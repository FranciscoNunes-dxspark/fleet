// Copying whole folders over an SftpClient, one file at a time: the tree is walked first, so the
// progress has a total, and then every file goes by `download` or `upload`. Links and other special
// files are skipped, never followed (a link out of the folder would copy what isn't in it).
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { joinRemote } from './sftp.js';

/** What's under a remote `path`: { files: [{ remote, rel, size }], dirs: [rel] }, `rel` with `/`. */
export async function walkRemote(client, path, rel = '', out = { files: [], dirs: [] }) {
  for (const e of await client.readdir(path)) {
    const sub = rel ? `${rel}/${e.name}` : e.name;
    if (e.kind === 'dir') {
      out.dirs.push(sub);
      await walkRemote(client, joinRemote(path, e.name), sub, out);
    } else if (e.kind === 'file') out.files.push({ remote: joinRemote(path, e.name), rel: sub, size: e.size });
  }
  return out;
}

/** What's under a local `path`, as walkRemote's. */
export async function walkLocal(path, rel = '', out = { files: [], dirs: [] }) {
  for (const e of await fsp.readdir(path, { withFileTypes: true })) {
    const sub = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.dirs.push(sub);
      await walkLocal(join(path, e.name), sub, out);
    } else if (e.isFile()) out.files.push({ local: join(path, e.name), rel: sub, size: (await fsp.stat(join(path, e.name))).size });
  }
  return out;
}

/** Makes `path` on the server unless it's a folder already. */
export async function ensureRemoteDir(client, path) {
  try {
    await client.mkdir(path);
  } catch (e) {
    const attrs = await client.stat(path).catch(() => null);
    if (!attrs || (attrs.permissions & 0o170000) !== 0o040000) throw e;
  }
}

/**
 * Downloads `remote` (a file, or a folder's tree with `recursive`) to `local`, which names the file or
 * the folder to make. `onProgress({ bytes, total, file })` counts bytes over the whole copy.
 */
export async function download(client, remote, local, { recursive, signal, onProgress } = {}) {
  let bytes = 0;
  const progress = (total, file) => (n) => onProgress?.({ bytes: (bytes += n), total, file });
  if (!recursive) {
    const { size = 0 } = await client.stat(remote);
    onProgress?.({ bytes: 0, total: size, file: remote });
    return client.download(remote, local, { signal, onBytes: progress(size, remote) });
  }
  const tree = await walkRemote(client, remote);
  const total = tree.files.reduce((sum, f) => sum + f.size, 0);
  await fsp.mkdir(local, { recursive: true });
  for (const d of tree.dirs) await fsp.mkdir(join(local, ...d.split('/')), { recursive: true });
  onProgress?.({ bytes: 0, total, file: remote });
  for (const f of tree.files) await client.download(f.remote, join(local, ...f.rel.split('/')), { signal, onBytes: progress(total, f.remote) });
}

/** Uploads `local` (a file, or a folder's tree with `recursive`) to `remote`, as `download` does. */
export async function upload(client, local, remote, { recursive, signal, onProgress } = {}) {
  let bytes = 0;
  const progress = (total, file) => (n) => onProgress?.({ bytes: (bytes += n), total, file });
  if (!recursive) {
    const { size } = await fsp.stat(local);
    onProgress?.({ bytes: 0, total: size, file: local });
    return client.upload(local, remote, { signal, onBytes: progress(size, local) });
  }
  const tree = await walkLocal(local);
  const total = tree.files.reduce((sum, f) => sum + f.size, 0);
  await ensureRemoteDir(client, remote);
  for (const d of tree.dirs) await ensureRemoteDir(client, joinRemote(remote, d));
  onProgress?.({ bytes: 0, total, file: local });
  for (const f of tree.files) await client.upload(f.local, joinRemote(remote, f.rel), { signal, onBytes: progress(total, f.local) });
}
