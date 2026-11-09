import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isAttachmentBlob } from '../recognize.mjs';

/**
 * One photo, delivered twice.
 *
 * A chat bridge hands the same bytes to a command through two independent
 * routes. The Host attaches its own content-addressed copy — an image part
 * whose on-disk name is a sha256 under `~/.dsh/attachments/v1/objects/` — and
 * the bridge also downloads the file itself, stages it inside the session
 * workspace as `<workspace>/.dsh-im/inbound/<stamp>/<NN>-<name>`, and announces
 * that path in a `<dsh_im_files>` manifest. Both paths open identical bytes.
 *
 * Recognising both printed the whole result block twice for a single photo
 * (`【1】附件 b1a65527` then `【2】1-3D92….jpg`, same five scores, two timings).
 * Deduplicating by path cannot help — the paths differ — so identity is the
 * content.
 */

/**
 * Content identity of one file.
 *
 * A Host attachment is already content-addressed: its basename IS the sha256
 * of its bytes, so reading the whole file back to hash it again would be
 * wasted work on a photo of several megabytes.
 */
export async function fileDigest(file) {
  if (isAttachmentBlob(file)) return path.basename(file).toLowerCase();
  const handle = await fs.open(file, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Keep one representative per distinct content, preserving arrival order.
 *
 * When the same bytes arrive under two names, the readable one wins: a staged
 * `1-3D92….jpg` tells the reader which photo this is, while `附件 b1a65527` is
 * a hash fragment. A file whose bytes cannot be read is kept rather than
 * dropped — losing a photo to a permission error would be worse than a
 * duplicate.
 */
export async function uniqueByContent(files, { labels, logger } = {}) {
  if (!Array.isArray(files) || files.length <= 1) return Array.isArray(files) ? [...files] : [];
  const kept = [];
  const byDigest = new Map();
  const rename = (from, to) => {
    if (!(labels instanceof Map)) return;
    if (labels.has(from) && !labels.has(to)) labels.set(to, labels.get(from));
    labels.delete(from);
  };
  for (const file of files) {
    let digest;
    try {
      digest = await fileDigest(file);
    } catch (error) {
      logger?.warn?.('无法读取 ' + file + ' 以去重：' + (error?.message ?? error));
    }
    if (digest === undefined) {
      kept.push(file);
      continue;
    }
    const previous = byDigest.get(digest);
    if (previous === undefined) {
      byDigest.set(digest, file);
      kept.push(file);
      continue;
    }
    // Same content again. Keep whichever name a human can act on.
    if (isAttachmentBlob(file) || !isAttachmentBlob(previous)) continue;
    const index = kept.indexOf(previous);
    if (index < 0) continue;
    kept[index] = file;
    byDigest.set(digest, file);
    rename(previous, file);
  }
  return kept;
}