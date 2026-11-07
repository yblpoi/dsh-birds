import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * Chinese bird names, aligned to the label files by row index.
 *
 * The tables under ./names/ were generated from the IOC World Bird List
 * (versions 15.1 and 14.2, plus SuperPicky's own merged list) and each one
 * records the SHA-256 of the label file it was built against. A label file that
 * does not hash to that digest is a different list, so the index alignment
 * cannot be trusted: the table is disabled and the reply stays English-only
 * rather than showing the Chinese name of a different species.
 */
const FORMAT = 'dsh-birds/names@1';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const TABLES = {
  image: { file: 'image-zh.json', label: '图片分类标签表' },
  audio: { file: 'audio-zh.json', label: '声学分类标签表' },
};

const cache = new Map();

function table(kind) {
  if (cache.has(kind)) return cache.get(kind);
  const spec = TABLES[kind];
  let entry = { names: null, digest: '', count: 0, named: 0, bound: false, source: '' };
  try {
    const raw = fs.readFileSync(path.join(HERE, 'names', spec.file), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.format !== FORMAT || !Array.isArray(parsed.names)) {
      throw new Error('结构不是 ' + FORMAT);
    }
    entry = {
      names: parsed.names,
      digest: String(parsed.labelsSha256 ?? ''),
      count: parsed.names.length,
      named: Number(parsed.named) > 0 ? Number(parsed.named) : parsed.names.filter(Boolean).length,
      bound: false,
      source: String(parsed.source ?? ''),
    };
  } catch (error) {
    entry.error = error?.message ?? String(error);
  }
  cache.set(kind, entry);
  return entry;
}

/** SHA-256 of the label text the classifier actually read. */
export function labelDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Point a table at the label file it must describe.
 *
 * Called by the classifiers once their labels are parsed; returning the bound
 * state keeps the caller honest about whether Chinese names are in play.
 */
export function bindLabels(kind, digest, logger) {
  const entry = table(kind);
  if (entry.names === null) {
    logger?.warn?.('中文名表不可用（' + (entry.error ?? '未知原因') + '），识别结果只显示英文名');
    return false;
  }
  if (entry.digest !== digest) {
    logger?.warn?.(
      '中文名表和' + TABLES[kind].label + '的指纹不一致（表 ' + entry.digest.slice(0, 12)
        + '… / 文件 ' + String(digest).slice(0, 12) + '…），为避免张冠李戴只显示英文名',
    );
    entry.bound = false;
    return false;
  }
  entry.bound = true;
  logger?.debug?.('中文名表已启用：' + entry.named + '/' + entry.count + ' 条（' + kind + '）');
  return true;
}

/** Chinese name for one label row, or undefined when the table cannot answer. */
export function chineseName(kind, index) {
  const entry = table(kind);
  if (entry.bound !== true || !Number.isInteger(index) || index < 0) return undefined;
  const name = entry.names[index];
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** Coverage summary for /birdstatus. */
export function nameTableStatus() {
  const out = {};
  for (const kind of Object.keys(TABLES)) {
    const entry = table(kind);
    out[kind] = {
      bound: entry.bound === true,
      named: entry.named,
      count: entry.count,
      source: entry.source,
      error: entry.error,
    };
  }
  return out;
}

/** Test seam: forget every loaded table. */
export function resetNameTables() {
  cache.clear();
}
