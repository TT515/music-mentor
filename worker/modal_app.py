"""Music Mentor — Modal worker.

Exposes the music-perception tool belt as HTTP endpoints:
  POST /upload            multipart audio -> {upload_id}
  POST /quick_features    {upload_id} -> DSP triage (sync, seconds)
  POST /section_features  {upload_id, segments} -> per-section RMS/width/bands (sync)
  POST /separate          {upload_id, two_stems?} -> {job_id}   (Demucs, GPU, async)
  POST /structure         {upload_id} -> {job_id}               (allin1, GPU, async)
  POST /job               {job_id} -> {status, result?}

Deploy:  modal deploy worker/modal_app.py
Then set MODAL_BASE_URL in the site env to the printed app URL prefix.
"""
import json
import uuid

import modal

app = modal.App("music-mentor-worker")

# ---------------------------------------------------------------- images
cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("numpy", "librosa", "soundfile", "fastapi[standard]", "python-multipart")
)

# demucs.api exists only in the git version (PyPI 4.0.1 predates it) —
# same lesson learned the hard way on the local MCP install.
gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install("torch", "torchaudio", "numpy", "soundfile")
    .pip_install("git+https://github.com/adefossez/demucs", extra_options="--no-deps")
    .pip_install("dora-search", "einops", "julius", "lameenc", "openunmix", "pyyaml", "tqdm")
)

# allin1 needs NATTEN (CUDA kernels). This builds on Modal's GPU images but is
# the flakiest install in the stack; structure() falls back gracefully if the
# import fails at runtime.
structure_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git")
    .pip_install("torch", "torchaudio", "numpy", "soundfile", "librosa")
    .pip_install("natten", "allin1")
)

volume = modal.Volume.from_name("music-mentor-files", create_if_missing=True)
jobs = modal.Dict.from_name("music-mentor-jobs", create_if_missing=True)
DATA = "/data"


# ---------------------------------------------------------------- helpers
def _load_mono(path: str, sr: int = 22050):
    import numpy as np
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=True)
    return y, sr


def _load_stereo(path: str, sr: int = 22050):
    import librosa
    y, _ = librosa.load(path, sr=sr, mono=False)
    if y.ndim == 1:
        import numpy as np
        y = np.stack([y, y])
    return y, sr


# ---------------------------------------------------------------- HTTP API
@app.function(image=cpu_image, volumes={DATA: volume}, timeout=300)
@modal.asgi_app()
def api_app():
    """Single FastAPI app fronting all tools, with CORS for the site."""
    from fastapi import FastAPI, UploadFile
    from fastapi.middleware.cors import CORSMiddleware

    api = FastAPI()
    api.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )

    @api.post("/upload")
    async def do_upload(file: UploadFile):
        ext = (file.filename or "audio").rsplit(".", 1)[-1].lower()
        if ext not in {"wav", "mp3", "aif", "aiff", "flac", "m4a", "ogg"}:
            return {"error": f"unsupported extension: {ext}"}
        uid = uuid.uuid4().hex[:12]
        dest = f"{DATA}/{uid}.{ext}"
        with open(dest, "wb") as f:
            f.write(await file.read())
        volume.commit()
        return {"upload_id": uid, "path": dest, "filename": file.filename}

    @api.post("/quick_features")
    async def do_quick(body: dict):
        return quick_features.remote(body["upload_id"])

    @api.post("/section_features")
    async def do_sections(body: dict):
        return section_features.remote(body["upload_id"], body["segments"])

    @api.post("/separate")
    async def do_separate(body: dict):
        job_id = uuid.uuid4().hex[:8]
        jobs[job_id] = {"status": "running", "kind": "separate"}
        separate_stems.spawn(body["upload_id"], body.get("two_stems", ""), job_id)
        return {"job_id": job_id, "status": "running",
                "note": "Demucs on GPU, typically 30-90s. Poll /job."}

    @api.post("/structure")
    async def do_structure(body: dict):
        job_id = uuid.uuid4().hex[:8]
        jobs[job_id] = {"status": "running", "kind": "structure"}
        analyze_structure.spawn(body["upload_id"], job_id)
        return {"job_id": job_id, "status": "running",
                "note": "allin1 on GPU, typically 1-3 min. Poll /job."}

    @api.post("/mix")
    async def do_mix(body: dict):
        return mix_tracks.remote(body["upload_ids"], body.get("name", "mix"),
                                 body.get("gains_db"))

    @api.post("/save_meta")
    async def do_save_meta(body: dict):
        import os
        mid = uuid.uuid4().hex[:12]
        os.makedirs(f"{DATA}/meta", exist_ok=True)
        with open(f"{DATA}/meta/{mid}.json", "w") as f:
            f.write(body.get("meta", ""))
        volume.commit()
        return {"meta_id": mid}

    @api.post("/get_meta")
    async def do_get_meta(body: dict):
        volume.reload()
        try:
            with open(f"{DATA}/meta/{body['meta_id']}.json") as f:
                return {"meta": f.read()}
        except FileNotFoundError:
            return {"error": "unknown meta_id"}

    @api.post("/job")
    async def do_job(body: dict):
        return jobs.get(body["job_id"], {"status": "unknown"})

    return api


@app.function(image=cpu_image, volumes={DATA: volume}, timeout=300)
def quick_features(upload_id: str) -> dict:
    """Port of the MCP quick_features: fast DSP triage."""
    import glob
    import numpy as np
    import librosa

    volume.reload()
    path = glob.glob(f"{DATA}/{upload_id}.*")[0]
    y, sr = _load_mono(path)
    dur = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    tempo = float(np.asarray(tempo).flatten()[0])  # newer librosa returns a 1-element array
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    keys = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    maj = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minr = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
    scores = []
    for i in range(12):
        scores.append((float(np.corrcoef(chroma, np.roll(maj, i))[0, 1]), f"{keys[i]} major"))
        scores.append((float(np.corrcoef(chroma, np.roll(minr, i))[0, 1]), f"{keys[i]} minor"))
    scores.sort(reverse=True)
    rms = librosa.feature.rms(y=y)[0]
    rms_db = 20 * np.log10(rms + 1e-10)
    cent = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    onsets = librosa.onset.onset_detect(y=y, sr=sr)
    n_sec = 8
    seg = np.array_split(rms, n_sec)
    energy = [round(float(np.sqrt((s**2).mean())), 5) for s in seg]
    return {
        "duration_sec": round(dur, 2),
        "tempo_bpm_estimate": round(float(tempo), 1),
        "n_beats_detected": int(len(beats)),
        "key_estimate": scores[0][1],
        "key_confidence_0to1": round(scores[0][0], 3),
        "loudness_db": {"mean": round(float(rms_db.mean()), 1),
                        "max": round(float(rms_db.max()), 1)},
        "brightness_hz_mean_spectral_centroid": round(cent, 0),
        "onset_density_per_sec": round(len(onsets) / dur, 2),
        "energy_curve_8_sections": energy,
        "note": "DSP estimates only; confirm structure with /structure.",
    }


@app.function(image=cpu_image, volumes={DATA: volume}, timeout=300)
def section_features(upload_id: str, segments: list) -> list:
    """Per-section RMS / stereo width / band energy / envelope flatness.
    segments: [{start, end, label}] — from /structure or user-corrected.
    upload_id may also be 'stems/<uid>/<stem>' to analyze a separated stem."""
    import glob
    import numpy as np

    volume.reload()
    if upload_id.startswith("stems/"):
        path = f"{DATA}/{upload_id}.wav"
    else:
        path = glob.glob(f"{DATA}/{upload_id}.*")[0]
    st, sr = _load_stereo(path)
    L, R = st[0], st[1]
    mono = (L + R) / 2
    out = []
    for seg in segments:
        a, b = int(seg["start"] * sr), int(seg["end"] * sr)
        if b - a < sr:
            continue
        m = mono[a:b]
        n = len(m)
        X = np.abs(np.fft.rfft(m * np.hanning(n))) ** 2
        freqs = np.fft.rfftfreq(n, 1 / sr)
        bands = {"sub_20_60": (20, 60), "bass_60_150": (60, 150),
                 "lowmid_150_400": (150, 400), "mid_400_2k": (400, 2000),
                 "himid_2k_6k": (2000, 6000), "air_6k_10k": (6000, 10500)}
        tot = X.sum() + 1e-12
        band_db = {k: round(float(10 * np.log10(X[(freqs >= lo) & (freqs < hi)].sum() / tot + 1e-12)), 1)
                   for k, (lo, hi) in bands.items()}
        mid = (L[a:b] + R[a:b]) / 2
        side = (L[a:b] - R[a:b]) / 2
        width = float(np.sqrt((side**2).mean()) / (np.sqrt((mid**2).mean()) + 1e-12))
        hop = 512
        fr = np.lib.stride_tricks.sliding_window_view(m, hop * 2)[::hop]
        env = np.sqrt((fr**2).mean(axis=1))
        flat = float(np.exp(np.log(env + 1e-9).mean()) / (env.mean() + 1e-12)) if len(env) > 20 else None
        out.append({"label": seg["label"], "start": seg["start"], "end": seg["end"],
                    "rms_db": round(float(20 * np.log10(np.sqrt((m**2).mean()) + 1e-12)), 1),
                    "width_side_over_mid": round(width, 3),
                    "envelope_flatness": round(flat, 3) if flat else None,
                    "bands_rel_db": band_db})
    return out


@app.function(image=cpu_image, volumes={DATA: volume}, timeout=600)
def mix_tracks(upload_ids: list, name: str, gains_db: list = None) -> dict:
    """Sum several uploads/stems into one temporary track (sample-aligned,
    peak-limited). gains_db: optional per-track dB gains, parallel to
    upload_ids — pass DAW fader values to reconstruct the project mix.
    Returns a new upload_id usable everywhere."""
    import glob
    import uuid as _uuid
    import numpy as np
    import librosa
    import soundfile as sf

    volume.reload()

    def resolve(uid: str) -> str:
        if uid.startswith("stems/"):
            return f"{DATA}/{uid}.wav"
        return glob.glob(f"{DATA}/{uid}.*")[0]

    sr0 = None
    total = None
    for idx, uid in enumerate(upload_ids):
        y, sr = librosa.load(resolve(uid), sr=sr0, mono=False)
        if y.ndim == 1:
            y = np.stack([y, y])
        if gains_db and idx < len(gains_db) and gains_db[idx] is not None:
            y = y * (10.0 ** (float(gains_db[idx]) / 20.0))
        if sr0 is None:
            sr0 = sr
        if total is None:
            total = y.astype(np.float64)
        else:
            n = max(total.shape[1], y.shape[1])
            if total.shape[1] < n:
                total = np.pad(total, ((0, 0), (0, n - total.shape[1])))
            if y.shape[1] < n:
                y = np.pad(y, ((0, 0), (0, n - y.shape[1])))
            total += y

    peak = float(np.abs(total).max()) or 1.0
    scaled = peak > 0.99
    if scaled:
        total *= 0.95 / peak
    new_id = _uuid.uuid4().hex[:12]
    sf.write(f"{DATA}/{new_id}.wav", total.T.astype(np.float32), sr0)
    volume.commit()
    return {
        "upload_id": new_id,
        "mixed_from": upload_ids,
        "gains_db_applied": gains_db or "none (equal gain)",
        "sample_rate": sr0,
        "peak_normalized": scaled,
        "note": ("Gain-weighted sum" if gains_db else "Equal-gain sum") +
                (", scaled down to avoid clipping" if scaled else "") +
                (". Fader gains applied — approximates the project mix (minus master-bus FX)."
                 if gains_db else
                 ". Raw stem levels — NOT the project's fader mix."),
    }


# ---------------------------------------------------------------- async GPU tools
@app.function(image=gpu_image, volumes={DATA: volume}, gpu="T4", timeout=900)
def separate_stems(upload_id: str, two_stems: str, job_id: str):
    import glob
    import soundfile as sf

    try:
        volume.reload()
        path = glob.glob(f"{DATA}/{upload_id}.*")[0]
        from demucs.api import Separator
        sep = Separator(model="htdemucs_ft", device="cuda")
        _, sources = sep.separate_audio_file(path)
        out_dir = f"{DATA}/stems/{upload_id}"
        import os
        os.makedirs(out_dir, exist_ok=True)
        stems = {}
        for name, tensor in sources.items():
            if two_stems and name != two_stems:
                continue
            p = f"{out_dir}/{name}.wav"
            sf.write(p, tensor.cpu().numpy().T, sep.samplerate)
            stems[name] = f"stems/{upload_id}/{name}"
        volume.commit()
        jobs[job_id] = {"status": "done",
                        "result": {"stems": stems, "model": "htdemucs_ft",
                                   "note": "Pass a stem id to /section_features to analyze it."}}
    except Exception as e:  # noqa: BLE001
        jobs[job_id] = {"status": "failed", "error": repr(e)}


@app.function(image=structure_image, volumes={DATA: volume}, gpu="T4", timeout=900)
def analyze_structure(upload_id: str, job_id: str):
    import glob

    volume.reload()
    path = glob.glob(f"{DATA}/{upload_id}.*")[0]
    try:
        import allin1
        r = allin1.analyze(path, device="cuda")
        jobs[job_id] = {"status": "done", "result": {
            "bpm": r.bpm,
            "segments": [{"start": s.start, "end": s.end, "label": s.label} for s in r.segments],
            "downbeats_sec": [round(d, 2) for d in r.downbeats],
            "note": "Model segmentation. ALWAYS confirm boundaries/labels with the user "
                    "before giving timeline advice — unconventional structures fool allin1.",
        }}
    except Exception as e:  # noqa: BLE001
        # graceful fallback: beats + novelty-based boundaries, unlabeled
        try:
            import numpy as np
            import librosa
            y, sr = _load_mono(path)
            tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
            tempo = float(np.asarray(tempo).flatten()[0])  # newer librosa returns a 1-element array
            S = librosa.feature.melspectrogram(y=y, sr=sr)
            bounds = librosa.segment.agglomerative(librosa.power_to_db(S), 10)
            times = list(librosa.frames_to_time(bounds, sr=sr)) + [len(y) / sr]
            segs = [{"start": round(float(a), 2), "end": round(float(b), 2), "label": f"section{i+1}"}
                    for i, (a, b) in enumerate(zip(times[:-1], times[1:]))]
            jobs[job_id] = {"status": "done", "result": {
                "bpm": round(float(tempo)), "segments": segs,
                "note": f"allin1 unavailable ({e!r}); fallback novelty segmentation, "
                        "UNLABELED — ask the user to name each section.",
            }}
        except Exception as e2:  # noqa: BLE001
            jobs[job_id] = {"status": "failed", "error": repr(e2)}
