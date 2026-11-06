/**
 * Band-limited resampling to 32 kHz.
 *
 * A windowed-sinc kernel (Hann-windowed, 16 taps each side) is used instead of
 * linear interpolation: bird song energy sits mostly above 2 kHz, where linear
 * interpolation aliases far too much for a classifier trained on clean audio.
 */
export function resampleTo(samples, fromRate, toRate) {
  if (!samples || samples.length === 0) return new Float32Array(0);
  if (!fromRate || fromRate === toRate) return samples;
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLength);
  const cutoff = Math.min(1, ratio) * 0.95; // guard band below Nyquist
  const taps = 16;
  const half = taps;
  for (let i = 0; i < outLength; i += 1) {
    const center = i / ratio;
    const start = Math.floor(center) - half + 1;
    let acc = 0;
    let weight = 0;
    for (let k = 0; k < taps * 2; k += 1) {
      const index = start + k;
      if (index < 0 || index >= samples.length) continue;
      const t = center - index;
      // sinc with Hann window
      const x = Math.PI * cutoff * t;
      const sinc = x === 0 ? 1 : Math.sin(x) / x;
      const window = 0.5 * (1 + Math.cos(Math.PI * t / taps));
      const coefficient = cutoff * sinc * (Math.abs(t) <= taps ? window : 0);
      acc += samples[index] * coefficient;
      weight += coefficient;
    }
    out[i] = weight === 0 ? 0 : acc / weight;
  }
  return out;
}
