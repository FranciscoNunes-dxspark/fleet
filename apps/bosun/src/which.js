// Finding a program on the PATH, as the shell would: each folder in order, and on Windows each of
// PATHEXT's extensions (hail.cmd, hail.exe). `exists` is injectable for the tests.
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, win32, posix } from 'node:path';

const runnable = (file, platform) => {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The full path of `name` on the PATH, or null. */
export function findOnPath(name, { env = process.env, platform = process.platform, exists = (f) => runnable(f, platform) } = {}) {
  const win = platform === 'win32';
  const path = win ? (env.PATH ?? env.Path ?? env.path ?? '') : (env.PATH ?? '');
  const dirs = path.split(win ? ';' : platform === process.platform ? delimiter : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exts = win ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  const hasExt = win && exts.some((e) => name.toLowerCase().endsWith(e));
  const joinPath = win ? win32.join : platform === process.platform ? join : posix.join;
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const file = joinPath(dir, name + ext);
      if (exists(file)) return file;
    }
  }
  return null;
}
