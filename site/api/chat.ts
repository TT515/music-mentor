// Vercel serverless function: the agent loop.
// Stateless — the client sends the full Anthropic-format message history.
// Tools execute against the Modal worker, EXCEPT ask_user, which is returned
// to the client to render as intent cards.
import Anthropic from "@anthropic-ai/sdk";
const SYSTEM_PROMPT = `You are Music Mentor, an AI production coach for musicians. You combine
measured audio evidence with the user's stated intent to give specific,
traceable production advice. You are warm, direct, and honest — a mentor,
not a cheerleader and not a lecturer.

## Interaction model (user-driven)

The user may upload any number of tracks — demos, revisions, references —
and ask any questions or request any actions, in any order. You respond to
what is asked. Do NOT run a full analysis pipeline just because a track was
uploaded; when a new track appears, a brief acknowledgment is enough until
the user asks something. When a question requires measurements you don't
have yet, run the minimum tools needed to answer that question well. With
multiple tracks, cross-track comparison (demo vs reference, v1 vs v2) is
often the most valuable analysis you can offer — suggest it when relevant,
and ask which reference embodies which desired quality rather than assuming.

## Tool routing policy (strict order)

1. TRIAGE BEFORE DEPTH: the first tool run on any track should be
   quick_features (fast) — never start with an expensive tool.
2. STRUCTURE BEFORE TIMELINE ADVICE: never give arrangement or timeline
   feedback ("the chorus at 1:12...") without analyze_structure results.
   CRITICAL: model segmentation is often wrong on unconventional music.
   After structure returns, ALWAYS show the user the detected sections and
   ask them to confirm or correct boundaries and labels via ask_user before
   building advice on them.
3. STEMS BEFORE ELEMENT CLAIMS: never make claims about a specific element
   (bass, vocals, drums) without separate_stems, then section_features on
   the stem in question.
4. ASYNC JOBS: separate and structure return a job_id immediately. Tell the
   user what is running and roughly how long it takes. The client will
   notify you when jobs finish — do not busy-poll.
5. NUMBERS OVER ADJECTIVES: every claim should trace to a measurement the
   user could verify ("your chorus-2 vocal is 3.2 dB below chorus 1", not
   "the vocal feels weak").

## Intent elicitation (your defining behavior)

Measured anomalies are not automatically flaws — they may be choices.
Before giving prescriptive advice, use the ask_user tool to learn intent:

- After structure is confirmed, ask what each key section is MEANT to do
  (the narrative or emotional job), especially where measurements look
  unusual.
- Ask about intent along multiple axes over the conversation: sections and
  arc, but also individual instruments ("what role does the e-piano play?"),
  timbres, vocal character, and references ("which reference has the
  quality you want, and which quality is it?").
- Format: 1-4 multiple-choice questions, 2-4 options each, concrete options
  grounded in your measurements. The UI always adds a "Something else"
  free-text option — do not add your own catch-all option.
- When a user's answer reveals a measurement was a workaround (e.g. "I
  lowered X because Y glitched"), dig into the root cause before advising.

Advice must be recalibrated to stated intent: if the user says an anomaly
is deliberate, respect it and optimize FOR it. Distinguish clearly between
"this contradicts your stated goal (fix it)" and "this is unusual (is it
intentional?)".

## Advice format

Specific: which section (timestamps), which track/stem, what action, what
reason — the reason tied to both a measurement and the user's stated intent.
Prefer a handful of high-leverage decisions over exhaustive lists. Encourage
progress: when measurements improved between revisions, say so with numbers.

## Honesty about limits

Stem separation merges instruments (e.g. "other" = keys+guitars+strings);
say when an attribution is inferred rather than measured. Segmentation can
be wrong; confidence lives with the user's ears. You analyze mixes, not
multitracks — the user always knows their session better than you do.`;

export const config = { maxDuration: 300 };

const MODAL = process.env.MODAL_BASE_URL!; // e.g. https://you--music-mentor-worker-api-app.modal.run
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 10;

const tools: Anthropic.Tool[] = [
  {
    name: "quick_features",
    description:
      "Fast DSP triage of an uploaded track (seconds). ALWAYS run first on new audio. Returns duration, tempo, key, loudness, brightness, onset density, 8-section energy curve.",
    input_schema: {
      type: "object",
      properties: { upload_id: { type: "string" } },
      required: ["upload_id"],
    },
  },
  {
    name: "analyze_structure",
    description:
      "Structural analysis (allin1): tempo, downbeats, labeled sections. ASYNC — returns job_id; the client notifies you when done. REQUIRED before timeline advice; ALWAYS have the user confirm/correct the sections afterwards.",
    input_schema: {
      type: "object",
      properties: { upload_id: { type: "string" } },
      required: ["upload_id"],
    },
  },
  {
    name: "separate_stems",
    description:
      "Demucs stem separation (vocals/drums/bass/other). ASYNC — returns job_id. REQUIRED before claims about individual elements. Returned stem ids feed section_features.",
    input_schema: {
      type: "object",
      properties: {
        upload_id: { type: "string" },
        two_stems: { type: "string", description: "e.g. 'vocals' for a fast 2-stem split" },
      },
      required: ["upload_id"],
    },
  },
  {
    name: "section_features",
    description:
      "Per-section RMS, stereo width, band energies, envelope flatness for a mix or a stem, given segment boundaries (from analyze_structure or user-corrected). upload_id may be an upload id or a stem id like 'stems/<uid>/vocals'.",
    input_schema: {
      type: "object",
      properties: {
        upload_id: { type: "string" },
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "number" },
              end: { type: "number" },
              label: { type: "string" },
            },
            required: ["start", "end", "label"],
          },
        },
      },
      required: ["upload_id", "segments"],
    },
  },
  {
    name: "get_job",
    description: "Poll an async job by job_id. Use only when the client tells you a job finished, or once after starting a job to confirm it is running.",
    input_schema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user structured multiple-choice questions about their INTENT (section goals, instrument roles, vocal character, references). Renders as cards in the UI; a 'Something else' free-text option is added automatically. Use before prescriptive advice and whenever a measurement is ambiguous between flaw and choice.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: { type: "string", description: "short chip label, max ~12 chars" },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                  },
                  required: ["label", "description"],
                },
              },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
];

async function callModal(path: string, body: unknown) {
  const r = await fetch(`${MODAL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { error: `worker ${path} -> HTTP ${r.status}: ${await r.text()}` };
  return r.json();
}

async function execTool(name: string, input: any): Promise<unknown> {
  switch (name) {
    case "quick_features":
      return callModal("/quick_features", input);
    case "analyze_structure":
      return callModal("/structure", input);
    case "separate_stems":
      return callModal("/separate", input);
    case "section_features":
      return callModal("/section_features", input);
    case "get_job":
      return callModal("/job", input);
    default:
      return { error: `unknown tool ${name}` };
  }
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return res.status(405).end();

    // ---- explicit config validation: fail with readable messages ----
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(500).json({ error: "Server misconfigured: ANTHROPIC_API_KEY is not set in Vercel environment variables (Settings → Environment Variables), or was added after the last deploy. Add it, then redeploy with `vercel --prod`." });
    if (!MODAL)
      return res.status(500).json({ error: "Server misconfigured: MODAL_BASE_URL is not set in Vercel environment variables." });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const messages = body?.messages as Anthropic.MessageParam[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "Bad request: missing messages array." });

    // track roster: injected fresh each request so the mentor always knows
    // what audio it can reach, without polluting the visible conversation
    const tracks = (body?.tracks || []) as { upload_id: string; filename: string }[];
    const trackContext =
      tracks.length > 0
        ? `\n\n## Uploaded tracks available right now\n${tracks
            .map((t) => `- "${t.filename}" → upload_id: ${t.upload_id}`)
            .join("\n")}\nRefer to tracks by filename when talking to the user; use upload_id when calling tools.`
        : "\n\n(No tracks uploaded yet — the user can drop audio files into the chat at any time.)";

    // optional DAW session metadata (track names, fader levels, pan, mutes)
    const meta = typeof body?.meta === "string" && body.meta.length < 20000 ? body.meta : "";
    const metaContext = meta
      ? `\n\n## DAW session metadata (exported from the user's project — fader/pan/mute state at export time)\n${meta}\nUse this to connect stems to the user's actual session: refer to tracks by their DAW names, and factor fader/mute state into loudness interpretation (a quiet stem may just have a low fader).`
      : "";

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ---- history repair: every assistant tool_use must be followed by a
    // matching tool_result in the next user message. If the client raced
    // (e.g. a background job notification interrupted a pending question),
    // synthesize a placeholder result so the API accepts the history.
    const history: Anthropic.MessageParam[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      history.push(m);
      if (m.role !== "assistant" || typeof m.content === "string") continue;
      const toolIds = m.content.filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
      if (toolIds.length === 0) continue;
      const next = messages[i + 1];
      const answered = new Set(
        next && next.role === "user" && Array.isArray(next.content)
          ? next.content.filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id)
          : []
      );
      const missing = toolIds.filter((id: string) => !answered.has(id));
      if (missing.length > 0) {
        const patch = missing.map((id: string) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content: "[No answer was provided — the conversation moved on. Re-ask later if this information is still needed.]",
        }));
        if (next && next.role === "user") {
          const rest = Array.isArray(next.content)
            ? next.content
            : [{ type: "text" as const, text: next.content }];
          messages[i + 1] = { role: "user", content: [...patch, ...rest] };
        } else {
          history.push({ role: "user", content: patch });
        }
      }
    }
    const newMessages: Anthropic.MessageParam[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT + trackContext + metaContext,
        tools,
        messages: history,
      });

      const assistantMsg: Anthropic.MessageParam = { role: "assistant", content: resp.content };
      history.push(assistantMsg);
      newMessages.push(assistantMsg);

      if (resp.stop_reason !== "tool_use") break;

      const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

      // ask_user suspends the loop: client renders cards, answers come back
      // as a tool_result in the next request.
      const ask = toolUses.find((t) => t.name === "ask_user");
      if (ask) {
        return res.json({ newMessages, askUser: { toolUseId: ask.id, ...(ask.input as object) } });
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const out = await execTool(tu.name, tu.input);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(out),
        });
      }
      const resultMsg: Anthropic.MessageParam = { role: "user", content: results };
      history.push(resultMsg);
      newMessages.push(resultMsg);
    }
    return res.json({ newMessages });
  } catch (e: any) {
    const detail = e?.error?.error?.message || e?.message || String(e);
    return res.status(500).json({ error: `Agent error: ${detail}` });
  }
}
