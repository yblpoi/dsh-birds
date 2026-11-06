#!/usr/bin/env node
/**
 * Fetch every model bundle into the models directory.
 *
 * Endpoint choices are deliberate for a phone in mainland China:
 *   - huggingface.co, cdn.jsdelivr.net and raw.githubusercontent.com are
 *     unreachable on many networks, hf-mirror.com is not;
 *   - Zenodo and GitHub Releases both work and both honour Range requests,
 *     which is what makes an interrupted mobile download resumable.
 *
 * Two hard-won quirks are encoded below:
 *   - Zenodo answers 403 to a request without a User-Agent (Node's fetch sends
 *     none by default), so every request carries an explicit one. This was the
 *     actual cause of the "HTTP 403" failure seen on a phone.
 *   - every file lists fallback endpoints, so one blocked host does not stop
 *     the whole run.
 *
 * Re-running is safe: finished files are skipped, partial ones resume, and a
 * file is only moved into place after its size and SHA-256 are verified.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, '').split('=');
  args.set(key, value ?? 'true');
}

const modelsDir = path.resolve(
  (args.get('dir') ?? process.env.DSH_BIRDS_MODELS ?? process.env.DSH_BIRD_MODELS
    ?? path.join(os.homedir(), '.dsh', 'models', 'bird'))
    .replace(/^~/, os.homedir()),
);

const HF_MIRROR = args.get('hf') ?? 'https://hf-mirror.com';
const HF_DIRECT = 'https://huggingface.co';
const ZENODO = 'https://zenodo.org/records/20703646/files';
const ZENODO_API = 'https://zenodo.org/api/records/20703646/files';
const GEOMODEL = 'https://github.com/birdnet-team/geomodel/releases/download/v3.0.4';

/** Zenodo rejects a request with no User-Agent with 403; send an explicit one. */
const USER_AGENT = args.get('ua') ?? process.env.DSH_BIRDS_UA
  ?? 'dsh-birds/0.1.0 (+https://github.com/yblpoi/dsh-birds)';
const ATTEMPTS = Math.max(1, Number(args.get('retry') ?? 3));
const IDLE_MS = Math.max(5_000, Number(args.get('idle') ?? 45_000));
const ONLY = args.get('only') ?? null;
const FORCE = args.get('force') === 'true';
const CHECK = args.get('check') === 'true';

const TARGETS = [
  {
    file: 'BirdTrace-FastViT-MA36-10K.onnx',
    urls: [
      `${HF_MIRROR}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx`,
      `${HF_DIRECT}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx`,
    ],
    bytes: 222_385_590,
    sha256: '0f2c02591ac1e85146b8964d33a174f29ecfb52334bf42e3e3bcf91743a46e31',
    note: 'BirdTrace FastViT-MA36 图片分类（10,480 类，FP32）',
  },
  {
    file: 'BirdTrace-FastViT-MA36-10K.classes.json',
    urls: [
      `${HF_MIRROR}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/classes.json`,
      `${HF_DIRECT}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/classes.json`,
    ],
    bytes: 1_000_770,
    sha256: 'db040636f828b4d676d2cd7754ca02a56784f58fa4108309fa039dde46394daa',
    note: '图片分类标签表（10480 条 {index, species_id, species_name}）',
  },
  {
    file: 'BirdNET+_V3.0-preview3.1_Global_11K_FP16_pruned.onnx',
    urls: [
      `${ZENODO}/BirdNET%2B_V3.0-preview3.1_Global_11K_FP16_pruned.onnx?download=1`,
      `${ZENODO_API}/BirdNET%2B_V3.0-preview3.1_Global_11K_FP16_pruned.onnx/content`,
    ],
    bytes: 71_528_628,
    sha256: '69cfc8db3ebec163feb6329e546eb56e1aadac2a309f1ee99aecfabd1aa9bd24',
    note: 'BirdNET+ V3 声学分类（11K 物种，FP16，32 kHz 输入）',
  },
  {
    file: 'BirdNET+_V3.0-preview3.1_Global_11K_Labels.csv',
    urls: [
      `${ZENODO}/BirdNET%2B_V3.0-preview3.1_Global_11K_Labels.csv?download=1`,
      `${ZENODO_API}/BirdNET%2B_V3.0-preview3.1_Global_11K_Labels.csv/content`,
    ],
    bytes: 809_172,
    sha256: '8124b0ea2d187104c5e2cd95a0f937165647e20349c8fd34d4d5ef991821f8f0',
    note: '声学分类标签表（分号分隔，列 id;sci_name;com_name;gbif;class;order）',
  },
  {
    file: 'BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx',
    urls: [`${GEOMODEL}/BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx`],
    bytes: 7_885_053,
    sha256: '80e410f811bf4455e6cb1a2d48e394737d3828fe943a444646778495b67e7bab',
    note: 'Geomodel V3.0.4 地理先验（14,082 分类群，FP16）',
  },
  {
    file: 'BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt',
    urls: [`${GEOMODEL}/BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt`],
    bytes: 671_823,
    sha256: '8250b457e45d43fc3e77b5cbd06a1d311baf585ab9c51ed8d42e011d98534835',
    note: 'Geomodel 标签表（TAB 分隔：species_code / scientific_name / common_name）',
  },
].filter((target) => !ONLY || target.file.includes(ONLY));

const mb = (bytes) => (bytes / 1048576).toFixed(1);
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Total size the server advertises for the whole file, when it says. */
function totalFromHeaders(response, have) {
  const match = response.headers.get('content-range')?.match(/\/(\d+)\s*$/);
  if (match) return Number(match[1]);
  const length = Number(response.headers.get('content-length') ?? 0);
  return length ? length + have : 0;
}

/** Abort when the body stops producing data rather than after a fixed wall clock. */
function idleGuard(ms) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error(`超过 ${ms / 1000}s 没有收到数据`)), ms);
  return {
    controller,
    touch() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`超过 ${ms / 1000}s 没有收到数据`)), ms);
    },
    clear() { clearTimeout(timer); },
  };
}

/** Download one URL with resume; throws on transport or HTTP failure. */
async function fetchFrom(url, target) {
  const destination = path.join(modelsDir, target.file);
  const temporary = destination + '.part';

  let have = await sizeOf(temporary);
  if (target.bytes && have >= target.bytes) have = 0; // stale or corrupt .part

  const headers = { 'User-Agent': USER_AGENT };
  if (have > 0) headers.Range = `bytes=${have}-`;

  const guard = idleGuard(IDLE_MS);
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'follow', signal: guard.controller.signal });
  } catch (error) {
    guard.clear();
    throw new Error(`连接失败：${error?.cause?.code ?? error?.message ?? error}`);
  }

  if (!response.ok && response.status !== 206) {
    guard.clear();
    const hint = response.status === 403
      ? '（对方拒绝了该请求：确认 --ua 非空，或稍后重试）'
      : response.status === 404 ? '（地址失效或模型已迁移）'
      : response.status >= 500 ? '（对方服务器问题，稍后重试）'
      : '';
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} ${response.statusText} ${hint}`.trim());
  }
  if (have > 0 && response.status !== 206) have = 0; // server ignored Range

  const total = target.bytes || totalFromHeaders(response, have);
  const sink = fs.createWriteStream(temporary, { flags: have > 0 ? 'a' : 'w' });

  let received = have;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    guard.touch();
    const now = Date.now();
    if (now - lastReport > 1000) {
      lastReport = now;
      const progress = total ? ((received / total) * 100).toFixed(1) + '%' : '?';
      process.stdout.write(
        `\r  ${target.file}  ${mb(received)} MB / ${total ? mb(total) : '?'} MB  ${progress}   `,
      );
    }
  });

  try {
    await pipeline(body, sink);
  } catch (error) {
    guard.clear();
    throw new Error(`传输中断：${error?.message ?? error}（.part 已保留，可续传）`);
  }
  guard.clear();
  process.stdout.write('\r' + ' '.repeat(72) + '\r');

  if (target.bytes && received !== target.bytes) {
    throw new Error(`大小不符：期望 ${target.bytes} 字节，收到 ${received} 字节（.part 已保留，可续传）`);
  }
  if (target.sha256) {
    const actual = await sha256Of(temporary);
    if (actual !== target.sha256) {
      await fsp.rm(temporary, { force: true });
      throw new Error(`SHA-256 不符：期望 ${target.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…（已删除 .part）`);
    }
  }
  await fsp.rename(temporary, destination);
  return url;
}

/** Walk the endpoint list, retrying transient failures with backoff. */
async function download(target) {
  const destination = path.join(modelsDir, target.file);
  const temporary = destination + '.part';

  const finished = await sizeOf(destination);
  if (finished > 0 && !FORCE) {
    if (!target.bytes || finished === target.bytes) {
      console.log(`skip  ${target.file}（${mb(finished)} MB 已存在）`);
      return { status: 'skip' };
    }
    console.log(`redo  ${target.file}（已有文件大小不符：${finished} ≠ ${target.bytes}，重新下载）`);
    await fsp.rm(destination, { force: true });
  } else if (finished > 0 && FORCE) {
    await fsp.rm(destination, { force: true });
    await fsp.rm(temporary, { force: true });
  }

  const errors = [];
  for (const url of target.urls) {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        await fetchFrom(url, target);
        console.log(`done  ${target.file}  ← ${hostOf(url)}`);
        return { status: 'done' };
      } catch (error) {
        const reason = error?.message ?? String(error);
        // 4xx (except 429) will not fix itself: move on to the next endpoint.
        const retryable = !/^HTTP 4\d\d/.test(reason) || /^HTTP 429/.test(reason);
        errors.push(`${hostOf(url)}：${reason}`);
        if (retryable && attempt < ATTEMPTS) {
          const wait = 1000 * 2 ** (attempt - 1);
          console.log(`  retry ${attempt}/${ATTEMPTS - 1}  ${reason}  → ${wait / 1000}s 后重试`);
          await sleep(wait);
          continue;
        }
        console.log(`  fail  ${reason}`);
        break;
      }
    }
  }
  console.log(`FAIL  ${target.file}`);
  return { status: 'fail', errors };
}

/** Probe every endpoint without writing anything, so a blocked host is obvious. */
async function checkAll() {
  console.log(`探测下载线路（不写任何文件）\n`);
  let blockedFiles = 0;
  for (const target of TARGETS) {
    console.log(target.file);
    let reachable = 0;
    for (const url of target.urls) {
      const started = Date.now();
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' },
          redirect: 'follow',
          signal: AbortSignal.timeout(IDLE_MS),
        });
        const elapsed = Date.now() - started;
        const range = response.headers.get('content-range') ?? '';
        const total = Number(range.match(/\/(\d+)\s*$/)?.[1] ?? 0);
        const where = `${hostOf(url)} → ${hostOf(response.url)}`;
        await response.body?.cancel().catch(() => {});
        if (response.ok || response.status === 206) {
          reachable += 1;
          console.log(`  ✓ ${response.status}  ${where}  ${mb(total)} MB  ${elapsed}ms`);
        } else {
          console.log(`  ✗ ${response.status}  ${where}  ${elapsed}ms`);
        }
      } catch (error) {
        console.log(`  ✗ 连接失败  ${hostOf(url)}  ${error?.cause?.code ?? error?.message ?? error}`);
      }
    }
    if (reachable === 0) blockedFiles += 1;
    console.log(reachable ? `  → 可用线路 ${reachable}/${target.urls.length}\n` : `  → 该文件所有线路都不通\n`);
  }
  if (blockedFiles === 0) {
    console.log('全部文件的下载线路至少有一条可用，直接运行下载即可。');
  } else {
    console.log(`${blockedFiles} 个文件没有任何可用线路：换网络（例如关掉代理/VPN）后再试，或用 --hf= 指定镜像。`);
  }
  return blockedFiles;
}

if (CHECK) {
  const blocked = await checkAll();
  process.exit(blocked === 0 ? 0 : 1);
}

await fsp.mkdir(modelsDir, { recursive: true });
console.log(`模型目录：${modelsDir}`);
console.log(`下载来源：hf-mirror / huggingface / zenodo / github`);
console.log(`可用参数：--dir=<目录> --only=<文件名片段> --hf=<镜像> --retry=<次数> --force --ua=<User-Agent>\n`);

const results = [];
for (const target of TARGETS) {
  console.log(`== ${target.note}`);
  try {
    results.push({ target, ...(await download(target)) });
  } catch (error) {
    results.push({ target, status: 'fail', errors: [error?.message ?? String(error)] });
    console.log(`FAIL  ${target.file}`);
  }
}

const failed = results.filter((entry) => entry.status === 'fail');
const skipped = results.filter((entry) => entry.status === 'skip');

console.log('');
if (failed.length === 0) {
  console.log(`全部完成：新下载 ${results.length - skipped.length} 个，已存在 ${skipped.length} 个。`);
  console.log('运行 /birdstatus 确认模型都已就绪。');
} else {
  console.log(`${failed.length} 个文件下载失败，其余已就绪：`);
  for (const entry of failed) {
    console.log(`  ✗ ${entry.target.file}`);
    for (const line of entry.errors ?? []) console.log(`      ${line}`);
  }
  console.log('');
  console.log('排查顺序：');
  console.log('  1) 只重跑失败的文件：node scripts/download-models.mjs --only=<文件名片段>');
  console.log('  2) 网络受限时换镜像：--hf=https://huggingface.co（或 https://hf-mirror.com）');
  console.log('  3) 已下好的 .part 会续传，重复运行是安全的；已完成的文件会跳过。');
}
console.log('许可证提醒：BirdTrace 为 CC-BY-NC-4.0（仅非商用），BirdNET+ 使用需遵守其 TERMS_OF_USE。');

process.exit(failed.length === 0 ? 0 : 1);
