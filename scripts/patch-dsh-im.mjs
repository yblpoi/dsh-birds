#!/usr/bin/env node
/**
 * 给 dsh-im 补一处「引用图片」的洞（QQ 群）。
 *
 * 起因：群里有人发图，你引用那张图发 /birds 时，插件说「引用的那条消息里的
 * 图片没有存到本机」。字节确实不在本机——但 QQ 的推送里是带着图片地址的。
 *
 *   QQ 推送 msg_elements[0].attachments[i] = { content_type, url, filename, ... }
 *   @tencent-connect/qqbot-nodejs 的 QuotedAttachment 类型也是这么定义的
 *   （src/middleware/quote-ref.ts）。也就是说 url 本来就在手上。
 *
 * 可是 dsh-im 在把这条消息交给 Harness 之前，把引用附件压成了 { kind, name }：
 *
 *   src/channels/qq/qq-bridge.mjs -> qqReplyReference()
 *   const attachments = sourceAttachments.map((a) => {
 *     const name = nonEmptyString(a?.filename);
 *     return { kind: qqAttachmentKind(a), ...(name ? { name } : {}) };
 *   });
 *
 * url 就这么被丢掉了，于是插件只能按文件名去本机历史库里找——别人发的图当然
 * 找不到。dsh-im 5.10.0 依旧如此，升级不解决。
 *
 * 这个脚本做一件事：把同一个 QQ 推送对象里的引用图片，额外塞进本条消息的
 * images 列表（和普通图片走的完全是同一条 Harness 附件通道）。这样引用图会
 * 变成真正的图片附件，/birds 和模型都看得到。
 *
 * 注意：改的是第三方插件的构建产物，dsh-im 升级或 profile 重装会覆盖掉，
 * 需要重新跑这个脚本（会自动检测是否已经打过补丁）。
 *
 * 用法：
 *   node scripts/patch-dsh-im.mjs                 # 自动找当前 profile 里的 dsh-im
 *   node scripts/patch-dsh-im.mjs --dry-run       # 只看会不会改
 *   node scripts/patch-dsh-im.mjs --bundle=/path/to/dsh-im/lib/index.js
 *   node scripts/patch-dsh-im.mjs --restore=/path/to/index.js.orig-xxxxxxxx
 *
 * 改完重启 DSH（或重启 App）才会生效。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 打过补丁的标记；也是幂等判断依据。 */
export const MARKER = '__qbQuotedMedia';

// dsh-im 5.8.0 的压缩产物里这两处各出现一次，是唯一可靠的落点。
const FUNCTION_ANCHOR = 'function rY(n,{fetchImpl:t=fetch}={}){';
const RETURN_ANCHOR = 'let e=iY(n);return{content:aC(n),images:o,files:a,...e?{replyTo:e}:{}}';
const PATCHED_RETURN = 'let e=iY(n);for(const __q of __qbQuotedMedia(n,t))o.push(__q);return{content:aC(n),images:o,files:a,...e?{replyTo:e}:{}}';

// 只搬运图片（不搬其它引用文件）：图片是 /birds 真正要的，而且走的是 dsh-im
// 自己的图片下载通道（hs + 平台 CDN 白名单 kVe），失败也只是这张图当没引。
const HELPER = `function __qbQuotedMedia(n,f){try{const el=Array.isArray(n?.msgElements)?n.msgElements[0]:null;const atts=Array.isArray(el?.attachments)?el.attachments:[];const existing=new Set();for(const a of n?.attachments??[]){const u=typeof a?.url==="string"?a.url.trim():"";if(u)existing.add(u);}const images=[];const seen=new Set();for(const a of atts){let u=typeof a?.url==="string"?a.url.trim():"";if(!u)continue;if(u.startsWith("//"))u="https:"+u;if(!u.startsWith("https:"))continue;if(seen.has(u)||existing.has(u))continue;const nm=typeof a?.filename==="string"&&a.filename.trim()?a.filename.trim():void 0;const raw=String(a?.content_type??a?.contentType??"").split(";")[0].trim().toLowerCase();const isImg=raw.startsWith("image/")||/\\.(?:jpe?g|png|gif|webp|bmp|heic|heif|tiff?)$/i.test(nm??"");if(!isImg)continue;seen.add(u);images.push({...(nm?{name:nm}:{}),...(raw.startsWith("image/")?{mediaType:raw}:{}),load:({signal:sg,maxBytes:mb}={})=>hs(u,{...(typeof f==="function"?{fetchImpl:f}:{}),signal:sg,maxBytes:mb,allowedHosts:kVe})});}return images;}catch{return[];}}`;

/** 这份 dsh-im 构建产物是否已经打过补丁。 */
export function isPatched(source) {
  return typeof source === 'string' && source.includes(MARKER);
}

/**
 * 纯文本变换：输入 dsh-im 的 lib/index.js 源码，输出版本。
 * 认不出目标构建产物时抛 UnsupportedBundleError，宁可不改也不乱改。
 */
export function patchDshImSource(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  if (isPatched(source)) return source;
  const functionHits = source.split(FUNCTION_ANCHOR).length - 1;
  const returnHits = source.split(RETURN_ANCHOR).length - 1;
  if (functionHits !== 1 || returnHits !== 1) {
    throw new UnsupportedBundleError(
      `认不出这份 dsh-im 构建产物（定位点命中 ${functionHits}/${returnHits}，预期各 1 次）。`
        + '这套补丁是按 dsh-im 5.8.0 的压缩产物写的；升级后需要重新校对定位点。',
    );
  }
  return source
    .replace(FUNCTION_ANCHOR, `${HELPER}\n${FUNCTION_ANCHOR}`)
    .replace(RETURN_ANCHOR, PATCHED_RETURN);
}

/** 认不出构建产物的错误：对使用者来说是可读的「不支持」，不是崩溃。 */
export class UnsupportedBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedBundleError';
  }
}

/** 默认去 DSH_HOME 的 profile 里找 dsh-im。 */
export async function findDshImBundles(home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')) {
  const profiles = path.join(home, 'profiles');
  let names;
  try {
    names = await fs.readdir(profiles);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names.sort()) {
    const bundle = path.join(profiles, name, 'node_modules', '@xmanrui', 'dsh-im', 'lib', 'index.js');
    try {
      const stat = await fs.stat(bundle);
      if (stat.isFile() || stat.isSymbolicLink()) found.push(bundle);
    } catch {
      // 这个 profile 没装 dsh-im。
    }
  }
  return found;
}

function usage() {
  return [
    '用法：node scripts/patch-dsh-im.mjs [选项]',
    '',
    '  --bundle=<路径>   直接指定 dsh-im 的 lib/index.js（默认自动找 DSH_HOME/profiles/*）',
    '  --dry-run         只检查、不写文件',
    '  --restore=<路径>  用备份覆盖回去（备份名形如 index.js.orig-xxxxxxxx）',
    '  -h, --help        显示这段帮助',
    '',
    '改完要重启 DSH（或重启 App）才生效。补丁会被 dsh-im 升级/重装覆盖，届时重跑即可。',
  ].join('\n');
}

/** 备份文件名带内容摘要，重装后再打补丁不会覆盖上一份。 */
function backupPathFor(bundle, digest) {
  return `${bundle}.orig-${digest.slice(0, 8)}`;
}

async function sha256(text) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

async function patchOne(bundle, { dryRun }) {
  const source = await fs.readFile(bundle, 'utf8');
  if (isPatched(source)) {
    return { bundle, changed: false, reason: '已经打过补丁（文件里有 ' + MARKER + '）' };
  }
  const patched = patchDshImSource(source);
  if (dryRun) return { bundle, changed: true, reason: '可以打补丁（--dry-run，未写入）' };
  const backup = backupPathFor(bundle, await sha256(source));
  await fs.writeFile(backup, source, { encoding: 'utf8', mode: 0o644 });
  await fs.writeFile(bundle, patched, { encoding: 'utf8', mode: 0o644 });
  return { bundle, changed: true, backup };
}

async function restore(backup) {
  const name = path.basename(backup);
  const match = /^(index\.js)\.orig-[0-9a-f]{8}$/u.exec(name);
  if (!match) throw new Error(`备份文件名不像这个脚本生成的：${name}`);
  const bundle = path.join(path.dirname(backup), match[1]);
  const source = await fs.readFile(backup, 'utf8');
  await fs.writeFile(bundle, source, { encoding: 'utf8', mode: 0o644 });
  return bundle;
}

function parseArgs(argv) {
  const options = { dryRun: false, bundle: undefined, restore: undefined, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('--bundle=')) options.bundle = arg.slice('--bundle='.length);
    else if (arg.startsWith('--restore=')) options.restore = arg.slice('--restore='.length);
    else throw new Error(`不认识的参数：${arg}\n\n${usage()}`);
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.restore) {
    try {
      const bundle = await restore(options.restore);
      console.log(`已还原：${bundle}`);
      console.log('重启 DSH（或重启 App）后生效。');
      return 0;
    } catch (error) {
      console.error(`还原失败：${error.message}`);
      return 1;
    }
  }

  const bundles = options.bundle ? [options.bundle] : await findDshImBundles();
  if (bundles.length === 0) {
    console.error('没找到 dsh-im。用 --bundle=<路径> 指定它的 lib/index.js。');
    return 1;
  }

  let failed = 0;
  let changed = 0;
  for (const bundle of bundles) {
    try {
      const result = await patchOne(bundle, options);
      if (result.changed) changed += 1;
      console.log(result.changed
        ? `✓ ${result.bundle}\n  已写入；原文件备份在 ${result.backup}`
        : `· ${result.bundle}\n  ${result.reason}`);
    } catch (error) {
      failed += 1;
      console.error(`✗ ${bundle}\n  ${error.message}`);
    }
  }

  if (changed > 0) {
    console.log('');
    console.log('重启 DSH（或重启 App）后生效：引用图片会作为真正的附件进来，/birds 可以直接识别。');
    console.log('dsh-im 升级或 profile 重装会覆盖补丁，到时候重跑这个脚本即可。');
  } else if (failed === 0) {
    console.log('');
    console.log('没有需要改的地方。');
  }
  return failed > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
