// This machine's side of the two panes, with the same shape as a session's listing: { name, kind, size,
// mode, modified (ms) } (a link to a folder has `isDir`). `createLocal` is the real folder; `demo.js`
// `demoLocal()` is its in-memory twin. Paths go through the object's own `join` and `parent`, so the
// panes never assume this machine's separator.
import { createHash } from 'node:crypto';
import { createReadStream, watch as fsWatch } from 'node:fs';
import fsp from 'node:fs/promises';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { modeText } from './sftp-proto.js';
import { sortEntries } from './sftp.js';

/** The entries of `dir`, folders first. Unreadable entries are listed without a size rather than dropped. */
export async function readDir(dir, path = nodePath) {
  const found = await fsp.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    found.map(async (d) => {
      const full = path.join(dir, d.name);
      const st = await fsp.lstat(full).catch(() => null);
      const entry = {
        name: d.name,
        kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other',
        size: st?.size ?? 0,
        // Windows has no mode bits worth showing.
        mode: st && process.platform !== 'win32' ? modeText(st.mode) : '',
        modified: st?.mtimeMs ?? null,
      };
      if (entry.kind === 'link' && (await fsp.stat(full).catch(() => null))?.isDirectory()) entry.isDir = true;
      return entry;
    }),
  );
  return sortEntries(entries);
}

export function createLocal({ dir = homedir() } = {}) {
  return {
    kind: 'local',
    dir,
    sep: nodePath.sep,
    join: nodePath.join,
    parent: (d) => nodePath.dirname(d),
    /** Where `path` goes from `dir`: absolute as it is, `~` the home folder, else inside `dir`. */
    resolve: (d, path) => nodePath.resolve(d, /^~([/\\]|$)/.test(path) ? `${homedir()}${path.slice(1)}` : path),
    home: async () => homedir(),
    list: (d) => readDir(d),
    mkdir: (d) => fsp.mkdir(d),
    rename: (from, to) => fsp.rename(from, to),
    /** A file, a link (never followed) or a folder with all that is in it. */
    remove: (path) => fsp.rm(path, { recursive: true }),
    exists: (path) => fsp.lstat(path).then(() => true, () => false),
    /** A small text file's contents (a .mooringignore), or null when it isn't there. */
    readText: (path) => fsp.readFile(path, 'utf8').catch(() => null),
    /** A file's sha256, as sha256sum prints it, read as a stream so a big one isn't held in memory. */
    hash: (path) =>
      new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(path).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
      }),
    /**
     * Calls `onChange(rel)` (the path inside `dir`, with `/`) when something under `dir` changes;
     * returns the function that stops it. fs.watch's recursive mode, which Node has on Linux, macOS and Windows.
     */
    watch(d, onChange) {
      const w = fsWatch(d, { recursive: true, persistent: false }, (_event, name) => name && onChange(String(name).split(nodePath.sep).join('/')));
      w.on('error', () => {});
      return () => w.close();
    },
  };
}
