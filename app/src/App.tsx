import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChatTurn, type EpisodeDetail, type EpisodeListItem } from "./api";
import { beep } from "./audio";

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

const HOSTS = "Maya & Sam";

// Deterministic "cover art" gradient per episode so the library looks designed
// without real artwork.
function coverStyle(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 45) % 360;
  return { backgroundImage: `linear-gradient(135deg, hsl(${a} 68% 52%), hsl(${b} 72% 40%))` };
}

const SpeechRecognitionImpl =
  (window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown })
    .SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;

const micSupported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
const wakeSupported = micSupported && !!SpeechRecognitionImpl;

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
  const [showClaims, setShowClaims] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<{ start: () => void; stop: () => void } | null>(null);
  const interruptingRef = useRef(false);

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

  // Episode list + 5s poll (drives optimistic entries to ready/failed).
  useEffect(() => {
    void loadEpisodes();
    const t = setInterval(loadEpisodes, 5000);
    return () => clearInterval(t);
  }, [loadEpisodes]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
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

  return (
    <div className="app">
      <header>
        <h1>Learn</h1>
        <div className="submit">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Article URL, X link, or a topic…"
          />
          <button onClick={submit}>Make episode</button>
        </div>
      </header>

      <div className="body">
        <aside className="episodes">
          {episodes.length === 0 && <p className="muted">No episodes yet.</p>}
          {episodes.map((e) => (
            <button
              key={e.id}
              className={`episode ${e.id === selectedId ? "active" : ""}`}
              onClick={() => setSelectedId(e.id)}
            >
              <span className="cover sm" style={coverStyle(e.id)} aria-hidden="true">
                <span className="cover-glyph">♫</span>
              </span>
              <span className="ep-meta">
                <span className="etitle">{e.title || "Generating…"}</span>
                <span className="ep-sub">
                  <span className={`dot ${e.status}`} />
                  {e.status === "ready" && e.durationMs ? mmss(e.durationMs) : e.status}
                  {" · "}
                  {e.sourceKind}
                </span>
              </span>
            </button>
          ))}
        </aside>

        <main className="player">
          {!detail && <p className="muted">Select an episode.</p>}
          {detail && (
            <>
              <div className="nowplaying">
                <div className="cover lg" style={coverStyle(detail.id)} aria-hidden="true">
                  <span className="cover-glyph">♫</span>
                </div>
                <div className="np-info">
                  <span className="np-kind">{detail.sourceKind}</span>
                  <h2>{detail.title || "(untitled)"}</h2>
                  <span className="np-hosts">{HOSTS}</span>
                  {detail.status !== "ready" && (
                    <span className={`status-pill ${detail.status}`}>
                      {detail.status === "failed"
                        ? `failed${detail.error ? `: ${detail.error.message}` : ""}`
                        : `${detail.status}…`}
                    </span>
                  )}
                </div>
              </div>

              {ready && (
                <>
                  <audio
                    ref={audioRef}
                    src={api.audioUrl(detail.id)}
                    preload="metadata"
                    onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                  />
                  <div className="transport">
                    <button className="skip" onClick={() => seekBy(-15)} aria-label="Back 15 seconds">
                      ↺ 15
                    </button>
                    <button
                      className="playpause"
                      onClick={togglePlay}
                      aria-label={playing ? "Pause" : "Play"}
                    >
                      {playing ? "⏸" : "▶"}
                    </button>
                    <button className="skip" onClick={() => seekBy(30)} aria-label="Forward 30 seconds">
                      30 ↻
                    </button>
                    <span className="time">
                      {mmss(currentMs)} / {mmss(durationMs)}
                    </span>
                  </div>
                  <input
                    className="seekbar"
                    type="range"
                    min={0}
                    max={durationMs || 0}
                    step={1000}
                    value={Math.min(currentMs, durationMs || 0)}
                    onChange={(e) => seekToMs(Number(e.target.value))}
                    aria-label="Seek"
                    style={{
                      background: `linear-gradient(to right, var(--accent) ${
                        durationMs ? (Math.min(currentMs, durationMs) / durationMs) * 100 : 0
                      }%, var(--track) 0)`,
                    }}
                  />
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
                        {recording ? "● recording — release to ask" : "Hold to ask"}
                      </button>
                      {wakeSupported && (
                        <label className="wake">
                          <input type="checkbox" checked={wakeOn} onChange={(e) => setWakeOn(e.target.checked)} />
                          wake word “question”{listening ? " · listening" : ""}
                        </label>
                      )}
                    </div>
                  ) : (
                    <p className="muted">Voice needs the Tailscale HTTPS address.</p>
                  )}

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
                          <span className="who">{s.speaker === "HOST" ? "Maya" : "Sam"}</span>
                          <span className="seg-text">{s.text}</span>
                          <span className="ts">{mmss(s.startMs ?? 0)}</span>
                        </li>
                      );
                    })}
                  </ol>
                </>
              )}

              {detail.dossier && (
                <section className="sources">
                  <h3>Sources</h3>
                  <ul>
                    {detail.dossier.sources.map((s, i) => (
                      <li key={i}>
                        <a href={s.url} target="_blank" rel="noreferrer">
                          {s.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {detail.factcheck && detail.factcheck.claims.length > 0 && (
                <section className="factcheck">
                  <button className="link" onClick={() => setShowClaims((v) => !v)}>
                    {showClaims ? "▾" : "▸"} Fact-check ({detail.factcheck.claims.length} claims)
                  </button>
                  {showClaims && (
                    <table>
                      <tbody>
                        {detail.factcheck.claims.map((c, i) => (
                          <tr key={i}>
                            <td className={`verdict ${c.verdict}`}>{c.verdict}</td>
                            <td>{c.claim}</td>
                            <td className="muted">{c.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              )}
            </>
          )}
        </main>

        <aside className="chat">
          <h3>Ask</h3>
          <div className="turns">
            {chats.map((t, i) => (
              <div key={i} className={`turn ${t.role}`}>
                {t.text}
              </div>
            ))}
          </div>
          {ready && (
            <div className="asktext">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendQuestion()}
                placeholder="Type a question…"
                disabled={busy}
              />
              <button onClick={sendQuestion} disabled={busy}>
                {busy ? "…" : "Ask"}
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
