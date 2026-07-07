# 🎛️ Music Mentor

An AI production mentor: upload a track, it **measures** (DSP triage, real
song structure, Demucs stems, per-section/per-stem features), **asks your
intent** (multiple-choice cards with "Something else"), and **advises**
against the gap between what you meant and what the audio does.

Successor to [music-analysis-tutor-vercel](https://github.com/TT515/music-analysis-tutor-vercel),
rebuilt around tool orchestration + intent elicitation instead of a single
audio-LLM call.

## Architecture

```
Browser (React/Vite, Vercel)
   │  audio upload (direct)                 chat
   ▼                                         ▼
Modal worker (Python, GPU) ◄──tools──  /api/chat (Vercel fn, Claude agent loop)
  /upload /quick_features                    │
  /structure /separate         ask_user ────► intent cards in UI
  /section_features /job
```

Design decisions carried over from the local MCP experiments (July 2026):

- **Routing policy in the system prompt**: triage → structure → stems →
  advice; numbers over adjectives; async jobs don't block chat.
- **Structure must be user-confirmed**: allin1 mislabeled an unconventional
  song badly in testing; the agent always shows detected sections and asks
  for corrections before building advice on them.
- **Intent elicitation is a first-class tool** (`ask_user`): measured
  anomalies are ambiguous between flaw and choice; only the user knows.
  The UI adds a "Something else" free-text option to every question.
- **demucs from git**: PyPI 4.0.1 predates `demucs.api` (cost us an hour).

## Deploy (~20 min)

### 1. Worker (Modal)

```bash
pip install modal
modal setup                        # one-time auth
modal deploy worker/modal_app.py
```

Note the printed URL for `api_app` — something like
`https://YOU--music-mentor-worker-api-app.modal.run`. That is `MODAL_BASE_URL`.

Smoke test:

```bash
curl -X POST $MODAL_BASE_URL/upload -F file=@some_track.mp3
curl -X POST $MODAL_BASE_URL/quick_features -H 'content-type: application/json' \
     -d '{"upload_id": "<id from upload>"}'
```

### 2. Site (Vercel)

```bash
cd site
cp .env.example .env    # fill in keys for local dev
npm install
npx vercel              # link project, then:
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add MODAL_BASE_URL
npx vercel env add VITE_MODAL_BASE_URL
npx vercel --prod
```

Local dev: `npx vercel dev` (runs Vite + the /api function together).

## Costs (capstone-prototype scale)

- Modal: T4 GPU ≈ $0.000164/s → a 60s Demucs job ≈ $0.01; structure ≈ $0.02.
  Free tier credits (~$30/mo) cover hundreds of analyses.
- Claude API: a full mentor conversation with tool calls ≈ $0.05–0.30
  depending on model. Set `ANTHROPIC_MODEL` to a smaller model to cut cost.
- Vercel hobby tier is fine; `/api/chat` needs `maxDuration` ≥ 60s (set in code).

## Known gaps (deliberate, prototype scope)

- No auth / rate limiting — anyone with the URL spends your credits.
  Don't share publicly until added (Clerk or a simple invite code both work).
- Uploaded audio persists in the Modal volume unencrypted; add a cleanup
  cron + a privacy note before inviting strangers.
- allin1 install on Modal can be finicky (NATTEN); the worker falls back to
  unlabeled novelty segmentation and tells the agent to ask the user for
  labels — which the mentor flow needs anyway.
- No streaming; responses arrive whole. Add SSE later if it feels slow.
- `vibe_similarity` (MuQ-MuLan) and `transcribe_pitch` (basic-pitch) from the
  local MCP are not ported yet — straightforward additions to the worker
  following the same pattern.

## Roadmap ideas (from the 2026-07-03 session)

- Intent memory: persist per-track intent answers (section goals, instrument
  roles, references) and reuse across revisions.
- Revision diffing: upload v1 + v2, report which measured gaps moved toward
  stated intent (the coaching moment that landed hardest in testing).
- Intent axes beyond sections: instruments, timbres, vocal character,
  reference-quality mapping ("which reference, which quality").
