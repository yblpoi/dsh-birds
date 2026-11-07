import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ffmpegInstallPath, ffmpegTargetFor } from './provision.mjs';

const execFileAsync = promisify(execFile);

/**
 * Locating ffmpeg, in the order that keeps a stock phone working:
 *
 *   1. config.ffmpegPath, 2. $DSH_BIRDS_FFMPEG,
 *   3. the copy this plugin provisioned under <modelsDir>/bin,
 *   4. whatever is on PATH (a desktop that has one already).
 *
 * Step 3 is the one that removed the "apt install ffmpeg" step: the plugin
 * downloads a static build for its own platform, so a PRoot phone with no
 * package manager access still decodes mp3/m4a and still has the image
 * fallback when sharp is unavailable.
 *
 * Everything here is lazy on purpose. Resolving ffmpeg may mean a 50 MB
 * download, so it happens when the first file actually needs it, not when the
 * Host boots.
 */

let settings = {
  modelsDir: path.join(os.homedir(), '.dsh', 'models', 'bird'),
  explicitPath: undefined,
  provisioner: undefined,
  logger: console,
};

/** Point the ffmpeg lookup at the same models directory the plugin uses. */
export function configureFfmpeg(next = {}) {
  settings = { ...settings, ...next };
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Where this plugin would put the binary it downloaded itself. */
export function provisionedFfmpegPath(modelsDir = settings.modelsDir) {
  return ffmpegInstallPath(modelsDir, process.platform);
}

/**
 * The first usable local ffmpeg, without touching the network.
 * Returns undefined when nothing is installed yet.
 */
export function localFfmpegPath() {
  const candidates = [
    { path: settings.explicitPath, source: 'config' },
    { path: process.env.DSH_BIRDS_FFMPEG, source: 'env' },
    { path: provisionedFfmpegPath(), source: 'provisioned' },
  ];
  for (const candidate of candidates) {
    if (candidate.path && exists(candidate.path)) return candidate;
  }
  return undefined;
}

/** Report what would be executed, for /birdstatus and error messages. */
export function ffmpegInfo() {
  const local = localFfmpegPath();
  if (local) return { ...local, bundled: local.source !== 'system' };
  const target = ffmpegTargetFor();
  return {
    path: undefined,
    source: target.unsupported ? 'unsupported' : 'missing',
    target,
    destination: provisionedFfmpegPath(),
  };
}

/** True when some ffmpeg can be executed right now (local first, then PATH). */
export async function ffmpegAvailable() {
  if (localFfmpegPath()) return true;
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure the plugin's own ffmpeg exists, downloading it if needed.
 * Returns the path, or undefined when this platform has no shipped build.
 */
export async function ensureFfmpeg() {
  const local = localFfmpegPath();
  if (local) return local.path;
  const target = ffmpegTargetFor();
  if (target.unsupported) {
    settings.logger?.warn?.('该平台没有随插件分发的 ffmpeg：' + process.platform + '/' + process.arch);
    return undefined;
  }
  if (!settings.provisioner) return undefined;
  await settings.provisioner.ensureFfmpeg();
  return localFfmpegPath()?.path;
}

/**
 * Run ffmpeg and stay honest about where it came from.
 *
 * A missing binary is not a dead end: the plugin provisions one and retries
 * once, so the first /birds on a fresh install decodes its file instead of
 * telling the user to install packages.
 */
export async function runFfmpeg(args, options = {}) {
  const local = localFfmpegPath();
  const command = local?.path ?? 'ffmpeg';
  try {
    return await execFileAsync(command, args, options);
  } catch (error) {
    if (error?.code !== 'ENOENT' || local) throw error;
    const provisioned = await ensureFfmpeg().catch(() => undefined);
    if (!provisioned) throw error;
    return execFileAsync(provisioned, args, options);
  }
}

/** A short human-readable description of the ffmpeg situation for status text. */
export function describeFfmpeg(info = ffmpegInfo()) {
  if (info.path) {
    const where = info.source === 'provisioned' ? '插件自带' : info.source === 'config' ? '配置指定' : '环境变量指定';
    return where + '：' + info.path;
  }
  if (info.source === 'unsupported') return '未支持：该平台没有随插件分发的 ffmpeg 二进制';
  return '未就绪：' + (info.destination ?? '');
}
