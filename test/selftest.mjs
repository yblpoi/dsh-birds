import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseWav } from '../lib/audio/wav.mjs';
import { resampleTo } from '../lib/audio/resample.mjs';
import { planChunks, sliceChunk } from '../lib/audio/chunk.mjs';
import { isoWeek, kindOf, sniffKind, classifyFile, isAttachmentBlob } from '../lib/recognize.mjs';
import { formatImageResult, formatAudioResult, formatNoBirdFound, formatNonBirdResult, formatStatus } from '../lib/format.mjs';
import {
  BIRD_CLASS,
  COCO_CLASSES,
  COCO_ZH,
  GATE_RETRY_SIZE,
  GATE_SIZE,
  GATE_WEAK_BIRD,
  buildMask,
  classLabel,
  decodeOutput,
  expandBox,
  iou,
  letterboxGeometry,
  needsRetry,
  nonMaxSuppression,
  resolveGatePasses,
  strongestBird,
  unletterboxBox,
} from '../lib/yologate.mjs';
import { planChunks as pc } from '../lib/audio/chunk.mjs';
import {
  USER_AGENT,
  FFMPEG_BUILD,
  GITHUB_RELAY,
  modelTargets,
  ffmpegTargetFor,
  ffmpegBinaryName,
  ffmpegInstallPath,
  Provisioner,
  mb,
} from '../lib/provision.mjs';
import { configureFfmpeg, describeFfmpeg, localFfmpegPath, provisionedFfmpegPath } from '../lib/ffmpeg.mjs';
import { formatProvisioning } from '../lib/format.mjs';
import { bindLabels, chineseName, labelDigest, nameTableStatus, resetNameTables } from '../lib/names.mjs';
import { parseBridgeEnvelope, quotedMediaNames, resolveQuotedMedia } from '../lib/im/quoted.mjs';
import { uniqueByContent, fileDigest } from '../lib/im/duplicates.mjs';
import { patchDshImSource, isPatched, UnsupportedBundleError, MARKER } from '../scripts/patch-dsh-im.mjs';

const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

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

// ---- content sniffing: chat attachments carry no extension at all ----
// A photo sent from dsh-Go's composer lands at
// ~/.dsh/attachments/v1/objects/5c/<sha256> with no suffix, so extension-only
// routing rejected a real JPEG with "无法判断文件类型：5ce3a0e2…". These
// assertions pin the magic-byte fallback that makes such files routable.
const sniffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-sniff-'));
function probeBytes(name, bytes) {
  const target = path.join(sniffDir, name);
  fs.writeFileSync(target, Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]));
  return target;
}
const magicProbes = [
  ['jpeg', 'image', [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]],
  ['png', 'image', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['gif', 'image', [...Buffer.from('GIF89a')]],
  ['webp', 'image', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]],
  ['wav', 'audio', [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVEfmt ')]],
  ['mp3', 'audio', [...Buffer.from('ID3'), 4, 0, 0, 0]],
  ['adts', 'audio', [0xff, 0xf1, 0x50, 0x80]],
  ['flac', 'audio', [...Buffer.from('fLaC')]],
  ['ogg', 'audio', [...Buffer.from('OggS')]],
  ['heic', 'image', [0, 0, 0, 0x18, ...Buffer.from('ftypheic')]],
  ['m4a', 'audio', [0, 0, 0, 0x18, ...Buffer.from('ftypM4A ')]],
  ['random', 'unknown', [0x00, 0x01, 0x02, 0x03]],
];
for (const [label, expected, bytes] of magicProbes) {
  const probe = probeBytes('probe-' + label, bytes);
  const sniffed = sniffKind(fs.readFileSync(probe));
  const classified = await classifyFile(probe);
  check('sniff ' + label + ' without extension', sniffed === expected, sniffed);
  check('classify ' + label + ' without extension', classified === expected, classified);
}
// A misleading or missing suffix must not shadow the bytes.
const disguised = path.join(sniffDir, 'photo.txt');
fs.writeFileSync(disguised, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(64)]));
check('extensionless blob is sniffed despite a .txt name', (await classifyFile(disguised)) === 'image');
check('known suffix still wins without reading the file', (await classifyFile('/tmp/never-opened.m4a')) === 'audio');
check('missing file classifies as unknown', (await classifyFile(path.join(sniffDir, 'gone'))) === 'unknown');
check('attachment blob names are recognised', isAttachmentBlob('/root/.dsh/attachments/v1/objects/5c/' + '5ce3a0e2'.repeat(8)));
check('ordinary names are not attachment blobs', !isAttachmentBlob('/tmp/test.wav'));
fs.rmSync(sniffDir, { recursive: true, force: true });

// ---- iso week ----
check('isoWeek 2026-01-01', isoWeek(new Date(Date.UTC(2026, 0, 1))) === 1, isoWeek(new Date(Date.UTC(2026, 0, 1))));
check('isoWeek 2026-11-06 in 1..48', (() => { const w = isoWeek(new Date(Date.UTC(2026, 10, 6))); return w >= 1 && w <= 48; })(), isoWeek(new Date(Date.UTC(2026, 10, 6))));

// ---- formatters ----
const imageText = formatImageResult({
  candidates: [
    { scientific: 'Turdus_merula', common: '', score: 0.91, chinese: '欧乌鸫' },
    { scientific: 'Turdus_philomelos', common: '', score: 0.05 },
  ],
  elapsedMs: 1200,
  topK: 2,
  file: 'bird.jpg',
});
check('image text mentions species', imageText.includes('Turdus merula'), imageText);
check('image text pairs the Chinese name with the English one', imageText.includes('欧乌鸫（Turdus merula）'), imageText);
check('image text keeps the English name when no Chinese name exists', imageText.includes('2. Turdus philomelos'), imageText);
check('image text states zero token', imageText.includes('0 token'), imageText);

const audioText = formatAudioResult({
  detections: [
    { scientific: 'Parus_major', common: 'Great Tit', score: 0.77, firstSeenSec: 0, lastSeenSec: 3, hits: 1, chinese: '大山雀' },
    { scientific: 'Gryllus_campestris', common: 'Field Cricket', score: 0.3, firstSeenSec: 3, lastSeenSec: 6, hits: 1 },
  ],
  windows: 2,
  durationSec: 6,
  elapsedMs: 2400,
  topK: 3,
  minConfidence: 0.15,
  geoApplied: false,
});
check('audio text mentions common name', audioText.includes('Great Tit'), audioText);
check('audio text pairs the Chinese name with the English one', audioText.includes('大山雀（Great Tit）'), audioText);
check('audio text falls back to the scientific name without a Chinese name', audioText.includes('Field Cricket（Gryllus campestris）'), audioText);
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

const statusBilingual = formatStatus({
  modelsDir: '/models',
  status: {},
  platform: 'linux',
  arch: 'arm64',
  node: 'v22.19.0',
  available: true,
  names: {
    image: { bound: true, named: 9826, count: 10480 },
    audio: { bound: true, named: 9794, count: 11560 },
  },
});
check(
  'status reports the bilingual name tables',
  statusBilingual.includes('中文名表：已启用') && statusBilingual.includes('9826/10480'),
  statusBilingual,
);
const statusMonolingual = formatStatus({
  modelsDir: '/models',
  status: {},
  platform: 'linux',
  arch: 'arm64',
  node: 'v22.19.0',
  available: true,
  names: { image: { bound: false }, audio: { bound: false } },
});
check('status explains when names fall back to English', statusMonolingual.includes('中文名表：未启用'), statusMonolingual);

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


// ---- Provisioning: the plugin installs itself (models + bundled ffmpeg) ----
// A fresh install used to need "apt install ffmpeg" plus a manual
// "node scripts/download-models.mjs". Both are the plugin's own job now, and
// the tables below are the contract every download is verified against.
const models = modelTargets({});
check('provisioning knows seven model files', models.length === 7, String(models.length));
check('every model pins a byte count and a sha256', models.every((target) => target.bytes > 0 && /^[0-9a-f]{64}$/.test(target.sha256)), JSON.stringify(models.map((t) => t.file)));
check('every model has an https route', models.every((target) => target.urls.length >= 1 && target.urls.every((url) => url.startsWith('https://'))), JSON.stringify(models.map((target) => target.urls.length)));
check('every model keeps a second route', models.every((target) => target.urls.length >= 2), JSON.stringify(models.map((target) => target.key + ':' + target.urls.length)));
// github.com release assets (geomodel) are unreachable on some mobile
// networks, so those two targets route through a relay as well.
check('github-hosted models carry the relay route', ['geoModel', 'geoLabels'].every((key) => models.find((target) => target.key === key).urls.some((url) => url.startsWith(GITHUB_RELAY + '/https://github.com/'))), JSON.stringify(models.filter((t) => t.key.startsWith('geo')).map((t) => t.urls)));
check('the model table covers images, audio and geo', ['imageModel', 'audioModel', 'geoModel'].every((key) => models.some((target) => target.key === key)), JSON.stringify(models.map((t) => t.key)));
const mirrored = modelTargets({ hfMirror: 'https://mirror.example' });
check('an hf mirror is spliced into the huggingface routes', mirrored.some((target) => target.urls.some((url) => url.startsWith('https://mirror.example/'))), String(mirrored.length));
check('the user agent is not bare node', USER_AGENT.startsWith('dsh-birds/'), USER_AGENT);
check('the user agent carries the shipped version', USER_AGENT.startsWith('dsh-birds/' + PKG_VERSION + ' '), USER_AGENT);
check('ffmpeg build is pinned', FFMPEG_BUILD === 'b6.0', FFMPEG_BUILD);

const linuxArm = ffmpegTargetFor('linux', 'arm64');
const linuxX64 = ffmpegTargetFor('linux', 'x64');
const darwinArm = ffmpegTargetFor('darwin', 'arm64');
const winX64 = ffmpegTargetFor('win32', 'x64');
const unsupported = ffmpegTargetFor('linux', 'ia32');
check('ffmpeg has a linux arm64 build', linuxArm.bytes === 50_015_760 && linuxArm.asset === 'ffmpeg-linux-arm64', JSON.stringify(linuxArm));
check('ffmpeg has a linux x64 build', linuxX64.bytes === 78_683_840, JSON.stringify(linuxX64));
check('ffmpeg has a darwin arm64 build', darwinArm.bytes === 45_568_216, JSON.stringify(darwinArm));
check('ffmpeg has a win32 x64 build', winX64.bytes === 81_114_624, JSON.stringify(winX64));
check('ffmpeg names the platform binary', ffmpegBinaryName('win32') === 'ffmpeg.exe' && ffmpegBinaryName('linux') === 'ffmpeg', ffmpegBinaryName('win32'));
check('an unshipped platform is reported as unsupported', unsupported.unsupported === true, JSON.stringify(unsupported));
check('unsupported platforms still yield no fake size', unsupported.bytes === 0, String(unsupported.bytes));
// 用 path.join 拼期望值：在 Windows 上它给出反斜杠，写死 '/' 的分隔符只会在
// Linux 上碰巧对上，真机跑 npm test 会红。
check(
  'ffmpeg installs under the models directory',
  ffmpegInstallPath('/m', 'linux') === path.join('/m', 'bin', 'ffmpeg')
    && ffmpegInstallPath('/m', 'win32') === path.join('/m', 'bin', 'ffmpeg.exe'),
  ffmpegInstallPath('/m', 'linux'),
);
check('ffmpeg links come from several hosts', linuxArm.urls.length >= 2 && new Set(linuxArm.urls.map((url) => new URL(url).host)).size >= 2, JSON.stringify(linuxArm.urls));

// plan() is the readiness gate /birds and /birdstatus both consult.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-provision-'));
const empty = new Provisioner({ modelsDir: emptyDir, logger: { info() {}, warn() {} } });
const emptyPlan = empty.plan();
check('an empty models dir plans seven downloads', emptyPlan.modelsMissing.length === 7, String(emptyPlan.modelsMissing.length));
check('an empty models dir also plans ffmpeg', emptyPlan.ffmpegMissing === true, String(emptyPlan.ffmpegMissing));
check('an empty models dir is not ready', emptyPlan.ready === false, String(emptyPlan.ready));
check('the plan totals the missing bytes', emptyPlan.missingBytes === models.reduce((sum, target) => sum + target.bytes, 0) + ffmpegTargetFor().bytes, mb(emptyPlan.missingBytes));

// A file of the wrong size is still "missing": a truncated download must never
// be mistaken for an installed one.
for (const target of models) {
  const file = path.join(emptyDir, target.file);
  fs.writeFileSync(file, Buffer.alloc(0));
  fs.truncateSync(file, target.bytes - 1);
}
fs.mkdirSync(path.join(emptyDir, 'bin'), { recursive: true });
fs.writeFileSync(ffmpegInstallPath(emptyDir), Buffer.alloc(0));
const shortPlan = empty.plan();
check('a truncated model is still missing', shortPlan.modelsMissing.length === 7, String(shortPlan.modelsMissing.length));
check('an empty ffmpeg placeholder is not ready', shortPlan.ffmpegMissing === true, String(shortPlan.ffmpegMissing));
for (const target of models) fs.truncateSync(path.join(emptyDir, target.file), target.bytes);
fs.writeFileSync(ffmpegInstallPath(emptyDir), Buffer.from('#!/bin/sh'));
const readyPlan = empty.plan();
check('exact sizes and an ffmpeg make the plan ready', readyPlan.ready === true, JSON.stringify({ missing: readyPlan.modelsMissing.length, ffmpeg: readyPlan.ffmpegMissing }));
check('a ready plan has nothing left to fetch', readyPlan.missingBytes === 0, String(readyPlan.missingBytes));

const idleState = empty.status();
check('an unran provisioner reports no progress', idleState.running === false && idleState.totalFiles === 0, String(idleState.running));
check('status snapshots hand out copies', Array.isArray(idleState.results) && idleState.results.length === 0, '');
fs.rmSync(emptyDir, { recursive: true, force: true });

// ---- ffmpeg lookup order: config, env, provisioned copy, then PATH ----
const ffmpegDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-ffmpeg-'));
configureFfmpeg({ modelsDir: ffmpegDir, explicitPath: undefined, logger: { info() {}, warn() {} } });
check('a bare models dir has no local ffmpeg', localFfmpegPath() === undefined, JSON.stringify(localFfmpegPath()));
check('the provisioned path lives under models/bin', provisionedFfmpegPath() === path.join(ffmpegDir, 'bin', ffmpegBinaryName()), provisionedFfmpegPath());
const missingInfo = describeFfmpeg();
check('a missing ffmpeg says where it will land', missingInfo.startsWith('未就绪') && missingInfo.includes(ffmpegDir), missingInfo);
const provisioned = provisionedFfmpegPath();
fs.mkdirSync(path.dirname(provisioned), { recursive: true });
fs.writeFileSync(provisioned, Buffer.from('#!/bin/sh'));
fs.chmodSync(provisioned, 0o755);
const found = localFfmpegPath();
check('the provisioned copy is picked up', found?.path === provisioned && found.source === 'provisioned', JSON.stringify(found));
check('describe() credits the plugin for its own binary', describeFfmpeg().startsWith('插件自带'), describeFfmpeg());
const explicit = path.join(ffmpegDir, 'hand-picked');
fs.writeFileSync(explicit, Buffer.from('#!/bin/sh'));
configureFfmpeg({ explicitPath: explicit });
check('config.ffmpegPath wins over the provisioned copy', localFfmpegPath()?.source === 'config', JSON.stringify(localFfmpegPath()));
check('describe() names an explicit path as configured', describeFfmpeg().startsWith('配置指定'), describeFfmpeg());
configureFfmpeg({ explicitPath: undefined });
fs.rmSync(ffmpegDir, { recursive: true, force: true });

// ---- /birdstatus wording for the download line ----
const runningLine = formatProvisioning({ running: true, doneFiles: 2, totalFiles: 7, doneBytes: 100 * 1048576, totalBytes: 400 * 1048576, current: 'audioModel', autoDownload: true, pendingFiles: 5 });
check('a running download reports files and megabytes', runningLine.includes('2/7') && runningLine.includes('audioModel') && runningLine.includes('25%'), runningLine);
const failedLine = formatProvisioning({ running: false, doneFiles: 3, totalFiles: 7, error: 'HTTP 403', autoDownload: true, pendingFiles: 4 });
check('a failed download keeps the reason', failedLine.includes('403') && failedLine.includes('续传'), failedLine);
const failedNamed = formatProvisioning({
  running: false,
  doneFiles: 5,
  totalFiles: 7,
  error: '2 个文件下载失败',
  autoDownload: true,
  pendingFiles: 2,
  errors: [{ file: 'geoModel' }, { file: 'geoLabels' }],
});
check(
  'a failed download names the files and promises a retry',
  failedNamed.includes('geoModel') && failedNamed.includes('geoLabels') && failedNamed.includes('自动重试'),
  failedNamed,
);
const pendingLine = formatProvisioning({ running: false, totalFiles: 0, doneFiles: 0, autoDownload: false, pendingFiles: 7 });
check('a never-started download counts what is pending', pendingLine.includes('7') && pendingLine.includes('自动下载已关闭'), pendingLine);
const localLine = formatProvisioning({ running: false, totalFiles: 0, doneFiles: 0, autoDownload: true, pendingFiles: 0 });
check('an installed plugin says nothing is left', localLine.includes('无需下载'), localLine);

// ---- Chinese name tables: index aligned, digest guarded ----
// The tables are generated against one exact label file each. If the label file
// is replaced (new model release, hand-edited copy) the row numbers stop meaning
// the same species, so the table must disable itself instead of mislabelling.
const imageTable = JSON.parse(fs.readFileSync(new URL('../lib/names/image-zh.json', import.meta.url), 'utf8'));
const audioTable = JSON.parse(fs.readFileSync(new URL('../lib/names/audio-zh.json', import.meta.url), 'utf8'));
const namesStatus = nameTableStatus();
check('image name table ships 10480 rows', namesStatus.image.count === 10480, String(namesStatus.image.count));
check('audio name table ships 11560 rows', namesStatus.audio.count === 11560, String(namesStatus.audio.count));
check(
  'most image and audio species carry a Chinese name',
  namesStatus.image.named >= 9800 && namesStatus.audio.named >= 9700,
  JSON.stringify({ image: namesStatus.image.named, audio: namesStatus.audio.named }),
);
check('an unbound table refuses to answer', chineseName('image', 0) === undefined);
check('labelDigest hashes the text as UTF-8', labelDigest('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', labelDigest('abc'));
check('a mismatched label file disables the table', bindLabels('image', 'deadbeef'.repeat(8)) === false);
check('a mismatched table still refuses to answer', chineseName('image', 0) === undefined);
check('a matching label file enables the image table', bindLabels('image', imageTable.labelsSha256) === true);
check('the image table answers by row index', chineseName('image', 0) === imageTable.names[0] && chineseName('image', 0).length > 0, chineseName('image', 0));
check('the image table leaves unmapped species empty', chineseName('image', imageTable.names.indexOf('')) === undefined);
check(
  'a matching label file enables the audio table',
  bindLabels('audio', audioTable.labelsSha256) === true && chineseName('audio', 0) === audioTable.names[0],
  chineseName('audio', 0),
);
resetNameTables();
check('reset forgets bindings', chineseName('image', 0) === undefined);


// ---- quoted chat media: a quote keeps only the platform file name ----
// dsh-im forwards a quoted message as <dsh_im_reply_to> with {kind, name} per
// attachment and drops the CDN url, so /birds saw no attachment at all and
// answered "没有收到图片或录音". The bytes are on disk in dsh-im's own history
// store, keyed by that very name, so the command looks them up itself.
const quotedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-quoted-'));
const quotedIntegration = path.join(quotedRoot, 'integrations', 'dsh-im');
const quotedBlobDir = path.join(quotedIntegration, 'group-files', 'group-1', 'message-1');
fs.mkdirSync(quotedBlobDir, { recursive: true });
const quotedBlob = path.join(quotedBlobDir, 'attachment-1');
fs.writeFileSync(quotedBlob, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(64)]));

let sqliteModule;
try {
  sqliteModule = await import('node:sqlite');
} catch {
  sqliteModule = undefined;
}
// QQ sends a voice message with no filename at all, so the quoted entry has no
// name to look up. The quote still names the message it points at, and the
// history store keys its rows by that platform id — which is what the unnamed
// path uses.
const quotedVoiceDir = path.join(quotedIntegration, 'group-files', 'group-2', 'message-2');
fs.mkdirSync(quotedVoiceDir, { recursive: true });
const quotedVoiceBlob = path.join(quotedVoiceDir, 'attachment-2');
fs.writeFileSync(quotedVoiceBlob, Buffer.concat([Buffer.from('#!AMR'), Buffer.alloc(64)]));

if (sqliteModule !== undefined) {
  const history = new sqliteModule.DatabaseSync(path.join(quotedIntegration, 'group-history.sqlite'));
  history.exec('create table groups (id text primary key, channel text, platform_group_id text)');
  history.exec('create table messages (id text primary key, group_id text, platform_message_id text, sent_at integer)');
  history.exec('create table attachments (id text primary key, message_id text, name text, mime_type text, size_bytes integer, relative_path text, status text)');
  history.prepare('insert into groups (id, channel, platform_group_id) values (?, ?, ?)').run('g1', 'qq', 'G-QUOTE');
  history.prepare('insert into messages (id, group_id, platform_message_id, sent_at) values (?, ?, ?, ?)').run('m1', 'g1', 'PLATFORM-1', 1);
  history.prepare('insert into attachments (id, message_id, name, mime_type, size_bytes, relative_path, status) values (?, ?, ?, ?, ?, ?, ?)')
    .run('a1', 'm1', 'A1B2C3.jpg', 'image/jpeg', 68, 'group-files/group-1/message-1/attachment-1', 'ready');
  history.prepare('insert into messages (id, group_id, platform_message_id, sent_at) values (?, ?, ?, ?)').run('m2', 'g1', 'PLATFORM-2', 2);
  history.prepare('insert into attachments (id, message_id, name, mime_type, size_bytes, relative_path, status) values (?, ?, ?, ?, ?, ?, ?)')
    .run('a2', 'm2', 'file-1', 'audio/amr', 68, 'group-files/group-2/message-2/attachment-2', 'ready');
  // One message can carry two recordings; both are unnamed in the quote, so
  // they must not collapse onto the same row.
  history.prepare('insert into messages (id, group_id, platform_message_id, sent_at) values (?, ?, ?, ?)').run('m3', 'g1', 'PLATFORM-3', 3);
  const secondVoiceDir = path.join(quotedIntegration, 'group-files', 'group-2', 'message-3');
  fs.mkdirSync(secondVoiceDir, { recursive: true });
  fs.writeFileSync(path.join(secondVoiceDir, 'attachment-3'), Buffer.concat([Buffer.from('#!AMR'), Buffer.alloc(64)]));
  fs.writeFileSync(path.join(secondVoiceDir, 'attachment-4'), Buffer.concat([Buffer.from('#!AMR'), Buffer.alloc(64)]));
  history.prepare('insert into attachments (id, message_id, name, mime_type, size_bytes, relative_path, status) values (?, ?, ?, ?, ?, ?, ?)')
    .run('a3', 'm3', 'file-1', 'audio/amr', 68, 'group-files/group-2/message-3/attachment-3', 'ready');
  history.prepare('insert into attachments (id, message_id, name, mime_type, size_bytes, relative_path, status) values (?, ?, ?, ?, ?, ?, ?)')
    .run('a4', 'm3', 'file-2', 'audio/amr', 68, 'group-files/group-2/message-3/attachment-4', 'ready');
  history.close();
}

const quotedEnvelope = parseBridgeEnvelope([
  { type: 'text', text: '<dsh_im_source>{"channel":"qq","conversationType":"group","chatId":"G-QUOTE"}</dsh_im_source>' },
  { type: 'text', text: '<dsh_im_reply_to>{"attachments":[{"kind":"image","name":"A1B2C3.jpg"}]}</dsh_im_reply_to>' },
  { type: 'text', text: '/birds' },
]);
check('a bridged message yields its source and its quote', quotedEnvelope.source?.chatId === 'G-QUOTE' && quotedEnvelope.replyTo?.attachments?.[0]?.name === 'A1B2C3.jpg');
check('a quote only names its media', quotedMediaNames(quotedEnvelope.replyTo).map((entry) => entry.name).join(',') === 'A1B2C3.jpg');
check('a text-only quote asks for no media', quotedMediaNames({ content: 'hi' }).length === 0);
check('a malformed quote is ignored instead of thrown', parseBridgeEnvelope([{ type: 'text', text: '<dsh_im_reply_to>not json</dsh_im_reply_to>' }]).replyTo === undefined);

if (sqliteModule !== undefined) {
  const recovered = await resolveQuotedMedia({ replyTo: quotedEnvelope.replyTo, source: quotedEnvelope.source, dshHome: quotedRoot });
  check('a quoted image is recovered from the chat history store', recovered.files[0]?.path === quotedBlob, JSON.stringify(recovered));
  check('the recovered blob is the quoted picture', (await classifyFile(recovered.files[0]?.path)) === 'image');
  const neverReceived = await resolveQuotedMedia({ replyTo: { attachments: [{ kind: 'image', name: 'NOPE.jpg' }] }, source: quotedEnvelope.source, dshHome: quotedRoot });
  check('an image the bot never received stays unresolved', neverReceived.files.length === 0 && neverReceived.unresolved[0]?.name === 'NOPE.jpg', JSON.stringify(neverReceived));

  // The regression this fix is about: a quoted recording never has a name.
  const voiceQuote = { messageId: 'PLATFORM-2', attachments: [{ kind: 'audio' }] };
  check('an unnamed quoted recording is still an attachment', quotedMediaNames(voiceQuote).length === 1
    && quotedMediaNames(voiceQuote)[0].kind === 'audio', JSON.stringify(quotedMediaNames(voiceQuote)));
  const voice = await resolveQuotedMedia({ replyTo: voiceQuote, source: quotedEnvelope.source, dshHome: quotedRoot });
  check('a quoted recording with no name is found through its message id', voice.files[0]?.path === quotedVoiceBlob, JSON.stringify(voice));
  check('the recovered blob really is the quoted recording', (await classifyFile(voice.files[0]?.path)) === 'audio');
  const voiceUnknown = await resolveQuotedMedia({ replyTo: { messageId: 'PLATFORM-NOPE', attachments: [{ kind: 'audio' }] }, source: quotedEnvelope.source, dshHome: quotedRoot });
  check('a recording the bot never received stays unresolved', voiceUnknown.files.length === 0 && voiceUnknown.unresolved[0]?.kind === 'audio', JSON.stringify(voiceUnknown));
  const namedFileQuote = { attachments: [{ kind: 'file' }] };
  check('an unnamed plain file is not guessed at', quotedMediaNames(namedFileQuote).length === 0);

  const twoVoices = { messageId: 'PLATFORM-3', attachments: [{ kind: 'audio' }, { kind: 'audio' }] };
  const both = await resolveQuotedMedia({ replyTo: twoVoices, source: quotedEnvelope.source, dshHome: quotedRoot });
  check('two unnamed recordings resolve to two distinct blobs',
    both.files.length === 2 && both.files[0].path !== both.files[1].path, JSON.stringify(both));
  check('neither of them is reported as missing', both.unresolved.length === 0, JSON.stringify(both.unresolved));
}

const stagedDir = path.join(quotedRoot, 'im', '.dsh-im', 'inbound', '20261107-120000-AAAAAA');
fs.mkdirSync(stagedDir, { recursive: true });
const stagedFile = path.join(stagedDir, '01-1-STAGED.jpg');
fs.writeFileSync(stagedFile, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(64)]));
const staged = await resolveQuotedMedia({
  replyTo: { attachments: [{ kind: 'image', name: 'STAGED.jpg' }] },
  source: { channel: 'qq', conversationType: 'direct' },
  dshHome: quotedRoot,
  cwd: path.join(quotedRoot, 'no-workspace'),
});
check('a staged inbound image is found by its platform name', staged.files[0]?.path === stagedFile, JSON.stringify(staged));
const noMedia = await resolveQuotedMedia({ replyTo: { content: '只有文字' }, dshHome: quotedRoot });
check('a text-only quote resolves to nothing instead of throwing', noMedia.files.length === 0 && noMedia.unresolved.length === 0);
fs.rmSync(quotedRoot, { recursive: true, force: true });

// ---- dsh-im build patch: quoted media must become real attachments ----
// The bridge keeps only { kind, name } for a quoted attachment — and a QQ voice
// message has no name at all. The patch rewrites the inbound builder so the url
// it still holds is put back on the message: pictures into images, everything
// else into files. dsh-im then downloads both itself, stages the recording under
// .dsh-im/inbound/ and announces it in a <dsh_im_files> manifest.
// Shaped like the real 5.10.0 builder: the two downloaders sit right after a
// fixed error message, which is how the patch finds their (mangled) names.
const MINI_IM_BUNDLE = [
  'function FY(n){return null}',
  'function hC(n){return n?.content??""}',
  'async function Bs(u,o){return Buffer.from("pixels")}',
  'async function N5e(u,o){return Buffer.from("audio")}',
  'const D5e=Object.freeze([".qpic.cn"]);',
  'function LY(n,{fetchImpl:t=fetch}={}){let o=[],a=[];',
  'for(const i of n?.attachments??[]){',
  'if(i.pic){o.push({load:({signal:sg,maxBytes:mb}={})=>{if(!i.url)throw new Error("QQ image attachment has no download URL");return Bs(i.url,{fetchImpl:t,signal:sg,maxBytes:mb,allowedHosts:D5e})}});continue;}',
  'a.push({load:({signal:sg}={})=>{if(!i.url)throw new Error("QQ file attachment has no download URL");return N5e(i.url,{fetchImpl:t,signal:sg})}});',
  '}',
  'let e=FY(n);return{content:hC(n),images:o,files:a,...e?{replyTo:e}:{}}}',
].join('\n');
const patchedIm = patchDshImSource(MINI_IM_BUNDLE);
check('the dsh-im patch rewrites the inbound builder', patchedIm.includes(MARKER)
  && patchedIm.includes('for(const __q of __qbQuotedMedia(n,t)){if(__q.kind==="image")o.push(__q.value);else a.push(__q.value);}'));
check('the dsh-im patch is idempotent', isPatched(patchedIm) && patchDshImSource(patchedIm) === patchedIm);
let refused;
try {
  patchDshImSource('function somethingElse(){}');
} catch (error) {
  refused = error;
}
check('the dsh-im patch refuses an unrecognised bundle', refused instanceof UnsupportedBundleError && /认不出/.test(refused.message));

// Mangled names differ between releases: the patch reads them out of the bundle
// instead of hard-coding them. Writing them down is what broke 5.10.0 — there
// "hs" is an assertion helper, so every promoted picture threw and got swallowed.
const RENAMED_IM_BUNDLE = MINI_IM_BUNDLE
  .split('function Bs(').join('function QqImage(')
  .split('allowedHosts:D5e').join('allowedHosts:Hosts')
  .split('const D5e=Object.freeze(').join('const Hosts=Object.freeze(')
  .split('return Bs(i.url').join('return QqImage(i.url');
const renamedPatched = patchDshImSource(RENAMED_IM_BUNDLE);
const renamedHelper = renamedPatched.slice(renamedPatched.indexOf('function __qbQuotedMedia'), renamedPatched.indexOf('function LY'));
check('the patch learns the downloader names instead of assuming them',
  renamedHelper.includes('=>QqImage(u,') && renamedHelper.includes('Array.isArray(Hosts)?Hosts'), renamedHelper.slice(0, 160));
// Same anchors, but the image downloader the hint points at is not declared:
// producing a patch here would ship a helper that throws on every use.
const brokenBundle = MINI_IM_BUNDLE.split('function Bs(').join('function QqImage(');
let brokenRefused;
try {
  patchDshImSource(brokenBundle);
} catch (error) {
  brokenRefused = error;
}
check('the patch refuses a bundle whose downloader it cannot find',
  brokenRefused instanceof UnsupportedBundleError && /下载器/.test(brokenRefused.message),
  brokenRefused === undefined ? 'no error' : brokenRefused.message);

// The helper is pulled out of the patched bundle and exercised against stubs,
// so the test measures the code dsh-im will really run.
const helperSource = patchedIm.slice(patchedIm.indexOf('function __qbQuotedMedia'), patchedIm.indexOf('function LY'));
const quotedMediaOf = new Function('Bs', 'N5e', 'D5e', helperSource + '; return __qbQuotedMedia;');
let fetched;
const stubBs = async (url, options) => {
  fetched = { url, options };
  return Buffer.from('pixels');
};
let fetchedFile;
const stubN5e = async (url, options) => {
  fetchedFile = { url, options };
  return Buffer.from('audio');
};
const promote = quotedMediaOf(stubBs, stubN5e, Object.freeze(['.qpic.cn']));
const imagesOf = (result) => result.filter((entry) => entry.kind === 'image').map((entry) => entry.value);
const filesOf = (result) => result.filter((entry) => entry.kind === 'file').map((entry) => entry.value);
const promoted = promote({
  attachments: [{ url: 'https://gchat.qpic.cn/original.jpg', name: 'already.jpg' }],
  msgElements: [{ attachments: [
    { url: 'https://gchat.qpic.cn/quoted.jpg', filename: 'QUOTED.jpg', content_type: 'image/jpeg' },
    { url: 'https://gchat.qpic.cn/original.jpg', filename: 'already.jpg', content_type: 'image/jpeg' },
    { url: 'http://gchat.qpic.cn/plain.jpg', filename: 'PLAIN.jpg', content_type: 'image/jpeg' },
    { filename: 'NOURL.jpg', content_type: 'image/jpeg' },
    { url: 'https://gchat.qpic.cn/voice.mp3', filename: 'VOICE.mp3', content_type: 'audio/mpeg' },
  ] }],
});
check('a quoted QQ image becomes a real attachment', imagesOf(promoted).length === 1
  && imagesOf(promoted)[0].name === 'QUOTED.jpg' && imagesOf(promoted)[0].mediaType === 'image/jpeg', JSON.stringify(promoted));
const promotedBytes = await imagesOf(promoted)[0].load({});
check('the promoted image loads through the platform allowlist', promotedBytes.toString() === 'pixels'
  && fetched?.url === 'https://gchat.qpic.cn/quoted.jpg' && fetched?.options?.allowedHosts?.includes('.qpic.cn'), JSON.stringify(fetched));
const ownFetch = async () => Buffer.from('own');
const ownPromoted = promote({ msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/own.jpg', filename: 'OWN.jpg', content_type: 'image/jpeg' }] }] }, ownFetch);
await imagesOf(ownPromoted)[0].load({});
check('the promoted image reuses dsh-im own fetch implementation', fetched?.options?.fetchImpl === ownFetch);
check('a quoted url outside the platform hosts is left alone', imagesOf(promote({ msgElements: [{ attachments: [{ url: 'https://cdn.example.com/x.jpg', filename: 'X.jpg', content_type: 'image/jpeg' }] }] })).length === 1);
check('a quoted picture that is already attached is not duplicated', promote({ attachments: [{ url: 'https://gchat.qpic.cn/dup.jpg' }], msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/dup.jpg', filename: 'D.jpg', content_type: 'image/jpeg' }] }] }).length === 0);
check('a quoted voice message is not promoted as a picture', imagesOf(promoted).length === 1, JSON.stringify(imagesOf(promoted)));

// The core of this fix: a quoted recording must survive QQ sending it unnamed.
const unnamedVoice = promote({ msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/voice.amr', content_type: 'audio/amr' }] }] });
check('a quoted recording with no filename is promoted as a file', filesOf(unnamedVoice).length === 1, JSON.stringify(unnamedVoice));
check('an unnamed recording is given a name with a usable suffix', filesOf(unnamedVoice)[0]?.name === 'quoted-file-1.amr', JSON.stringify(filesOf(unnamedVoice)));
check('the recording media type is kept', filesOf(unnamedVoice)[0]?.mediaType === 'audio/amr');
await filesOf(unnamedVoice)[0].load({});
check('the promoted recording downloads through dsh-im own file channel', fetchedFile?.url === 'https://gchat.qpic.cn/voice.amr');
const namedVoice = promote({ msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/v.mp3', filename: 'V.mp3', content_type: 'audio/mpeg' }] }] });
check('a named quoted recording keeps its platform name', filesOf(namedVoice)[0]?.name === 'V.mp3', JSON.stringify(filesOf(namedVoice)));
const mixed = filesOf(promote({ msgElements: [{ attachments: [
  { url: 'https://gchat.qpic.cn/a.amr', content_type: 'audio/amr' },
  { url: 'https://gchat.qpic.cn/b.amr', content_type: 'audio/amr' },
] }] }));
check('two unnamed recordings are numbered apart', mixed.map((entry) => entry.name).join(',') === 'quoted-file-1.amr,quoted-file-2.amr', JSON.stringify(mixed));
check('a quoted picture with no url is skipped', promote({ msgElements: [{ attachments: [{ filename: 'A.jpg', content_type: 'image/jpeg' }] }] }).length === 0);

// ---- one photo delivered twice: identity is the content, not the path ----
// A QQ photo reaches /birds through two independent routes: the Host attaches
// its own content-addressed copy (basename = sha256 of the bytes), and dsh-im
// stages the same bytes inside the session workspace under the platform file
// name and announces that path in <dsh_im_files>. Both were recognised, so one
// photo printed two identical `【1】`/`【2】` blocks. Reproduced with the exact
// sha256 the phone reported (b1a65527…).
const dupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-dup-'));
const dupBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1024, 0x42), Buffer.from([0xff, 0xd9])]);
const dupHash = createHash('sha256').update(dupBytes).digest('hex');
const blobDir = path.join(dupRoot, 'attachments', 'v1', 'objects', dupHash.slice(0, 2));
fs.mkdirSync(blobDir, { recursive: true });
const blobPath = path.join(blobDir, dupHash);
fs.writeFileSync(blobPath, dupBytes);
const dupStagedDir = path.join(dupRoot, 'im', '.dsh-im', 'inbound', '20261109-114042-s2CIRC');
fs.mkdirSync(dupStagedDir, { recursive: true });
const stagedPath = path.join(dupStagedDir, '01-1-3D92.jpg');
fs.writeFileSync(stagedPath, dupBytes);

const dupLabels = new Map([[blobPath, '附件 ' + dupHash.slice(0, 8)], [stagedPath, '1-3D92.jpg']]);
const deduped = await uniqueByContent([blobPath, stagedPath], { labels: dupLabels });
check('one photo delivered twice collapses to one file', deduped.length === 1, JSON.stringify(deduped));
check('the surviving copy keeps the readable name', deduped[0] === stagedPath, deduped[0]);
check('the blob label follows the surviving copy', !dupLabels.has(blobPath) && dupLabels.has(stagedPath));

const distinctA = path.join(dupStagedDir, '01-a.jpg');
const distinctB = path.join(dupStagedDir, '02-b.jpg');
fs.writeFileSync(distinctA, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('A')]));
fs.writeFileSync(distinctB, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('B')]));
const distinct = await uniqueByContent([distinctA, distinctB]);
check('two different photos both survive', distinct.length === 2, JSON.stringify(distinct));

const missing = path.join(dupStagedDir, '01-gone.jpg');
const unreadable = await uniqueByContent([missing, distinctA], { logger: { warn: () => {} } });
check('an unreadable file is kept rather than silently dropped', unreadable.length === 2, JSON.stringify(unreadable));

const dedupeSingle = await uniqueByContent([stagedPath]);
check('a single file passes through untouched', dedupeSingle.length === 1 && dedupeSingle[0] === stagedPath);
const dedupeEmpty = await uniqueByContent([]);
check('an empty list stays empty', Array.isArray(dedupeEmpty) && dedupeEmpty.length === 0);

fs.rmSync(dupRoot, { recursive: true, force: true });

// ---- The gate: YOLO26n-seg decides "bird or not" before BirdTrace is asked ----
// BirdTrace is a 10480-way classifier with no "no bird here" output, so a photo
// of a cat used to come back as a confident species. These checks pin the parts
// of the gate that decide that answer: the label table, the letterbox round
// trip, the raw-output decoder, NMS, the crop box, and the two reply shapes.
check('the COCO label table covers all 80 detection classes', COCO_CLASSES.length === 80 && COCO_ZH.length === 80, COCO_CLASSES.length + '/' + COCO_ZH.length);
check('class 14 is bird, which the whole feature hangs on', COCO_CLASSES[BIRD_CLASS] === 'bird' && COCO_ZH[BIRD_CLASS] === '鸟', classLabel(BIRD_CLASS));
check('the gate runs at the resolution the COCO export was trained for', GATE_SIZE === 640, String(GATE_SIZE));
check('the retry pass looks closer than the first pass', GATE_RETRY_SIZE === 960 && GATE_RETRY_SIZE > GATE_SIZE, String(GATE_RETRY_SIZE));
// Real birds measured here score 0.70-0.91 even at a fraction of a percent of
// the frame; the spurious bird hits that motivated this threshold sat at 0.30.
check('a weak bird hit is below the trust threshold', GATE_WEAK_BIRD > 0.3 && GATE_WEAK_BIRD < 0.7, String(GATE_WEAK_BIRD));
check('a class label pairs Chinese with English', classLabel(15) === '猫（cat）', classLabel(15));
check('an out-of-range class still yields a label', classLabel(999) === 'class 999', classLabel(999));

// Letterbox: a wide frame keeps its aspect ratio and is padded top and bottom.
const wide = letterboxGeometry(640, 1280, 720);
check('a 16:9 frame scales to full width', wide.drawnWidth === 640 && wide.drawnHeight === 360, JSON.stringify(wide));
check('a wide frame is padded top and bottom only', wide.padTop === 140 && wide.padLeft === 0, JSON.stringify(wide));
check('a landscape box keeps its scale', Math.abs(wide.scale - 0.5) < 1e-9, String(wide.scale));
const tall = letterboxGeometry(640, 480, 960);
check('a portrait frame is padded left and right', tall.padLeft === 160 && tall.padTop === 0, JSON.stringify(tall));

// Round trip: a box expressed in letterbox pixels must come back to the same
// source rectangle, otherwise the crop cuts the wrong part of the photograph.
const srcBox = { x1: 200, y1: 100, x2: 700, y2: 500 };
const back = unletterboxBox({
  x1: srcBox.x1 * wide.scale + wide.padLeft,
  y1: srcBox.y1 * wide.scale + wide.padTop,
  x2: srcBox.x2 * wide.scale + wide.padLeft,
  y2: srcBox.y2 * wide.scale + wide.padTop,
}, { size: 640, srcWidth: 1280, srcHeight: 720 });
check('letterbox boxes map back to source pixels', ['x1', 'y1', 'x2', 'y2'].every((k) => Math.abs(back[k] - srcBox[k]) < 1e-6), JSON.stringify(back));
const bled = unletterboxBox({ x1: 0, y1: 0, x2: 640, y2: 640 }, { size: 640, srcWidth: 1280, srcHeight: 720 });
check('a box bleeding into the padding is clamped to the frame', bled.x1 === 0 && bled.y1 === 0 && bled.x2 === 1280 && bled.y2 === 720, JSON.stringify(bled));

// Cropping margin: wings and tails sit outside the detector's body box.
const grown = expandBox({ x1: 100, y1: 100, x2: 300, y2: 200 }, { margin: 0.25, srcWidth: 1280, srcHeight: 720 });
check('the crop box grows by the margin on every side', grown.x1 === 50 && grown.x2 === 350 && grown.y1 === 75 && grown.y2 === 225, JSON.stringify(grown));
const pinned = expandBox({ x1: 10, y1: 10, x2: 90, y2: 90 }, { margin: 0.5, srcWidth: 100, srcHeight: 100 });
check('a grown box never leaves the frame', pinned.x1 === 0 && pinned.y1 === 0 && pinned.x2 === 100 && pinned.y2 === 100, JSON.stringify(pinned));

// Raw output: channel-major [4 + 80 + 32, anchors]. One anchor claiming bird at
// 0.9 and one claiming cat at 0.8; everything else must stay silent.
const ANCHORS = 4;
const CHANNELS = 4 + COCO_CLASSES.length + 32;
const raw = new Float32Array(ANCHORS * CHANNELS);
const put = (row, anchor, value) => { raw[row * ANCHORS + anchor] = value; };
put(0, 0, 320); put(1, 0, 320); put(2, 0, 100); put(3, 0, 100);
put(4 + BIRD_CLASS, 0, 0.9);
put(0, 1, 100); put(1, 1, 100); put(2, 1, 60); put(3, 1, 40);
put(4 + 15, 1, 0.8);
put(0, 2, 50); put(1, 2, 50); put(2, 2, 20); put(3, 2, 20);
put(4 + BIRD_CLASS, 2, 0.10);
put(4 + 16, 3, 0.05);
const decoded = decodeOutput(raw, { anchors: ANCHORS, channels: CHANNELS, classCount: COCO_CLASSES.length }, { confidence: 0.25 });
check('only anchors above the threshold survive decoding', decoded.length === 2, JSON.stringify(decoded.map((d) => [d.classIndex, d.score])));
check('the decoded bird keeps its class and score', decoded.some((d) => d.classIndex === BIRD_CLASS && Math.abs(d.score - 0.9) < 1e-6), JSON.stringify(decoded.map((d) => d.classIndex)));
check('a centre/size detection becomes corners', decoded.every((d) => d.x2 - d.x1 > 0 && d.y2 - d.y1 > 0), JSON.stringify(decoded.map((d) => [d.x1, d.y1, d.x2, d.y2])));
check('every detection carries its mask coefficients', decoded.every((d) => d.maskCoeffs.length === 32), JSON.stringify(decoded.map((d) => d.maskCoeffs.length)));
const stricter = decodeOutput(raw, { anchors: ANCHORS, channels: CHANNELS, classCount: COCO_CLASSES.length }, { confidence: 0.85 });
check('raising the confidence drops the weaker anchor', stricter.length === 1 && stricter[0].classIndex === BIRD_CLASS, JSON.stringify(stricter.map((d) => d.classIndex)));

// IoU and NMS: overlapping boxes of the same class collapse, other classes stay.
check('iou of identical boxes is 1', Math.abs(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 0, y1: 0, x2: 10, y2: 10 }) - 1) < 1e-9);
check('iou of disjoint boxes is 0', iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 20, y1: 20, x2: 30, y2: 30 }) === 0);
check('iou of a half-overlap is one third', Math.abs(iou({ x1: 0, y1: 0, x2: 10, y2: 10 }, { x1: 5, y1: 0, x2: 15, y2: 10 }) - 1 / 3) < 1e-9);
const crowded = nonMaxSuppression([
  { classIndex: BIRD_CLASS, score: 0.9, x1: 0, y1: 0, x2: 100, y2: 100 },
  { classIndex: BIRD_CLASS, score: 0.8, x1: 2, y1: 2, x2: 102, y2: 102 },
  { classIndex: BIRD_CLASS, score: 0.7, x1: 500, y1: 500, x2: 600, y2: 600 },
  { classIndex: 15, score: 0.6, x1: 0, y1: 0, x2: 100, y2: 100 },
]);
check('nms merges duplicate boxes of one class', crowded.filter((d) => d.classIndex === BIRD_CLASS).length === 2, JSON.stringify(crowded.map((d) => d.score)));
check('nms keeps a different class in the same place', crowded.some((d) => d.classIndex === 15), JSON.stringify(crowded.map((d) => d.classIndex)));
check('nms returns the winners best-first', crowded[0].score === 0.9, JSON.stringify(crowded.map((d) => d.score)));


// Which pass to believe. This rule is what stops a cat photo paying for a
// second forward pass, and what stops a lizard (one spurious bird at 0.30 plus
// an elephant at 0.56) being cropped and answered with a 15% species.
const birdHit = (score, box = [0, 0, 100, 100]) => ({ classIndex: BIRD_CLASS, score, box: { x1: box[0], y1: box[1], x2: box[2], y2: box[3] } });
const otherHit = (classIndex, score) => ({ classIndex, score, box: { x1: 0, y1: 0, x2: 10, y2: 10 } });
const pass = (width, height, detections) => ({ sourceWidth: width, sourceHeight: height, detections });

check('the strongest bird wins over a weaker one', strongestBird([birdHit(0.4), birdHit(0.8), birdHit(0.6)])?.score === 0.8);
check('no bird means no strongest bird', strongestBird([otherHit(15, 0.9)]) === undefined);

check('a confident bird needs no retry', needsRetry([birdHit(0.9)]) === false);
check('an empty first pass deserves a retry', needsRetry([]) === true);
check('a weak bird hit deserves a retry', needsRetry([birdHit(0.3)]) === true);
// A cat is the load-bearing case: the first pass already has an answer, and a
// retry spent confirming "not a bird" would slow down every non-bird upload.
check('a frame full of non-birds needs no retry', needsRetry([otherHit(15, 0.91), otherHit(79, 0.48)]) === false);

const firstStrong = resolveGatePasses({ first: pass(1200, 800, [birdHit(0.9)]) });
check('a confident first pass is used as-is', firstStrong.bird?.score === 0.9 && firstStrong.sourceWidth === 1200, JSON.stringify(firstStrong.bird));
const retryWins = resolveGatePasses({
  first: pass(1200, 800, []),
  second: pass(1600, 1200, [birdHit(0.73)]),
});
check('a bird found only by the retry brings the retry frame size', retryWins.bird?.score === 0.73 && retryWins.sourceWidth === 1600 && retryWins.sourceHeight === 1200, JSON.stringify(retryWins.sourceWidth));
const weakOnly = resolveGatePasses({
  first: pass(1200, 800, [birdHit(0.3), otherHit(20, 0.56)]),
  second: pass(1200, 800, []),
});
check('a weak bird nobody confirms is discarded', weakOnly.bird === undefined);
check('the objects the first pass saw survive the rejected bird', weakOnly.detections.length === 1 && weakOnly.detections[0].classIndex === 20, JSON.stringify(weakOnly.detections.map((d) => d.classIndex)));
check('a rejected bird still reports the frame it was measured in', weakOnly.sourceWidth === 1200 && weakOnly.sourceHeight === 800);
const weakBeatenByRetry = resolveGatePasses({
  first: pass(1200, 800, [birdHit(0.3)]),
  second: pass(1200, 800, [birdHit(0.72)]),
});
check('the retry can upgrade a weak hit into a real bird', weakBeatenByRetry.bird?.score === 0.72, JSON.stringify(weakBeatenByRetry.bird?.score));
const bothEmpty = resolveGatePasses({ first: pass(1200, 800, []), second: pass(1200, 800, []) });
check('two empty passes leave nothing to crop', bothEmpty.bird === undefined && bothEmpty.detections.length === 0);
const retrySeesOthers = resolveGatePasses({
  first: pass(1200, 800, [birdHit(0.3)]),
  second: pass(1200, 800, [otherHit(15, 0.86)]),
});
check('when the retry sees objects and the first pass did not, they are kept', retrySeesOthers.detections.length === 1 && retrySeesOthers.detections[0].classIndex === 15, JSON.stringify(retrySeesOthers.detections.map((d) => d.classIndex)));

// Masks: a single positive proto channel and a positive coefficient.
const protos = new Float32Array(32 * 4);
protos.fill(-1);
protos[0] = 1; protos[1] = 1; // channel 0, first two pixels
const coeffs = new Float32Array(32);
coeffs[0] = 1;
const mask = buildMask(coeffs, protos, { protoHeight: 2, protoWidth: 2 });
check('a mask marks the pixels its protos select', mask.length === 4 && mask[0] === 1 && mask[1] === 1 && mask[2] === 0 && mask[3] === 0, Array.from(mask).join(','));

// Reply shape for a non-bird photo: names what was found, never a species.
const nonBird = formatNonBirdResult({
  detections: [
    { classIndex: 15, label: '猫（cat）', score: 0.911 },
    { classIndex: 15, label: '猫（cat）', score: 0.7 },
    { classIndex: 16, label: '狗（dog）', score: 0.5 },
    { classIndex: 47, label: '苹果（apple）', score: 0.4 },
  ],
  elapsedMs: 61,
  file: 'cat.jpg',
  gate: { bird: false, cropped: false },
});
check('a non-bird reply says there is no bird', /没有检测到鸟/u.test(nonBird), nonBird.split('\n')[0]);
check('a non-bird reply names the object it found', /猫（cat）/u.test(nonBird) && /91\.1%/u.test(nonBird), nonBird);
check('a non-bird reply lists each class once', (nonBird.match(/猫（cat）/gu) ?? []).length === 1, nonBird);
check('a non-bird reply stops at three classes', nonBird.split('\n').filter((line) => /^\d\. /u.test(line)).length === 3, nonBird);
check('a non-bird reply never calls the model', /未调用大模型/u.test(nonBird), nonBird);
const emptyFrame = formatNonBirdResult({ detections: [], elapsedMs: 12, file: 'x.jpg', gate: { bird: false, cropped: false } });
check('an empty frame is reported as empty, not guessed', /没有在画面里找到任何可识别的物体/u.test(emptyFrame), emptyFrame);

// A bird photo the gate cropped says so; one it could not crop admits the
// whole frame was used; one it never confirmed warns the answer is a guess.
const croppedReply = formatImageResult({
  candidates: [{ chinese: '东黄鸲鹟', english: 'Eastern Yellow Robin', scientific: 'Eopsaltria_australis', score: 0.999 }],
  elapsedMs: 594,
  topK: 5,
  file: 'bird1.jpg',
  gate: {
    bird: true, cropped: true, score: 0.906,
    boxWidth: 684, boxHeight: 638, boxShare: 0.4,
    cropWidth: 1011, cropHeight: 853, cropShare: 0.802,
  },
});
check('a cropped bird reply reports the crop box', /684×638/u.test(croppedReply) && /40\.0%/u.test(croppedReply), croppedReply);
// The bird box and the region actually handed to the classifier are different
// numbers (the margin widens it); the reply must not conflate them.
check(
  'a cropped bird reply also reports what was actually sent',
  /1011×853/u.test(croppedReply) && /80\.2%/u.test(croppedReply),
  croppedReply,
);
const bareCropReply = formatImageResult({
  candidates: [{ chinese: '东黄鸲鹟', english: 'Eastern Yellow Robin', score: 0.99 }],
  elapsedMs: 300, topK: 5, file: 'b.jpg',
  gate: { bird: true, cropped: true, score: 0.9, boxWidth: 684, boxHeight: 638, boxShare: 0.4 },
});
check(
  'a gate object without a crop size still renders one sentence',
  /684×638/u.test(bareCropReply) && !/外扩后/u.test(bareCropReply),
  bareCropReply,
);
const uncroppedReply = formatImageResult({
  candidates: [{ chinese: '麻雀', english: 'Eurasian Tree Sparrow', score: 0.7 }],
  elapsedMs: 300, topK: 5, file: 'b.jpg',
  gate: { bird: true, cropped: false, score: 0.31 },
});
check('a bird too small to crop says the whole frame was used', /按整图识别/u.test(uncroppedReply), uncroppedReply);
// Nothing found is not an answer. The headline says the model does not know;
// a ranked list of species under a hedge is exactly what got taken as a
// confirmed identification before.
const noBirdReply = formatNoBirdFound({ elapsedMs: 420, file: 'flower.jpg' });
check(
  'a frame with nothing in it says so in the first line',
  /^图片识别结果：前置模型没在这张图里检出鸟/u.test(noBirdReply),
  noBirdReply,
);
check('a frame with nothing in it admits it cannot name the subject', /也说不准画面里是什么/u.test(noBirdReply), noBirdReply);
check('a frame with nothing in it offers no species', !/\d+\.\s/u.test(noBirdReply.split('判断依据')[0]), noBirdReply);
check('a frame with nothing in it says the classifier was skipped', /没检出鸟就不调用识鸟模型/u.test(noBirdReply), noBirdReply);
check('a frame with nothing in it says both passes were spent', /640/u.test(noBirdReply) && /960/u.test(noBirdReply), noBirdReply);
check('a frame with nothing in it suggests what to do instead', /裁掉/u.test(noBirdReply) && /声音识别/u.test(noBirdReply), noBirdReply);
check(
  'a confirmed bird reply keeps its model banner',
  /^图片识别结果（BirdTrace/u.test(croppedReply),
  croppedReply,
);
const plainReply = formatImageResult({ candidates: [{ chinese: '鸟', english: 'bird', score: 0.5 }], elapsedMs: 10, topK: 5 });
check('a reply without a gate says nothing about one', !/前置模型/u.test(plainReply), plainReply);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
