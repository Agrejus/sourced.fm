// A 150 ms 880 Hz sine beep via WebAudio — no audio asset file. Played when an
// interrupt starts recording, so the listener knows the mic is live.
//
// ONE context, reused. Creating a context per beep leaks them: a context built
// outside a user gesture starts suspended, so `osc.onended` never fired and the
// old code never closed it. iOS caps live AudioContexts (historically four), so
// eventually `new AudioContext()` throws — which aborted the whole interrupt
// before it reached the microphone. Nothing in here may throw.

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!ctx) ctx = new Ctx();
    return ctx;
  } catch {
    return null;
  }
}

// Call from inside a real user gesture. iOS starts a context suspended and only
// a gesture may resume it; after that the context stays usable.
export function primeAudio(): void {
  const c = context();
  if (c && c.state === "suspended") void c.resume().catch(() => {});
}

export function beep(): void {
  const c = context();
  if (!c) return;
  try {
    if (c.state === "suspended") void c.resume().catch(() => {});
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.15);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  } catch {
    /* a beep is never worth breaking the interrupt for */
  }
}
