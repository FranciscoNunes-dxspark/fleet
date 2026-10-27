// Which branch and commit the project's checkout is on, read from the files git keeps (HEAD, the
// ref's file or packed-refs) rather than by starting git: the recorder asks at every process start,
// and a git process costs about 100 ms on Windows. Bosun only reads this; switching the checkout is
// Splice's, which /replay's restore hands a line to.
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** The git folder of the checkout `dir` is in (a linked worktree's own, from its .git file), or null. */
export function gitDirOf(dir, fs = { readFileSync, statSync }) {
  let at = resolve(dir);
  for (;;) {
    const dotGit = join(at, '.git');
    try {
      if (fs.statSync(dotGit).isDirectory()) return dotGit;
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (m) return isAbsolute(m[1].trim()) ? m[1].trim() : resolve(at, m[1].trim());
    } catch {}
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The folder a linked worktree shares its refs with (its `commondir`), else the git folder itself. */
function commonDirOf(gitDir, fs) {
  try {
    const rel = fs.readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
    return isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } catch {
    return gitDir;
  }
}

/** The commit `ref` (refs/heads/main) points at, from its own file or packed-refs, or null. */
export function readRef(gitDir, ref, fs = { readFileSync, statSync }) {
  for (const base of new Set([gitDir, commonDirOf(gitDir, fs)])) {
    try {
      const text = fs.readFileSync(join(base, ...ref.split('/')), 'utf8').trim();
      if (HASH.test(text)) return text;
      const sym = /^ref:\s*(\S+)/.exec(text);
      if (sym) return readRef(gitDir, sym[1], fs);
    } catch {}
  }
  try {
    const packed = fs.readFileSync(join(commonDirOf(gitDir, fs), 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      const [hash, name] = line.trim().split(' ');
      if (name === ref && HASH.test(hash)) return hash;
    }
  } catch {}
  return null;
}

/** { branch, commit } of the checkout `dir` is in (branch null when detached), or null outside one. */
export function gitHead(dir, fs = { readFileSync, statSync }) {
  const gitDir = gitDirOf(dir, fs);
  if (!gitDir) return null;
  let head;
  try {
    head = fs.readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
  if (HASH.test(head)) return { branch: null, commit: head };
  const m = /^ref:\s*(\S+)/.exec(head);
  if (!m) return null;
  // A branch with no commit yet (a new repository) has no commit to go back to.
  const commit = readRef(gitDir, m[1], fs);
  return { branch: m[1].replace(/^refs\/heads\//, ''), commit };
}

/** Where branch `name` points now in the checkout `dir` is in, or null. */
export function branchTip(dir, name, fs = { readFileSync, statSync }) {
  const gitDir = gitDirOf(dir, fs);
  return gitDir ? readRef(gitDir, `refs/heads/${name}`, fs) : null;
}
