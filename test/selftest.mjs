import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseWav } from '../lib/audio/wav.mjs';
import { resampleTo } from '../lib/audio/resample.mjs';
import { planChunks, sliceChunk } from '../lib/audio/chunk.mjs';
import { isoWeek, kindOf, sniffKind, classifyFile, isAttachmentBlob } from '../lib/recognize.mjs';
import { formatImageResult, formatAudioResult, formatStatus } from '../lib/format.mjs';
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
import { patchDshImSource, isPatched, UnsupportedBundleError, MARKER } from '../scripts/patch-dsh-im.mjs';

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
check('provisioning knows six model files', models.length === 6, String(models.length));
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
check('ffmpeg installs under the models directory', ffmpegInstallPath('/m', 'linux') === '/m/bin/ffmpeg' && ffmpegInstallPath('/m', 'win32') === '/m/bin/ffmpeg.exe', ffmpegInstallPath('/m', 'linux'));
check('ffmpeg links come from several hosts', linuxArm.urls.length >= 2 && new Set(linuxArm.urls.map((url) => new URL(url).host)).size >= 2, JSON.stringify(linuxArm.urls));

// plan() is the readiness gate /birds and /birdstatus both consult.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-provision-'));
const empty = new Provisioner({ modelsDir: emptyDir, logger: { info() {}, warn() {} } });
const emptyPlan = empty.plan();
check('an empty models dir plans six downloads', emptyPlan.modelsMissing.length === 6, String(emptyPlan.modelsMissing.length));
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
check('a truncated model is still missing', shortPlan.modelsMissing.length === 6, String(shortPlan.modelsMissing.length));
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
if (sqliteModule !== undefined) {
  const history = new sqliteModule.DatabaseSync(path.join(quotedIntegration, 'group-history.sqlite'));
  history.exec('create table groups (id text primary key, channel text, platform_group_id text)');
  history.exec('create table messages (id text primary key, group_id text, sent_at integer)');
  history.exec('create table attachments (id text primary key, message_id text, name text, mime_type text, size_bytes integer, relative_path text, status text)');
  history.prepare('insert into groups (id, channel, platform_group_id) values (?, ?, ?)').run('g1', 'qq', 'G-QUOTE');
  history.prepare('insert into messages (id, group_id, sent_at) values (?, ?, ?)').run('m1', 'g1', 1);
  history.prepare('insert into attachments (id, message_id, name, mime_type, size_bytes, relative_path, status) values (?, ?, ?, ?, ?, ?, ?)')
    .run('a1', 'm1', 'A1B2C3.jpg', 'image/jpeg', 68, 'group-files/group-1/message-1/attachment-1', 'ready');
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

// ---- dsh-im build patch: quoted QQ images must become real attachments ----
// The bridge keeps only { kind, name } for a quoted attachment. The patch
// rewrites its inbound builder so the CDN url it already holds also lands in
// the message's images list, which is how an ordinary photo arrives.
const MINI_IM_BUNDLE = [
  'function iY(n){return null}',
  'function aC(n){return n?.content??""}',
  'function hs(u){return u}',
  'const kVe=[".qpic.cn"];',
  'async function UVe(u){return u}',
  'function rY(n,{fetchImpl:t=fetch}={}){let o=[],a=[];let e=iY(n);return{content:aC(n),images:o,files:a,...e?{replyTo:e}:{}}}',
].join('\n');
const patchedIm = patchDshImSource(MINI_IM_BUNDLE);
check('the dsh-im patch rewrites the inbound builder', patchedIm.includes(MARKER) && patchedIm.includes('for(const __q of __qbQuotedMedia(n,t))o.push(__q)'));
check('the dsh-im patch is idempotent', isPatched(patchedIm) && patchDshImSource(patchedIm) === patchedIm);
let refused;
try {
  patchDshImSource('function somethingElse(){}');
} catch (error) {
  refused = error;
}
check('the dsh-im patch refuses an unrecognised bundle', refused instanceof UnsupportedBundleError && /认不出/.test(refused.message));

const helperSource = patchedIm.slice(patchedIm.indexOf('function __qbQuotedMedia'), patchedIm.indexOf('function rY'));
const quotedMediaOf = new Function('hs', 'kVe', helperSource + '; return __qbQuotedMedia;');
let fetched;
const stubHs = async (url, options) => {
  fetched = { url, options };
  return Buffer.from('pixels');
};
const promote = quotedMediaOf(stubHs, ['.qpic.cn']);
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
check('a quoted QQ image becomes a real attachment', promoted.length === 1 && promoted[0].name === 'QUOTED.jpg' && promoted[0].mediaType === 'image/jpeg', JSON.stringify(promoted));
const promotedBytes = await promoted[0].load({});
check('the promoted image loads through the platform allowlist', promotedBytes.toString() === 'pixels' && fetched?.url === 'https://gchat.qpic.cn/quoted.jpg' && fetched?.options?.allowedHosts?.includes('.qpic.cn'), JSON.stringify(fetched));
const ownFetch = async () => Buffer.from('own');
const ownPromoted = promote({ msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/own.jpg', filename: 'OWN.jpg', content_type: 'image/jpeg' }] }] }, ownFetch);
await ownPromoted[0].load({});
check('the promoted image reuses dsh-im own fetch implementation', fetched?.options?.fetchImpl === ownFetch);
check('a quoted url outside the platform hosts is left alone', promote({ msgElements: [{ attachments: [{ url: 'https://cdn.example.com/x.jpg', filename: 'X.jpg', content_type: 'image/jpeg' }] }] }).length === 1);
check('a quoted picture that is already attached is not duplicated', promote({ attachments: [{ url: 'https://gchat.qpic.cn/dup.jpg' }], msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/dup.jpg', filename: 'D.jpg', content_type: 'image/jpeg' }] }] }).length === 0);
check('a quoted voice message is not treated as a picture', promote({ msgElements: [{ attachments: [{ url: 'https://gchat.qpic.cn/v.mp3', filename: 'V.mp3', content_type: 'audio/mpeg' }] }] }).length === 0);
check('a quoted picture with no url is skipped', promote({ msgElements: [{ attachments: [{ filename: 'A.jpg', content_type: 'image/jpeg' }] }] }).length === 0);

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
