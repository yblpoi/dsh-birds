/**
 * 设置卡：宿主侧三条路由 + 浏览器半体（client.js）的槽位注册。
 *
 * 这个测试不连真实 Host：
 *   · 路由部分把 lib/im-patch-api.mjs 挂在一个假 ctx 上，用假 dsh-im 安装目录
 *     跑一遍「看状态 → 打补丁 → 再打一次（幂等）→ 还原」；
 *   · 浏览器半体用桩 window.__ModuleLoader__ 加载，断言它注册的槽名/key，
 *     并直接调用纯展示函数（summarize / cardModel）检查各种状态的文案。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log('OK   ' + label);
  else {
    failures += 1;
    console.log('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail));
  }
}

// 与 scripts/patch-dsh-im.mjs 里的定位点保持一致；改那边时这里也要跟着改。
const FUNCTION_ANCHOR = 'function rY(n,{fetchImpl:t=fetch}={}){';
const RETURN_ANCHOR = 'let e=iY(n);return{content:aC(n),images:o,files:a,...e?{replyTo:e}:{}}';

const MINI_BUNDLE = [
  'function aC(n){return n?.ok===true?"ok":"no";}',
  'function iY(n){return null;}',
  'function hs(u,o){return Promise.resolve(new Uint8Array([1]));}',
  'const kVe=["qpic.cn"];',
  FUNCTION_ANCHOR,
  'let o=[];let a=[];',
  RETURN_ANCHOR + ';',
  '}',
].join('\n');

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-home-'));
  const dir = path.join(home, 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '5.8.0' }));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), MINI_BUNDLE);
  return { home, bundle: path.join(dir, 'lib', 'index.js') };
}

function makeRequest({ method = 'GET', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: Object.assign({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }, headers),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeResponse() {
  return {
    headersSent: false,
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(text) {
      this.body = typeof text === 'string' ? text : '';
    },
    json() {
      try {
        return JSON.parse(this.body);
      } catch {
        return undefined;
      }
    },
  };
}

async function call(route, options) {
  const request = makeRequest(options);
  const response = makeResponse();
  await route.handler(request, response);
  return response;
}

/* ------------------------------ 路由部分 ------------------------------ */

const api = await import('../lib/im-patch-api.mjs');
const { home, bundle } = makeHome();

check('exports the route prefix', api.ROUTE_PREFIX === '/api/dsh-birds/dsh-im', api.ROUTE_PREFIX);

const routes = [];
const routeDisposers = [];
let injectedDeps;
const fakeCtx = {
  inject(dependencies, callback) {
    injectedDeps = dependencies;
    const scoped = {
      webServer: {
        register(route) {
          routes.push(route);
          return () => {};
        },
      },
      effect(callback2) {
        const disposer = callback2();
        routeDisposers.push(disposer);
        return disposer;
      },
    };
    return callback(scoped);
  },
};
const registration = api.registerDshImRoutes(fakeCtx, { home, logger: {} });
check('injects the webServer service', Array.isArray(injectedDeps) && injectedDeps.includes('webServer'), JSON.stringify(injectedDeps));
check('registers three exact routes', routes.length === 3 && routes.every((route) => route.kind === 'exact'), routes.map((r) => r.kind + ':' + r.path).join(','));
const byPath = new Map(routes.map((route) => [route.path, route]));
const statusRoute = byPath.get('/api/dsh-birds/dsh-im');
const patchRoute = byPath.get('/api/dsh-birds/dsh-im/patch');
const restoreRoute = byPath.get('/api/dsh-birds/dsh-im/restore');
check('registers the status route', statusRoute !== undefined);
check('registers the patch route', patchRoute !== undefined);
check('registers the restore route', restoreRoute !== undefined);
check('returns the effect disposer', typeof registration === 'function' || registration !== undefined);

// --- 初始状态：找到 dsh-im，未打补丁 ---
const initial = await call(statusRoute, {});
check('status answers 200', initial.status === 200, String(initial.status));
const initialBody = initial.json();
check('status finds one dsh-im', initialBody?.found === 1, JSON.stringify(initialBody?.bundles));
check('status reports plugin version 1.0.0', initialBody?.pluginVersion === '1.0.0', initialBody?.pluginVersion);
check('status reports the dsh-im version', initialBody?.bundles?.[0]?.version === '5.8.0', JSON.stringify(initialBody?.bundles?.[0]));
check('status starts unpatched', initialBody?.patched === false && initialBody?.bundles?.[0]?.patched === false);
check('status starts with no backup', Array.isArray(initialBody?.bundles?.[0]?.backups) && initialBody.bundles[0].backups.length === 0);
check('status stores no-store', initial.headers['cache-control'] === 'no-store', JSON.stringify(initial.headers));

// --- 守卫：非回环、跨站、方法不符、缺同源证据 ---
const remote = await call(statusRoute, { headers: { host: '127.0.0.1:3080' } });
check('a loopback request passes', remote.status === 200, String(remote.status));

const nonLoopback = makeRequest({});
nonLoopback.socket.remoteAddress = '10.0.0.9';
const outsideResponse = makeResponse();
await statusRoute.handler(nonLoopback, outsideResponse);
check('a non-loopback caller gets 403', outsideResponse.status === 403, String(outsideResponse.status));

const crossSite = await call(statusRoute, { headers: { 'sec-fetch-site': 'cross-site' } });
check('a cross-site request gets 403', crossSite.status === 403, String(crossSite.status));

const wrongMethod = await call(statusRoute, { method: 'POST' });
check('the status route only accepts GET', wrongMethod.status === 405, String(wrongMethod.status));

const noProof = await call(patchRoute, { method: 'POST', headers: { 'sec-fetch-site': '', cookie: '' }, body: '{}' });
check('a mutation without same-origin proof gets 403', noProof.status === 403, String(noProof.status));

const badJson = await call(patchRoute, { method: 'POST', body: 'not json' });
check('a malformed body gets 400', badJson.status === 400, String(badJson.status));

// --- 打补丁 ---
const patched = await call(patchRoute, { method: 'POST', body: '{}' });
const patchedBody = patched.json();
check('patch answers 200', patched.status === 200, String(patched.status));
check('patch reports one changed bundle', patchedBody?.changed === 1, JSON.stringify(patchedBody));
check('patch asks for a restart', patchedBody?.restartRequired === true);
check('the bundle really contains the marker', fs.readFileSync(bundle, 'utf8').includes('__qbQuotedMedia'));
check('a backup was written', fs.readdirSync(path.dirname(bundle)).some((name) => /^index\.js\.orig-[0-9a-f]{8}$/u.test(name)), fs.readdirSync(path.dirname(bundle)).join(','));

const afterPatch = await call(statusRoute, {});
check('status now reports patched', afterPatch.json()?.patched === true, JSON.stringify(afterPatch.json()?.bundles?.[0]));
check('status now lists a backup', afterPatch.json()?.bundles?.[0]?.backups?.length === 1);

const patchedAgain = await call(patchRoute, { method: 'POST', body: '{}' });
check('patching twice is idempotent', patchedAgain.json()?.changed === 0, JSON.stringify(patchedAgain.json()));

// --- 还原 ---
const restored = await call(restoreRoute, { method: 'POST', body: '{}' });
check('restore answers 200', restored.status === 200, String(restored.status));
check('restore reports one restored bundle', restored.json()?.restored === 1, JSON.stringify(restored.json()));
check('restore puts the original back', fs.readFileSync(bundle, 'utf8') === MINI_BUNDLE);
check('restore also asks for a restart', restored.json()?.restartRequired === true);

const restoredAgain = await call(restoreRoute, { method: 'POST', body: '{}' });
check('restoring without a fresh backup changes nothing', restoredAgain.json()?.restored === 0, JSON.stringify(restoredAgain.json()));

// --- 找不到 dsh-im 时 ---
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-empty-'));
const emptyRoutes = [];
api.registerDshImRoutes({
  inject(_deps, callback) {
    return callback({
      webServer: { register(route) { emptyRoutes.push(route); return () => {}; } },
      effect(callback2) { return callback2(); },
    });
  },
}, { home: emptyHome, logger: {} });
const emptyStatus = await call(emptyRoutes.find((route) => route.path === '/api/dsh-birds/dsh-im'), {});
check('status with no dsh-im answers 200', emptyStatus.status === 200, String(emptyStatus.status));
check('status with no dsh-im reports zero', emptyStatus.json()?.found === 0 && emptyStatus.json()?.patched === false, JSON.stringify(emptyStatus.json()));
const emptyPatch = await call(emptyRoutes.find((route) => route.path === '/api/dsh-birds/dsh-im/patch'), { method: 'POST', body: '{}' });
check('patch with no dsh-im answers 404', emptyPatch.status === 404, String(emptyPatch.status));
check('patch with no dsh-im explains why', typeof emptyPatch.json()?.error === 'string' && emptyPatch.json().error.includes('dsh-im'), JSON.stringify(emptyPatch.json()));

// --- 认不出的构建产物：不写坏文件 ---
const oddHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-birds-odd-'));
const oddDir = path.join(oddHome, 'profiles', 'web', 'node_modules', '@xmanrui', 'dsh-im');
fs.mkdirSync(path.join(oddDir, 'lib'), { recursive: true });
fs.writeFileSync(path.join(oddDir, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', version: '9.9.9' }));
fs.writeFileSync(path.join(oddDir, 'lib', 'index.js'), 'export const nothing = 1;\n');
const oddRoutes = [];
api.registerDshImRoutes({
  inject(_deps, callback) {
    return callback({
      webServer: { register(route) { oddRoutes.push(route); return () => {}; } },
      effect(callback2) { return callback2(); },
    });
  },
}, { home: oddHome, logger: {} });
const oddPatch = await call(oddRoutes.find((route) => route.path === '/api/dsh-birds/dsh-im/patch'), { method: 'POST', body: '{}' });
const oddBody = oddPatch.json();
check('an unknown bundle does not get patched', oddBody?.changed === 0, JSON.stringify(oddBody));
check('an unknown bundle keeps its bytes', fs.readFileSync(path.join(oddDir, 'lib', 'index.js'), 'utf8') === 'export const nothing = 1;\n');
check('an unknown bundle explains the mismatch', typeof oddBody?.results?.[0]?.error === 'string' && oddBody.results[0].error.includes('认不出'), JSON.stringify(oddBody?.results));

/* --------------------------- 浏览器半体部分 --------------------------- */

let loaded;
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
};
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', clientSource)(fakeWindow);
check('client bundle registers itself with the module loader', loaded?.id === 'dsh-birds', loaded?.id);

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
  forwardRef(fn) {
    return fn;
  },
};
const clientExports = loaded.factory((id) => {
  if (id === 'react') return reactStub;
  if (id === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('this host has no primitives');
  throw new Error('unexpected require: ' + id);
});
check('client injects the slots service', Array.isArray(clientExports.inject) && clientExports.inject.includes('slots'), JSON.stringify(clientExports.inject));
check('client exports apply()', typeof clientExports.apply === 'function');

const injectedSlots = [];
const slotRegistrations = [];
const slotsCtx = {
  slots: {
    inject(name, callback) {
      injectedSlots.push(name);
      return callback();
    },
    register(definition, component) {
      slotRegistrations.push({ definition, component });
      return () => {};
    },
  },
};
clientExports.apply(slotsCtx);
const bundleConfig = slotRegistrations.find((entry) => entry.definition.name === 'plugins.bundle.config');
check('registers the bundle config card', bundleConfig !== undefined, JSON.stringify(slotRegistrations.map((entry) => entry.definition)));
check('the bundle config key is the package name', bundleConfig?.definition?.key === 'dsh-birds', bundleConfig?.definition?.key);
const rowKeys = slotRegistrations.filter((entry) => entry.definition.name === 'plugins.row.config').map((entry) => entry.definition.key);
check('registers the row config card under both row ids', rowKeys.includes('dsh-birds#dsh-birds') && rowKeys.includes('dsh-birds#birds'), rowKeys.join(','));
check('keeps the legacy settings slot', slotRegistrations.some((entry) => entry.definition.name === 'settings.plugin.item'));
check('every slot registers the same component', slotRegistrations.every((entry) => typeof entry.component === 'function'));
check('the summary view stays empty', bundleConfig.component({ view: 'summary' }) === null);

const applyWithoutSlots = () => clientExports.apply({});
check('apply() survives a host without slots', applyWithoutSlots() === undefined);

const model = clientExports.__test;
check('exposes the api path', model.API === '/api/dsh-birds/dsh-im', model.API);

const summary = model.summarize({
  bundles: [{ patched: true, backups: [{ name: 'b' }] }, { patched: false, backups: [], error: '认不出' }],
});
check('summarize counts patched bundles', summary.total === 2 && summary.patchedCount === 1 && summary.allPatched === false, JSON.stringify(summary));
check('summarize counts backups', summary.backupCount === 1);
check('summarize collects unsupported bundles', summary.unsupported.length === 1);

const loading = model.cardModel({ phase: 'loading' }, null);
check('loading state says it is reading', loading.statusText.includes('正在读取') && loading.canPatch === false, loading.statusText);

const errored = model.cardModel({ phase: 'error', error: 'ECONNREFUSED' }, null);
check('error state surfaces the message', errored.tone === 'error' && errored.statusText.includes('ECONNREFUSED'), errored.statusText);

const emptyState = model.cardModel({ phase: 'ready', data: { bundles: [], pluginVersion: '1.0.0' } }, null);
check('empty state points at dsh-im', emptyState.tone === 'warning' && emptyState.statusText.includes('dsh-im'), emptyState.statusText);
check('empty state disables both buttons', emptyState.canPatch === false && emptyState.canRestore === false);

const readyState = model.cardModel({
  phase: 'ready',
  data: {
    pluginVersion: '1.0.0',
    bundles: [{ displayPath: '~/x/index.js', version: '5.8.0', patched: false, backups: [] }],
  },
}, null);
check('unpatched state offers the patch button', readyState.canPatch === true, JSON.stringify(readyState));
check('unpatched state has nothing to restore', readyState.canRestore === false);
check('unpatched state lists the bundle path', readyState.detailLines.some((line) => line.text.includes('~/x/index.js')), JSON.stringify(readyState.detailLines));
check('the card carries the plugin version', readyState.pluginVersion === '1.0.0');

const doneState = model.cardModel({
  phase: 'ready',
  data: { bundles: [{ displayPath: '~/x/index.js', patched: true, backups: [{ displayPath: '~/x/index.js.orig-1234abcd' }] }] },
}, null);
check('patched state is a success', doneState.tone === 'success' && doneState.canPatch === false, JSON.stringify(doneState));
check('patched state offers restore', doneState.canRestore === true);
check('patched state shows the backup', doneState.detailLines.some((line) => line.text.includes('orig-1234abcd')), JSON.stringify(doneState.detailLines));

const busyState = model.cardModel({ phase: 'ready', data: { bundles: [{ patched: false, backups: [] }] } }, 'patch');
check('a running patch disables the buttons', busyState.canPatch === false && busyState.canRestore === false);
check('a running patch says so', busyState.statusText.includes('正在写入'), busyState.statusText);

if (failures > 0) {
  console.log('\n' + failures + ' FAILURES');
  process.exitCode = 1;
} else {
  console.log('\nall settings checks passed');
}
