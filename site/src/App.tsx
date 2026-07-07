import { useEffect, useRef, useState } from "react";

// ---- types mirroring the Anthropic message format (subset we render) ----
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string };
type Msg = { role: "user" | "assistant"; content: string | ContentBlock[] };

type Track = { upload_id: string; filename: string; url: string };

type AskUser = {
  toolUseId: string;
  questions: {
    question: string;
    header: string;
    multiSelect?: boolean;
    options: { label: string; description: string }[];
  }[];
};

const WORKER = import.meta.env.VITE_MODAL_BASE_URL as string;

const TOOL_LABELS: Record<string, { label: string; eta: string }> = {
  quick_features: { label: "Measuring tempo, key & loudness", eta: "~20 s" },
  analyze_structure: { label: "Mapping song structure", eta: "1–3 min" },
  separate_stems: { label: "Splitting into stems (vocals / drums / bass / other)", eta: "1–2 min" },
  section_features: { label: "Measuring each section", eta: "~30 s" },
  get_job: { label: "Collecting results", eta: "" },
};

// --- tiny markdown-lite renderer (bold, italics, code, headers, lists) ---
function md(text: string) {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, '<code class="bg-black/10 rounded px-1">$1</code>');
  const lines = text.split("\n");
  let html = "", inList = false, inTable = false;
  for (const ln of lines) {
    if (ln.trim().startsWith("|")) {
      if (!inTable) { html += '<div class="font-mono text-xs overflow-x-auto whitespace-pre my-2">'; inTable = true; }
      html += esc(ln) + "\n";
      continue;
    } else if (inTable) { html += "</div>"; inTable = false; }
    const li = ln.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!inList) { html += '<ul class="list-disc ml-5 my-1">'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    } else if (inList) { html += "</ul>"; inList = false; }
    const h = ln.match(/^(#{1,4})\s+(.*)/);
    if (h) html += `<div class="font-semibold mt-2 mb-1">${inline(h[2])}</div>`;
    else if (ln.trim() === "") html += '<div class="h-2"></div>';
    else html += `<div>${inline(ln)}</div>`;
  }
  if (inList) html += "</ul>";
  if (inTable) html += "</div>";
  return html;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.floor((Date.now() - since) / 1000);
  return <span>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [askUser, setAskUser] = useState<AskUser | null>(null);
  const [answers, setAnswers] = useState<Record<number, { picks: Set<string>; other: string }>>({});
  const [runningJobs, setRunningJobs] = useState<Record<string, { kind: string; since: number }>>({});
  const [queuedNotices, setQueuedNotices] = useState<string[]>([]);
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const tracksRef = useRef<Track[]>([]);
  tracksRef.current = tracks;

  // flush queued job notifications only when the conversation is free:
  // never interrupt a pending intent question or an in-flight request
  useEffect(() => {
    if (queuedNotices.length > 0 && !busy && !askUser) {
      const batch = queuedNotices.join("\n");
      setQueuedNotices([]);
      void send(batch, []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedNotices, busy, askUser]);

  // accept file drops anywhere on the page; block browser default navigation
  useEffect(() => {
    const over = (e: DragEvent) => { e.preventDefault(); };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) void onFile(f);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy, askUser, tracks]);

  // ---------- upload (no auto-analysis: the mentor waits for a question) ----------
  async function onFile(f: File) {
    setError("");
    if (!/\.(wav|mp3|aif|aiff|flac|m4a|ogg)$/i.test(f.name)) {
      setError(`"${f.name}" doesn't look like audio (wav/mp3/aiff/flac/m4a/ogg).`);
      return;
    }
    const mb = f.size / 1e6;
    if (mb > 20)
      setUploadStatus(`Heads up: ${mb.toFixed(0)} MB is big — an mp3 uploads ~15x faster and analyzes just as well.`);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const j: any = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${WORKER}/upload`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            const pct = Math.round((ev.loaded / ev.total) * 100);
            setUploadStatus(
              pct < 100
                ? `Uploading ${f.name} — ${pct}% of ${mb.toFixed(1)} MB`
                : `Upload complete — registering with the analysis server…`
            );
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("bad server response")); }
          } else reject(new Error(`upload failed (HTTP ${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error("network error during upload"));
        xhr.send(fd);
      });
      if (j.error) throw new Error(j.error);
      setTracks((t) => [...t, { upload_id: j.upload_id, filename: f.name, url: URL.createObjectURL(f) }]);
      setUploadStatus("");
    } catch (e: any) {
      setUploadStatus("");
      setError(`Upload problem: ${e.message}. The analysis server may be waking up — try once more.`);
    }
  }

  // ---------- job auto-resume ----------
  function watchJobs(msgs: Msg[]) {
    for (const m of msgs) {
      if (typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        try {
          const out = JSON.parse(b.content);
          if (out.job_id && out.status === "running" && !pollTimers.current[out.job_id]) {
            setRunningJobs((p) => ({ ...p, [out.job_id]: { kind: out.note || "analysis", since: Date.now() } }));
            pollTimers.current[out.job_id] = setInterval(async () => {
              try {
                const r = await fetch(`${WORKER}/job`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ job_id: out.job_id }),
                });
                const j = await r.json();
                if (j.status === "done" || j.status === "failed") {
                  clearInterval(pollTimers.current[out.job_id]);
                  delete pollTimers.current[out.job_id];
                  setRunningJobs((p) => { const q = { ...p }; delete q[out.job_id]; return q; });
                  setQueuedNotices((q) => [...q, `[system] Job ${out.job_id} is ${j.status}. Fetch it with get_job and continue.`]);
                }
              } catch { /* transient network — keep polling */ }
            }, 15000);
          }
        } catch { /* not json */ }
      }
    }
  }

  // ---------- agent round-trip ----------
  async function send(text: string, extraBlocks: ContentBlock[]) {
    setBusy(true);
    setError("");
    const userMsg: Msg =
      extraBlocks.length > 0 ? { role: "user", content: extraBlocks } : { role: "user", content: text };
    const outbound = [...messagesRef.current, userMsg];
    setMessages(outbound);
    setInput("");
    setStatus("The mentor is thinking…");
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: outbound,
          tracks: tracksRef.current.map(({ upload_id, filename }) => ({ upload_id, filename })),
        }),
      });
      if (!r.ok) {
        const bodyText = await r.text();
        throw new Error(`chat failed (HTTP ${r.status}): ${bodyText.slice(0, 200)}`);
      }
      const j = await r.json();
      const all = [...outbound, ...(j.newMessages || [])];
      setMessages(all);
      watchJobs(j.newMessages || []);
      if (j.askUser) {
        setAskUser(j.askUser);
        setAnswers({});
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }

  // ---------- intent cards ----------
  function toggle(qi: number, label: string, multi: boolean) {
    setAnswers((prev) => {
      const cur = prev[qi] || { picks: new Set<string>(), other: "" };
      const picks = new Set(cur.picks);
      if (!multi) picks.clear();
      picks.has(label) ? picks.delete(label) : picks.add(label);
      return { ...prev, [qi]: { ...cur, picks } };
    });
  }

  async function submitAnswers() {
    if (!askUser) return;
    const payload = askUser.questions.map((q, qi) => {
      const a = answers[qi] || { picks: new Set<string>(), other: "" };
      const picks = [...a.picks];
      if (a.other.trim()) picks.push(`Something else: ${a.other.trim()}`);
      return { question: q.question, answer: picks.join("; ") || "(no answer)" };
    });
    const block: ContentBlock = {
      type: "tool_result",
      tool_use_id: askUser.toolUseId,
      content: JSON.stringify(payload),
    };
    setAskUser(null);
    await send("", [block]);
  }

  const hasChat = messages.length > 0;
  const showHero = tracks.length === 0 && !hasChat;

  // ---------- render ----------
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4 min-h-screen">
        <header className="flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-bold tracking-tight">🎛️ Music Mentor</h1>
            <span className="text-sm text-slate-400 hidden sm:inline">measure → ask intent → advise</span>
          </div>
          {tracks.length > 0 && (
            <span className="text-xs bg-slate-800 rounded-full px-3 py-1">🎵 {tracks.length} track{tracks.length > 1 ? "s" : ""}</span>
          )}
        </header>

        {/* landing hero */}
        {showHero && (
          <div className="flex-1 flex flex-col justify-center gap-6">
            <div className="text-center space-y-2">
              <div className="text-4xl">🔥</div>
              <h2 className="text-xl font-semibold">Production feedback that starts by listening — then asks what you meant.</h2>
              <p className="text-slate-400 max-w-lg mx-auto text-sm">
                Drop in as many tracks as you like — demos, revisions, references — then ask
                anything. The mentor measures what it needs (tempo, key, structure, stems,
                per-section energy), asks about your <em>intent</em>, and answers with specific,
                traceable advice.
              </p>
            </div>
            <label
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void onFile(f);
              }}
              className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition
                ${dragging ? "border-amber-400 bg-amber-400/10 scale-[1.01]" : "border-slate-700 hover:border-slate-500 hover:bg-white/5"}`}
            >
              <input
                type="file"
                accept="audio/*,.aif,.aiff,.flac"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
              <div className="text-lg font-medium">{uploadStatus || "Drop your first track here"}</div>
              <div className="text-sm text-slate-400 mt-1">or click to browse — mp3 / m4a upload fastest; wav & aiff work but are 10–15× larger</div>
            </label>
            <div className="grid grid-cols-3 gap-3 text-center text-xs text-slate-400">
              <div className="bg-white/5 rounded-xl p-3"><div className="text-base mb-1">📐</div>Real measurements, not vibes — every claim has a number</div>
              <div className="bg-white/5 rounded-xl p-3"><div className="text-base mb-1">🎯</div>It asks what each section is <em>supposed</em> to do before judging it</div>
              <div className="bg-white/5 rounded-xl p-3"><div className="text-base mb-1">🎚️</div>Compare demos against references — yours vs. the sound you're chasing</div>
            </div>
          </div>
        )}

        {/* track shelf */}
        {tracks.length > 0 && (
          <div className="flex flex-col gap-2">
            {tracks.map((t) => (
              <div key={t.upload_id} className="flex items-center gap-3 bg-white/5 rounded-xl px-3 py-2">
                <span className="text-xs truncate flex-1" title={t.filename}>🎵 {t.filename}</span>
                <audio controls src={t.url} className="h-8 max-w-[55%]" />
              </div>
            ))}
            <label className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer self-start px-1">
              <input
                type="file"
                accept="audio/*,.aif,.aiff,.flac"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
              ＋ add another track (or drop it anywhere)
            </label>
            {uploadStatus && <div className="text-xs text-amber-300">{uploadStatus}</div>}
          </div>
        )}

        {/* chat */}
        <main className="flex-1 flex flex-col gap-3">
          {messages.map((m, i) => {
            if (typeof m.content === "string") {
              if (m.content.startsWith("[system]")) return null;
              return (
                <div key={i} className="self-end bg-blue-600 rounded-2xl rounded-br-sm px-4 py-2 max-w-[85%] text-sm">
                  {m.content}
                </div>
              );
            }
            return m.content.map((b, k) => {
              if (b.type === "text")
                return (
                  <div key={`${i}-${k}`} className="self-start bg-white/10 rounded-2xl rounded-bl-sm px-4 py-3 max-w-[92%] text-sm leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: md(b.text) }} />
                );
              if (b.type === "tool_use" && b.name !== "ask_user") {
                const t = TOOL_LABELS[b.name] || { label: b.name, eta: "" };
                return (
                  <div key={`${i}-${k}`} className="self-start flex items-center gap-2 text-xs text-slate-400 pl-2">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    {t.label}{t.eta && <span className="opacity-60">· {t.eta}</span>}
                  </div>
                );
              }
              return null;
            });
          })}

          {Object.entries(runningJobs).map(([id, j]) => (
            <div key={id} className="self-start flex items-center gap-2 text-xs bg-amber-400/10 text-amber-300 rounded-full px-3 py-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              Deep analysis running (<Elapsed since={j.since} /> elapsed) — keep chatting; I'll pick it up when it finishes
            </div>
          ))}

          {askUser && (
            <div className="border border-amber-400/40 rounded-2xl p-4 flex flex-col gap-4 bg-amber-400/5">
              <div className="text-xs uppercase tracking-widest text-amber-300 font-semibold">The mentor wants to understand your intent</div>
              {askUser.questions.map((q, qi) => (
                <div key={qi}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{q.header}</div>
                  <div className="font-medium mb-2 text-sm">{q.question}</div>
                  <div className="flex flex-col gap-2">
                    {q.options.map((o) => (
                      <button
                        key={o.label}
                        onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                        className={`text-left border rounded-xl px-3 py-2 transition ${
                          answers[qi]?.picks.has(o.label)
                            ? "border-amber-400 bg-amber-400/10"
                            : "border-slate-700 hover:border-slate-500 hover:bg-white/5"
                        }`}
                      >
                        <div className="font-medium text-sm">{o.label}</div>
                        <div className="text-xs text-slate-400">{o.description}</div>
                      </button>
                    ))}
                    <input
                      placeholder="Something else…"
                      className="bg-transparent border border-slate-700 rounded-xl px-3 py-2 text-sm placeholder:text-slate-500 focus:border-amber-400 outline-none"
                      value={answers[qi]?.other || ""}
                      onChange={(e) =>
                        setAnswers((p) => ({
                          ...p,
                          [qi]: { picks: p[qi]?.picks || new Set<string>(), other: e.target.value },
                        }))
                      }
                    />
                  </div>
                </div>
              ))}
              <button onClick={submitAnswers} className="self-end bg-amber-400 text-slate-900 font-semibold rounded-xl px-5 py-2 text-sm hover:bg-amber-300">
                Send answers
              </button>
            </div>
          )}

          {busy && (
            <div className="self-start flex items-center gap-2 text-sm text-slate-400">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" />
                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0.15s]" />
                <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0.3s]" />
              </span>
              {status || "The mentor is thinking…"}
            </div>
          )}
          {error && (
            <div className="self-start text-sm text-red-300 bg-red-400/10 border border-red-400/30 rounded-xl px-4 py-2">
              ⚠️ {error}
            </div>
          )}
          <div ref={bottomRef} />
        </main>

        {!showHero && (
          <footer className="sticky bottom-0 py-3 bg-gradient-to-t from-slate-950 via-slate-950">
            <input
              className="w-full bg-slate-900 border border-slate-700 rounded-2xl px-4 py-3 text-sm placeholder:text-slate-500 focus:border-slate-400 outline-none"
              placeholder={
                askUser
                  ? "Answer the questions above first…"
                  : tracks.length === 0
                  ? "Drop a track in, or ask anything…"
                  : "Ask anything about your tracks — compare them, question a section, request an analysis…"
              }
              value={input}
              disabled={busy || !!askUser}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && input.trim() && send(input.trim(), [])}
            />
          </footer>
        )}
      </div>
    </div>
  );
}
