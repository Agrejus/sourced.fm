import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatTurn, type EpisodeDetail, type EpisodeListItem } from "./api";
import { beep } from "./audio";
import { loadPlaylists, newId, savePlaylists, type Playlist } from "./playlists";

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

const HOSTS = "Maya & Sam";

// Deterministic per-episode hue so every episode gets its own color world —
// artwork gradient in the library, and the ambient wash + accent on the player.
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}
function coverStyle(seed: string) {
  const a = hueOf(seed);
  const b = (a + 40) % 360;
  return { backgroundImage: `linear-gradient(140deg, hsl(${a} 74% 56%), hsl(${b} 70% 42%))` };
}
const KIND_GLYPH: Record<string, string> = { article: "¶", tweet: "𝕏", topic: "✦" };

const SpeechRecognitionImpl =
  (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
    .SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;

const micSupported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
const wakeSupported = micSupported && !!SpeechRecognitionImpl;

type Tab = "transcript" | "sources" | "facts";

export default function App() {
  const [episodes, setEpisodes] = useState<EpisodeListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [chats, setChats] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [question, setQuestion] = useState("");
  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [wakeOn, setWakeOn] = useState(false); // opt-in: keeps the mic closed during normal playback
  const [listening, setListening] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");
  const [view, setView] = useState<"home" | "episodes" | "playlists">("home");
  const [filter, setFilter] = useState<"all" | "unlistened" | "listened">("all");

  // Playlists (on-device). openPlaylistId drives the playlist-detail screen;
  // queue is the running listen order that auto-advances when an episode ends.
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadPlaylists());
  const [openPlaylistId, setOpenPlaylistId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [queue, setQueue] = useState<string[] | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<{ start: () => void; stop: () => void } | null>(null);
  const interruptingRef = useRef(false);
  const autoplayRef = useRef(false); // request autoplay after the next detail loads

  useEffect(() => savePlaylists(playlists), [playlists]);

  const loadEpisodes = useCallback(async () => {
    try {
      setEpisodes(await api.listEpisodes());
    } catch {
      /* transient */
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const [d, c] = await Promise.all([api.getEpisode(id), api.getChats(id)]);
    setDetail(d);
    setChats(c);
  }, []);

  // Listened state lives on the server (unlike playlists), so the same episode
  // reads as listened on every device. Flip locally first, then reconcile.
  const markListened = useCallback(
    async (id: string, listened: boolean) => {
      const at = listened ? Date.now() : null;
      setEpisodes((es) => es.map((e) => (e.id === id ? { ...e, listenedAt: at } : e)));
      setDetail((d) => (d && d.id === id ? { ...d, listenedAt: at } : d));
      try {
        await api.setListened(id, listened);
      } catch {
        /* the refresh below restores whatever the server actually has */
      }
      void loadEpisodes();
    },
    [loadEpisodes],
  );

  // Episode list + 5s poll (drives optimistic entries to ready/failed).
  useEffect(() => {
    void loadEpisodes();
    const t = setInterval(loadEpisodes, 5000);
    return () => clearInterval(t);
  }, [loadEpisodes]);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
    // Keep refreshing while the open episode is still generating so the player
    // rolls from "generating…" to the ready transport without a manual reload.
    const t = setInterval(() => {
      setDetail((d) => {
        if (d && d.status !== "ready" && d.status !== "failed") void loadDetail(selectedId);
        return d;
      });
    }, 5000);
    return () => clearInterval(t);
  }, [selectedId, loadDetail]);

  const ready = detail?.status === "ready" && detail.script;

  // Media Session — lock-screen controls.
  useEffect(() => {
    if (!ready || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: detail!.title, artist: "Learn" });
    const audio = audioRef.current!;
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => (audio.currentTime -= 15));
    navigator.mediaSession.setActionHandler("seekforward", () => (audio.currentTime += 30));
  }, [ready, detail]);

  // When we advance through a queue, autoplay the episode once it's loaded.
  useEffect(() => {
    if (ready && autoplayRef.current) {
      autoplayRef.current = false;
      void audioRef.current?.play();
    }
  }, [ready]);

  async function submit() {
    const value = input.trim();
    if (!value) return;
    setInput("");
    try {
      const created = await api.createEpisode(value);
      await loadEpisodes();
      setSelectedId(created.id);
    } catch (e) {
      alert(`Submit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function sendQuestion() {
    if (!detail || !question.trim() || busy) return;
    const q = question.trim();
    setQuestion("");
    setBusy(true);
    try {
      await api.askText(detail.id, q, currentMs);
      setChats(await api.getChats(detail.id));
    } finally {
      setBusy(false);
    }
  }

  // Hold-to-talk / wake-word interrupt (§4.2 frozen flow).
  const startRecording = useCallback(async () => {
    if (!detail || busy || interruptingRef.current) return;
    interruptingRef.current = true;
    const audio = audioRef.current!;
    const positionMs = audio.currentTime * 1000;
    audio.pause();
    disarmWake();
    beep();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    } catch {
      interruptingRef.current = false;
      return;
    }
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      setBusy(true);
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const { audio: answerBlob } = await api.askAudio(detail.id, blob, positionMs);
        setChats(await api.getChats(detail.id));
        const answer = new Audio(URL.createObjectURL(answerBlob));
        answer.onended = () => {
          audio.currentTime = positionMs / 1000;
          void audio.play();
          rearmWake();
        };
        await answer.play();
      } finally {
        setBusy(false);
        interruptingRef.current = false;
      }
    };
    recorderRef.current = rec;
    setRecording(true);
    rec.start();
    setTimeout(() => rec.state !== "inactive" && rec.stop(), 15000); // hard cap
  }, [detail, busy]);

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  // Wake word: while playing + visible + toggle on, listen for the standalone
  // word "question". Restart on iOS's ~60s auto-stop. Disarm during interrupts.
  const disarmWake = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const rearmWake = useCallback(() => {
    if (!wakeSupported || !wakeOn) return;
    const audio = audioRef.current;
    if (!audio || audio.paused || document.visibilityState !== "visible") return;
    if (recognitionRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = new (SpeechRecognitionImpl as any)();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i]![0]!.transcript;
        if (/\bquestion\b/i.test(transcript)) {
          void startRecording();
          return;
        }
      }
    };
    rec.onend = () => {
      // iOS auto-stops ~60s; re-arm if still eligible.
      if (recognitionRef.current === recWrapped) {
        recognitionRef.current = null;
        rearmWake();
      }
    };
    const recWrapped = { start: () => rec.start(), stop: () => rec.stop() };
    recognitionRef.current = recWrapped;
    try {
      rec.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
    }
  }, [wakeOn, startRecording]);

  // Arm/disarm as playback + visibility + toggle change.
  useEffect(() => {
    if (!wakeSupported) return;
    const audio = audioRef.current;
    if (!audio) return;
    const update = () => {
      if (wakeOn && !audio.paused && document.visibilityState === "visible" && !interruptingRef.current) {
        rearmWake();
      } else {
        disarmWake();
      }
    };
    audio.addEventListener("play", update);
    audio.addEventListener("pause", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      audio.removeEventListener("play", update);
      audio.removeEventListener("pause", update);
      document.removeEventListener("visibilitychange", update);
      disarmWake();
    };
  }, [ready, wakeOn, rearmWake, disarmWake]);

  const durationMs = detail?.durationMs ?? 0;
  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  }
  function seekBy(seconds: number) {
    const a = audioRef.current;
    if (a) a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + seconds));
  }
  function seekToMs(ms: number) {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = ms / 1000;
    setCurrentMs(ms);
  }
  function goBack() {
    audioRef.current?.pause();
    setPlaying(false);
    setCurrentMs(0);
    setDetail(null);
    setChats([]);
    setSelectedId(null);
    setTab("transcript");
  }

  // ---- playlist mutations ----
  function createPlaylist() {
    const name = newName.trim();
    if (!name) return;
    const pl: Playlist = { id: newId(), name, episodeIds: [] };
    setPlaylists((ps) => [...ps, pl]);
    setNewName("");
    setOpenPlaylistId(pl.id);
  }
  function deletePlaylist(id: string) {
    setPlaylists((ps) => ps.filter((p) => p.id !== id));
    setOpenPlaylistId(null);
  }
  function toggleInPlaylist(id: string, episodeId: string) {
    setPlaylists((ps) =>
      ps.map((p) =>
        p.id !== id
          ? p
          : {
              ...p,
              episodeIds: p.episodeIds.includes(episodeId)
                ? p.episodeIds.filter((e) => e !== episodeId)
                : [...p.episodeIds, episodeId],
            },
      ),
    );
  }
  function moveInPlaylist(id: string, index: number, dir: -1 | 1) {
    setPlaylists((ps) =>
      ps.map((p) => {
        if (p.id !== id) return p;
        const to = index + dir;
        if (to < 0 || to >= p.episodeIds.length) return p;
        const ids = [...p.episodeIds];
        [ids[index], ids[to]] = [ids[to]!, ids[index]!];
        return { ...p, episodeIds: ids };
      }),
    );
  }
  // Start a playlist: play from `startId` (or the first ready item) and set the
  // running queue so playback auto-advances through the remaining episodes.
  function playPlaylist(pl: Playlist, startId?: string) {
    const playable = pl.episodeIds.filter((id) => {
      const e = episodes.find((x) => x.id === id);
      return e && e.status === "ready";
    });
    if (playable.length === 0) return;
    const first = startId && playable.includes(startId) ? startId : playable[0]!;
    setQueue(playable);
    autoplayRef.current = true;
    setSelectedId(first);
  }
  // Called when the current episode finishes — mark it listened, then advance
  // to the next queued item.
  function handleEnded() {
    setPlaying(false);
    if (selectedId) void markListened(selectedId, true);
    if (!queue || !selectedId) return;
    const i = queue.indexOf(selectedId);
    const next = i >= 0 ? queue[i + 1] : undefined;
    if (next) {
      autoplayRef.current = true;
      setCurrentMs(0);
      setSelectedId(next);
    }
  }

  // Which tabs have content to show on the player.
  const tabs = useMemo(() => {
    const t: Tab[] = [];
    if (detail?.script?.segments.length) t.push("transcript");
    if (detail?.dossier?.sources.length) t.push("sources");
    if (detail?.factcheck?.claims.length) t.push("facts");
    return t;
  }, [detail]);
  const activeTab: Tab | null = tabs.includes(tab) ? tab : (tabs[0] ?? null);

  // ================= HOME / EPISODES (with bottom nav) =================
  if (selectedId === null) {
    const sorted = [...episodes].sort((a, b) => b.createdAt - a.createdAt);
    const generating = episodes.filter((e) => e.status !== "ready" && e.status !== "failed").length;
    const unlistened = sorted.filter((e) => e.listenedAt === null);
    const filtered =
      filter === "unlistened"
        ? unlistened
        : filter === "listened"
          ? sorted.filter((e) => e.listenedAt !== null)
          : sorted;
    // "Jump back in" surfaces what you still have to listen to; once everything
    // is listened it falls back to the most recent episodes.
    const jumpBackIn = (unlistened.length > 0 ? unlistened : sorted).slice(0, 3);

    const card = (e: EpisodeListItem) => {
      const busyState = e.status !== "ready" && e.status !== "failed";
      const listened = e.listenedAt !== null;
      return (
        <li key={e.id} className={`card-row${listened ? " is-listened" : ""}`}>
          <button className="card" onClick={() => setSelectedId(e.id)}>
            <span className="card-art" style={coverStyle(e.id)} aria-hidden="true">
              <span className="card-glyph">{KIND_GLYPH[e.sourceKind] ?? "♫"}</span>
              {e.status === "ready" && <span className="card-play">▶</span>}
            </span>
            <span className="card-body">
              <span className="card-title">{e.title || "Generating…"}</span>
              <span className="card-meta">
                <span className={`chip ${e.status}`}>
                  {busyState && <span className="spinner" aria-hidden="true" />}
                  {e.status === "ready"
                    ? e.durationMs
                      ? mmss(e.durationMs)
                      : "ready"
                    : e.status === "failed"
                      ? "failed"
                      : e.status}
                </span>
                <span className="kind-tag">{e.sourceKind}</span>
                {listened && <span className="chip listened">✓ Listened</span>}
              </span>
            </span>
          </button>
          <button
            className={`listen-toggle${listened ? " on" : ""}`}
            onClick={() => void markListened(e.id, !listened)}
            aria-pressed={listened}
            title={listened ? "Mark as unlistened" : "Mark as listened"}
            aria-label={listened ? "Mark as unlistened" : "Mark as listened"}
          >
            ✓
          </button>
        </li>
      );
    };

    return (
      <div className="shell">
        {view === "home" && (
          <div className="page">
            <div className="hero">
              <span className="hero-eyebrow" aria-hidden="true">
                ◉ Learn
              </span>
              <h1 className="hero-title">Turn anything into a podcast you can actually listen to.</h1>
              <p className="hero-sub">
                Drop in an article, an X post, or just a topic. Maya &amp; Sam host a tight two-voice
                episode — fact-checked, with sources — and you can jump in to ask questions while it plays.
              </p>
              <div className="composer big">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="Paste a link or type a topic…"
                />
                <button className="btn-primary" onClick={submit} disabled={!input.trim()}>
                  Create
                </button>
              </div>
              {generating > 0 && (
                <p className="hero-status">
                  <span className="spinner" aria-hidden="true" /> {generating} episode
                  {generating > 1 ? "s" : ""} generating…
                </p>
              )}
            </div>

            {sorted.length > 0 && (
              <section className="home-section">
                <div className="section-head">
                  <h2>{unlistened.length > 0 ? "Up next" : "Jump back in"}</h2>
                  <button className="see-all" onClick={() => setView("episodes")}>
                    All episodes →
                  </button>
                </div>
                <ul className="cards">{jumpBackIn.map(card)}</ul>
              </section>
            )}
          </div>
        )}
        {view === "episodes" && (
          <div className="page">
            <div className="page-head">
              <h1>Episodes</h1>
              <span className="count">{episodes.length}</span>
              {unlistened.length > 0 && (
                <span className="count unlistened">{unlistened.length} to listen</span>
              )}
            </div>
            {episodes.length > 0 && (
              <div className="filters" role="tablist">
                {(["all", "unlistened", "listened"] as const).map((f) => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={filter === f}
                    className={`filter ${filter === f ? "on" : ""}`}
                    onClick={() => setFilter(f)}
                  >
                    {f === "all" ? "All" : f === "unlistened" ? "Unlistened" : "Listened"}
                  </button>
                ))}
              </div>
            )}
            {episodes.length === 0 ? (
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">
                  ♫
                </div>
                <p>No episodes yet.</p>
                <p className="muted">Head to Home and paste a link or topic to make your first one.</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">
                  ✓
                </div>
                <p>{filter === "unlistened" ? "All caught up." : "Nothing listened to yet."}</p>
                <p className="muted">
                  {filter === "unlistened"
                    ? "Every episode is marked listened."
                    : "Episodes you finish — or mark with ✓ — show up here."}
                </p>
              </div>
            ) : (
              <ul className="cards">{filtered.map(card)}</ul>
            )}
          </div>
        )}
        {view === "playlists" && (
          <div className="page">
            {(() => {
              const open = playlists.find((p) => p.id === openPlaylistId) ?? null;
              if (!open) {
                return (
                  <>
                    <div className="page-head">
                      <h1>Playlists</h1>
                      <span className="count">{playlists.length}</span>
                    </div>
                    <div className="composer">
                      <input
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && createPlaylist()}
                        placeholder="New playlist name…"
                      />
                      <button className="btn-primary" onClick={createPlaylist} disabled={!newName.trim()}>
                        Add
                      </button>
                    </div>
                    {playlists.length === 0 ? (
                      <div className="empty">
                        <div className="empty-glyph" aria-hidden="true">
                          ☰
                        </div>
                        <p>No playlists yet.</p>
                        <p className="muted">
                          Make one above, then add episodes to build a queue that plays through on its own.
                        </p>
                      </div>
                    ) : (
                      <ul className="cards">
                        {playlists.map((p) => {
                          const items = p.episodeIds
                            .map((id) => episodes.find((e) => e.id === id))
                            .filter((e): e is EpisodeListItem => !!e);
                          const ready = items.filter((e) => e.status === "ready").length;
                          const left = items.filter((e) => e.listenedAt === null).length;
                          return (
                            <li key={p.id}>
                              <button className="card" onClick={() => setOpenPlaylistId(p.id)}>
                                <span className="card-art pl-art" aria-hidden="true">
                                  <span className="card-glyph">☰</span>
                                </span>
                                <span className="card-body">
                                  <span className="card-title">{p.name}</span>
                                  <span className="card-meta">
                                    <span className="kind-tag">
                                      {p.episodeIds.length} episode{p.episodeIds.length === 1 ? "" : "s"}
                                      {ready < p.episodeIds.length ? ` · ${ready} ready` : ""}
                                      {items.length > 0
                                        ? left === 0
                                          ? " · ✓ all listened"
                                          : ` · ${left} to listen`
                                        : ""}
                                    </span>
                                  </span>
                                </span>
                                <span className="ep-chevron" aria-hidden="true">
                                  ›
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                );
              }

              // ---- playlist detail ----
              const inList = open.episodeIds
                .map((id) => episodes.find((e) => e.id === id))
                .filter((e): e is EpisodeListItem => !!e);
              const readyCount = inList.filter((e) => e.status === "ready").length;
              const addable = [...episodes]
                .sort((a, b) => b.createdAt - a.createdAt)
                .filter((e) => !open.episodeIds.includes(e.id));
              return (
                <>
                  <div className="detail-top">
                    <button className="pill-btn" onClick={() => setOpenPlaylistId(null)}>
                      ‹ Playlists
                    </button>
                    <button className="link danger" onClick={() => deletePlaylist(open.id)}>
                      Delete
                    </button>
                  </div>
                  <div className="page-head">
                    <h1>{open.name}</h1>
                  </div>
                  <button
                    className="btn-primary play-all"
                    onClick={() => playPlaylist(open)}
                    disabled={readyCount === 0}
                  >
                    ▶ Play all{readyCount > 0 ? ` (${readyCount})` : ""}
                  </button>

                  {inList.length === 0 ? (
                    <p className="muted pl-hint">Empty — add episodes below.</p>
                  ) : (
                    <ol className="pl-items">
                      {inList.map((e, i) => (
                        <li key={e.id} className={`pl-item${e.listenedAt !== null ? " is-listened" : ""}`}>
                          <span className="pl-index">{i + 1}</span>
                          <button
                            className="pl-main"
                            onClick={() => e.status === "ready" && playPlaylist(open, e.id)}
                            disabled={e.status !== "ready"}
                          >
                            <span className="pl-title">{e.title || "Generating…"}</span>
                            <span className="pl-sub">
                              {e.status === "ready"
                                ? e.durationMs
                                  ? mmss(e.durationMs)
                                  : "ready"
                                : e.status}{" "}
                              · {e.sourceKind}
                              {e.listenedAt !== null ? " · ✓ listened" : ""}
                            </span>
                          </button>
                          <span className="pl-ctrls">
                            <button
                              aria-label={
                                e.listenedAt !== null ? "Mark as unlistened" : "Mark as listened"
                              }
                              aria-pressed={e.listenedAt !== null}
                              className={`pl-listen${e.listenedAt !== null ? " on" : ""}`}
                              onClick={() => void markListened(e.id, e.listenedAt === null)}
                            >
                              ✓
                            </button>
                            <button
                              aria-label="Move up"
                              onClick={() => moveInPlaylist(open.id, i, -1)}
                              disabled={i === 0}
                            >
                              ▲
                            </button>
                            <button
                              aria-label="Move down"
                              onClick={() => moveInPlaylist(open.id, i, 1)}
                              disabled={i === inList.length - 1}
                            >
                              ▼
                            </button>
                            <button
                              aria-label="Remove"
                              className="pl-remove"
                              onClick={() => toggleInPlaylist(open.id, e.id)}
                            >
                              ✕
                            </button>
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}

                  {addable.length > 0 && (
                    <section className="home-section">
                      <div className="section-head">
                        <h2>Add episodes</h2>
                      </div>
                      <ul className="add-list">
                        {addable.map((e) => (
                          <li key={e.id}>
                            <button className="add-row" onClick={() => toggleInPlaylist(open.id, e.id)}>
                              <span className="add-plus" aria-hidden="true">
                                ＋
                              </span>
                              <span className="add-title">{e.title || "Generating…"}</span>
                              <span className="kind-tag">{e.sourceKind}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              );
            })()}
          </div>
        )}

        <nav className="tabbar">
          <button
            className={`tab-item ${view === "home" ? "on" : ""}`}
            onClick={() => setView("home")}
            aria-current={view === "home"}
          >
            <span className="ti-glyph" aria-hidden="true">
              ⌂
            </span>
            Home
          </button>
          <button
            className={`tab-item ${view === "episodes" ? "on" : ""}`}
            onClick={() => setView("episodes")}
            aria-current={view === "episodes"}
          >
            <span className="ti-glyph" aria-hidden="true">
              ♫
            </span>
            Episodes
          </button>
          <button
            className={`tab-item ${view === "playlists" ? "on" : ""}`}
            onClick={() => {
              setOpenPlaylistId(null);
              setView("playlists");
            }}
            aria-current={view === "playlists"}
          >
            <span className="ti-glyph" aria-hidden="true">
              ☰
            </span>
            Playlists
          </button>
        </nav>
      </div>
    );
  }

  // ================= NOW PLAYING =================
  const remainingMs = Math.max(0, durationMs - currentMs);
  const progress = durationMs ? (Math.min(currentMs, durationMs) / durationMs) * 100 : 0;
  const hue = detail ? hueOf(detail.id) : 260;

  return (
    <div className="now" style={{ ["--h" as string]: String(hue) } as React.CSSProperties}>
      <div className="ambient" aria-hidden="true" />
      <div className="now-inner">
        <div className="now-top">
          <button className="pill-btn back" onClick={goBack} aria-label="Back to episodes">
            <span className="chev-down" aria-hidden="true">
              ⌄
            </span>
            Episodes
          </button>
          {queue && selectedId && queue.indexOf(selectedId) >= 0 ? (
            <span className="now-kind">
              Playlist · {queue.indexOf(selectedId) + 1}/{queue.length}
            </span>
          ) : (
            detail && <span className="now-kind">{detail.sourceKind}</span>
          )}
        </div>

        {!detail && <p className="loading muted">Loading…</p>}

        {detail && (
          <>
            <div className="stage">
              <div className="art" style={coverStyle(detail.id)}>
                <span className="art-glyph" aria-hidden="true">
                  {KIND_GLYPH[detail.sourceKind] ?? "♫"}
                </span>
              </div>
              <h1 className="now-title">{detail.title || "(untitled)"}</h1>
              <p className="now-hosts">{HOSTS}</p>
              {detail.status !== "ready" && (
                <span className={`state ${detail.status}`}>
                  {detail.status === "failed" ? (
                    `Failed${detail.error ? ` · ${detail.error.message}` : ""}`
                  ) : (
                    <>
                      <span className="spinner light" aria-hidden="true" />
                      {detail.status}…
                    </>
                  )}
                </span>
              )}
            </div>

            {ready && (
              <div className="controls">
                <audio
                  ref={audioRef}
                  src={api.audioUrl(detail.id)}
                  preload="metadata"
                  onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={handleEnded}
                />
                <input
                  className="scrub"
                  type="range"
                  min={0}
                  max={durationMs || 0}
                  step={1000}
                  value={Math.min(currentMs, durationMs || 0)}
                  onChange={(e) => seekToMs(Number(e.target.value))}
                  aria-label="Seek"
                  style={{
                    background: `linear-gradient(to right, hsl(var(--h) 90% 62%) ${progress}%, rgba(255,255,255,0.14) ${progress}%)`,
                  }}
                />
                <div className="times">
                  <span>{mmss(currentMs)}</span>
                  <span>-{mmss(remainingMs)}</span>
                </div>
                <div className="transport">
                  <button className="tp-skip" onClick={() => seekBy(-15)} aria-label="Back 15 seconds">
                    <span className="tp-num">15</span>↺
                  </button>
                  <button
                    className="tp-play"
                    onClick={togglePlay}
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {playing ? "❚❚" : "▶"}
                  </button>
                  <button className="tp-skip" onClick={() => seekBy(30)} aria-label="Forward 30 seconds">
                    <span className="tp-num">30</span>↻
                  </button>
                </div>

                <button
                  className={`mark-listened${detail.listenedAt !== null ? " on" : ""}`}
                  onClick={() => void markListened(detail.id, detail.listenedAt === null)}
                  aria-pressed={detail.listenedAt !== null}
                >
                  {detail.listenedAt !== null ? "✓ Listened — undo" : "Mark as listened"}
                </button>

                {micSupported ? (
                  <div className="voice">
                    <button
                      className={`talk ${recording ? "rec" : ""}`}
                      onMouseDown={startRecording}
                      onMouseUp={stopRecording}
                      onTouchStart={(e) => {
                        e.preventDefault();
                        void startRecording();
                      }}
                      onTouchEnd={stopRecording}
                      disabled={busy}
                    >
                      {recording ? "● Recording — release to ask" : "🎙 Hold to ask"}
                    </button>
                    {wakeSupported && (
                      <label className="wake">
                        <input
                          type="checkbox"
                          checked={wakeOn}
                          onChange={(e) => setWakeOn(e.target.checked)}
                        />
                        <span className="wake-track" aria-hidden="true">
                          <span className="wake-knob" />
                        </span>
                        wake word “question”{listening ? " · listening" : ""}
                      </label>
                    )}
                  </div>
                ) : (
                  <p className="muted voice-note">Voice needs the Tailscale HTTPS address.</p>
                )}
              </div>
            )}

            {activeTab && (
              <div className="panel">
                {tabs.length > 1 && (
                  <div className="tabs" role="tablist">
                    {tabs.map((t) => (
                      <button
                        key={t}
                        role="tab"
                        aria-selected={activeTab === t}
                        className={`tab ${activeTab === t ? "on" : ""}`}
                        onClick={() => setTab(t)}
                      >
                        {t === "transcript" ? "Transcript" : t === "sources" ? "Sources" : "Fact-check"}
                      </button>
                    ))}
                  </div>
                )}

                {activeTab === "transcript" && (
                  <ol className="transcript">
                    {detail.script!.segments.map((s) => {
                      const next = detail.script!.segments[s.idx + 1];
                      const active =
                        currentMs >= (s.startMs ?? 0) && (!next || currentMs < (next.startMs ?? Infinity));
                      return (
                        <li
                          key={s.idx}
                          className={`seg ${s.speaker.toLowerCase()}${active ? " active" : ""}`}
                          onClick={() => seekToMs(s.startMs ?? 0)}
                        >
                          <span className="seg-who">{s.speaker === "HOST" ? "Maya" : "Sam"}</span>
                          <span className="seg-text">{s.text}</span>
                          <span className="seg-ts">{mmss(s.startMs ?? 0)}</span>
                        </li>
                      );
                    })}
                  </ol>
                )}

                {activeTab === "sources" && (
                  <ul className="sources">
                    {detail.dossier!.sources.map((s, i) => (
                      <li key={i}>
                        <a href={s.url} target="_blank" rel="noreferrer">
                          <span className="src-num">{i + 1}</span>
                          <span className="src-title">{s.title}</span>
                          <span className="src-go" aria-hidden="true">
                            ↗
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}

                {activeTab === "facts" && (
                  <ul className="facts">
                    {detail.factcheck!.claims.map((c, i) => (
                      <li key={i} className="fact">
                        <span className={`verdict ${c.verdict}`}>{c.verdict}</span>
                        <span className="fact-claim">{c.claim}</span>
                        {c.note && <span className="fact-note">{c.note}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {ready && (
              <div className="ask">
                <h3>Ask about this episode</h3>
                {chats.length > 0 && (
                  <div className="turns">
                    {chats.map((t, i) => (
                      <div key={i} className={`turn ${t.role}`}>
                        {t.text}
                      </div>
                    ))}
                  </div>
                )}
                <div className="ask-bar">
                  <input
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
                    placeholder="Type a question…"
                    disabled={busy}
                  />
                  <button className="btn-primary" onClick={sendQuestion} disabled={busy || !question.trim()}>
                    {busy ? "…" : "Ask"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
