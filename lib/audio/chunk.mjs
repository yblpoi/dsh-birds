/**
 * Plan BirdNET+ analysis windows.
 *
 * The V3 model takes variable-length audio, so a partial trailing window is
 * legal; zero padding it to the nominal chunk keeps tensor shapes uniform and
 * matches analyze.py's behaviour.
 */
export function planChunks(totalSamples, { sampleRate, chunkSeconds = 3, overlapSeconds = 0 } = {}) {
  const chunkSamples = Math.max(1, Math.round(chunkSeconds * sampleRate));
  const step = Math.max(1, chunkSamples - Math.round(overlapSeconds * sampleRate));
  const chunks = [];
  if (totalSamples <= 0) return { chunks, chunkSamples };
  for (let start = 0; start < totalSamples; start += step) {
    const end = Math.min(start + chunkSamples, totalSamples);
    chunks.push({ start, end: Math.min(end, totalSamples), paddedEnd: start + chunkSamples });
    if (end >= totalSamples) break;
  }
  return { chunks, chunkSamples };
}

/** Copy one window into a zero-padded Float32Array of exactly chunkSamples. */
export function sliceChunk(samples, chunk, chunkSamples) {
  const out = new Float32Array(chunkSamples);
  const end = Math.min(chunk.end, samples.length);
  out.set(samples.subarray(chunk.start, end), 0);
  return out;
}
