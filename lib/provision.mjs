import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Provisioning: the two things /birds needs before it can answer anything —
 * the model bundle and an ffmpeg binary — are fetched by the plugin itself.
 *
 * Install scripts are not a reliable place for this. npm's current policy
 * refuses install scripts unless a human allowlists them, and a git dependency
 * that declares a postinstall fails outright (EALLOWSCRIPTS) on the npm that
 * ships with this toolchain; a phone profile has no way to approve one
 * interactively. So provisioning runs here instead: the plugin starts it in the
 * background as soon as the Host loads it, /birdstatus reports progress, and
 * the first /birds waits for whatever is left. A user never runs a script and
 * never installs ffmpeg from a distro repository.
 *
 * Endpoint choices are deliberate for a phone in mainland China:
 *   - huggingface.co, cdn.jsdelivr.net and raw.githubusercontent.com are
 *     unreachable on many networks, hf-mirror.com is not;
 *   - Zenodo and GitHub Releases both work and both honour Range requests,
 *     which is what makes an interrupted mobile download resumable;
 *   - npmmirror.com mirrors the ffmpeg-static release, so the binary does not
 *     have to come from a blocked CDN.
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

export const USER_AGENT = 'dsh-birds/0.1.0 (+https://github.com/yblpoi/dsh-birds)';
export const DEFAULT_HF_MIRROR = 'https://hf-mirror.com';

const HF_DIRECT = 'https://huggingface.co';
const ZENODO = 'https://zenodo.org/records/20703646/files';
const ZENODO_API = 'https://zenodo.org/api/records/20703646/files';
const GEOMODEL = 'https://github.com/birdnet-team/geomodel/releases/download/v3.0.4';

/** Release every ffmpeg binary below was cut from. */
export const FFMPEG_BUILD = 'b6.0';

const ffmpegUrls = (asset) => [
  `https://cdn.npmmirror.com/binaries/ffmpeg-static/${FFMPEG_BUILD}/${asset}`,
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_BUILD}/${asset}`,
];

/**
 * Static ffmpeg builds keyed by "<platform>-<arch>".
 *
 * These are the ffmpeg-static release assets: single self-contained binaries
 * (no archive, no dynamic libraries) with a fixed byte count and digest, which
 * is what makes them safe to drop next to the models and execute.
 */
export const FFMPEG_BUILDS = Object.freeze({
  'linux-arm64': {
    asset: 'ffmpeg-linux-arm64',
    bytes: 50_015_760,
    sha256: '237800b37bb65a81ad47871c6c8b7c45c0a3ca62a5b3f9d2a7a9a2dd9a338271',
  },
  'linux-x64': {
    asset: 'ffmpeg-linux-x64',
    bytes: 78_683_840,
    sha256: 'ed652b2f32e0851d1946894fb8333f5b677c1b2ce6b9d187910a67f8b99da028',
  },
  'darwin-arm64': {
    asset: 'ffmpeg-darwin-arm64',
    bytes: 45_568_216,
    sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  },
  'darwin-x64': {
    asset: 'ffmpeg-darwin-x64',
    bytes: 78_829_164,
    sha256: 'cfe20936c83ecf5d68e424b87e8cc45b24dd6be81787810123bb964a0df686f9',
  },
  'win32-x64': {
    asset: 'ffmpeg-win32-x64',
    bytes: 81_114_624,
    sha256: 'e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1',
  },
});

/** Model files, in the order they are fetched, with their fallback endpoints. */
export function modelTargets({ hfMirror = DEFAULT_HF_MIRROR } = {}) {
  return [
    {
      key: 'imageModel',
      file: 'BirdTrace-FastViT-MA36-10K.onnx',
      urls: [
        `${hfMirror}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx`,
        `${HF_DIRECT}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/model.onnx`,
      ],
      bytes: 222_385_590,
      sha256: '0f2c02591ac1e85146b8964d33a174f29ecfb52334bf42e3e3bcf91743a46e31',
      note: 'BirdTrace FastViT-MA36 图片分类（10,480 类，FP32）',
    },
    {
      key: 'imageClasses',
      file: 'BirdTrace-FastViT-MA36-10K.classes.json',
      urls: [
        `${hfMirror}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/classes.json`,
        `${HF_DIRECT}/warden123/BirdTrace-FastViT-MA36-10K/resolve/main/classes.json`,
      ],
      bytes: 1_000_770,
      sha256: 'db040636f828b4d676d2cd7754ca02a56784f58fa4108309fa039dde46394daa',
      note: '图片分类标签表（10480 条 {index, species_id, species_name}）',
    },
    {
      key: 'audioModel',
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
      key: 'audioLabels',
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
      key: 'geoModel',
      file: 'BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx',
      urls: [`${GEOMODEL}/BirdNET+_Geomodel_V3.0.4_Global_14K_FP16.onnx`],
      bytes: 7_885_053,
      sha256: '80e410f811bf4455e6cb1a2d48e394737d3828fe943a444646778495b67e7bab',
      note: 'Geomodel V3.0.4 地理先验（14,082 分类群，FP16）',
    },
    {
      key: 'geoLabels',
      file: 'BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt',
      urls: [`${GEOMODEL}/BirdNET+_Geomodel_V3.0.4_Global_14K_Labels.txt`],
      bytes: 671_823,
      sha256: '8250b457e45d43fc3e77b5cbd06a1d311baf585ab9c51ed8d42e011d98534835',
      note: 'Geomodel 标签表（TAB 分隔：species_code / scientific_name / common_name）',
    },
  ];
}

/** The ffmpeg build this host can execute, or an unsupported marker. */
export function ffmpegTargetFor(platform = process.platform, arch = process.arch) {
  const entry = FFMPEG_BUILDS[platform + '-' + arch];
  // bytes stays 0 rather than undefined: callers budget the download from it.
  if (!entry) return { platform, arch, unsupported: true, bytes: 0 };
  return { platform, arch, ...entry, urls: ffmpegUrls(entry.asset) };
}

/** ffmpeg's filename differs on Windows; everything else is plain "ffmpeg". */
export function ffmpegBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/** Where the provisioned binary lives: <modelsDir>/bin/ffmpeg(.exe). */
export function ffmpegInstallPath(modelsDir, platform = process.platform) {
  return path.join(modelsDir, 'bin', ffmpegBinaryName(platform));
}

export const mb = (bytes) => (bytes / 1048576).toFixed(1);

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const arm = () => setTimeout(
    () => controller.abort(new Error(`超过 ${ms / 1000}s 没有收到数据`)),
    ms,
  );
  let timer = arm();
  return {
    controller,
    touch() {
      clearTimeout(timer);
      timer = arm();
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

/**
 * Download one target with resume.
 *
 * The bytes only become the real file after both the length and the SHA-256
 * match, so a truncated or tampered download can never be mistaken for a model.
 */
async function fetchToFile(url, { destination, bytes, sha256, userAgent, idleMs, onProgress }) {
  const temporary = destination + '.part';

  let have = await sizeOf(temporary);
  if (bytes && have >= bytes) have = 0; // stale or corrupt .part

  const headers = { 'User-Agent': userAgent };
  if (have > 0) headers.Range = `bytes=${have}-`;

  const guard = idleGuard(idleMs);
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
      ? '（对方拒绝了该请求：确认 User-Agent 非空，或稍后重试）'
      : response.status === 404 ? '（地址失效或文件已迁移）'
        : response.status >= 500 ? '（对方服务器问题，稍后重试）'
          : '';
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status} ${response.statusText} ${hint}`.trim());
  }
  if (have > 0 && response.status !== 206) have = 0; // server ignored Range

  const total = bytes || totalFromHeaders(response, have);
  const sink = fs.createWriteStream(temporary, { flags: have > 0 ? 'a' : 'w' });

  let received = have;
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    guard.touch();
    onProgress?.({ received, total });
  });

  try {
    await pipeline(body, sink);
  } catch (error) {
    guard.clear();
    throw new Error(`传输中断：${error?.message ?? error}（.part 已保留，可续传）`);
  }
  guard.clear();

  if (bytes && received !== bytes) {
    throw new Error(`大小不符：期望 ${bytes} 字节，收到 ${received} 字节（.part 已保留，可续传）`);
  }
  if (sha256) {
    const actual = await sha256Of(temporary);
    if (actual !== sha256) {
      await fsp.rm(temporary, { force: true });
      throw new Error(`SHA-256 不符：期望 ${sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…（已删除 .part）`);
    }
  }
  await fsp.rename(temporary, destination);
  return url;
}

/** Walk a target's endpoint list, retrying transient failures with backoff. */
async function fetchTarget(target, {
  directory,
  force = false,
  attempts = 3,
  idleMs = 45_000,
  userAgent = USER_AGENT,
  onProgress,
  log = () => {},
}) {
  // The ffmpeg binary lands in <modelsDir>/bin, which does not exist on a fresh
  // install; without this the .part open fails with ENOENT (seen on device).
  await fsp.mkdir(directory, { recursive: true });
  const destination = path.join(directory, target.file);
  const temporary = destination + '.part';

  const finished = await sizeOf(destination);
  if (finished > 0 && !force) {
    if (!target.bytes || finished === target.bytes) {
      return { status: 'skip', file: target.file, bytes: finished };
    }
    log(`redo  ${target.file}（已有文件大小不符：${finished} ≠ ${target.bytes}，重新下载）`);
    await fsp.rm(destination, { force: true });
  } else if (finished > 0 && force) {
    await fsp.rm(destination, { force: true });
    await fsp.rm(temporary, { force: true });
  }

  const errors = [];
  for (const url of target.urls) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await fetchToFile(url, {
          destination,
          bytes: target.bytes,
          sha256: target.sha256,
          userAgent,
          idleMs,
          onProgress,
        });
        return { status: 'done', file: target.file, bytes: target.bytes, via: hostOf(url) };
      } catch (error) {
        const reason = error?.message ?? String(error);
        // 4xx (except 429) will not fix itself: move on to the next endpoint.
        const retryable = !/^HTTP 4\d\d/.test(reason) || /^HTTP 429/.test(reason);
        errors.push(`${hostOf(url)}：${reason}`);
        log(`  fail  ${target.file} ← ${hostOf(url)}  ${reason}`);
        if (retryable && attempt < attempts) {
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
    }
  }
  return { status: 'fail', file: target.file, errors };
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/**
 * Fetches models and ffmpeg for one models directory, and remembers how far it
 * got so /birdstatus can answer "is it downloading right now?" honestly.
 *
 * Only one process downloads at a time: a lock file next to the models stops a
 * second Host (or a manual CLI run) from writing the same .part files.
 */
export class Provisioner {
  #modelsDir;
  #logger;
  #options;
  #state;
  #task;
  #onEvent;

  constructor({
    modelsDir,
    logger,
    hfMirror,
    userAgent,
    retry,
    idleMs,
    force = false,
    platform = process.platform,
    arch = process.arch,
    only,
    onEvent,
  } = {}) {
    this.#modelsDir = modelsDir;
    this.#logger = logger ?? console;
    this.#onEvent = onEvent;
    this.#options = {
      hfMirror: hfMirror ?? DEFAULT_HF_MIRROR,
      userAgent: userAgent ?? process.env.DSH_BIRDS_UA ?? USER_AGENT,
      attempts: Math.max(1, Number(retry) || 3),
      idleMs: Math.max(5_000, Number(idleMs) || 45_000),
      force,
      platform,
      arch,
      only: typeof only === 'string' && only.length > 0 ? only : null,
    };
    this.#state = {
      running: false,
      startedAt: null,
      finishedAt: null,
      totalFiles: 0,
      doneFiles: 0,
      totalBytes: 0,
      doneBytes: 0,
      current: null,
      currentReceived: 0,
      results: [],
      errors: [],
      ffmpeg: null,
      error: null,
    };
  }

  get modelsDir() {
    return this.#modelsDir;
  }

  get platform() {
    return this.#options.platform;
  }

  get arch() {
    return this.#options.arch;
  }

  /** Snapshot for /birdstatus and logs. */
  status() {
    const { results, errors, ...rest } = this.#state;
    return { ...rest, results: [...results], errors: [...errors] };
  }

  /** What still has to be fetched before /birds can answer anything. */
  plan() {
    const models = modelTargets({ hfMirror: this.#options.hfMirror });
    const modelsMissing = [];
    for (const target of models) {
      let size = 0;
      try {
        size = fs.statSync(path.join(this.#modelsDir, target.file)).size;
      } catch {
        size = 0;
      }
      if (size !== target.bytes) modelsMissing.push(target);
    }
    const target = ffmpegTargetFor(this.#options.platform, this.#options.arch);
    const ffmpegPath = ffmpegInstallPath(this.#modelsDir, this.#options.platform);
    let ffmpegPresent = false;
    try {
      ffmpegPresent = fs.statSync(ffmpegPath).size > 0;
    } catch {
      ffmpegPresent = false;
    }
    const ffmpegMissing = !ffmpegPresent && !target.unsupported;
    return {
      modelsMissing,
      ffmpegTarget: target,
      ffmpegPath,
      ffmpegPresent,
      ffmpegMissing,
      missingBytes: modelsMissing.reduce((sum, entry) => sum + entry.bytes, 0)
        + (ffmpegMissing ? target.bytes : 0),
      ready: modelsMissing.length === 0 && !ffmpegMissing,
    };
  }

  /**
   * Start once; every later caller awaits the same task.
   *
   * The flags let a caller fetch only what is actually missing: a host that
   * already has a system ffmpeg must not spend 50 MB on a bundled copy, so the
   * plugin asks for models only and leaves the binary alone.
   */
  start({ force, models = true, ffmpeg = true } = {}) {
    if (force) this.#task = undefined;
    this.#task ??= this.#run({ force: force ?? this.#options.force, models, ffmpeg });
    return this.#task;
  }

  /** Fetch only the model bundle. */
  ensureModels() {
    return this.#run({ force: this.#options.force, models: true, ffmpeg: false });
  }

  /** Fetch only the ffmpeg binary. */
  ensureFfmpeg() {
    return this.#run({ force: this.#options.force, models: false, ffmpeg: true });
  }

  #emit(event) {
    try {
      this.#onEvent?.(event);
    } catch {
      // A progress listener must never break provisioning.
    }
  }

  #log(message) {
    this.#logger?.info?.(message);
    this.#emit({ type: 'log', message });
  }

  async #lock() {
    const lockFile = path.join(this.#modelsDir, '.provision.lock');
    try {
      const info = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
      const age = Date.now() - Number(info.startedAt ?? 0);
      if (pidAlive(Number(info.pid)) && age < 6 * 60 * 60 * 1000) {
        return { acquired: false, lockFile, owner: info };
      }
    } catch {
      // No lock, or an unreadable one: take it.
    }
    try {
      await fsp.mkdir(this.#modelsDir, { recursive: true });
      await fsp.writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      return { acquired: true, lockFile };
    } catch (error) {
      this.#logger?.warn?.('无法写入下载锁：' + (error?.message ?? error));
      return { acquired: true, lockFile: null };
    }
  }

  async #run({ force = false, models = true, ffmpeg = true } = {}) {
    const lock = await this.#lock();
    if (!lock.acquired) {
      this.#log('另一个进程正在下载模型（pid ' + lock.owner?.pid + '），这次跳过。');
      return this.status();
    }

    const all = models ? modelTargets({ hfMirror: this.#options.hfMirror }) : [];
    // --only=<substring> retries a single model file; used by the CLI.
    const candidates = this.#options.only
      ? all.filter((target) => target.file.includes(this.#options.only))
      : all;
    const wanted = candidates.filter((target) => {
      if (force) return true;
      try {
        return fs.statSync(path.join(this.#modelsDir, target.file)).size !== target.bytes;
      } catch {
        return true;
      }
    });
    const binary = ffmpeg ? ffmpegTargetFor(this.#options.platform, this.#options.arch) : null;
    const binaryBytes = binary && !binary.unsupported ? binary.bytes : 0;

    Object.assign(this.#state, {
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
      totalFiles: wanted.length + (binaryBytes ? 1 : 0),
      doneFiles: 0,
      totalBytes: wanted.reduce((sum, target) => sum + target.bytes, 0) + binaryBytes,
      doneBytes: 0,
      current: null,
      currentReceived: 0,
      results: [],
      errors: [],
      error: null,
    });
    this.#emit({ type: 'start', totalFiles: this.#state.totalFiles, totalBytes: this.#state.totalBytes });

    try {
      await fsp.mkdir(this.#modelsDir, { recursive: true });
      for (const target of wanted) {
        this.#state.current = target.file;
        this.#state.currentReceived = 0;
        this.#emit({ type: 'file-start', file: target.file, note: target.note, bytes: target.bytes });
        const settledBefore = this.#settledBytes();
        const result = await fetchTarget(target, {
          directory: this.#modelsDir,
          force,
          attempts: this.#options.attempts,
          idleMs: this.#options.idleMs,
          userAgent: this.#options.userAgent,
          log: (line) => this.#log(line),
          onProgress: ({ received, total }) => {
            this.#state.currentReceived = received;
            this.#state.doneBytes = settledBefore + received;
            this.#emit({
              type: 'progress',
              file: target.file,
              received,
              total: total || target.bytes,
              doneBytes: this.#state.doneBytes,
              totalBytes: this.#state.totalBytes,
            });
          },
        });
        this.#state.results.push(result);
        if (result.status === 'fail') {
          this.#state.errors.push({ file: target.file, errors: result.errors ?? [] });
        } else {
          this.#state.doneFiles += 1;
        }
        this.#state.doneBytes = this.#settledBytes();
        this.#log(result.status === 'fail'
          ? 'FAIL  ' + target.file
          : (result.status === 'skip' ? 'skip  ' : 'done  ') + target.file
            + (result.via ? '  ← ' + result.via : ''));
      }

      if (binary && !binary.unsupported) {
        await this.#fetchFfmpeg(binary, { force });
      }

      this.#state.finishedAt = Date.now();
      this.#state.error = this.#state.errors.length ? this.#state.errors.length + ' 个文件下载失败' : null;
      this.#emit({
        type: 'finish',
        doneFiles: this.#state.doneFiles,
        totalFiles: this.#state.totalFiles,
        errors: this.#state.errors,
        error: this.#state.error,
      });
      return this.status();
    } catch (error) {
      this.#state.error = error?.message ?? String(error);
      this.#state.finishedAt = Date.now();
      this.#logger?.error?.('provisioning failed: ' + (error?.stack ?? error));
      this.#emit({ type: 'finish', doneFiles: this.#state.doneFiles, totalFiles: this.#state.totalFiles, errors: this.#state.errors, error: this.#state.error });
      return this.status();
    } finally {
      this.#state.running = false;
      this.#state.current = null;
      if (lock.lockFile) await fsp.rm(lock.lockFile, { force: true }).catch(() => {});
    }
  }

  #settledBytes() {
    return this.#state.results.reduce((sum, entry) => sum + (entry.status === 'fail' ? 0 : entry.bytes ?? 0), 0);
  }

  async #fetchFfmpeg(binary, { force }) {
    const destination = ffmpegInstallPath(this.#modelsDir, this.#options.platform);
    const present = await sizeOf(destination);
    if (present === binary.bytes && !force) {
      this.#state.ffmpeg = { status: 'skip', path: destination, ...(await this.#ffmpegVersion(destination)) };
      this.#state.doneFiles += 1;
      this.#state.doneBytes += binary.bytes;
      this.#log('skip  ' + path.basename(destination) + '（' + mb(present) + ' MB 已存在）');
      return;
    }

    const staged = path.join(this.#modelsDir, 'bin', 'ffmpeg.download');
    this.#state.current = binary.asset;
    this.#state.currentReceived = 0;
    this.#emit({ type: 'file-start', file: binary.asset, note: 'ffmpeg 静态二进制', bytes: binary.bytes });
    const settledBefore = this.#settledBytes();
    const result = await fetchTarget({ ...binary, file: path.basename(staged) }, {
      directory: path.join(this.#modelsDir, 'bin'),
      force,
      attempts: this.#options.attempts,
      idleMs: this.#options.idleMs,
      userAgent: this.#options.userAgent,
      log: (line) => this.#log(line),
      onProgress: ({ received, total }) => {
        this.#state.currentReceived = received;
        this.#state.doneBytes = settledBefore + received;
        this.#emit({
          type: 'progress',
          file: binary.asset,
          received,
          total: total || binary.bytes,
          doneBytes: this.#state.doneBytes,
          totalBytes: this.#state.totalBytes,
        });
      },
    });

    this.#state.results.push(result);
    if (result.status === 'fail') {
      this.#state.ffmpeg = { status: 'fail', path: destination, errors: result.errors ?? [] };
      this.#state.errors.push({ file: binary.asset, errors: result.errors ?? [] });
      this.#state.doneBytes = this.#settledBytes();
      this.#log('FAIL  ' + binary.asset);
      return;
    }

    await fsp.rm(destination, { force: true });
    await fsp.rename(staged, destination);
    await fsp.chmod(destination, 0o755);
    const version = await this.#ffmpegVersion(destination);
    this.#state.ffmpeg = { status: 'done', path: destination, ...version };
    this.#state.doneFiles += 1;
    this.#state.doneBytes = this.#settledBytes();
    this.#log('done  ' + path.basename(destination) + (version.version ? '（' + version.version + '）' : ''));
  }

  /** A downloaded ffmpeg that cannot execute is worse than none: report why. */
  async #ffmpegVersion(binary) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)(binary, ['-version'], { timeout: 20_000 });
      return { version: String(stdout).split('\n')[0].trim().slice(0, 120) };
    } catch (error) {
      this.#logger?.warn?.('下载的 ffmpeg 无法执行：' + (error?.message ?? error));
      return { version: null, problem: error?.message ?? String(error) };
    }
  }
}
