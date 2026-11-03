// A build as Ballast shows it, from a parsed stats file or an output folder: each chunk's file, its
// raw, gzip and brotli size, and the modules in it with the package each belongs to. Pure; disk.js
// does the reading.
//
// build = { root, tool, source: { kind: 'stats'|'files'|'none', path?, label }, chunks, licences, at }
// chunk = { file, name, raw, gzip, brotli, kind, entry, modules: [{ id, bytes, pkg }] }
// `file` is the path relative to the project (/-separated) where it was found on the disk, else as the
// stats name it; `name` is the file without its content hash, which is how one build's chunk is
// matched with another's. `gzip` and `brotli` are null for a file the stats name but the disk hasn't.
// A module's `bytes` are its share of the chunk's raw size: what the stats said, scaled so the
// modules add up to the file (webpack and the visualizer count before minifying).
import { packageOf } from './packages.js';

/**
 * The file name without its content hash: dist/assets/index-B7xk2Lq9.js → dist/assets/index-[hash].js,
 * main.3f9a1c2e.js, 412.a1b2c3d4e5.chunk.js. The hash is the last part after a - or . that is eight
 * characters or more (Vite's own may hold a - too: index-D-xk2Lq9.js); a word (vendor-components)
 * isn't one: a hash has a digit, or upper and lower case mixed.
 */
export function stableName(file) {
  const m = /^(.*?)((?:\.chunk)?\.[a-z0-9]+)$/i.exec(file);
  if (!m) return file;
  const [, base, ext] = m;
  const slash = base.lastIndexOf('/');
  for (let i = base.length - 1; i > slash; i--) {
    if (base[i] !== '-' && base[i] !== '.') continue;
    const tail = base.slice(i + 1);
    if (tail.length < 8) continue;
    if (tail.length > 32 || !/^[A-Za-z0-9_-]+$/.test(tail)) return file;
    if (!(/\d/.test(tail) || (/[a-z]/.test(tail) && /[A-Z]/.test(tail)))) return file;
    return `${base.slice(0, i + 1)}[hash]${ext}`;
  }
  return file;
}

/** js, css, html, wasm, font, image, or other: how a file is grouped and which ones budgets total. */
export function kindOf(file) {
  const f = String(file).toLowerCase();
  if (/\.(m?js|cjs)$/.test(f)) return 'js';
  if (f.endsWith('.css')) return 'css';
  if (/\.html?$/.test(f)) return 'html';
  if (f.endsWith('.wasm')) return 'wasm';
  if (/\.(woff2?|ttf|otf|eot)$/.test(f)) return 'font';
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(f)) return 'image';
  return 'other';
}

/**
 * One chunk, finished: `sizes` ({ raw, gzip, brotli }, from the disk) or the stats' own `bytes`;
 * modules scaled to the raw size and given their package (`versionAt(installPath)` fills in the
 * version where the path doesn't say it).
 */
export function finishChunk({ file, bytes = 0, sizes = null, modules = [], entry = false }, { versionAt = () => null } = {}) {
  const raw = sizes?.raw ?? bytes;
  const sum = modules.reduce((n, m) => n + m.bytes, 0);
  const scale = sum > 0 && raw > 0 ? raw / sum : 1;
  const finished = modules.map((m) => {
    const pkg = packageOf(m.id);
    const version = pkg && (pkg.version ?? versionAt(pkg.installPath));
    return { id: m.id, bytes: Math.round(m.bytes * scale), pkg: pkg ? { ...pkg, ...(version ? { version } : {}) } : null };
  });
  finished.sort((a, b) => b.bytes - a.bytes);
  return { file, name: stableName(file), raw, gzip: sizes?.gzip ?? null, brotli: sizes?.brotli ?? null, kind: kindOf(file), entry, modules: finished };
}

/** The chunks' sizes added up: { raw, gzip, brotli } (gzip and brotli null when a chunk has none). */
export function totals(chunks) {
  const sum = (k) => (chunks.every((c) => c[k] != null) ? chunks.reduce((n, c) => n + c[k], 0) : null);
  return { raw: chunks.reduce((n, c) => n + c.raw, 0), gzip: sum('gzip'), brotli: sum('brotli') };
}

/** A module's share of its chunk in `measure`: its raw bytes at the chunk's compression ratio (an estimate, said so where shown). */
export function moduleSize(m, chunk, measure = 'gzip') {
  if (measure === 'raw' || !chunk.raw || chunk[measure] == null) return m.bytes;
  return Math.round((m.bytes * chunk[measure]) / chunk.raw);
}

/**
 * Every package in `chunks`, biggest first: [{ name, bytes, gzip, modules, versions: [..], installs:
 * [{ installPath, version, bytes, modules, chunks: [file] }], chunks: [file] }]. `gzip` is estimated as
 * moduleSize does.
 */
export function packageTotals(chunks, measure = 'gzip') {
  const byName = new Map();
  for (const c of chunks) {
    for (const m of c.modules) {
      if (!m.pkg) continue;
      let p = byName.get(m.pkg.name);
      if (!p) byName.set(m.pkg.name, (p = { name: m.pkg.name, bytes: 0, size: 0, modules: 0, installs: new Map(), chunks: new Set() }));
      p.bytes += m.bytes;
      p.size += moduleSize(m, c, measure);
      p.modules++;
      p.chunks.add(c.file);
      let i = p.installs.get(m.pkg.installPath);
      if (!i) p.installs.set(m.pkg.installPath, (i = { installPath: m.pkg.installPath, version: m.pkg.version ?? null, bytes: 0, size: 0, modules: 0, chunks: new Set() }));
      i.bytes += m.bytes;
      i.size += moduleSize(m, c, measure);
      i.modules++;
      i.chunks.add(c.file);
    }
  }
  return [...byName.values()]
    .map((p) => {
      const installs = [...p.installs.values()].map((i) => ({ ...i, chunks: [...i.chunks] })).sort((a, b) => b.bytes - a.bytes);
      return { ...p, installs, chunks: [...p.chunks], versions: [...new Set(installs.map((i) => i.version).filter(Boolean))] };
    })
    .sort((a, b) => b.bytes - a.bytes);
}
