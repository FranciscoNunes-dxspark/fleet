// Ballast's reads of the disk: a project's stats file or output folder made into a build (build.js's
// shape), the versions and licences of its packages from its lock file, its budgets file, and the
// output folders read for what they give away. Everything here only reads.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseNpmLock } from '@fleet/kit/lockfiles.js';
import { cleanId, parseStats, statsJson, TOOLS } from './stats.js';
import { finishChunk, kindOf } from './build.js';
import { compressedSizesAsync, mapLimit } from './sizes.js';
import { mapUrlOf, sourceSizes } from './sourcemap.js';
import { readBudgets } from './budgets.js';
import { bundleSecrets, mapFinding } from './security.js';

/** The folders a build is looked for in, in this order. */
export const OUTPUT_DIRS = ['dist', 'build', '.next/static', 'out'];

/** Where stats files are looked for, under the project: its own folder, the output folders, and .ballast/. */
export const STATS_NAMES = ['stats.json', 'meta.json', 'metafile.json', 'esbuild-meta.json', 'webpack-stats.json', 'bundle-stats.json', 'compilation-stats.json', 'stats.html'];
const STATS_DIRS = ['', '.ballast', 'dist', 'build', 'out', 'reports'];

const MAX_FILES = 5000;
const MAX_TEXT = 20 * 1024 * 1024;
// What a server compresses; an image or a font is sent as it is.
const COMPRESSIBLE = new Set(['js', 'css', 'html', 'wasm']);
const TEXTUAL = /\.(m?js|cjs|css|html?|json|txt|xml|svg|webmanifest)$/i;

const slash = (p) => p.split(sep).join('/');
const rel = (root, p) => slash(relative(root, p)) || '.';

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The files under `dir`, as [{ full, path }] (`path` relative to `dir`, /-separated), at most MAX_FILES. */
export function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < MAX_FILES) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) stack.push(full);
      else if (e.isFile()) out.push({ full, path: slash(relative(dir, full)) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A file's sizes, compressed only where a server would compress it. */
async function fileSizes(full, file) {
  const bytes = readFileSync(full);
  if (!COMPRESSIBLE.has(kindOf(file)) && !/\.(json|svg|txt|xml)$/i.test(file)) return { raw: bytes.length, gzip: bytes.length, brotli: bytes.length };
  return compressedSizesAsync(bytes);
}

// Files compressed at once: libuv's four threads, each file's gzip and brotli on two of them. An 18 MB
// output folder of 31 files took 36 s one file after another, on the main thread.
const AT_ONCE = 4;

/** The stats files under `root`, newest first: [{ path, mtime }]. */
export function findStatsFiles(root) {
  const found = [];
  for (const d of STATS_DIRS) {
    for (const name of STATS_NAMES) {
      const p = join(root, d, name);
      try {
        const s = statSync(p);
        if (s.isFile()) found.push({ path: p, mtime: s.mtimeMs });
      } catch {}
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** The output folders there are under `root`: [{ dir, label }]. */
export const findOutputDirs = (root) => OUTPUT_DIRS.map((d) => ({ dir: join(root, d), label: d })).filter((o) => existsSync(o.dir) && statSync(o.dir).isDirectory());

/**
 * The project's lock file (package-lock.json here or up to three folders above, as in a workspace) and
 * what it says: `versionAt(installPath)`, and `licences` name@version → licence (the kit's parser).
 * Where the lock file is silent, the installed package's own package.json is read.
 */
export function readLock(root) {
  let dir = resolve(root);
  let lock = null;
  let text = null;
  for (let i = 0; i < 4 && !lock; i++) {
    for (const name of ['package-lock.json', 'npm-shrinkwrap.json']) {
      text = readText(join(dir, name));
      if (text) {
        try {
          lock = { dir, json: JSON.parse(text) };
          break;
        } catch {}
      }
    }
    if (dirname(dir) === dir) break;
    if (!lock) dir = dirname(dir);
  }
  const licences = new Map();
  if (lock) {
    try {
      for (const p of parseNpmLock(text)) if (p.license) licences.set(`${p.name}@${p.version}`, p.license);
    } catch {}
  }
  const own = new Map();
  const installed = (installPath) => {
    if (!own.has(installPath)) {
      let found = null;
      for (const base of [root, lock?.dir].filter(Boolean)) {
        const t = readText(join(base, installPath, 'package.json'));
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          found = { version: j.version ?? null, license: typeof j.license === 'string' ? j.license : (j.license?.type ?? null) };
          break;
        } catch {}
      }
      own.set(installPath, found);
    }
    return own.get(installPath);
  };
  const versionAt = (installPath) => lock?.json?.packages?.[installPath]?.version ?? installed(installPath)?.version ?? null;
  const licenceOf = (name, version, installPath) => licences.get(`${name}@${version}`) ?? (installPath ? installed(installPath)?.license : null) ?? null;
  return { path: lock ? join(lock.dir, 'package-lock.json') : null, versionAt, licenceOf };
}

/** Where a chunk the stats name is on the disk, or null. */
function locate(root, name, { statsDir, outputPath }) {
  if (isAbsolute(name)) return isFile(name) ? name : null;
  const bases = [root, outputPath, ...OUTPUT_DIRS.map((d) => join(root, d)), statsDir].filter(Boolean);
  for (const b of bases) if (isFile(join(b, name))) return join(b, name);
  return null;
}

/** A source map's sources as module ids: relative to the project, from the map's own folder. */
function mapModules(root, mapFile, map, code) {
  const sizes = sourceSizes(map, code);
  if (!sizes) return [];
  return [...sizes].map(([source, bytes]) => {
    if (source === '[unmapped]') return { id: source, bytes };
    const s = source.replace(/^\0/, '').replace(/\?.*$/, '');
    // webpack:// sources are the project's already, absolute ones are made so, the rest are relative to the map.
    let id;
    if (/^webpack:\/\//.test(s)) id = cleanId(s, root);
    else if (isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) id = rel(root, s);
    else id = rel(root, resolve(dirname(mapFile), s));
    return { id: id.replace(/^(\.\.\/)+(?=node_modules\/)/, ''), bytes };
  });
}

/** The modules of a built file from its map, when it has one beside it (or named in it). */
function modulesFromMap(root, full) {
  if (!/\.(m?js|cjs|css)$/i.test(full)) return [];
  const code = readText(full);
  if (code == null) return [];
  const url = mapUrlOf(code);
  const candidates = [url && !/^https?:/.test(url) ? resolve(dirname(full), decodeURIComponent(url)) : null, `${full}.map`].filter(Boolean);
  for (const mapFile of candidates) {
    const text = readText(mapFile);
    if (!text) continue;
    try {
      return mapModules(root, mapFile, JSON.parse(text), code);
    } catch {}
  }
  return [];
}

/**
 * The project's build: from `statsPath` (or the newest stats file found), else from the output folders
 * (`outDirs`, or those found), each file a chunk and its source map, if it has one, its modules.
 * { root, tool, source: { kind, path?, label }, chunks, licences, lock, at }; kind 'none' with no chunks
 * when there is nothing to read.
 */
export async function readBuild(root, { statsPath = null, outDirs = null, now = Date.now } = {}) {
  root = resolve(root);
  const lock = readLock(root);
  const versionAt = lock.versionAt;
  const finish = (build, source) => {
    const licences = {};
    for (const c of build.chunks) for (const m of c.modules) if (m.pkg?.version && !(`${m.pkg.name}@${m.pkg.version}` in licences)) licences[`${m.pkg.name}@${m.pkg.version}`] = lock.licenceOf(m.pkg.name, m.pkg.version, m.pkg.installPath);
    return { root, tool: build.tool, source, chunks: build.chunks.sort((a, b) => (b.gzip ?? b.raw) - (a.gzip ?? a.raw)), licences, lock: lock.path ? rel(root, lock.path) : null, at: now() };
  };

  const candidates = statsPath ? [{ path: resolve(root, statsPath) }] : outDirs ? [] : findStatsFiles(root);
  for (const { path } of candidates) {
    const text = readText(path);
    const json = text == null ? null : statsJson(text);
    const parsed = json && parseStats(json, { root });
    if (!parsed) {
      if (statsPath) throw new Error(text == null ? `Couldn't read ${statsPath}` : `${statsPath} isn't stats Ballast reads (esbuild's metafile, rollup-plugin-visualizer's data, webpack's stats)`);
      continue;
    }
    const chunks = await mapLimit(parsed.chunks, AT_ONCE, async (c) => {
      const found = locate(root, c.name, { statsDir: dirname(path), outputPath: parsed.outputPath });
      return finishChunk({ file: found ? rel(root, found) : c.name, bytes: c.bytes, sizes: found ? await fileSizes(found, found) : null, modules: c.modules, entry: c.entry }, { versionAt });
    });
    return finish({ tool: parsed.tool, chunks }, { kind: 'stats', path: rel(root, path), label: `${TOOLS[parsed.tool]}, ${rel(root, path)}` });
  }

  const dirs = outDirs ?? findOutputDirs(root);
  const files = dirs.flatMap(({ dir, label }) => walk(dir).filter((f) => !/\.(map|gz|br)$/i.test(f.path)).map((f) => ({ ...f, file: `${label}/${f.path}` })));
  // A file's map is read while the files before it are compressed.
  const chunks = await mapLimit(files, AT_ONCE, async (f) => {
    const sizes = fileSizes(f.full, f.file);
    const modules = modulesFromMap(root, f.full);
    return finishChunk({ file: f.file, sizes: await sizes, modules }, { versionAt });
  });
  if (!chunks.length) return { root, tool: null, source: { kind: 'none', label: 'nothing read' }, chunks: [], licences: {}, lock: lock.path ? rel(root, lock.path) : null, at: now() };
  const mapped = chunks.some((c) => c.modules.length);
  return finish({ tool: null, chunks }, { kind: 'files', label: `${dirs.map((d) => `${d.label}/`).join(', ')}${mapped ? ' and its source maps' : ' (no stats: sizes only)'}` });
}

/**
 * The budgets file: ballast.json, else package.json's fleet.ballast; readBudgets's result with `from`
 * (the file, or null when there is none).
 */
export function readBudgetsFile(root) {
  const own = readText(join(root, 'ballast.json'));
  if (own != null) {
    try {
      return { ...readBudgets(JSON.parse(own)), from: 'ballast.json' };
    } catch (e) {
      return { ...readBudgets({}), errors: [`ballast.json: ${e.message}`], from: 'ballast.json' };
    }
  }
  const pkg = readText(join(root, 'package.json'));
  try {
    const section = pkg && JSON.parse(pkg)?.fleet?.ballast;
    if (section) return { ...readBudgets(section), from: 'package.json (fleet.ballast)' };
  } catch {}
  return { ...readBudgets({}), from: null };
}

/**
 * The output folders (`outDirs`, or those found) read for what they give away: source maps, and
 * secrets in the built files. { dirs, files, findings } in findings.js's shape.
 */
export function readSecurity(root, { outDirs = null } = {}) {
  root = resolve(root);
  const dirs = outDirs ?? findOutputDirs(root);
  const findings = [];
  let files = 0;
  for (const { dir, label } of dirs) {
    const maps = [];
    for (const f of walk(dir)) {
      files++;
      const path = `${label}/${f.path}`;
      if (/\.map$/i.test(f.path)) {
        const text = readText(f.full) ?? '';
        maps.push({ path, sources: /"sourcesContent"\s*:\s*\[\s*"/.test(text) });
        continue;
      }
      if (!TEXTUAL.test(f.path)) continue;
      try {
        if (statSync(f.full).size > MAX_TEXT) continue;
      } catch {
        continue;
      }
      const text = readText(f.full);
      if (text) findings.push(...bundleSecrets(path, text));
    }
    const m = mapFinding(label, maps);
    if (m) findings.push(m);
  }
  return { dirs: dirs.map((d) => d.label), files, findings };
}

/** The project's package.json and the names in its folder, for buildplan.js. */
export function projectFiles(root) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {}
  let names = [];
  try {
    names = readdirSync(root);
  } catch {}
  return { pkg, files: new Set(names) };
}
