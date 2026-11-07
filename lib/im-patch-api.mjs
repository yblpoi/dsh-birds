import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  findDshImBundles,
  isPatched,
  patchDshImSource,
  UnsupportedBundleError,
  MARKER,
} from './dsh-im-patch.mjs';

/**
 * 设置页里那个「给 dsh-im 打补丁」按钮的宿主侧实现。
 *
 * 为什么需要它：补 dsh-im 引用图的那段变换原先只在终端里跑
 * （scripts/patch-dsh-im.mjs）。手机上没有终端，桌面用户也不该为一个小开关开
 * 终端，所以插件把同一件事暴露成三条 HTTP 路由，浏览器半体（client.js）画卡。
 * 变换实现放在 lib/dsh-im-patch.mjs：运行时不能依赖 scripts/，有的装机方式只搬
 * lib/，那样插件会整块 import 失败（真机踩过）。
 *
 *   GET  /api/dsh-birds/dsh-im           当前状态（找到哪些 bundle、是否已打补丁、备份）
 *   POST /api/dsh-birds/dsh-im/patch     打补丁
 *   POST /api/dsh-birds/dsh-im/restore   用最近的备份还原
 *
 * 安全边界：只接受本机回环请求；变更类端点还要求同源证据（Sec-Fetch-Site /
 * Origin / 宿主 Cookie）。这段逻辑是照着 @hyzyn/dsh-kit 的 http 工具重写的，
 * 不引新依赖。
 */

/** 三条路由共同的路径前缀；浏览器半体按这个常量发请求。 */
export const ROUTE_PREFIX = '/api/dsh-birds/dsh-im';

const BACKUP_RE = /^index\.js\.orig-[0-9a-f]{8}$/u;

/** DSH 家目录：宿主进程一般会带 DSH_HOME，缺省回落到 ~/.dsh。 */
export function resolveHome(home) {
  if (typeof home === 'string' && home.trim() !== '') return path.resolve(home.trim());
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return path.resolve(process.env.DSH_HOME.trim());
  }
  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return path.join(userHome, '.dsh');
}

async function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 给设置页看的路径：家目录缩成 ~，手机上那一长串 prefix 不再占满一行。 */
function displayPath(absolute, home) {
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return absolute.startsWith(prefix) ? '~' + path.sep + absolute.slice(prefix.length) : absolute;
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** dsh-im 自己的版本号（package.json 就在 bundle 的上两级）。 */
async function dshImVersion(bundle) {
  const pkgFile = path.join(path.dirname(path.dirname(bundle)), 'package.json');
  const text = await readText(pkgFile);
  if (text === undefined) return undefined;
  try {
    const pkg = JSON.parse(text);
    return typeof pkg?.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** 同一目录下这个脚本写过的备份，最新的排前面。 */
async function listBackups(bundle) {
  const dir = path.dirname(bundle);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const prefix = path.basename(bundle) + '.orig-';
  const backups = [];
  for (const name of names) {
    if (!BACKUP_RE.test(name) || !name.startsWith(prefix)) continue;
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) backups.push({ path: file, name, mtime: stat.mtimeMs, bytes: stat.size });
    } catch {
      // 读不到就当作没有。
    }
  }
  backups.sort((a, b) => b.mtime - a.mtime);
  return backups;
}

/** 找到 bundle 的状态；读不了源码时保留 error 供设置页显示。 */
async function describeBundle(bundle, home) {
  const entry = {
    path: bundle,
    displayPath: displayPath(bundle, home),
    version: await dshImVersion(bundle),
    patched: false,
    backups: [],
    error: undefined,
  };
  try {
    const source = await fs.readFile(bundle, 'utf8');
    entry.patched = isPatched(source);
    entry.bytes = Buffer.byteLength(source);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  entry.backups = (await listBackups(bundle)).map((backup) => ({
    name: backup.name,
    path: backup.path,
    displayPath: displayPath(backup.path, home),
    mtime: backup.mtime,
  }));
  return entry;
}

/** 插件自己的版本，设置卡上要显示。 */
async function pluginVersion() {
  const text = await readText(new URL('../package.json', import.meta.url));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text)?.version;
  } catch {
    return undefined;
  }
}

/** GET 的返回体：找到几个 dsh-im、各自状态。 */
export async function statusPayload({ home } = {}) {
  const resolved = resolveHome(home);
  const bundles = await findDshImBundles(resolved);
  const described = [];
  for (const bundle of bundles) described.push(await describeBundle(bundle, resolved));
  const version = await pluginVersion();
  return {
    ok: true,
    pluginVersion: version,
    home: resolved,
    marker: MARKER,
    bundles: described,
    // 客户端据此决定按钮文案：全部都打过补丁就没有「注入」可点。
    patched: described.length > 0 && described.every((entry) => entry.patched),
    found: described.length,
  };
}

/** 临时文件 + rename，避免写到一半被宿主读到半截 bundle。 */
async function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.dsh-birds-' + String(process.pid) + '-' + String(Date.now()));
  let mode = 0o644;
  try {
    mode = (await fs.stat(file)).mode & 0o777;
  } catch {
    // 文件不在就按 0644 建。
  }
  await fs.writeFile(tmp, text, { encoding: 'utf8', mode });
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function patchOne(bundle) {
  const source = await fs.readFile(bundle, 'utf8');
  if (isPatched(source)) {
    return { bundle, changed: false, reason: '已经打过补丁（文件里有 ' + MARKER + '）' };
  }
  let patched;
  try {
    patched = patchDshImSource(source);
  } catch (error) {
    if (error instanceof UnsupportedBundleError) {
      return { bundle, changed: false, error: error.message };
    }
    throw error;
  }
  const backup = bundle + '.orig-' + (await sha256(source)).slice(0, 8);
  try {
    await fs.stat(backup);
  } catch {
    await fs.writeFile(backup, source, { encoding: 'utf8', mode: 0o644 });
  }
  await writeAtomic(bundle, patched);
  return { bundle, changed: true, backup };
}

/** POST /patch：给每个找到的 dsh-im 打补丁（幂等）。 */
export async function patchAll({ home } = {}) {
  const resolved = resolveHome(home);
  const bundles = await findDshImBundles(resolved);
  const results = [];
  for (const bundle of bundles) {
    try {
      results.push(await patchOne(bundle));
    } catch (error) {
      results.push({ bundle, changed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: true,
    home: resolved,
    changed: results.filter((entry) => entry.changed).length,
    bundles: bundles.length,
    results,
    restartRequired: results.some((entry) => entry.changed),
  };
}

/** POST /restore：用最近的备份还原；没有备份就跳过。 */
export async function restoreAll({ home } = {}) {
  const resolved = resolveHome(home);
  const bundles = await findDshImBundles(resolved);
  const results = [];
  for (const bundle of bundles) {
    try {
      const backups = await listBackups(bundle);
      if (backups.length === 0) {
        results.push({ bundle, restored: false, reason: '没有找到备份（这个脚本写的备份名是 index.js.orig-xxxxxxxx）' });
        continue;
      }
      const source = await fs.readFile(backups[0].path, 'utf8');
      // 备份留着不动（下次还能再还原），但内容已经一致时就不必重写：
      // 连续点两次「还原」应当是幂等的。
      const current = await fs.readFile(bundle, 'utf8');
      if (current === source) {
        results.push({ bundle, restored: false, reason: '当前文件和备份一致，不需要还原。' });
        continue;
      }
      await writeAtomic(bundle, source);
      results.push({ bundle, restored: true, backup: backups[0].path });
    } catch (error) {
      results.push({ bundle, restored: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    ok: true,
    home: resolved,
    restored: results.filter((entry) => entry.restored).length,
    bundles: bundles.length,
    results,
    restartRequired: results.some((entry) => entry.restored),
  };
}

/* ------------------------------ HTTP 外壳 ------------------------------ */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return undefined;
  const bracket = /^\[([^\]]+)\]/u.exec(hostHeader);
  if (bracket !== null) return '[' + bracket[1] + ']';
  const index = hostHeader.indexOf(':');
  return (index === -1 ? hostHeader : hostHeader.slice(0, index)).toLowerCase();
}

/**
 * 只服务本机页面：远端地址必须是回环，Host 得是回环名，跨站请求直接拒绝。
 * 和 @hyzyn/dsh-kit 的 isLoopbackRequest 同一套判定，独立实现以免多一个依赖。
 */
export function isLoopbackRequest(request) {
  const remote = request?.socket?.remoteAddress;
  if (typeof remote !== 'string' || !LOOPBACK.has(remote)) return false;
  const hostname = hostnameOf(request?.headers?.host);
  if (hostname !== undefined && !LOOPBACK_HOSTS.has(hostname)) return false;
  const site = request?.headers?.['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const origin = request?.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== String(request.headers.host ?? '')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 变更类端点的同源证据：浏览器页面会带 Sec-Fetch-Site: same-origin；桌面壳的
 * 转发链会去掉这两个头，但一定带宿主 Cookie。两者都没有就拒绝。
 */
export function hasSameOriginProof(request) {
  const site = request?.headers?.['sec-fetch-site'];
  if (site === 'same-origin' || site === 'none') return true;
  const origin = request?.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).host === String(request?.headers?.host ?? '');
    } catch {
      return false;
    }
  }
  const cookie = request?.headers?.cookie;
  return typeof cookie === 'string' && cookie.trim() !== '';
}

function writeJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/** 读 JSON 体；空体当作 {}，超限或坏 JSON 返回 undefined。 */
async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      total += chunk.length;
      if (total > maxBytes) return undefined;
      chunks.push(chunk);
    }
  } catch {
    return undefined;
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function guard(request, response, method, { sameOrigin = false } = {}) {
  if (!isLoopbackRequest(request)) {
    writeJson(response, 403, { ok: false, error: '这个接口只接受本机回环请求。' });
    return false;
  }
  if ((request.method ?? 'GET').toUpperCase() !== method) {
    writeJson(response, 405, { ok: false, error: '方法不允许：用 ' + method + '。' });
    return false;
  }
  if (sameOrigin && !hasSameOriginProof(request)) {
    writeJson(response, 403, { ok: false, error: '缺少同源证据，拒绝执行变更。' });
    return false;
  }
  return true;
}

function failure(response, error) {
  const message = error instanceof Error ? error.message : String(error);
  writeJson(response, 500, { ok: false, error: message });
}

/**
 * 注册三条路由。宿主没装 webServer（CLI / 无界面的组合）时什么都不做——
 * 设置页本来也不会出现在那种场景里。
 */
export function registerDshImRoutes(ctx, { logger, home } = {}) {
  if (typeof ctx?.inject !== 'function') return undefined;
  const routes = [
    {
      kind: 'exact',
      path: ROUTE_PREFIX,
      handler: async (request, response) => {
        if (!guard(request, response, 'GET')) return;
        try {
          writeJson(response, 200, await statusPayload({ home }));
        } catch (error) {
          failure(response, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/patch',
      handler: async (request, response) => {
        if (!guard(request, response, 'POST', { sameOrigin: true })) return;
        if ((await readJsonBody(request)) === undefined) {
          writeJson(response, 400, { ok: false, error: '请求体不是合法 JSON。' });
          return;
        }
        try {
          const result = await patchAll({ home });
          if (result.bundles === 0) {
            writeJson(response, 404, { ...result, ok: false, error: '没找到 dsh-im（@xmanrui/dsh-im）。' });
            return;
          }
          writeJson(response, 200, result);
        } catch (error) {
          failure(response, error);
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTE_PREFIX + '/restore',
      handler: async (request, response) => {
        if (!guard(request, response, 'POST', { sameOrigin: true })) return;
        if ((await readJsonBody(request)) === undefined) {
          writeJson(response, 400, { ok: false, error: '请求体不是合法 JSON。' });
          return;
        }
        try {
          const result = await restoreAll({ home });
          if (result.bundles === 0) {
            writeJson(response, 404, { ...result, ok: false, error: '没找到 dsh-im（@xmanrui/dsh-im）。' });
            return;
          }
          writeJson(response, 200, result);
        } catch (error) {
          failure(response, error);
        }
      },
    },
  ];

  return ctx.inject(['webServer'], (scoped) => {
    if (typeof scoped?.effect !== 'function' || typeof scoped?.webServer?.register !== 'function') {
      logger?.debug?.('dsh-birds: webServer 不可用，设置页接口未注册');
      return undefined;
    }
    return scoped.effect(() => {
      const disposers = [];
      for (const route of routes) {
        try {
          disposers.push(scoped.webServer.register(route));
        } catch (error) {
          logger?.warn?.('dsh-birds: 注册设置页路由失败 ' + route.path + '：' + (error instanceof Error ? error.message : String(error)));
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // 卸载路径不抛。
          }
        }
      };
    }, 'dsh-birds: settings routes');
  });
}
