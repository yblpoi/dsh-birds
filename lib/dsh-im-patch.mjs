/**
 * 给 dsh-im 补的那处「引用」的洞：核心实现。
 *
 * 之所以单独放在 lib/ 而不是 scripts/：运行时的设置页接口（lib/im-patch-api.mjs）
 * 也要用它。scripts/ 是给终端用的入口，装上插件后不保证留在磁盘上（有的装机方式
 * 只搬 lib/），运行时依赖 scripts/ 会直接 ERR_MODULE_NOT_FOUND —— 真机踩过。
 *
 * 起因与做法见 scripts/patch-dsh-im.mjs 顶部注释：QQ 推送的 msg_elements[0]
 * 里带着引用附件的 url，dsh-im（5.8.0 / 5.10.0 都一样）把它压成 { kind, name }
 * 丢掉了，于是把附件再塞回本条消息：图片进 images、音频等进 files，都走 dsh-im
 * 自己的下载通道，由它落盘到 .dsh-im/inbound/ 并生成 <dsh_im_files> 清单。
 *
 * 只搬图片是不够的：语音/录音在 QQ 里本来就不带 filename，引用之后连 name 都没有，
 * 上层拿不到任何可用的键去查文件；唯一的办法是让 dsh-im 自己把字节下载下来。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 打过补丁的标记；也是幂等判断依据。 */
export const MARKER = '__qbQuotedMedia';

/**
 * 已知可用的定位点：每项是一份 dsh-im 压缩产物的三处锚点。
 *
 * 都要求各自在产物里恰好出现一次；命中不唯一的版本一律拒绝，宁可不动也不乱改。
 */
const ANCHOR_SETS = [
  {
    version: '5.9 – 5.10',
    fn: 'function LY(n,{fetchImpl:t=fetch}={}){',
    ret: 'let e=FY(n);return{content:hC(n),images:o,files:a,...e?{replyTo:e}:{}}',
  },
  {
    version: '5.5 – 5.8',
    fn: 'function rY(n,{fetchImpl:t=fetch}={}){',
    ret: 'let e=iY(n);return{content:aC(n),images:o,files:a,...e?{replyTo:e}:{}}',
    // 这一代产物里没有可用于探测的提示语，用当时校对过的短名兜底。
    fallback: { image: 'hs', hosts: 'kVe', file: 'N5e' },
  },
];

// 无 filename 的附件补个后缀：dsh-im 落盘用的是这个 name，带上后缀，
// 下游按扩展名分类就不必依赖魔数探测（虽然也能兜底）。
const EXT_MAP = {
  'audio/amr': '.amr',
  'audio/amr-wb': '.amr',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/aacp': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/silk': '.silk',
  'audio/x-silk': '.silk',
  'video/mp4': '.mp4',
};

// 图片/文件下载器在两个分支里各自紧随一句固定的错误提示语，用它把名字读出来。
// 名字是压缩产物里的短名，逐版本不同（5.10.0 是 Bs / D5e，早年是 hs / kVe），
// 写死必炸：真机上 hs 在 5.10.0 里是个返回布尔的断言函数，调用抛 TypeError 又被
// helper 的 try/catch 吞成空数组 —— 补丁看起来成功，实际一张图也搬不过去。
const IMAGE_HINT = 'QQ image attachment has no download URL';
const FILE_HINT = 'QQ file attachment has no download URL';

const REGEXP_SPECIALS = '.*+?^$()[]{}|\\';

function escapeRegExp(text) {
  let out = '';
  for (const ch of text) out += REGEXP_SPECIALS.includes(ch) ? '\\' + ch : ch;
  return out;
}

/** 从「提示语 -> return 某函数(...)」里读出那个函数名。 */
function loaderName(body, hint) {
  const pattern = new RegExp(escapeRegExp(hint) + '"\\)\\s*;?\\s*return\\s+([A-Za-z_$][\\w$]*)\\s*\\(', 'u');
  return pattern.exec(body)?.[1];
}

/** 从 allowedHosts: 后面读出白名单变量名。 */
function allowlistName(body) {
  return /allowedHosts:\s*([A-Za-z_$][\w$]*)/u.exec(body)?.[1];
}

/** 这个名字在产物里是否恰好声明为一个数组（Object.freeze([...]) 也算）。 */
function declaresArray(source, name) {
  if (typeof name !== 'string' || name === '') return false;
  const pattern = new RegExp('\\b' + escapeRegExp(name) + '\\s*=\\s*(?:Object\\.freeze\\()?\\[', 'u');
  return pattern.test(source);
}

/** 这个名字在产物里是否恰好定义了一个函数。 */
function declaresFunction(source, name) {
  if (typeof name !== 'string' || name === '') return false;
  return source.split('function ' + name + '(').length - 1 === 1;
}

function buildHelper(names) {
  // 白名单名对但值不是数组时（真机踩过：同名变量是别的模块的字符串常量），
  // 传 undefined，让 dsh-im 自己跳过域名检查，而不是传一个它认不出的值。
  const hosts = names.hosts === undefined
    ? 'void 0'
    : '(typeof ' + names.hosts + '!=="undefined"&&Array.isArray(' + names.hosts + ')?' + names.hosts + ':void 0)';
  // 引用附件的搬运工：图片走 dsh-im 的图片通道（带平台 CDN 白名单），
  // 其余（语音、文件）走它自己的文件下载通道，由 dsh-im 负责落盘。
  // 返回 [{kind, value}]：调用点按 kind 决定塞进 images 还是 files。后缀表放进
  // helper 自己体内，不污染产物的模块作用域（不同版本可能已有同名变量）。
  return 'function __qbQuotedMedia(n,f){try{'
    + 'const EXT=' + JSON.stringify(EXT_MAP) + ';'
    + 'const el=Array.isArray(n?.msgElements)?n.msgElements[0]:null;'
    + 'const atts=Array.isArray(el?.attachments)?el.attachments:[];'
    + 'const existing=new Set();'
    + 'for(const a of n?.attachments??[]){const u=typeof a?.url==="string"?a.url.trim():"";if(u)existing.add(u);}'
    + 'const out=[];const seen=new Set();let nf=0;'
    + 'for(const a of atts){'
    + 'let u=typeof a?.url==="string"?a.url.trim():"";'
    + 'if(!u)continue;'
    + 'if(u.startsWith("//"))u="https:"+u;'
    + 'if(!u.startsWith("https:"))continue;'
    + 'if(seen.has(u)||existing.has(u))continue;'
    + 'const nm=typeof a?.filename==="string"&&a.filename.trim()?a.filename.trim():void 0;'
    + 'const raw=String(a?.content_type??a?.contentType??"").split(";")[0].trim().toLowerCase();'
    + 'const sz=Number(a?.size);'
    + 'const size=Number.isFinite(sz)&&sz>=0?{size:sz}:{};'
    + 'const isImg=raw.startsWith("image/")||/\.(?:jpe?g|png|gif|webp|bmp|heic|heif|tiff?)$/i.test(nm??"");'
    + 'if(isImg){'
    + 'seen.add(u);'
    + 'out.push({kind:"image",value:{...(nm?{name:nm}:{}),...(raw.startsWith("image/")?{mediaType:raw}:{}),...size,load:({signal:sg,maxBytes:mb}={})=>' + names.image + '(u,{...(typeof f==="function"?{fetchImpl:f}:{}),signal:sg,maxBytes:mb,allowedHosts:' + hosts + '})}});'
    + 'continue;'
    + '}'
    + 'seen.add(u);'
    + 'out.push({kind:"file",value:{name:nm??("quoted-file-"+(++nf)+(EXT[raw]??"")),...(raw.includes("/")?{mediaType:raw}:{}),...size,load:({signal:sg}={})=>' + names.file + '(u,{fetchImpl:f,signal:sg})}});'
    + '}'
    + 'return out;'
    + '}catch{return[];}}';
}

function patchedReturn(anchor) {
  const head = anchor.ret.slice(0, anchor.ret.indexOf('return{'));
  const tail = anchor.ret.slice(anchor.ret.indexOf('return{'));
  return head
    + 'for(const __q of __qbQuotedMedia(n,t)){if(__q.kind==="image")o.push(__q.value);else a.push(__q.value);}'
    + tail;
}

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
  for (const anchor of ANCHOR_SETS) {
    const fnHits = source.split(anchor.fn).length - 1;
    const retHits = source.split(anchor.ret).length - 1;
    if (fnHits !== 1 || retHits !== 1) continue;
    const start = source.indexOf(anchor.fn);
    const retAt = source.indexOf(anchor.ret, start);
    const body = source.slice(start, retAt < 0 ? start + 8000 : retAt + anchor.ret.length);
    const names = {
      image: loaderName(body, IMAGE_HINT) ?? anchor.fallback?.image,
      file: loaderName(body, FILE_HINT) ?? anchor.fallback?.file,
      hosts: allowlistName(body) ?? anchor.fallback?.hosts,
    };
    if (!declaresArray(source, names.hosts)) names.hosts = undefined;
    if (!declaresFunction(source, names.image) || !declaresFunction(source, names.file)) {
      throw new UnsupportedBundleError(
        '认出了 dsh-im ' + anchor.version + ' 的定位点，但认不出它的下载器（图片 ' + (names.image ?? '?')
          + '、文件 ' + (names.file ?? '?') + '）。为避免生成必然报错的补丁，这次不改。'
          + '请在插件仓库提 issue，附上 dsh-im 版本号。',
      );
    }
    return source
      .replace(anchor.fn, buildHelper(names) + '\n' + anchor.fn)
      .replace(anchor.ret, patchedReturn(anchor));
  }
  // 位置都不对：把每一组的命中情况报出来，方便对齐新版本。
  const report = ANCHOR_SETS
    .map((anchor) => anchor.version + ' ' + (source.split(anchor.fn).length - 1) + '/' + (source.split(anchor.ret).length - 1))
    .join('、');
  throw new UnsupportedBundleError(
    '认不出这份 dsh-im 构建产物（定位点命中 ' + report + '，预期各 1 次）。'
      + '这套补丁是按 dsh-im 5.5 – 5.10 的压缩产物写的；升级后需要重新校对定位点。',
  );
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
