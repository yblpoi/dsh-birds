/**
 * 给 dsh-im 补的那处「引用图片」的洞：核心实现。
 *
 * 之所以单独放在 lib/ 而不是 scripts/：运行时的设置页接口（lib/im-patch-api.mjs）
 * 也要用它。scripts/ 是给终端用的入口，装上插件后不保证留在磁盘上（有的装机方式
 * 只搬 lib/），运行时依赖 scripts/ 会直接 ERR_MODULE_NOT_FOUND —— 真机踩过。
 *
 * 起因与做法见 scripts/patch-dsh-im.mjs 顶部注释：QQ 推送的 msg_elements[0]
 * 里带着引用图的 url，dsh-im（5.8.0 / 5.10.0 都一样）把它压成 { kind, name }
 * 丢掉了，于是把图片再塞回本条消息的 images 里，走 dsh-im 自己的下载通道。
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
