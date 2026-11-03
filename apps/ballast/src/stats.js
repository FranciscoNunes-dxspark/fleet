// The stats files bundlers write, read into one shape. Pure.
//
// - esbuild's metafile (--metafile, or `metafile: true`): `outputs` maps each output file to its bytes
//   and the bytes each input put in it (`bytesInOutput`, after minifying).
// - rollup-plugin-visualizer's data, as Vite and Rollup builds write it (`template: 'raw-data'`, a
//   JSON file, or the data inside the stats.html of its other templates): `nodeMetas` are the modules,
//   each with a `moduleParts` entry per output file pointing into `nodeParts` (`renderedLength`, the
//   bytes it rendered, before minifying).
// - webpack's stats (webpack --json, or stats.toJson()): `assets` and their sizes, `chunks` and the
//   files they became, `modules` with their size (before minifying) and the chunks they are in; a
//   concatenated module ("./src/index.js + 12 modules") carries the modules it holds. A multi-compiler
//   build has `children`.
//
// A parsed build is { tool, chunks: [{ name, bytes, modules: [{ id, bytes }], entry }], outputPath? }:
// `name` as the stats name the file, `bytes` its size as they say, `id` a module's path (relative,
// /-separated). Module sizes as webpack and the visualizer give them are before minifying; disk.js
// scales them to what the chunk weighs.

export const TOOLS = { esbuild: 'esbuild metafile', rollup: 'rollup-plugin-visualizer data', webpack: 'webpack stats' };

/** Which stats a parsed JSON is: 'esbuild', 'rollup', 'webpack', or null. */
export function detectFormat(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.inputs && json.outputs) return 'esbuild';
  if (json.nodeMetas && json.nodeParts) return 'rollup';
  if (Array.isArray(json.assets) || Array.isArray(json.chunks) || Array.isArray(json.children)) return 'webpack';
  return null;
}

/**
 * A stats file's text as JSON: the file itself, or the data rollup-plugin-visualizer puts in its HTML
 * (`const data = {…};`). null when it is neither.
 */
export function statsJson(text) {
  const s = String(text ?? '');
  try {
    return JSON.parse(s);
  } catch {
    const m = /\bconst\s+data\s*=\s*(\{[\s\S]*?\});\s*\n/.exec(s);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
}

/**
 * A module's id as a path to show and group by: forward slashes, without webpack's `webpack://app/`,
 * a loader chain (`css-loader!…`), a query, Rollup's \0 for a virtual module, `./`, or `root` (an
 * absolute path in the stats made relative to the project). A leading / (the visualizer's way of
 * saying "from the project") goes too.
 */
export function cleanId(id, root = '') {
  let s = String(id ?? '').replace(/\\/g, '/');
  s = s.replace(/^webpack:\/\/[^/]*\//, '').replace(/^\0/, '');
  if (s.includes('!')) s = s.slice(s.lastIndexOf('!') + 1);
  s = s.replace(/\?.*$/, '').replace(/ \+ \d+ modules?$/, '');
  const r = String(root).replace(/\\/g, '/').replace(/\/$/, '');
  if (r && s.toLowerCase().startsWith(`${r.toLowerCase()}/`)) s = s.slice(r.length + 1);
  return s.replace(/^\.\//, '').replace(/^\/(?=[^/])/, '');
}

const isMap = (name) => /\.map$/i.test(name);

/** Parses `json` in whatever format it is: a build, or null when it is no stats Ballast reads. */
export function parseStats(json, { root = '' } = {}) {
  const format = detectFormat(json);
  if (format === 'esbuild') return parseEsbuild(json, root);
  if (format === 'rollup') return parseVisualizer(json, root);
  if (format === 'webpack') return parseWebpack(json, root);
  return null;
}

export function parseEsbuild(meta, root = '') {
  const chunks = [];
  for (const [name, out] of Object.entries(meta.outputs ?? {})) {
    if (isMap(name)) continue;
    const modules = Object.entries(out.inputs ?? {})
      .map(([id, v]) => ({ id: cleanId(id, root), bytes: v?.bytesInOutput ?? 0 }))
      .filter((m) => m.bytes > 0);
    chunks.push({ name: cleanId(name, root), bytes: out.bytes ?? 0, modules, entry: Boolean(out.entryPoint) });
  }
  return { tool: 'esbuild', chunks };
}

export function parseVisualizer(data, root = '') {
  const chunks = new Map();
  const chunk = (name) => {
    if (!chunks.has(name)) chunks.set(name, { name, bytes: 0, modules: [], entry: false });
    return chunks.get(name);
  };
  for (const meta of Object.values(data.nodeMetas ?? {})) {
    for (const [file, uid] of Object.entries(meta.moduleParts ?? {})) {
      const part = data.nodeParts?.[uid];
      const c = chunk(file);
      if (meta.isEntry) c.entry = true;
      if (!part?.renderedLength) continue;
      c.modules.push({ id: cleanId(meta.id, root), bytes: part.renderedLength });
      c.bytes += part.renderedLength;
    }
  }
  return { tool: 'rollup', chunks: [...chunks.values()].filter((c) => !isMap(c.name)) };
}

/** A module's own modules where webpack concatenated them (scope hoisting), else the module itself. */
function flatModules(m) {
  if (Array.isArray(m.modules) && m.modules.length) return m.modules.flatMap((inner) => flatModules({ ...inner, chunks: inner.chunks?.length ? inner.chunks : m.chunks }));
  return [m];
}

export function parseWebpack(stats, root = '') {
  // A multi-compiler build: every child's files, as one build.
  if (!stats.assets && Array.isArray(stats.children)) {
    const parts = stats.children.map((c) => parseWebpack(c, root));
    return { tool: 'webpack', chunks: parts.flatMap((p) => p.chunks), outputPath: stats.children[0]?.outputPath };
  }
  const assetSize = new Map((stats.assets ?? []).map((a) => [a.name, a.size ?? 0]));
  const byFile = new Map();
  const fileOfChunk = new Map();
  for (const c of stats.chunks ?? []) {
    const files = (c.files ?? []).filter((f) => !isMap(f));
    // A chunk's modules go to its script, its stylesheets' to its stylesheet when it has one.
    const js = files.find((f) => /\.m?js$/i.test(f)) ?? files[0];
    const css = files.find((f) => /\.css$/i.test(f)) ?? js;
    for (const f of files) if (!byFile.has(f)) byFile.set(f, { name: f, bytes: assetSize.get(f) ?? 0, modules: [], entry: Boolean(c.entry || c.initial) });
    if (js) fileOfChunk.set(String(c.id), { js, css });
  }
  const modules = stats.modules ?? (stats.chunks ?? []).flatMap((c) => (c.modules ?? []).map((m) => ({ ...m, chunks: m.chunks ?? [c.id] })));
  const seen = new Set();
  for (const top of modules) {
    // An orphan is in no chunk; the modules a concatenated one holds are marked orphans too, but ship in it.
    if (top.orphan) continue;
    for (const m of flatModules(top)) {
      if (!m.size) continue;
      const id = cleanId(m.name ?? m.identifier, root);
      const css = /^css\b/.test(m.moduleType ?? '') || /\.(css|scss|sass|less)$/i.test(id);
      for (const chunkId of m.chunks ?? []) {
        const file = fileOfChunk.get(String(chunkId))?.[css ? 'css' : 'js'];
        if (!file || seen.has(`${file}\0${id}`)) continue;
        seen.add(`${file}\0${id}`);
        byFile.get(file).modules.push({ id, bytes: m.size });
      }
    }
  }
  // Assets no chunk names (images, fonts copied by a loader) still ship.
  for (const [name, bytes] of assetSize) if (!byFile.has(name) && !isMap(name)) byFile.set(name, { name, bytes, modules: [], entry: false });
  return { tool: 'webpack', chunks: [...byFile.values()], outputPath: stats.outputPath };
}
