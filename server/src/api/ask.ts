import type { Message } from "ollama";
import type { Context } from "hono";
import type { Accessors } from "../db";
import type { Dossier } from "../fetchers/types";
import type { Script } from "../domain";
import { chatText } from "../llm";
import { ANSWER_RULES } from "../prompts";
import type { SpeechProvider } from "../speech";

// Zero-padded m:ss. 754000 -> "12:34"; hours roll into minutes ("75:10").
export function mmss(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Exact grounding template (§3.2): sources + dossier.markdown + FULL transcript
// with [m:ss] stamps + the verbatim answer rules.
export function groundingBlock(dossier: Dossier, script: Script): string {
  const sources = dossier.sources.map((s) => `- ${s.title}: ${s.url}`).join("\n");
  const transcript = script.segments
    .map((s) => `[${mmss(s.startMs ?? 0)}] ${s.speaker}: ${s.text}`)
    .join("\n");
  return (
    `## Sources\n${sources}\n\n` +
    `## Source dossier\n${dossier.markdown}\n\n` +
    `## Episode transcript\n${transcript}\n\n` +
    `## Answer rules\n${ANSWER_RULES}`
  );
}

// Last n chats oldest→newest as chat messages; drop a leading assistant turn so
// history always starts with a user turn.
export function lastNChatTurns(accessors: Accessors, episodeId: string, n: number): Message[] {
  const rows = accessors.listChats(episodeId).slice(-n);
  if (rows.length && rows[0]!.role === "assistant") rows.shift();
  return rows.map((r) => ({ role: r.role, content: r.text }));
}

export interface AskDeps {
  accessors: Accessors;
  speech: SpeechProvider;
  now: () => number;
}

export function createAsk(deps: AskDeps) {
  // Shared answer path for both endpoints. Persists both chat turns.
  async function answer(episodeId: string, question: string, positionMs: number): Promise<string> {
    const ep = deps.accessors.getEpisode(episodeId);
    if (!ep || !ep.dossier_json || !ep.script_json) {
      throw new Error(`episode ${episodeId} not ready for questions`);
    }
    const dossier = JSON.parse(ep.dossier_json) as Dossier;
    const script = JSON.parse(ep.script_json) as Script;

    const system =
      groundingBlock(dossier, script) +
      `\n\n(The listener has heard up to ${mmss(positionMs)}. Do not spoil later parts unless asked.)`;

    const messages: Message[] = [
      { role: "system", content: system },
      ...lastNChatTurns(deps.accessors, episodeId, 6),
      { role: "user", content: question },
    ];
    const answerText = await chatText(messages);

    deps.accessors.insertChat(episodeId, "user", question, positionMs, deps.now());
    deps.accessors.insertChat(episodeId, "assistant", answerText, null, deps.now());
    return answerText;
  }

  function ready(id: string): boolean {
    const ep = deps.accessors.getEpisode(id);
    return !!ep && !!ep.dossier_json && !!ep.script_json;
  }

  async function handleAskText(c: Context): Promise<Response> {
    const id = c.req.param("id")!;
    if (!ready(id)) return c.json({ error: "episode not found or not ready" }, 404);
    const body = (await c.req.json()) as { question?: string; positionMs?: number };
    if (!body.question) return c.json({ error: "question required" }, 400);
    const answerText = await answer(id, body.question, body.positionMs ?? 0);
    return c.json({ answerText });
  }

  async function handleAsk(c: Context): Promise<Response> {
    const id = c.req.param("id")!;
    if (!ready(id)) return c.json({ error: "episode not found or not ready" }, 404);
    const form = await c.req.formData();
    const audio = form.get("audio");
    const positionMs = Number(form.get("positionMs") ?? 0);
    if (!(audio instanceof Blob)) return c.json({ error: "audio required" }, 400);

    const question = await deps.speech.transcribe(audio);
    const answerText = await answer(id, question, positionMs);
    const stream = await deps.speech.synthesizeAnswer(answerText);

    // Pipe the answer audio straight through; text rides in a header (base64,
    // because header values can't hold arbitrary text).
    return new Response(stream, {
      headers: {
        "Content-Type": "audio/wav",
        "X-Answer-Text": Buffer.from(answerText).toString("base64"),
      },
    });
  }

  return { answer, handleAskText, handleAsk };
}
