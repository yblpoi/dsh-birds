import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Files a chat bridge hands over as a `<dsh_im_files>` manifest.
 *
 * dsh-im does not deliver a non-image attachment as a file part. It downloads
 * the bytes itself, stages them under `<workspace>/.dsh-im/inbound/<time>/<NN>-<name>`
 * and appends one text part listing `{ name, path }` — the path being relative
 * to the Harness session workspace. An image arrives as an image part, but an
 * audio clip (and every other non-image file) only ever arrives this way, so a
 * plugin that reads attachment parts alone never sees a recording at all.
 *
 * The session workspace is not part of the turn payload, so a relative path is
 * resolved against every place a workspace can be registered: the process
 * directory and the paths in DSH's own workspace store.
 */

const MANIFEST_TAG = /<dsh_im_files>([\s\S]*?)<\/dsh_im_files>/gu;

function defaultHome(dshHome) {
  return typeof dshHome === 'string' && dshHome !== ''
    ? dshHome
    : (process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'));
}

/**
 * Every `{ name, path }` a bridged message announced, in the order it did.
 *
 * Malformed JSON is skipped rather than thrown: a manifest the bridge could
 * not serialise must not break the command.
 */
export function parseFileManifest(content) {
  const entries = [];
  if (!Array.isArray(content)) return entries;
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    MANIFEST_TAG.lastIndex = 0;
    let match;
    while ((match = MANIFEST_TAG.exec(part.text)) !== null) {
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        continue;
      }
      for (const file of Array.isArray(parsed?.files) ? parsed.files : []) {
        const target = typeof file?.path === 'string' ? file.path.trim() : '';
        if (target === '') continue;
        const name = typeof file?.name === 'string' ? file.name.trim() : '';
        entries.push({ name, path: target });
      }
    }
  }
  return entries;
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
 * Candidate workspace roots, most specific first.
 *
 * DSH keeps every registered workspace in `<DSH_HOME>/storages/workspace.json`
 * (`tables.workspaces[*].path`). Reading the file is cheap and works no matter
 * which session the bridge is talking to; an unreadable store simply leaves the
 * process directory as the only candidate.
 */
export async function workspaceRoots({ dshHome, cwd } = {}) {
  const roots = [];
  const push = (root) => {
    if (typeof root !== 'string' || root === '') return;
    const normalised = path.resolve(root);
    if (!roots.includes(normalised)) roots.push(normalised);
  };
  push(cwd ?? process.cwd());
  push(process.cwd());

  try {
    const raw = await fs.readFile(path.join(defaultHome(dshHome), 'storages', 'workspace.json'), 'utf8');
    const store = JSON.parse(raw);
    for (const workspace of Object.values(store?.tables?.workspaces ?? {})) push(workspace?.path);
  } catch {
    // No workspace store (first run, another profile): the process directory
    // still covers the common case.
  }
  push(path.join(defaultHome(dshHome), 'workspace'));
  return roots;
}

/** Turn one manifest path into an absolute one that really holds bytes. */
async function locate(target, roots) {
  if (path.isAbsolute(target)) {
    return (await statFile(target)) === undefined ? undefined : path.resolve(target);
  }
  for (const root of roots) {
    const absolute = path.resolve(root, target);
    const relative = path.relative(root, absolute);
    // A manifest must never point outside the workspace it belongs to.
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if ((await statFile(absolute)) !== undefined) return absolute;
  }
  return undefined;
}

/**
 * Resolve every manifest entry to a readable file this process can open.
 *
 * Never throws: an entry that is gone from disk is reported in `unresolved`
 * so the reply can say which file is missing instead of claiming nothing was
 * sent.
 */
export async function resolveBridgeFiles({ content, dshHome, cwd, logger } = {}) {
  const entries = parseFileManifest(content);
  const resolved = { files: [], unresolved: [] };
  if (entries.length === 0) return resolved;

  const roots = await workspaceRoots({ dshHome, cwd });
  for (const entry of entries) {
    const absolute = await locate(entry.path, roots);
    if (absolute === undefined) {
      logger?.info?.('birds: 桥接消息里的 ' + entry.path + ' 不在工作区里');
      resolved.unresolved.push(entry);
      continue;
    }
    if (resolved.files.some((file) => file.path === absolute)) continue;
    resolved.files.push({ path: absolute, name: entry.name !== '' ? entry.name : path.basename(absolute) });
  }
  return resolved;
}
