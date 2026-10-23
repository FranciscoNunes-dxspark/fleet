// Which file changes restart a process (bosun.json's "watch" and "ignore"): paths or globs from the
// process's folder. Pure: the supervisor watches the folders and asks here about each change.

// Never worth a restart, whatever "ignore" says.
export const ALWAYS_IGNORED = ['node_modules', '.git'];

const GLOB = /[*?[{]/;

/** A path as it's matched: forward slashes, no ./ in front or / at the end. */
export const tidy = (path) => String(path).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';

/** The regular expression for a glob: ** any folders, * and ? within one name, {a,b} either. */
export function globRegex(glob) {
  let out = '';
  const g = tidy(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else out += '.*';
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end < 0) out += '\\{';
      else {
        out += `(?:${g.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = end;
      }
    } else out += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Whether `path` is `pattern`: a glob it matches, or a plain path it is or is inside of. */
function matches(pattern, path) {
  const p = tidy(pattern);
  if (GLOB.test(p)) return globRegex(p).test(path);
  return p === '.' || path === p || path.startsWith(`${p}/`);
}

/**
 * What to watch for `patterns`: [{ root, deep }], each pattern's part before its first glob, so
 * "src/**\/*.ts" watches src and everything in it (`deep`), and "*.json" the process's folder alone.
 * A plain path is watched deep (it may be a folder). Ones a deep root covers are left out.
 */
export function watchRoots(patterns) {
  const found = new Map();
  for (const pattern of patterns) {
    const parts = tidy(pattern).split('/');
    const at = parts.findIndex((x) => GLOB.test(x));
    const root = at < 0 ? parts.join('/') : parts.slice(0, at).join('/') || '.';
    const deep = at < 0 || at < parts.length - 1 || parts[at].includes('**');
    found.set(root, found.get(root) || deep);
  }
  const all = [...found].map(([root, deep]) => ({ root, deep }));
  const covers = (o, r) => o.deep && o.root !== r.root && (o.root === '.' || r.root.startsWith(`${o.root}/`));
  return all.filter((r) => !all.some((o) => covers(o, r)));
}

/**
 * Whether a change to `path` (from the process's folder) restarts it: it matches a `watch` pattern
 * and no `ignore` one. An ignore pattern without a / matches any name along the path (as
 * .gitignore's do); node_modules and .git are always ignored.
 */
export function watchMatcher(patterns, ignore = []) {
  const skip = [...ALWAYS_IGNORED, ...ignore].map((pattern) => {
    const p = tidy(pattern);
    if (p.includes('/')) return (path) => matches(p, path);
    const re = globRegex(p);
    return (path) => path.split('/').some((name) => re.test(name));
  });
  return (file) => {
    const path = tidy(file);
    return patterns.some((p) => matches(p, path)) && !skip.some((s) => s(path));
  };
}

/**
 * Whether nothing in the folder at `path` (from the process's folder) can restart it, so it needn't be
 * watched: node_modules, .git, a name "ignore" has (anywhere along the path, as watchMatcher reads
 * it), or a plain path "ignore" has. An ignore glob with a / in it may take some of a folder and not
 * the rest, so it never leaves one out.
 */
export function skipsFolder(ignore = []) {
  const rules = [...ALWAYS_IGNORED, ...ignore].map(tidy).flatMap((p) => {
    if (!p.includes('/')) {
      const re = globRegex(p);
      return [(path) => p === '.' || path.split('/').some((name) => re.test(name))];
    }
    return GLOB.test(p) ? [] : [(path) => path === p || path.startsWith(`${p}/`)];
  });
  return (path) => {
    const at = tidy(path);
    return rules.some((r) => r(at));
  };
}
