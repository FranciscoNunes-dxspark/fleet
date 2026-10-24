// Watching a folder and everything in it, one fs.watch a folder, leaving out the folders `skip` names
// (node_modules, .git and the ones "ignore" takes whole). On Linux, Node's own recursive fs.watch
// walks the whole tree and watches every file, node_modules included: a second or more of blocking
// and an inotify watch a file on a big project, for changes that would never count anyway.
import { watch as fsWatch, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Whether Node's recursive fs.watch is the slow, file-by-file kind here (the supervisor uses watchTree then). */
export const walksTree = (platform = process.platform) => platform === 'linux';

/**
 * Watches `dir` and its folders but the ones `skip(rel)` names (`rel` from `dir`, forward slashes):
 * `onChange(rel)` hears the path from `dir` of each change, as fs.watch's recursive callback names it.
 * A folder made later is watched from then on, one removed forgotten. Throws when `dir` can't be
 * watched. Returns { close, on, folders } (folders: what's watched, for the tests).
 */
export function watchTree(dir, { skip = () => false, onChange, watch = (path, listener) => fsWatch(path, listener) }) {
  const watchers = new Map();
  let closed = false;
  const forget = (rel) => {
    for (const [at, w] of watchers) {
      if (at === rel || at.startsWith(`${rel}/`)) {
        w.close();
        watchers.delete(at);
      }
    }
  };
  const add = (rel) => {
    if (closed || watchers.has(rel) || (rel !== '.' && skip(rel))) return;
    const abs = rel === '.' ? dir : join(dir, rel);
    let w;
    try {
      w = watch(abs, (type, name) => {
        if (closed || !name) return;
        const path = rel === '.' ? String(name).replace(/\\/g, '/') : `${rel}/${String(name).replace(/\\/g, '/')}`;
        if (type === 'rename') {
          // A folder made (watched from now on, and what's in it already) or one gone.
          let isDir = false;
          try {
            isDir = statSync(join(dir, path)).isDirectory();
          } catch {
            forget(path);
          }
          if (isDir) add(path);
        }
        onChange(path);
      });
    } catch (e) {
      if (rel === '.') throw e;
      return;
    }
    w.on?.('error', () => forget(rel));
    watchers.set(rel, w);
    let entries = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      // Gone already: its parent's event says so.
    }
    for (const e of entries) if (e.isDirectory()) add(rel === '.' ? e.name : `${rel}/${e.name}`);
  };
  add('.');
  return {
    close() {
      closed = true;
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
    on() {},
    folders: () => [...watchers.keys()].sort(),
  };
}
