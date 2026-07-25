// A 150 ms 880 Hz sine beep via WebAudio — no audio asset file. Played when an
// interrupt starts recording, so the listener knows the mic is live.
export function beep(): void {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = 880;
  gain.gain.value = 0.15;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
  osc.onended = () => ctx.close();
}
