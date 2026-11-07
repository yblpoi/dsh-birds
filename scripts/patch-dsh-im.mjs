#!/usr/bin/env node
/**
 * 给 dsh-im 补一处「引用图片」的洞（QQ 群）—— 终端入口。
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
 *
 * url 就这么被丢掉了，于是插件只能按文件名去本机历史库里找——别人发的图当然
 * 找不到。dsh-im 5.10.0 依旧如此，升级不解决。
 *
 * 这个脚本做一件事：把同一个 QQ 推送对象里的引用图片，额外塞进本条消息的
 * images 列表（和普通图片走的完全是同一条 Harness 附件通道）。这样引用图会
 * 变成真正的图片附件，/birds 和模型都看得到。
 *
 * 变换逻辑本体在 lib/dsh-im-patch.mjs（设置页也用同一份），这里只负责读写文件
 * 与命令行。注意：改的是第三方插件的构建产物，dsh-im 升级或 profile 重装会覆盖
 * 掉，需要重新跑（会自动检测是否已经打过补丁；设置页里也能一键再打）。
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
import path from 'node:path';
import {
  MARKER,
  isPatched,
  patchDshImSource,
  findDshImBundles,
} from '../lib/dsh-im-patch.mjs';

export {
  MARKER,
  isPatched,
  patchDshImSource,
  findDshImBundles,
  UnsupportedBundleError,
} from '../lib/dsh-im-patch.mjs';

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
    '设置页（插件 → dsh-birds → 配置）里也有同样的开关，不用终端。',
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
