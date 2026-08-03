// Thin typed client for the learn API. No key ever lives here — all external
// calls are server-side.

export type Status =
  | "submitted"
  | "sourced"
  | "scripted"
  | "verified"
  | "synthesizing"
  | "ready"
  | "failed";

export type SourceKind = "article" | "tweet" | "youtube" | "topic" | "research";

export interface EpisodeListItem {
  id: string;
  title: string;
  status: Status;
  sourceKind: SourceKind;
  durationMs: number | null;
  /** epoch ms when marked listened; null = not listened yet. Server-side, so it follows you across devices. */
  listenedAt: number | null;
  /** Saved playback position in ms; 0 = start. Server-side, like listenedAt. */
  positionMs: number;
  /** What a long-running stage is doing right now (deep research); null when idle. */
  note: string | null;
  createdAt: number;
}

export interface Segment {
  idx: number;
  speaker: "HOST" | "EXPERT" | "CRITIC";
  text: string;
  startMs?: number;
}

export interface Claim {
  segmentIdx: number;
  claim: string;
  verdict: "supported" | "unsupported" | "distorted";
  note: string;
  sourceUrl?: string;
}

export interface EpisodeDetail {
  id: string;
  title: string;
  status: Status;
  source: { kind: string; url?: string; topic?: string; brief?: string; seedUrls?: string[] };
  sourceKind: SourceKind;
  dossier: { sources: { title: string; url: string }[] } | null;
  script: { segments: Segment[] } | null;
  factcheck: { claims: Claim[] } | null;
  durationMs: number | null;
  listenedAt: number | null;
  positionMs: number;
  note: string | null;
  error: { stage: string; message: string } | null;
  createdAt: number;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  positionMs: number | null;
  createdAt: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  listEpisodes: () => fetch("/api/episodes").then(json<EpisodeListItem[]>),
  getEpisode: (id: string) => fetch(`/api/episodes/${id}`).then(json<EpisodeDetail>),
  getChats: (id: string) => fetch(`/api/episodes/${id}/chats`).then(json<ChatTurn[]>),
  // Deep research: a written assignment. Links inside it seed the research.
  createResearch: (brief: string) =>
    fetch("/api/episodes/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief }),
    }).then(json<{ id: string; status: Status; source: { kind: string; seedUrls: string[] } }>),
  createEpisode: (input: string) =>
    fetch("/api/episodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    }).then(json<{ id: string; status: Status; source: { kind: string } }>),
  setListened: (id: string, listened: boolean) =>
    fetch(`/api/episodes/${id}/listened`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listened }),
    }).then(json<{ id: string; listenedAt: number | null }>),
  // keepalive lets the last report survive the page unloading (pagehide), which
  // is exactly when the position matters most.
  setPosition: (id: string, positionMs: number, keepalive = false) =>
    fetch(`/api/episodes/${id}/position`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionMs }),
      keepalive,
    }).then(json<{ id: string; positionMs: number }>),
  askText: (id: string, question: string, positionMs: number) =>
    fetch(`/api/episodes/${id}/ask-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, positionMs }),
    }).then(json<{ answerText: string }>),
  // Voice ask: returns the answer audio blob + decoded answer text (from the
  // X-Answer-Text header). The audio stream is piped straight through by learn.
  askAudio: async (id: string, audio: Blob, positionMs: number) => {
    const form = new FormData();
    form.append("audio", audio, "question.webm");
    form.append("positionMs", String(positionMs));
    const res = await fetch(`/api/episodes/${id}/ask`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const b64 = res.headers.get("X-Answer-Text") ?? "";
    const answerText = b64 ? new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))) : "";
    return { answerText, audio: await res.blob() };
  },
  audioUrl: (id: string) => `/api/episodes/${id}/audio`,
};
