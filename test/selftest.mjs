import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseWav } from '../lib/audio/wav.mjs';
import { resampleTo } from '../lib/audio/resample.mjs';
import { planChunks, sliceChunk } from '../lib/audio/chunk.mjs';
import { isoWeek, kindOf } from '../lib/recognize.mjs';
import { formatImageResult, formatAudioResult, formatStatus } from '../lib/format.mjs';
import { planChunks as pc } from '../lib/audio/chunk.mjs';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('OK   ' + label);
  } else {
    failures += 1;
    console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail));
  }
}

// ---- WAV round trip: build a 16-bit stereo 48k file, read it back ----
function buildWav({ sampleRate, channels, seconds, freq = 440 }) {
  const frames = Math.round(sampleRate * seconds);
  const dataBytes = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);            // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 16000);
    for (let c = 0; c < channels; c += 1) {
      buffer.writeInt16LE(value, 44 + (i * channels + c) * 2);
    }
  }
  return buffer;
}

const wav = buildWav({ sampleRate: 48000, channels: 2, seconds: 1 });
const parsed = parseWav(wav);
check('wav sampleRate', parsed.sampleRate === 48000, parsed.sampleRate);
check('wav channels', parsed.channels === 2, parsed.channels);
check('wav frames downmixed to mono', parsed.samples.length === 48000, parsed.samples.length);
const peak = Math.max(...Array.from(parsed.samples.slice(0, 2000)).map(Math.abs));
check('wav amplitude preserved', peak > 0.4 && peak <= 1.01, peak);

// ---- resampler: 48k -> 32k keeps length ratio and tone energy ----
const resampled = resampleTo(parsed.samples, 48000, 32000);
check('resample length', Math.abs(resampled.length - 32000) <= 2, resampled.length);
const rms = Math.sqrt(resampled.reduce((sum, v) => sum + v * v, 0) / resampled.length);
check('resample energy survives', rms > 0.2, rms);

// ---- chunking ----
const plan = planChunks(32000 * 7, { sampleRate: 32000, chunkSeconds: 3, overlapSeconds: 0 });
check('chunk count for 7s', plan.chunks.length === 3, plan.chunks.length);
check('chunk length samples', plan.chunkSamples === 96000, plan.chunkSamples);
const tail = plan.chunks[plan.chunks.length - 1];
check('tail chunk end clamped', tail.end === 32000 * 7, tail.end);
const padded = sliceChunk(new Float32Array(32000 * 7), tail, plan.chunkSamples);
check('tail chunk zero padded', padded.length === 96000, padded.length);
const withOverlap = pc(32000 * 6, { sampleRate: 32000, chunkSeconds: 3, overlapSeconds: 1 });
check('overlap increases windows', withOverlap.chunks.length === 3, withOverlap.chunks.length);

// ---- file kind routing ----
check('kind jpg', kindOf('/tmp/a.JPG') === 'image');
check('kind m4a', kindOf('/tmp/x.m4a') === 'audio');
check('kind unknown', kindOf('/tmp/x.txt') === 'unknown');

// ---- iso week ----
check('isoWeek 2026-01-01', isoWeek(new Date(Date.UTC(2026, 0, 1))) === 1, isoWeek(new Date(Date.UTC(2026, 0, 1))));
check('isoWeek 2026-11-06 in 1..48', (() => { const w = isoWeek(new Date(Date.UTC(2026, 10, 6))); return w >= 1 && w <= 48; })(), isoWeek(new Date(Date.UTC(2026, 10, 6))));

// ---- formatters ----
const imageText = formatImageResult({
  candidates: [
    { scientific: 'Turdus_merula', common: '', score: 0.91 },
    { scientific: 'Turdus_philomelos', common: '', score: 0.05 },
  ],
  elapsedMs: 1200,
  topK: 2,
  file: 'bird.jpg',
});
check('image text mentions species', imageText.includes('Turdus_merula'), imageText);
check('image text states zero token', imageText.includes('0 token'), imageText);

const audioText = formatAudioResult({
  detections: [{ scientific: 'Parus_major', common: 'Great Tit', score: 0.77, firstSeenSec: 0, lastSeenSec: 3, hits: 1 }],
  windows: 2,
  durationSec: 6,
  elapsedMs: 2400,
  topK: 3,
  minConfidence: 0.15,
  geoApplied: false,
});
check('audio text mentions common name', audioText.includes('Great Tit'), audioText);
check('audio text reports windows', audioText.includes('2 个 3 秒窗口'), audioText);

const emptyText = formatAudioResult({
  detections: [], windows: 1, durationSec: 3, elapsedMs: 500, topK: 3, minConfidence: 0.15, geoApplied: false,
});
check('empty audio result explains itself', emptyText.includes('没有超过'), emptyText);

const statusText = formatStatus({
  modelsDir: '/models',
  status: { imageModel: { path: '/models/a.onnx', present: true }, audioModel: { path: '/models/b.onnx', present: false } },
  platform: 'linux',
  arch: 'arm64',
  node: 'v22.19.0',
  available: true,
});
check('status marks present/missing', statusText.includes('✓ imageModel') && statusText.includes('✗ audioModel'), statusText);

// ---- GeoPrior: symbolic batch dim in the geomodel graph ----
// This was a real regression: geo.predict() passed [null, 3] to runSession, and
// onnxruntime-node rejects a non-integer dim with "dims[0] must be an integer,
// got: null". recognize.mjs wraps the geo step in try/catch, so the failure was
// silent and every acoustic result lost its geographic filter. The assertions
// below pin the shape contract without needing the 7.5 MB model on disk.
const geoSource = fs.readFileSync(new URL('../lib/geo.mjs', import.meta.url), 'utf8');
check('geo predicts with a concrete [1, 3] input shape', geoSource.includes('input, [1, 3]'), geoSource.match(/runSession\([^)]*\]/)?.[0]);
check('geo never passes a null dim to the tensor constructor', !/\[null,\s*3\]/.test(geoSource));

const { DEFAULT_GEO_THRESHOLD, filterByAllowedSpecies, normaliseSpeciesName } = await import('../lib/geo.mjs');
check('geo default threshold is 0.03', DEFAULT_GEO_THRESHOLD === 0.03, String(DEFAULT_GEO_THRESHOLD));
check('geo normalises a scientific name', normaliseSpeciesName('  Parus  Major ') === 'parus major', normaliseSpeciesName('  Parus  Major '));
check('geo folds underscores into spaces', normaliseSpeciesName('Parus_major') === 'parus major', normaliseSpeciesName('Parus_major'));

const filtered = filterByAllowedSpecies(
  [
    { scientific: 'Parus_major', score: 0.8 },
    { scientific: 'Pica_pica', score: 0.7 },
    { scientific: '', score: 0.6 },
  ],
  new Set(['parus major']),
);
check('geo keeps allowed species', filtered.kept.some((d) => d.scientific === 'Parus_major'), JSON.stringify(filtered.kept));
check('geo drops ruled-out species', !filtered.kept.some((d) => d.scientific === 'Pica_pica'), JSON.stringify(filtered.kept));
check('geo keeps detections without a scientific name', filtered.kept.some((d) => d.scientific === ''), JSON.stringify(filtered.kept));
check('geo reports how many it dropped', filtered.dropped === 1, String(filtered.dropped));
check('geo marks the filter as applied', filtered.applied === true, String(filtered.applied));

const unapplied = filterByAllowedSpecies([{ scientific: 'Pica_pica', score: 0.7 }], null);
check('geo passes detections through when there is no gate', unapplied.applied === false && unapplied.kept.length === 1, JSON.stringify(unapplied));

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
