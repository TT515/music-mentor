import { useEffect, useRef, useState } from "react";

// ---- types mirroring the Anthropic message format (subset we render) ----
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string };
type Msg = { role: "user" | "assistant"; content: string | ContentBlock[] };

type Track = { upload_id: string; filename: string; url?: string };
type Session = { id: string; title: string; createdAt: number; messages: Msg[]; tracks: Track[] };

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
const STORE_KEY = "mm_sessions_v1";

const TOOL_LABELS: Record<string, { label: string; eta: string }> = {
  quick_features: { label: "Measuring tempo, key & loudness", eta: "~20 s" },
  analyze_structure: { label: "Mapping song structure", eta: "1–3 min" },
  separate_stems: { label: "Splitting into stems", eta: "1–2 min" },
  section_features: { label: "Measuring sections", eta: "~30 s" },
  get_job: { label: "Collecting results", eta: "" },
};

// --- tiny markdown-lite renderer ---
function md(text: string) {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, '<code class="bg-gray-100 rounded px-1">$1</code>');
  const lines = text.split("\n");
  let html = "", inList = false, inTable = false;
  for (const ln of lines) {
    if (ln.trim().startsWith("|")) {
      if (!inTable) { html += '<div class="font-mono text-xs overflow-x-auto whitespace-pre my-2 text-gray-700">'; inTable = true; }
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

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted store — start fresh */ }
  return [];
}

const newSession = (): Session => ({
  id: Math.random().toString(36).slice(2, 10),
  title: "New chat",
  createdAt: Date.now(),
  messages: [],
  tracks: [],
});

export default function App() {
  const [sessions, setSessions] = useState<Session[]>(() => {
    const s = loadSessions();
    return s.length > 0 ? s : [newSession()];
  });
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id);
  const [messages, setMessages] = useState<Msg[]>(() => sessions[0]?.messages || []);
  const [tracks, setTracks] = useState<Track[]>(() => sessions[0]?.tracks || []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [askUser, setAskUser] = useState<AskUser | null>(null);
  const [answers, setAnswers] = useState<Record<number, { picks: Set<string>; other: string }>>({});
  const [runningJobs, setRunningJobs] = useState<Record<string, { kind: string; since: number }>>({});
  const [queuedNotices, setQueuedNotices] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const tracksRef = useRef<Track[]>([]);
  tracksRef.current = tracks;

  // ---------- session persistence ----------
  useEffect(() => {
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === activeId
          ? {
              ...s,
              messages,
              tracks: tracks.map(({ upload_id, filename }) => ({ upload_id, filename })),
              title:
                s.title === "New chat"
                  ? (() => {
                      const firstText = messages.find((m) => typeof m.content === "string" && !(m.content as string).startsWith("[system]"));
                      if (firstText) return (firstText.content as string).slice(0, 40);
                      if (tracks[0]) return tracks[0].filename.slice(0, 40);
                      return "New chat";
                    })()
                  : s.title,
            }
          : s
      );
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
  }, [messages, tracks, activeId]);

  function clearTransient() {
    Object.values(pollTimers.current).forEach(clearInterval);
    pollTimers.current = {};
    setRunningJobs({});
    setQueuedNotices([]);
    setAskUser(null);
    setAnswers({});
    setError("");
    setInput("");
  }

  function switchSession(id: string) {
    if (id === activeId) return;
    clearTransient();
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    setActiveId(id);
    setMessages(s.messages);
    setTracks(s.tracks);
    setSidebarOpen(false);
  }

  function createSession() {
    clearTransient();
    const s = newSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setMessages([]);
    setTracks([]);
    setSidebarOpen(false);
  }

  function deleteSession(id: string) {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* quota */ }
      if (id === activeId) {
        const fallback = next[0] || newSession();
        if (next.length === 0) next.push(fallback);
        clearTransient();
        setActiveId(fallback.id);
        setMessages(fallback.messages);
        setTracks(fallback.tracks);
      }
      return next;
    });
  }

  // flush queued job notifications only when the conversation is free
  useEffect(() => {
    if (queuedNotices.length > 0 && !busy && !askUser) {
      const batch = queuedNotices.join("\n");
      setQueuedNotices([]);
      void send(batch, []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedNotices, busy, askUser]);

  // accept file drops anywhere; block browser default navigation
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy, askUser]);

  // ---------- upload (silent: the mentor waits for a question) ----------
  async function onFile(f: File) {
    setError("");
    if (!/\.(wav|mp3|aif|aiff|flac|m4a|ogg)$/i.test(f.name)) {
      setError(`"${f.name}" isn't a supported format (mp3, wav, aiff, flac, m4a, ogg).`);
      return;
    }
    const mb = f.size / 1e6;
    try {
      const fd = new FormData();
      fd.append("file", f);
      const j: any = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${WORKER}/upload`);
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            const pct = Math.round((ev.loaded / ev.total) * 100);
            setUploadStatus(pct < 100 ? `Uploading ${f.name} — ${pct}%` : "Almost done…");
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
      setError(`Upload failed: ${e.message}. Try again in a moment.`);
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

  function findAnswers(toolUseId: string): { question: string; answer: string }[] | null {
    for (const m of messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
          try { return JSON.parse(b.content); } catch { return null; }
        }
      }
    }
    return null;
  }

  // ---------- render ----------
  const sidebar = (
    <aside className="w-64 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col h-full">
      <div className="p-3">
        <button
          onClick={createSession}
          className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm font-medium hover:bg-white text-left"
        >
          ＋ New chat
        </button>
      </div>

      <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Chats</div>
      <div className="flex-1 overflow-y-auto px-2 flex flex-col gap-0.5">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => switchSession(s.id)}
            className={`group flex items-center rounded-lg px-2 py-1.5 text-sm cursor-pointer ${
              s.id === activeId ? "bg-gray-200/80 font-medium" : "hover:bg-gray-100 text-gray-600"
            }`}
          >
            <span className="truncate flex-1">{s.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-xs px-1"
              title="Delete chat"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-200 p-3 flex flex-col gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Tracks in this chat</div>
        {tracks.length === 0 && <div className="text-xs text-gray-400">No tracks yet</div>}
        {tracks.map((t) => (
          <div key={t.upload_id} className="flex flex-col gap-1 bg-white border border-gray-200 rounded-lg px-2 py-1.5">
            <span className="text-xs truncate" title={t.filename}>{t.filename}</span>
            {t.url && <audio controls src={t.url} className="w-full h-7" />}
          </div>
        ))}
        <label
          onDragEnter={() => setDragging(true)}
          onDragLeave={() => setDragging(false)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault(); setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void onFile(f);
          }}
          className={`border border-dashed rounded-lg px-2 py-2 text-center text-xs cursor-pointer transition ${
            dragging ? "border-blue-500 bg-blue-50 text-blue-600" : "border-gray-300 text-gray-500 hover:border-gray-400 hover:bg-white"
          }`}
        >
          <input
            type="file"
            accept="audio/*,.aif,.aiff,.flac"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          {uploadStatus || "Upload track — mp3 · wav · aiff · flac"}
        </label>
      </div>
    </aside>
  );

  return (
    <div className="h-screen bg-white text-gray-900 flex overflow-hidden">
      {/* sidebar: static on desktop, drawer on mobile */}
      <div className="hidden md:flex h-full">{sidebar}</div>
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-20 flex">
          <div className="h-full">{sidebar}</div>
          <div className="flex-1 bg-black/30" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* main column */}
      <div className="flex-1 flex flex-col h-full">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
          <button className="md:hidden text-gray-500" onClick={() => setSidebarOpen(true)}>☰</button>
          <h1 className="text-base font-semibold tracking-tight">Music Mentor</h1>
          <span className="text-xs text-gray-400 hidden sm:inline">measure → ask intent → advise</span>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-4">
          <div className="max-w-2xl mx-auto flex flex-col gap-3">
            {messages.length === 0 && (
              <div className="text-center text-gray-400 text-sm mt-16 space-y-1">
                <div className="text-2xl">🎛️</div>
                <div>Upload a track in the sidebar, then ask anything —</div>
                <div className="italic">"why does my chorus feel weak?" · "compare my demo to the reference"</div>
              </div>
            )}

            {messages.map((m, i) => {
              if (typeof m.content === "string") {
                if (m.content.startsWith("[system]")) return null;
                return (
                  <div key={i} className="self-end bg-gray-100 rounded-2xl rounded-br-md px-4 py-2 max-w-[85%] text-[15px]">
                    {m.content}
                  </div>
                );
              }
              return m.content.map((b, k) => {
                if (b.type === "text")
                  return (
                    <div key={`${i}-${k}`} className="self-start max-w-[95%] text-[15px] leading-relaxed px-1"
                      dangerouslySetInnerHTML={{ __html: md(b.text) }} />
                  );
                if (b.type === "tool_use" && b.name !== "ask_user") {
                  const t = TOOL_LABELS[b.name] || { label: b.name, eta: "" };
                  return (
                    <div key={`${i}-${k}`} className="self-start flex items-center gap-2 text-xs text-gray-400 px-1">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                      {t.label}{t.eta && <span className="opacity-70"> · {t.eta}</span>}
                    </div>
                  );
                }
                if (b.type === "tool_use" && b.name === "ask_user") {
                  const ans = findAnswers(b.id);
                  if (!ans) return null;
                  return (
                    <div key={`${i}-${k}`} className="self-start w-full max-w-[95%] border border-gray-200 rounded-2xl p-4 bg-gray-50 flex flex-col gap-3">
                      {ans.map((qa, qi) => (
                        <div key={qi}>
                          <div className="text-sm text-gray-600">{qa.question}</div>
                          <div className="text-sm font-medium mt-0.5 text-blue-700">{qa.answer}</div>
                        </div>
                      ))}
                    </div>
                  );
                }
                return null;
              });
            })}

            {Object.entries(runningJobs).map(([id, j]) => (
              <div key={id} className="self-start flex items-center gap-2 text-xs bg-blue-50 text-blue-700 rounded-full px-3 py-1.5">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                Analyzing (<Elapsed since={j.since} />) — keep chatting, results arrive automatically
              </div>
            ))}

            {askUser && (
              <div className="border border-blue-200 rounded-2xl p-4 flex flex-col gap-4 bg-blue-50/50 w-full max-w-[95%]">
                {askUser.questions.map((q, qi) => (
                  <div key={qi}>
                    <div className="font-medium mb-2 text-sm">{q.question}</div>
                    <div className="flex flex-col gap-2">
                      {q.options.map((o) => (
                        <button
                          key={o.label}
                          onClick={() => toggle(qi, o.label, !!q.multiSelect)}
                          className={`text-left border rounded-xl px-3 py-2 transition bg-white ${
                            answers[qi]?.picks.has(o.label)
                              ? "border-blue-500 ring-1 ring-blue-500"
                              : "border-gray-200 hover:border-gray-300"
                          }`}
                        >
                          <div className="font-medium text-sm">{o.label}</div>
                          <div className="text-xs text-gray-500">{o.description}</div>
                        </button>
                      ))}
                      <input
                        placeholder="Something else…"
                        className="bg-white border border-gray-200 rounded-xl px-3 py-2 text-sm placeholder:text-gray-400 focus:border-blue-400 outline-none"
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
                <button onClick={submitAnswers} className="self-end bg-blue-600 text-white font-medium rounded-xl px-5 py-2 text-sm hover:bg-blue-700">
                  Send
                </button>
              </div>
            )}

            {busy && (
              <div className="self-start flex items-center gap-2 text-sm text-gray-400 px-1">
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" />
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce [animation-delay:0.15s]" />
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce [animation-delay:0.3s]" />
                </span>
                Thinking…
              </div>
            )}
            {error && (
              <div className="self-start text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">
                {error}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </main>

        <footer className="px-4 py-3 border-t border-gray-100">
          <div className="max-w-2xl mx-auto">
            <input
              className="w-full bg-white border border-gray-300 rounded-2xl px-4 py-3 text-[15px] placeholder:text-gray-400 focus:border-gray-500 outline-none shadow-sm"
              placeholder={
                askUser
                  ? "Answer above first…"
                  : messages.length > 0
                  ? "Ask a follow-up…"
                  : 'Ask a question — e.g. "why does my chorus feel weak?"'
              }
              value={input}
              disabled={busy || !!askUser}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && input.trim() && send(input.trim(), [])}
            />
          </div>
        </footer>
      </div>
    </div>
  );
}
