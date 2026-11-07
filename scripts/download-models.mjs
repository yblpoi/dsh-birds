#!/usr/bin/env node
/**
 * Optional command-line front end for the downloader the plugin already runs
 * by itself when it loads.
 *
 * Installing the plugin is the whole setup: models and the bundled ffmpeg land
 * in the models directory in the background, so nobody has to run this file.
 * It stays around for the cases a background job cannot serve — a machine
 * behind a mirror that needs `--hf=`, a single file that failed, or a
 * `--check` that proves which endpoints this network can actually reach
 * without writing anything.
 */
import process from 'node:process';
import {
  Provisioner,
  modelTargets,
  ffmpegTargetFor,
  ffmpegInstallPath,
  mb,
  USER_AGENT,
  DEFAULT_HF_MIRROR,
} from '../lib/provision.mjs';
import { resolveModelsDir } from '../lib/paths.mjs';

const HELP = `用法：node scripts/download-models.mjs [选项]

插件加载时会自动下载模型和 ffmpeg，这个脚本只是可选的手动入口。

  --dir=<目录>     模型目录（默认 ~/.dsh/models/bird）
  --check          只探测所有下载线路，不写任何文件
  --only=<子串>    只处理文件名包含该子串的模型（如 --only=BirdNET）
  --ffmpeg         只下载 ffmpeg
  --models-only    只下载模型，跳过 ffmpeg
  --hf=<镜像>      Hugging Face 镜像，默认 ${DEFAULT_HF_MIRROR}
  --retry=<次数>   每条线路的重试次数，默认 3
  --idle=<毫秒>    下载空闲超时，默认 45000
  --force          已存在且大小正确的文件也重下
  --ua=<字符串>    覆盖 User-Agent（Zenodo 需要非 node 的 UA）
  -h, --help       显示这段帮助
`;

function parseArgs(argv) {
  const options = { check: false, force: false, mode: 'all', only: null };
  for (const argument of argv) {
    if (argument === '--check') options.check = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--ffmpeg') options.mode = 'ffmpeg';
    else if (argument === '--models-only') options.mode = 'models';
    else if (argument === '-h' || argument === '--help') options.help = true;
    else if (argument.startsWith('--dir=')) options.dir = argument.slice(6);
    else if (argument.startsWith('--only=')) options.only = argument.slice(7);
    else if (argument.startsWith('--hf=')) options.hfMirror = argument.slice(5);
    else if (argument.startsWith('--retry=')) options.retry = Number(argument.slice(8));
    else if (argument.startsWith('--idle=')) options.idleMs = Number(argument.slice(7));
    else if (argument.startsWith('--ua=')) options.userAgent = argument.slice(5);
    else throw new Error('未知参数：' + argument + '（用 --help 看用法）');
  }
  return options;
}

/** One Range probe: enough to learn the status code and the size, no writes. */
async function probe(url, userAgent, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': userAgent, range: 'bytes=0-0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    const total = Number(response.headers.get('content-range')?.split('/')?.[1]
      ?? response.headers.get('content-length')
      ?? 0);
    await response.body?.cancel?.();
    return { ok: response.ok || response.status === 206, status: response.status, total, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 0, total: 0, elapsedMs: Date.now() - startedAt, message: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function check({ modelsDir, hfMirror, userAgent, only, mode }) {
  const wantsModels = mode !== 'ffmpeg';
  const wantsFfmpeg = mode !== 'models';
  const targets = [
    ...(wantsModels
      ? modelTargets({ hfMirror })
        .filter((target) => (only ? target.file.includes(only) : true))
        .map((target) => ({ name: target.file, bytes: target.bytes, urls: target.urls }))
      : []),
    ...(wantsFfmpeg
      ? [(() => {
        const binary = ffmpegTargetFor(process.platform, process.arch);
        return { name: binary.asset ?? binary.file, bytes: binary.bytes, urls: binary.urls, path: ffmpegInstallPath(modelsDir) };
      })()]
      : []),
  ];
  if (targets.length === 0) {
    console.log('没有匹配的文件。');
    return 0;
  }
  let broken = 0;
  for (const target of targets) {
    console.log(target.name + '  ' + mb(target.bytes) + ' MB');
    let reachable = false;
    for (const url of target.urls) {
      const result = await probe(url, userAgent);
      const host = new URL(url).host;
      if (result.ok) {
        reachable = true;
        console.log('  ✓ ' + result.status + ' ' + host + '  ' + mb(result.total) + ' MB  ' + result.elapsedMs + 'ms');
      } else {
        console.log('  ✗ ' + (result.status || '') + ' ' + host + '  ' + (result.message ?? ''));
      }
    }
    if (!reachable) broken += 1;
    console.log('');
  }
  console.log(broken === 0 ? '所有文件都至少有一条线路可用。' : broken + ' 个文件的所有线路都不通。');
  return broken === 0 ? 0 : 1;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const modelsDir = resolveModelsDir(options.dir);
  const hfMirror = options.hfMirror ?? DEFAULT_HF_MIRROR;
  const userAgent = options.userAgent ?? process.env.DSH_BIRDS_UA ?? USER_AGENT;

  if (options.check) {
    console.log('模型目录：' + modelsDir + '（--check 不写文件）\n');
    return check({
      modelsDir,
      hfMirror,
      userAgent,
      only: options.only,
      mode: options.mode,
    });
  }

  const provisioner = new Provisioner({
    modelsDir,
    hfMirror,
    userAgent,
    retry: options.retry,
    idleMs: options.idleMs,
    force: options.force,
    only: options.only,
    logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
    onEvent: (event) => {
      if (event.type === 'start') {
        console.log('开始下载 ' + event.totalFiles + ' 个文件，共 ' + mb(event.totalBytes) + ' MB');
      } else if (event.type === 'file-start') {
        console.log('↓ ' + event.file + '（' + mb(event.bytes) + ' MB）' + (event.note ? ' — ' + event.note : ''));
      }
    },
  });

  const plan = provisioner.plan();
  if (options.mode === 'models') await provisioner.ensureModels();
  else if (options.mode === 'ffmpeg') await provisioner.ensureFfmpeg();
  else await provisioner.start();

  const state = provisioner.status();
  for (const result of state.results) {
    console.log((result.skipped ? '✓ 已存在 ' : '✓ 已下载 ') + result.file);
  }
  for (const failure of state.errors) {
    console.warn('✗ ' + failure.file + '：' + failure.message);
  }
  console.log('');
  console.log('模型目录：' + modelsDir);
  console.log('ffmpeg：' + plan.ffmpegPath);
  if (state.errors.length > 0) {
    console.log('排错顺序：1) --check 看线路  2) --only=<子串> 单独重跑  3) --hf=<镜像> 换源（.part 会续传）');
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
