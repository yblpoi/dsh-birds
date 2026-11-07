import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Recover media that a chat bridge only forwarded as metadata.
 *
 * dsh-im (QQ group bot) wraps every inbound message in tags of its own. A reply
 * it builds for a quoted message keeps just {kind, name} for each attachment —
 * the CDN url is dropped before the Harness ever sees it, and the quoted image
 * itself is not admitted as an image part. So `/birds` on a quoted photo used
 * to find no attachment at all and answer "没有收到图片或录音".
 *
 * Those bytes do exist on the host, though: dsh-im records the group it serves
 * in its own history store (integrations/dsh-im/group-history.sqlite, plus
 * group-files/<message>/<attachment> blobs), and it also stages every image it
 * did receive under <workspace>/.dsh-im/inbound/. The name in the quote is the
 * platform file name, which is what both places are keyed by, so the file can
 * be looked back up.
 *
 * What cannot be recovered: a picture the bot never received (someone else's
 * message, or anything older than the recording started). Those stay unresolved
 * and the reply says so instead of pretending nothing was sent.
 */

const ENVELOPE_TAG = /<dsh_im_(reply_to|source)>([\s\S]*?)<\/dsh_im_\1>/gu;

/** The attachment kinds a bridge can quote that this plugin might read. */
const MEDIA_KINDS = new Set(['image', 'audio', 'video', 'file']);

/**
 * Split a bridged message into the two JSON blocks dsh-im prepends.
 *
 * Both live in their own text parts and may sit anywhere in the message, so
 * every text part is scanned. Malformed JSON is ignored rather than thrown: a
 * quote the bridge could not serialise must not break the command.
 */
export function parseBridgeEnvelope(content) {
  const envelope = { source: undefined, replyTo: undefined };
  if (!Array.isArray(content)) return envelope;
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    ENVELOPE_TAG.lastIndex = 0;
    let match;
    while ((match = ENVELOPE_TAG.exec(part.text)) !== null) {
      let parsed;
      try {
        parsed = JSON.parse(match[2]);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (match[1] === 'source') envelope.source = parsed;
      else envelope.replyTo = parsed;
    }
  }
  return envelope;
}

/**
 * The named attachments of a quoted message.
 *
 * A quote that only carried text has none, and an image the bridge marked
 * unavailable carries no name either — both simply produce an empty list.
 */
export function quotedMediaNames(replyTo) {
  const attachments = Array.isArray(replyTo?.attachments) ? replyTo.attachments : [];
  const names = [];
  for (const attachment of attachments) {
    const name = typeof attachment?.name === 'string' ? attachment.name.trim() : '';
    if (name === '') continue;
    const kind = typeof attachment?.kind === 'string' ? attachment.kind : 'file';
    if (!MEDIA_KINDS.has(kind)) continue;
    names.push({ kind, name });
  }
  return names;
}

/** Absolute path of dsh-im's own integration directory. */
export function integrationDir(dshHome) {
  const home = typeof dshHome === 'string' && dshHome !== ''
    ? dshHome
    : (process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
  return path.join(home, 'integrations', 'dsh-im');
}

async function statFile(file) {
  try {
    const info = await fs.stat(file);
    return info.isFile() && info.size > 0 ? info : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Look the quoted file up in dsh-im's history store.
 *
 * Only rows it marked ready are backed by a blob; the join keeps a same-named
 * attachment from another chat from winning when the source says which group
 * this message came from.
 */
async function lookupInHistory({ dbPath, name, source, logger }) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    // Node without the built-in SQLite module: the directory scan still runs.
    return undefined;
  }
  // dsh-im publishes the platform group id as `chatId` in <dsh_im_source>.
  const chatId = typeof source?.chatId === 'string' ? source.chatId : undefined;
  const channel = typeof source?.channel === 'string' ? source.channel : undefined;

  const base = 'select a.name, a.mime_type, a.size_bytes, a.relative_path from attachments a'
    + ' join messages m on m.id = a.message_id'
    + ' join groups g on g.id = m.group_id'
    + " where a.name = ? and a.status = 'ready' and a.relative_path is not null";
  const scoped = chatId !== undefined && channel !== undefined
    ? base + ' and g.channel = ? and g.platform_group_id = ? order by m.sent_at desc limit 3'
    : undefined;
  // Unknown chat ids (or a direct chat) still search every recorded group: the
  // platform name is a content hash, so a same-named file is the same picture.
  const across = base + ' order by m.sent_at desc limit 3';

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    logger?.warn?.('birds: 无法打开 dsh-im 历史库（' + (error?.message ?? error) + '）');
    return undefined;
  }

  const directory = path.dirname(dbPath);
  const attempt = async (sql, params) => {
    let rows;
    try {
      rows = db.prepare(sql).all(...params);
    } catch (error) {
      logger?.warn?.('birds: 查询 dsh-im 历史库失败（' + (error?.message ?? error) + '）');
      return undefined;
    }
    for (const row of rows) {
      if (typeof row?.relative_path !== 'string') continue;
      const absolute = path.resolve(directory, row.relative_path);
      const info = await statFile(absolute);
      if (info === undefined) continue;
      // A recorded size that disagrees with the blob means the file changed on
      // disk; the bytes on disk are still the ones to read, so only note it.
      if (Number(row.size_bytes) > 0 && Number(row.size_bytes) !== info.size) {
        logger?.warn?.('birds: ' + name + ' 的历史记录大小与磁盘不一致（' + row.size_bytes + ' / ' + info.size + '）');
      }
      return { path: absolute, name, mimeType: typeof row.mime_type === 'string' ? row.mime_type : undefined };
    }
    return undefined;
  };

  try {
    if (scoped !== undefined) {
      const hit = await attempt(scoped, [name, channel, chatId]);
      if (hit !== undefined) return hit;
    }
    return await attempt(across, [name]);
  } finally {
    try {
      db.close();
    } catch {
      // A close that fails leaves nothing worth reporting to the user.
    }
  }
}
/**
 * Where a chat image lands when the bridge did receive it.
 *
 * The file keeps its platform name but is prefixed with the message ordinal
 * ("01-1-<name>"), inside a per-message folder. Both the workspace root and the
 * default dsh-im workspace are checked; a missing directory is normal.
 */
async function scanInbound({ roots, name, logger }) {
  for (const root of roots) {
    let folders;
    try {
      folders = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const directory = path.join(root, folder.name);
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name !== name && !entry.name.endsWith('-' + name)) continue;
        const absolute = path.join(directory, entry.name);
        if ((await statFile(absolute)) !== undefined) return absolute;
      }
    }
    logger?.info?.('birds: 引用的 ' + name + ' 不在 ' + root);
  }
  return undefined;
}

function inboundRoots({ dshHome, cwd }) {
  const roots = [];
  const push = (root) => {
    if (typeof root === 'string' && root !== '' && !roots.includes(root)) roots.push(root);
  };
  push(path.join(cwd ?? process.cwd(), '.dsh-im', 'inbound'));
  const home = typeof dshHome === 'string' && dshHome !== ''
    ? dshHome
    : (process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
  push(path.join(home, 'im', '.dsh-im', 'inbound'));
  push(path.join(home, 'workspace', '.dsh-im', 'inbound'));
  return roots;
}

/**
 * Turn the quoted-message metadata into files this process can read.
 *
 * Never throws: a quote that cannot be resolved is reported in `unresolved`
 * so the command can explain what happened instead of failing.
 */
export async function resolveQuotedMedia({ replyTo, source, dshHome, cwd, logger } = {}) {
  const names = quotedMediaNames(replyTo);
  const resolved = { files: [], unresolved: [] };
  if (names.length === 0) return resolved;

  let dbPath;
  try {
    dbPath = path.join(integrationDir(dshHome), 'group-history.sqlite');
    await fs.access(dbPath);
  } catch {
    dbPath = undefined;
  }

  const roots = inboundRoots({ dshHome, cwd });
  for (const entry of names) {
    let file;
    if (dbPath !== undefined) {
      file = await lookupInHistory({ dbPath, name: entry.name, source, logger });
    }
    if (file === undefined) {
      const staged = await scanInbound({ roots, name: entry.name, logger });
      if (staged !== undefined) file = { path: staged, name: entry.name, mimeType: undefined };
    }
    if (file === undefined) resolved.unresolved.push(entry);
    else resolved.files.push({ ...file, kind: entry.kind });
  }
  return resolved;
}
