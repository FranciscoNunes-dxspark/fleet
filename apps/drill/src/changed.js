// `c`: only the tests that touch what changed. The changed files are git's (`git status --porcelain`,
// what Splice shows as changed), read through run.js; a test file touches a changed file when it is
// that file, when their names match (cart.ts and cart.test.ts, Price.cs and PriceTests.cs), or when it
// imports it (or, in C#, names its class). Pure.
import { basename, dirname, extname, posix } from 'node:path';

/** The paths in `git status --porcelain` (v1) output, relative to the repository: a rename's new path, deletions too. */
export function parsePorcelain(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue;
    let path = line.slice(3);
    if (/^R|^C/.test(line) || / -> /.test(path)) path = path.split(' -> ').at(-1);
    out.push(path.replace(/^"(.*)"$/, '$1'));
  }
  return [...new Set(out)];
}

// A test file's name, as the runners find them.
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)\/.*\.[cm]?[jt]sx?$|(?:^|\/)test[-_][^/]*\.[cm]?[jt]s$|Tests?\.(?:cs|fs|vb)$)/;

/** Whether `path` (relative, /-separated) looks like a test file. */
export const isTestFile = (path) => TEST_FILE.test(path);

/** A file's name without its folder, extension or test suffix: src/cart.test.ts → cart, PriceTests.cs → Price. */
export function stem(path) {
  const name = basename(path, extname(path));
  return name.replace(/\.(?:test|spec)$/, '').replace(/^test[-_]/, '').replace(/Tests?$/, '').toLowerCase();
}

/** The relative imports in a JS or TS file's text ('./cart', '../lib/price.js'), resolved against its folder, without extensions. */
export function importsOf(path, text) {
  const out = new Set();
  const re = /(?:import\s[^'"`]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+|export\s[^'"`]*?from\s*)['"`](\.{1,2}\/[^'"`]+)['"`]/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const full = posix.normalize(posix.join(posix.dirname(path), m[1]));
    out.add(full.replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, ''));
  }
  return out;
}

const noExt = (p) => p.replace(/\.[^./]+$/, '');

/**
 * Of `testFiles` ([{ path, text }], relative to the project, /-separated), the ones touching `changed`
 * (paths the same way): [{ path, why }]. A C# test file touches a changed class when its name matches
 * or its text uses the class (`new Price(`, `Price.Format`).
 */
export function testsTouching(changed, testFiles) {
  // What each changed file is, worked out once rather than for every test file it's compared with.
  const each = changed.map((c) => ({
    c,
    dotnet: /\.(?:cs|fs|vb)$/.test(c),
    js: /\.[cm]?[jt]sx?$/.test(c),
    stem: stem(c),
    name: basename(c),
    cls: basename(c, extname(c)),
    top: dirname(c).split('/')[0],
    module: noExt(c).replace(/\/index$/, ''),
  }));
  for (const x of each) if (x.dotnet && x.cls.length > 2) x.uses = new RegExp(`\\b${x.cls}\\b`);
  const out = [];
  for (const t of testFiles) {
    let why = null;
    const tStem = stem(t.path);
    const tDotnet = /\.(?:cs|fs|vb)$/.test(t.path);
    // A test file's imports, read from its text once, and only when a changed file needs them.
    let imports = null;
    for (const x of each) {
      const c = x.c;
      if (c === t.path) why = 'changed';
      else if (x.dotnet && tDotnet) {
        if (x.stem === tStem) why = `tests ${x.name}`;
        else if (x.uses?.test(t.text ?? '')) why = `uses ${x.cls}`;
      } else if (x.js) {
        if (x.stem === tStem && x.top === dirname(t.path).split('/')[0]) why = `tests ${x.name}`;
        else if ((imports ??= importsOf(t.path, t.text)).has(x.module)) why = `imports ${x.name}`;
      }
      if (why) break;
    }
    if (why) out.push({ path: t.path, why });
  }
  return out;
}

/** The .NET test classes in a C# test file's text (Namespace.Class), for dotnet test's filter. */
export function classesIn(text) {
  const ns = /^\s*namespace\s+([\w.]+)/m.exec(String(text ?? ''))?.[1];
  return [...String(text ?? '').matchAll(/\bclass\s+(\w+)/g)].map((m) => (ns ? `${ns}.${m[1]}` : m[1]));
}
