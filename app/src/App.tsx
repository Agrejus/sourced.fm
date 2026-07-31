import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ChatTurn, type EpisodeDetail, type EpisodeListItem } from "./api";
import { beep, primeAudio } from "./audio";
import { loadPlaylists, newId, savePlaylists, type Playlist } from "./playlists";

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

const HOSTS = "Maya & Sam";

// Resume rules. A position inside the first 15s is not worth restoring, and one
// within 15s of the end means the episode is effectively done — both start over.
const RESUME_MIN_MS = 15_000;
const NEAR_END_MS = 15_000;
const REPORT_EVERY_MS = 10_000;

type Progress = "unlistened" | "progress" | "listened";

// Single source of truth for the three library states, used by the filters, the
// cards, and the home screen. Works for list items and the episode detail alike.
function progressOf(e: {
  listenedAt: number | null;
  positionMs: number;
  durationMs: number | null;
}): Progress {
  if (e.listenedAt !== null) return "listened";
  const duration = e.durationMs ?? 0;
  const nearEnd = duration > 0 && e.positionMs >= duration - NEAR_END_MS;
  return e.positionMs >= RESUME_MIN_MS && !nearEnd ? "progress" : "unlistened";
}

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
const KIND_GLYPH: Record<string, string> = { article: "¶", tweet: "𝕏", topic: "✦", research: "⌕" };

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
  // What the interrupt is doing right now, so the screen can say so. Also the
  // single guard against overlapping interrupts: only "idle" may start one.
  const [voiceState, setVoiceState] = useState<"idle" | "listening" | "thinking" | "answering">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  // Set when the browser refuses to autoplay the answer; the user taps to hear it.
  const [answerToTap, setAnswerToTap] = useState(false);
  const [wakeOn, setWakeOn] = useState(false); // opt-in: keeps the mic closed during normal playback
  const [listening, setListening] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");
  const [view, setView] = useState<"home" | "episodes" | "create" | "playlists">("home");
  const [mode, setMode] = useState<"link" | "deep">("link");
  const [brief, setBrief] = useState("");
  const [researchSent, setResearchSent] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState<string | null>(null);

  // Multi-select on the Episodes screen, for building a playlist in one pass.
  // selectedIds keeps selection order, which becomes the playlist order.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionName, setSelectionName] = useState("");
  const [filter, setFilter] = useState<"all" | Progress>("all");

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
  // One long-lived element for spoken answers, unlocked inside the press gesture.
  // A fresh `new Audio()` per answer is refused by iOS, because by the time the
  // answer arrives (mic, recording, round trip) the gesture is long gone: the
  // answer text appeared in the chat and nothing was ever spoken.
  const answerAudioRef = useRef<HTMLAudioElement>(null);
  const answerUnlockedRef = useRef(false);
  // Release can beat getUserMedia. Without this the press is ignored and the
  // recorder runs to its 15s cap with the interrupt latched the whole time.
  const pendingStopRef = useRef(false);
  const resumeAfterAnswerRef = useRef(false);
  // rearmWake is defined below because it calls startRecording; a ref keeps the
  // reference current without an ordering cycle.
  const rearmWakeRef = useRef<(() => void) | null>(null);
  const autoplayRef = useRef(false); // request autoplay after the next detail loads
  const lastSavedMsRef = useRef(-1); // last position written, to skip no-op writes
  const resumeForRef = useRef<string | null>(null); // episode still waiting for its resume seek
  const loadedIdRef = useRef<string | null>(null); // episode whose audio is in the element

  useEffect(() => savePlaylists(playlists), [playlists]);

  // Leaving the Episodes screen abandons an in-progress selection.
  useEffect(() => {
    if (view === "episodes") return;
    setSelectMode(false);
    setSelectedIds([]);
    setSelectionName("");
  }, [view]);

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
      // The server clears the saved position when an episode is marked listened.
      const patch = <T extends { listenedAt: number | null; positionMs: number }>(e: T): T => ({
        ...e,
        listenedAt: at,
        positionMs: listened ? 0 : e.positionMs,
      });
      setEpisodes((es) => es.map((e) => (e.id === id ? patch(e) : e)));
      setDetail((d) => (d && d.id === id ? patch(d) : d));
      if (listened) lastSavedMsRef.current = 0;
      try {
        await api.setListened(id, listened);
      } catch {
        /* the refresh below restores whatever the server actually has */
      }
      void loadEpisodes();
    },
    [loadEpisodes],
  );

  // Report where playback got to. Called on a timer while playing, and again on
  // every stop: pause, leaving the player, hiding the tab, unloading the page.
  const savePosition = useCallback((id: string, ms: number, force = false) => {
    const rounded = Math.max(0, Math.round(ms));
    if (!force && Math.abs(rounded - lastSavedMsRef.current) < 1000) return;
    lastSavedMsRef.current = rounded;
    setEpisodes((es) => es.map((e) => (e.id === id ? { ...e, positionMs: rounded } : e)));
    setDetail((d) => (d && d.id === id ? { ...d, positionMs: rounded } : d));
    void api.setPosition(id, rounded, force).catch(() => {
      /* the next report or the 5s poll reconciles */
    });
  }, []);

  // Episode list + 5s poll (drives optimistic entries to ready/failed).
  useEffect(() => {
    void loadEpisodes();
    const t = setInterval(loadEpisodes, 5000);
    return () => clearInterval(t);
  }, [loadEpisodes]);

  useEffect(() => {
    if (!selectedId) return;
    resumeForRef.current = selectedId; // this episode still owes us a resume seek
    lastSavedMsRef.current = -1;
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
    navigator.mediaSession.metadata = new MediaMetadata({ title: detail!.title, artist: "Sourced.fm" });
    const audio = audioRef.current!;
    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => (audio.currentTime -= 15));
    navigator.mediaSession.setActionHandler("seekforward", () => (audio.currentTime += 30));
    // Only offer next-track while a playlist queue is actually running.
    const next = nextInQueue(selectedId);
    navigator.mediaSession.setActionHandler("nexttrack", next ? () => playNow(next) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, detail, queue, selectedId]);

  // Jump to the saved position once the audio knows its own length. Runs once per
  // episode; a position near the start or near the end is ignored (see the rules
  // at the top of this file), so those episodes begin at zero.
  const applyResume = useCallback((audio: HTMLAudioElement, ep: EpisodeDetail) => {
    if (resumeForRef.current !== ep.id) return;
    resumeForRef.current = null;
    lastSavedMsRef.current = ep.positionMs;
    if (progressOf(ep) !== "progress") return;
    audio.currentTime = ep.positionMs / 1000;
    setCurrentMs(ep.positionMs);
  }, []);

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (audio && detail) applyResume(audio, detail);
  }

  // The <audio> element owns its own src — it is NOT a React prop. The queue
  // advance has to swap the source and call play() synchronously inside the
  // 'ended' handler, because iOS refuses a play() that happens after an await
  // (and the old flow awaited a detail fetch first). A src prop would re-set the
  // attribute on the next render and restart the audio we just started.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !ready || !detail) return;
    // `selectedId` is the authority on what should be playing; `detail` lags it by
    // one fetch after a queue advance. Acting on a stale detail here would load
    // the episode that just finished and abort the one we started.
    if (detail.id !== selectedId) return;
    // loadedIdRef — not the element's src — decides whether a load is needed.
    if (loadedIdRef.current === detail.id && audio.src) {
      if (audio.readyState >= 1) applyResume(audio, detail);
      return;
    }
    loadedIdRef.current = detail.id;
    audio.src = api.audioUrl(detail.id);
    if (autoplayRef.current) {
      autoplayRef.current = false;
      void audio.play().catch(() => setPlaying(false));
    }
  }, [ready, detail, selectedId, applyResume]);

  // While playing, report every 10 seconds. A crash or a force-quit then costs
  // at most 10 seconds of progress.
  useEffect(() => {
    if (!playing || !selectedId) return;
    const t = setInterval(() => {
      const audio = audioRef.current;
      if (audio && !audio.ended) savePosition(selectedId, audio.currentTime * 1000);
    }, REPORT_EVERY_MS);
    return () => clearInterval(t);
  }, [playing, selectedId, savePosition]);

  // Hiding the tab or closing the app is a stop too — flush the position, with
  // keepalive so the request outlives the page.
  useEffect(() => {
    if (!selectedId) return;
    const flush = () => {
      const audio = audioRef.current;
      if (!audio || audio.ended) return;
      savePosition(selectedId, audio.currentTime * 1000, true);
    };
    const onVisibility = () => document.visibilityState === "hidden" && flush();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [selectedId, savePosition]);

  // When we advance through a queue, autoplay the episode once it's loaded.
  useEffect(() => {
    if (ready && autoplayRef.current) {
      autoplayRef.current = false;
      void audioRef.current?.play();
    }
  }, [ready]);

  async function submit() {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await api.createEpisode(value);
      setInput("");
      setLinkSent(value.length > 60 ? `${value.slice(0, 59)}…` : value);
      await loadEpisodes();
    } catch (e) {
      alert(`Submit failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function goCreate(next: "link" | "deep" = "link") {
    setMode(next);
    setLinkSent(null);
    setResearchSent(null);
    setView("create");
  }

  // Deep research runs for minutes, so the screen confirms and gets out of the
  // way rather than jumping into an episode that has nothing to play yet.
  async function submitResearch() {
    const assignment = brief.trim();
    if (!assignment || busy) return;
    setBusy(true);
    try {
      await api.createResearch(assignment);
      setBrief("");
      setResearchSent(assignment);
      await loadEpisodes();
    } catch (e) {
      alert(`Research request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function sendQuestion() {
    if (!detail || !question.trim() || busy) return;
    const q = question.trim();
    setQuestion("");
    setBusy(true);
    setVoiceError(null);
    setVoiceState("thinking");
    try {
      await api.askText(detail.id, q, currentMs);
      setChats(await api.getChats(detail.id));
    } catch (e) {
      setVoiceError(`Could not answer: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVoiceState("idle");
      setBusy(false);
    }
  }

  // Stop listening for the wake word. Defined here so the interrupt below can
  // depend on it.
  const disarmWake = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  // Hold-to-talk / wake-word interrupt (§4.2 frozen flow).
  //
  // Everything that can fail is contained: a failure returns to "idle" and says
  // why, so the button always works on the next press.

  // Give the answer element a user-activated history while we still hold the
  // gesture. Playing a zero-length silent wav is enough to mark it playable.
  const SILENT_WAV =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
  function unlockAnswerAudio() {
    const el = answerAudioRef.current;
    if (!el || answerUnlockedRef.current) return;
    try {
      el.src = SILENT_WAV;
      void el
        .play()
        .then(() => {
          el.pause();
          answerUnlockedRef.current = true;
        })
        .catch(() => {
          /* fall back to the tap-to-play path below */
        });
    } catch {
      /* ignore */
    }
  }

  // Speak the answer through the unlocked element, then resume the episode.
  const playAnswer = useCallback(
    async (answerBlob: Blob, positionMs: number) => {
      const el = answerAudioRef.current;
      const episode = audioRef.current;
      const url = URL.createObjectURL(answerBlob);
      const finish = () => {
        URL.revokeObjectURL(url);
        setVoiceState("idle");
        setAnswerToTap(false);
        if (episode && resumeAfterAnswerRef.current) {
          episode.currentTime = positionMs / 1000;
          void episode.play().catch(() => {});
        }
        rearmWakeRef.current?.();
      };
      if (!el) {
        finish();
        return;
      }
      el.src = url;
      el.onended = finish;
      el.onerror = finish;
      setVoiceState("answering");
      try {
        await el.play();
      } catch {
        // Autoplay refused. Keep the answer loaded and let a tap start it.
        setVoiceState("idle");
        setAnswerToTap(true);
      }
    },
    [],
  );

  const startRecording = useCallback(async () => {
    // A follow-up may interrupt an answer that is still speaking; only an open
    // recording or an in-flight request blocks a new one.
    if (!detail || busy || voiceState === "listening" || voiceState === "thinking") return;
    const speaking = answerAudioRef.current;
    if (speaking && !speaking.paused) speaking.pause();

    // Inside the gesture: unlock playback and the beep context.
    primeAudio();
    unlockAnswerAudio();

    setVoiceError(null);
    setAnswerToTap(false);
    pendingStopRef.current = false;
    interruptingRef.current = true;
    setVoiceState("listening");

    const audio = audioRef.current;
    const positionMs = audio ? audio.currentTime * 1000 : 0;
    resumeAfterAnswerRef.current = !!audio && !audio.paused;
    audio?.pause();
    disarmWake();
    beep();

    const bail = (message?: string) => {
      interruptingRef.current = false;
      pendingStopRef.current = false;
      setRecording(false);
      setVoiceState("idle");
      if (message) setVoiceError(message);
      if (audio && resumeAfterAnswerRef.current) void audio.play().catch(() => {});
      rearmWakeRef.current?.();
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
    } catch {
      bail("Microphone was refused. Check the site's mic permission.");
      return;
    }

    // Released before the mic opened: treat it as a cancelled press.
    if (pendingStopRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      bail();
      return;
    }

    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      bail("This browser cannot record audio.");
      return;
    }

    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      // A tap rather than a hold records almost nothing; do not bother the LLM.
      if (blob.size < 1200) {
        bail();
        return;
      }
      setVoiceState("thinking");
      try {
        const { audio: answerBlob } = await api.askAudio(detail.id, blob, positionMs);
        setChats(await api.getChats(detail.id));
        await playAnswer(answerBlob, positionMs);
      } catch (e) {
        bail(`Could not answer: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      interruptingRef.current = false;
      pendingStopRef.current = false;
    };

    recorderRef.current = rec;
    setRecording(true);
    try {
      rec.start();
    } catch {
      bail("Recording would not start.");
      return;
    }
    setTimeout(() => rec.state !== "inactive" && rec.stop(), 15000); // hard cap
  }, [detail, busy, voiceState, disarmWake, playAnswer]);

  function stopRecording() {
    pendingStopRef.current = true; // honoured if the mic is still opening
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  // Wake word: while playing + visible + toggle on, listen for the standalone
  // word "question". Restart on iOS's ~60s auto-stop. Disarm during interrupts.
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

  useEffect(() => {
    rearmWakeRef.current = rearmWake;
  }, [rearmWake]);

  // While a hold is open, a release anywhere on the page ends it. Relying on the
  // button's own mouseup/touchend loses the release if the finger drifts off it,
  // or if the button re-renders between press and release.
  useEffect(() => {
    if (voiceState !== "listening") return;
    const end = () => stopRecording();
    window.addEventListener("mouseup", end);
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("mouseup", end);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
      window.removeEventListener("blur", end);
    };
  }, [voiceState]);

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
    loadedIdRef.current = null;
    const audio = audioRef.current;
    if (audio && selectedId && !audio.ended) savePosition(selectedId, audio.currentTime * 1000, true);
    audio?.pause();
    setPlaying(false);
    setCurrentMs(0);
    setDetail(null);
    setChats([]);
    setSelectedId(null);
    setTab("transcript");
  }

  // ---- multi-select -> new playlist ----
  function toggleSelected(id: string) {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }
  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds([]);
    setSelectionName("");
  }
  // Builds the playlist in selection order, then opens it so the order is visible
  // and reorderable straight away.
  function createPlaylistFromSelection() {
    if (selectedIds.length === 0) return;
    const name = selectionName.trim() || `Playlist ${playlists.length + 1}`;
    const pl: Playlist = { id: newId(), name, episodeIds: [...selectedIds] };
    setPlaylists((ps) => [...ps, pl]);
    exitSelectMode();
    setOpenPlaylistId(pl.id);
    setView("playlists");
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
    // A tap started this, so the element is user-activated: load and play now.
    playNow(first);
  }
  // The next episode in the running queue, if there is one.
  function nextInQueue(fromId: string | null): string | undefined {
    if (!queue || !fromId) return undefined;
    const i = queue.indexOf(fromId);
    return i >= 0 ? queue[i + 1] : undefined;
  }

  // Start `id` on the existing element right now. Called from the 'ended' handler
  // and from the lock-screen next-track button, both of which must stay
  // synchronous — see the src effect above.
  function playNow(id: string) {
    const audio = audioRef.current;
    resumeForRef.current = id;
    lastSavedMsRef.current = -1;
    setCurrentMs(0);
    if (audio) {
      loadedIdRef.current = id; // claim it before the effect sees a stale detail
      audio.src = api.audioUrl(id);
      autoplayRef.current = false; // started here, so the effect must not re-start it
      void audio.play().catch(() => setPlaying(false));
    } else {
      // No element yet (opening the player cold) — let the effect start it.
      autoplayRef.current = true;
    }
    setSelectedId(id);
  }

  // Called when the current episode finishes — mark it listened, then advance
  // to the next queued item.
  function handleEnded() {
    setPlaying(false);
    const endedId = selectedId;
    // Marking listened clears the saved position server-side, so a replay starts
    // from the top; mirror that locally.
    if (endedId) {
      lastSavedMsRef.current = 0;
      setEpisodes((es) => es.map((e) => (e.id === endedId ? { ...e, positionMs: 0 } : e)));
      setDetail((d) => (d && d.id === endedId ? { ...d, positionMs: 0 } : d));
      void markListened(endedId, true);
    }
    const next = nextInQueue(endedId);
    if (next) playNow(next);
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
    // Still being built: anything the pipeline has not finished or failed.
    const inFlight = sorted.filter((e) => e.status !== "ready" && e.status !== "failed");
    const unlistened = sorted.filter((e) => e.listenedAt === null);
    const inProgress = sorted.filter((e) => progressOf(e) === "progress");
    const filtered = filter === "all" ? sorted : sorted.filter((e) => progressOf(e) === filter);
    // Selection only applies on the Episodes screen; Home and Research reuse the
    // same card renderer and stay tap-to-play.
    const selecting = view === "episodes" && selectMode;
    // "Up next" leads with what I am part way through, then what I have not
    // started. Once everything is listened it falls back to the most recent.
    const notStarted = sorted.filter((e) => progressOf(e) === "unlistened");
    const readyUnstarted = notStarted.filter((e) => e.status === "ready");

    const card = (e: EpisodeListItem) => {
      const busyState = e.status !== "ready" && e.status !== "failed";
      const listened = e.listenedAt !== null;
      const selected = selectedIds.includes(e.id);
      const state = progressOf(e);
      const percent =
        e.durationMs && e.durationMs > 0 ? Math.min(100, (e.positionMs / e.durationMs) * 100) : 0;
      return (
        <li
          key={e.id}
          className={`card-row${listened ? " is-listened" : ""}${selected ? " is-selected" : ""}`}
        >
          <button
            className="card"
            onClick={() => (selecting ? toggleSelected(e.id) : setSelectedId(e.id))}
            aria-pressed={selecting ? selected : undefined}
          >
            <span className="card-art" style={coverStyle(e.id)} aria-hidden="true">
              <span className="card-glyph">{KIND_GLYPH[e.sourceKind] ?? "♫"}</span>
              {e.status === "ready" && <span className="card-play">{state === "progress" ? "↻" : "▶"}</span>}
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
                {state === "progress" && (
                  <span className="chip resume">
                    {e.durationMs ? `${mmss(e.durationMs - e.positionMs)} left` : `at ${mmss(e.positionMs)}`}
                  </span>
                )}
              </span>
              {state === "progress" && (
                <span className="card-progress" aria-hidden="true">
                  <span style={{ width: `${percent}%` }} />
                </span>
              )}
              {busyState && e.note && <span className="card-note">{e.note}</span>}
            </span>
          </button>
          {selecting && (
            <span className={`card-select${selected ? " on" : ""}`} aria-hidden="true">
              ✓
            </span>
          )}
        </li>
      );
    };

    return (
      <div className="shell">
        {view === "home" && (
          <div className="page">
            <header className="home-top">
              <span className="brand">
                <span aria-hidden="true">◉</span> Sourced.fm
              </span>
              <button className="ghost-btn" onClick={() => goCreate()}>
                ＋ New
              </button>
            </header>

            {episodes.length === 0 ? (
              <div className="empty">
                <div className="empty-glyph" aria-hidden="true">
                  ♫
                </div>
                <p>Nothing here yet.</p>
                <p className="muted">
                  Add a link, or write a research brief, and it comes back as an episode with sources.
                </p>
                <button className="btn-primary empty-cta" onClick={() => goCreate()}>
                  Make your first episode
                </button>
              </div>
            ) : (
              <>
                {/* Counts double as shortcuts into the matching library filter. */}
                <div className="stats">
                  <button
                    className="stat"
                    onClick={() => {
                      setFilter("progress");
                      setView("episodes");
                    }}
                  >
                    <span className="stat-n">{inProgress.length}</span>
                    <span className="stat-l">in progress</span>
                  </button>
                  <button
                    className="stat"
                    onClick={() => {
                      setFilter("unlistened");
                      setView("episodes");
                    }}
                  >
                    <span className="stat-n">{notStarted.length}</span>
                    <span className="stat-l">to listen</span>
                  </button>
                  <button
                    className="stat"
                    onClick={() => {
                      setFilter("all");
                      setView("episodes");
                    }}
                  >
                    <span className="stat-n">{episodes.length}</span>
                    <span className="stat-l">episodes</span>
                  </button>
                </div>

                {inFlight.length > 0 && (
                  <section className="home-section">
                    <div className="section-head">
                      <h2>
                        <span className="spinner" aria-hidden="true" /> In the works
                      </h2>
                      <span className="count">{inFlight.length}</span>
                    </div>
                    <ul className="cards">{inFlight.map(card)}</ul>
                  </section>
                )}

                {inProgress.length > 0 && (
                  <section className="home-section">
                    <div className="section-head">
                      <h2>Continue listening</h2>
                      {inProgress.length > 3 && (
                        <button
                          className="see-all"
                          onClick={() => {
                            setFilter("progress");
                            setView("episodes");
                          }}
                        >
                          See all →
                        </button>
                      )}
                    </div>
                    <ul className="cards">{inProgress.slice(0, 3).map(card)}</ul>
                  </section>
                )}

                {readyUnstarted.length > 0 && (
                  <section className="home-section">
                    <div className="section-head">
                      <h2>Up next</h2>
                      <button
                        className="see-all"
                        onClick={() => {
                          setFilter("unlistened");
                          setView("episodes");
                        }}
                      >
                        All episodes →
                      </button>
                    </div>
                    <ul className="cards">{readyUnstarted.slice(0, 4).map(card)}</ul>
                  </section>
                )}

                {/* Caught up: nothing playing, nothing queued, nothing rendering. */}
                {inFlight.length === 0 && inProgress.length === 0 && readyUnstarted.length === 0 && (
                  <section className="home-section">
                    <div className="section-head">
                      <h2>Listened</h2>
                      <button
                        className="see-all"
                        onClick={() => {
                          setFilter("all");
                          setView("episodes");
                        }}
                      >
                        All episodes →
                      </button>
                    </div>
                    <p className="muted caught-up">
                      You are caught up. Add something new, or replay one of these.
                    </p>
                    <ul className="cards">{sorted.slice(0, 3).map(card)}</ul>
                  </section>
                )}
              </>
            )}
          </div>
        )}
        {view === "episodes" && (
          <div className={`page${selecting ? " selecting" : ""}`}>
            <div className="page-head">
              <h1>Episodes</h1>
              <span className="count">{episodes.length}</span>
              {unlistened.length > 0 && !selecting && (
                <span className="count unlistened">{unlistened.length} to listen</span>
              )}
              {episodes.length > 0 && (
                <button
                  className="select-btn"
                  onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                >
                  {selectMode ? "Cancel" : "Select"}
                </button>
              )}
            </div>
            {selecting && (
              <p className="muted select-hint">
                Tap episodes to add them. The order you tap is the order they play.
              </p>
            )}
            {episodes.length > 0 && (
              <div className="filters" role="tablist">
                {(["all", "unlistened", "progress", "listened"] as const).map((f) => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={filter === f}
                    className={`filter ${filter === f ? "on" : ""}`}
                    onClick={() => setFilter(f)}
                  >
                    {f === "all"
                      ? "All"
                      : f === "unlistened"
                        ? "Unlistened"
                        : f === "progress"
                          ? `In progress${inProgress.length ? ` (${inProgress.length})` : ""}`
                          : "Listened"}
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
                  {filter === "progress" ? "↻" : "✓"}
                </div>
                <p>
                  {filter === "unlistened"
                    ? "All caught up."
                    : filter === "progress"
                      ? "Nothing part way through."
                      : "Nothing listened to yet."}
                </p>
                <p className="muted">
                  {filter === "unlistened"
                    ? "Every episode is marked listened."
                    : filter === "progress"
                      ? "Stop an episode part way and it waits for you here."
                      : "Episodes you finish — or mark with ✓ — show up here."}
                </p>
              </div>
            ) : (
              <ul className="cards">{filtered.map(card)}</ul>
            )}
          </div>
        )}
        {view === "create" && (
          <div className="page">
            <div className="page-head">
              <h1>New episode</h1>
            </div>

            {/* Both ways in, side by side — one is a link, the other is an assignment. */}
            <div className="modes" role="tablist">
              <button
                role="tab"
                aria-selected={mode === "link"}
                className={`mode ${mode === "link" ? "on" : ""}`}
                onClick={() => setMode("link")}
              >
                <span className="mode-name">Link or topic</span>
                <span className="mode-sub">One pass · minutes</span>
              </button>
              <button
                role="tab"
                aria-selected={mode === "deep"}
                className={`mode ${mode === "deep" ? "on" : ""}`}
                onClick={() => setMode("deep")}
              >
                <span className="mode-name">Deep research</span>
                <span className="mode-sub">Planned · much longer</span>
              </button>
            </div>

            {mode === "link" ? (
              <>
                <p className="muted mode-hint">
                  An article link, an X post, or a short topic. It sources that one thing and turns it
                  into an episode.
                </p>
                <div className="composer">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    placeholder="Paste a link or type a topic…"
                  />
                  <button className="btn-primary" onClick={submit} disabled={busy || !input.trim()}>
                    Add
                  </button>
                </div>
                {linkSent && <p className="brief-sent">Queued “{linkSent}”. It shows up below as it builds.</p>}
              </>
            ) : (
              <>
                <p className="muted mode-hint">
                  Say what to research and how deep to go — what to focus on, what to skip, who to
                  include. Paste links to build the research around them. It plans the questions,
                  researches each one, then writes the episode from what it finds. Several minutes of
                  work, so submit it and walk away.
                </p>
                <textarea
                  className="brief"
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={8}
                  maxLength={4000}
                  placeholder={
                    "e.g. Research how solid-state batteries actually work and whether the 2027 production claims hold up.\n\n" +
                    "Focus on the manufacturing problems, not the chemistry basics. Include the sceptics.\n\n" +
                    "Start from https://example.com/solid-state-explainer"
                  }
                />
                <div className="brief-bar">
                  <span className="muted brief-count">{brief.trim().length} / 4000</span>
                  <button
                    className="btn-primary"
                    onClick={submitResearch}
                    disabled={busy || !brief.trim()}
                  >
                    {busy ? "Sending…" : "Start deep research"}
                  </button>
                </div>
                {researchSent && (
                  <p className="brief-sent">
                    Researching now. Progress shows below, then it becomes an episode when the
                    research is done.
                  </p>
                )}
              </>
            )}

            {inFlight.length > 0 && (
              <section className="home-section">
                <div className="section-head">
                  <h2>
                    <span className="spinner" aria-hidden="true" /> In the works
                  </h2>
                  <span className="count">{inFlight.length}</span>
                </div>
                <ul className="cards">{inFlight.map(card)}</ul>
              </section>
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
                              {progressOf(e) === "progress" && e.durationMs
                                ? ` · ${mmss(e.durationMs - e.positionMs)} left`
                                : ""}
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

        {selecting && (
          <div className="selbar">
            <div className="selbar-top">
              <span className="selbar-count">
                {selectedIds.length} selected
              </span>
              {selectedIds.length > 0 && (
                <button className="link" onClick={() => setSelectedIds([])}>
                  Clear
                </button>
              )}
            </div>
            <div className="selbar-row">
              <input
                value={selectionName}
                onChange={(e) => setSelectionName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createPlaylistFromSelection()}
                placeholder="Playlist name…"
              />
              <button
                className="btn-primary"
                onClick={createPlaylistFromSelection}
                disabled={selectedIds.length === 0}
              >
                Create playlist
              </button>
            </div>
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
            className={`tab-item ${view === "create" ? "on" : ""}`}
            onClick={() => goCreate(mode)}
            aria-current={view === "create"}
          >
            <span className="ti-glyph" aria-hidden="true">
              ＋
            </span>
            Create
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
              {detail.status !== "ready" && detail.status !== "failed" && detail.note && (
                <p className="now-note">{detail.note}</p>
              )}
            </div>

            {ready && (
              <div className="controls">
                <audio
                  ref={audioRef}
                  preload="metadata"
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
                  onPlay={() => setPlaying(true)}
                  onPause={(e) => {
                    setPlaying(false);
                    // 'pause' also fires at the end; handleEnded owns that case.
                    if (!e.currentTarget.ended) savePosition(detail.id, e.currentTarget.currentTime * 1000);
                  }}
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
                    {/* One element for every spoken answer, unlocked on press. */}
                    <audio ref={answerAudioRef} preload="auto" />
                    <button
                      className={`talk ${recording ? "rec" : ""}`}
                      onMouseDown={startRecording}
                      onMouseUp={stopRecording}
                      onTouchStart={(e) => {
                        e.preventDefault();
                        void startRecording();
                      }}
                      onTouchEnd={stopRecording}
                      disabled={busy || voiceState === "thinking"}
                    >
                      {recording ? "● Recording — release to ask" : "🎙 Hold to ask"}
                    </button>

                    {/* What the interrupt is doing, so a pause is never a mystery. */}
                    {voiceState !== "idle" && (
                      <p className={`voice-state ${voiceState}`}>
                        {voiceState === "listening" ? (
                          <>
                            <span className="rec-dot" aria-hidden="true" /> Listening
                          </>
                        ) : voiceState === "thinking" ? (
                          <>
                            <span className="spinner light" aria-hidden="true" /> Thinking about your
                            question…
                          </>
                        ) : (
                          <>
                            <span className="eq" aria-hidden="true">
                              <i /><i /><i />
                            </span>
                            Answering…
                          </>
                        )}
                      </p>
                    )}

                    {answerToTap && (
                      <button
                        className="tap-answer"
                        onClick={() => {
                          const el = answerAudioRef.current;
                          if (!el) return;
                          setAnswerToTap(false);
                          setVoiceState("answering");
                          answerUnlockedRef.current = true;
                          void el.play().catch(() => setVoiceState("idle"));
                        }}
                      >
                        ▶ Tap to hear the answer
                      </button>
                    )}

                    {voiceError && <p className="voice-error">{voiceError}</p>}
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
                  <p className="muted voice-note">Voice needs an HTTPS connection.</p>
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
