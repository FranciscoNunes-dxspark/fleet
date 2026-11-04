// The project as one graph. `buildIndex(root)` walks it, reads each file it understands (from the
// cache when its size and time haven't changed) and links what the files say into edges between
// files: a view to its layout, partials, components, templates and child actions, scripts and
// styles to where they load, bundles to their members, compiled files to their sources, imports
// to what they import, and controller actions (nodes `action:<Area>/<Controller>/<Action>`) to the
// views they return. Every lookup on paths ignores case, as IIS and Windows do.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { parseConfig } from './parse/config.js';
import { parseCSharp } from './parse/csharp.js';
import { parseRazor } from './parse/razor.js';
import { parseScript } from './parse/script.js';
import { parseStyle } from './parse/style.js';
import { isVendor, walk } from './walk.js';

const CACHE_VERSION = 8;
const MAX_PARSE = 1_500_000;

/** Where the parsed files are kept between runs: PILOT_CACHE, else the platform's cache folder. */
export function cacheFile(root, env = process.env) {
  const base = env.PILOT_CACHE ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'pilot') : join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'pilot'));
  const key = createHash('sha1').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
  return join(base, `${basename(root).replace(/[^\w.-]/g, '_')}-${key}.json`);
}

/** Reads one file into what Pilot keeps of it. */
export function parseFile(rel, kind, text) {
  const name = posix.basename(rel);
  if (kind === 'view') return parseRazor(text);
  if (kind === 'cs') {
    // Only what can hold controllers, view components, bundles or routes is worth the time.
    if (!/Controller\b|ViewComponent\b|Bundle\s*\(|Map(?:Area)?(?:Controller)?Route\s*\(|\{\s*get\b/.test(text)) return null;
    return parseCSharp(text);
  }
  if (kind === 'script') return parseScript(text);
  if (kind === 'style') return parseStyle(text, rel.toLowerCase().endsWith('.scss') ? 'scss' : rel.toLowerCase().endsWith('.css') ? 'css' : 'less');
  if (kind === 'config') return parseConfig(name, text);
  return null;
}

const lowerKey = (p) => p.toLowerCase();
const stripExt = (p) => p.replace(/\.[^./]+$/, '');
const dirOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const joinRel = (...parts) => posix.normalize(parts.filter((p) => p !== '' && p != null).join('/')).replace(/^\.\/?/, '').replace(/^\/+/, '');

/** A glob's `*`, `**` and `{version}` as a RegExp over `/`-separated paths, case ignored. */
export function globRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (glob.startsWith('{version}', i)) {
      re += '[\\d.]+(?:-[\\w.]+)?';
      i += '{version}'.length - 1;
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// A route parameter's constraint as a pattern: {id:int} only matches digits, so /products/details
// isn't taken for /products/{id:int}.
const CONSTRAINTS = { int: '-?\\d+', long: '-?\\d+', decimal: '-?[\\d.]+', double: '-?[\\d.]+', float: '-?[\\d.]+', bool: '(?:true|false)', guid: '[0-9a-fA-F-]{32,36}', alpha: '[A-Za-z]+', datetime: '[^/]+' };

/** One segment of an attribute route template as a RegExp source. */
export function routeSegment(seg) {
  let out = '';
  let last = 0;
  for (const m of seg.matchAll(/\{([^}]*)\}/g)) {
    out += seg.slice(last, m.index).replace(/[.+^$()|[\]\\*?]/g, '\\$&');
    const [name, ...constraints] = m[1].replace(/=.*$/, '').split(':');
    const optional = name.endsWith('?') || m[1].includes('=') || constraints.some((c) => c.endsWith('?'));
    const pattern = constraints.map((c) => CONSTRAINTS[c.replace(/\(.*$|\?$/g, '').toLowerCase()]).find(Boolean) ?? '[^/]+';
    out += optional ? `(?:${pattern})?` : pattern;
    last = m.index + m[0].length;
  }
  return out + seg.slice(last).replace(/[.+^$()|[\]\\*?]/g, '\\$&');
}

export class ProjectIndex {
  constructor(root, { vendor = false } = {}) {
    this.root = root;
    this.vendor = vendor;
    this.files = new Map();
    this.builtAt = 0;
    this.stats = { parsed: 0, cached: 0, ms: 0 };
  }

  /** The file entry for a path as written anywhere (any case, `\` or `/`, with or without the root). */
  file(path) {
    if (!path) return null;
    let p = String(path).replace(/\\/g, '/');
    const root = this.root.replace(/\\/g, '/');
    if (p.toLowerCase().startsWith(root.toLowerCase() + '/')) p = p.slice(root.length + 1);
    p = p.replace(/^\.\//, '').replace(/:\d+(:\d+)?$/, '');
    return this.files.get(this.lower.get(lowerKey(p))) ?? null;
  }

  /** Walks and parses, reusing the cache for files that haven't changed. Returns this. */
  build({ cache = true, ignore = [], progress = () => {} } = {}) {
    const started = Date.now();
    const listed = walk(this.root, { ignore });
    const cachePath = cacheFile(this.root);
    let old = {};
    if (cache && this.files.size === 0) {
      try {
        const saved = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (saved.version === CACHE_VERSION) old = saved.files;
      } catch {
        // No cache yet, or an unreadable one: everything is read.
      }
    } else if (this.files.size) old = Object.fromEntries(this.files);
    const files = new Map();
    let parsed = 0;
    let cached = 0;
    listed.forEach((f, n) => {
      const prev = old[f.rel];
      if (prev && prev.size === f.size && prev.mtime === f.mtime && prev.kind === f.kind) {
        files.set(f.rel, prev);
        cached++;
        return;
      }
      const vendor = isVendor(f.rel);
      let data = null;
      let error = null;
      let lines = null;
      // A library is read only for what links it to the rest (its imports), never its selectors.
      const skip = f.size > MAX_PARSE || f.kind === 'project' || f.kind === 'image' || (vendor && f.kind !== 'config' && !this.vendor);
      if (!skip) {
        try {
          const text = readFileSync(join(this.root, f.rel), 'utf8');
          lines = text.length ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
          data = parseFile(f.rel, f.kind, text);
        } catch (e) {
          error = e.message;
        }
      } else if (vendor && f.kind === 'style' && !this.vendor && f.size < 4_000_000) {
        // A library's stylesheet (bootstrap, font-awesome): only the classes it defines, so markup
        // using them counts as styled. Cheap: no rules, no lines.
        try {
          const text = readFileSync(join(this.root, f.rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '{}');
          data = { libraryClasses: [...new Set([...text.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]))] };
        } catch {
          // Unreadable: it just isn't counted.
        }
      }
      files.set(f.rel, { rel: f.rel, kind: f.kind, size: f.size, mtime: f.mtime, vendor, lines, data, ...(error ? { error } : {}), ...(f.size > MAX_PARSE ? { skipped: 'too large' } : {}) });
      parsed++;
      if (parsed % 500 === 0) progress(`${n + 1}/${listed.length} files`);
    });
    this.files = files;
    this.stats = { parsed, cached, files: files.size, ms: Date.now() - started };
    if (cache && parsed) {
      try {
        mkdirSync(dirOf(cachePath.replace(/\\/g, '/')), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, root: this.root, files: Object.fromEntries(files) }));
      } catch {
        // A cache that can't be written only costs the next run time.
      }
    }
    this.link();
    this.builtAt = Date.now();
    this.stats.ms = Date.now() - started;
    return this;
  }

  // ─── Linking ──────────────────────────────────────────────────────────────────────────────────

  link() {
    this.lower = new Map();
    for (const rel of this.files.keys()) this.lower.set(lowerKey(rel), rel);
    this.edges = new Map();
    this.reverse = new Map();
    this._attrRoutes = null;
    this.nodes = new Map();
    this.problems = [];
    this.projects = [...this.files.values()].filter((f) => f.kind === 'project').map((f) => dirOf(f.rel)).sort((a, b) => b.length - a.length);
    this.wwwroots = new Set(this.projects.filter((p) => [...this.lower.keys()].some((k) => k.startsWith(lowerKey(joinRel(p, 'wwwroot')) + '/'))).map(lowerKey));
    this.linkCompiled();
    this.linkControllers();
    this.linkBundles();
    this.linkViews();
    this.linkScripts();
    this.linkStyles();
    this.linkImages();
    this.linkModels();
    this.buildSymbols();
  }

  edge(from, to, kind, line, extra = {}) {
    const e = { from, to, kind, line, ...extra };
    if (!this.edges.has(from)) this.edges.set(from, []);
    this.edges.get(from).push(e);
    if (to) {
      if (!this.reverse.has(to)) this.reverse.set(to, []);
      this.reverse.get(to).push(e);
    }
    return e;
  }

  problem(file, line, message) {
    this.problems.push({ file, line, message });
  }

  /** The project folder (holding a .csproj) a file is in; '' for the root. */
  projectOf(rel) {
    const l = lowerKey(rel);
    return this.projects.find((p) => p === '' || l.startsWith(lowerKey(p) + '/')) ?? '';
  }

  exists(rel) {
    return this.lower.get(lowerKey(rel)) ?? null;
  }

  /** Files matching a glob relative to `base`. */
  glob(base, pattern) {
    const re = globRegExp(joinRel(base, pattern));
    return [...this.files.keys()].filter((r) => re.test(r));
  }

  /** `~/x`, `/x` or `x` from a file: the project-relative candidates, wwwroot first where there is one. */
  appPaths(from, url) {
    const project = this.projectOf(from);
    let p = url.replace(/[?#].*$/, '');
    if (p.startsWith('~/')) p = p.slice(2);
    else if (p.startsWith('/')) p = p.slice(1);
    else if (p.startsWith('./') || p.startsWith('../')) return [joinRel(dirOf(from), p)];
    const out = [];
    if (this.wwwroots.has(lowerKey(project))) out.push(joinRel(project, 'wwwroot', p));
    out.push(joinRel(project, p));
    return out;
  }

  // Compiled files to their sources: tsconfig outDir, compilerconfig, bundleconfig, webpack, and the
  // same name beside it (site.js ← site.ts, site.css ← site.less, site.min.js ← site.js).
  linkCompiled() {
    this.sources = new Map();
    this.bundleOutputs = new Map();
    this.tsconfigs = [...this.files.values()].filter((f) => f.kind === 'config' && f.data?.type === 'tsconfig');
    this.sourcePaths = new Map();
    const add = (output, input, how) => {
      const k = lowerKey(output);
      if (!this.sourcePaths.has(k)) this.sourcePaths.set(k, output);
      if (!this.sources.has(k)) this.sources.set(k, []);
      if (!this.sources.get(k).some((s) => s.file === input)) this.sources.get(k).push({ file: input, how });
    };
    for (const f of this.files.values()) {
      if (f.kind !== 'config' || !f.data) continue;
      const base = dirOf(f.rel);
      const d = f.data;
      if (d.type === 'compilerconfig') for (const c of d.compile) add(joinRel(base, c.output), joinRel(base, c.input), 'compilerconfig.json');
      if (d.type === 'bundleconfig') {
        for (const b of d.bundles) {
          const inputs = b.inputs.flatMap((i) => (/[*?]/.test(i) ? this.glob(base, i) : [joinRel(base, i)]));
          this.bundleOutputs.set(lowerKey(joinRel(base, b.output)), { config: f.rel, inputs });
          for (const i of inputs) add(joinRel(base, b.output), i, 'bundleconfig.json');
        }
      }
      if (d.type === 'webpack') {
        for (const [name, specs] of Object.entries(d.entries)) {
          const out = joinRel(base, d.outDir, d.filename.replace(/\[name\]/g, name).replace(/\[(contenthash|hash|chunkhash)(:\d+)?\]\.?/g, ''));
          for (const s of specs) {
            const target = this.resolveModule(f.rel, s);
            if (target) add(out, target, 'webpack.config.js');
          }
        }
      }
    }
    // tsconfig: each .ts under rootDir lands under outDir with .js, or everything in outFile.
    const tsconfigs = this.tsconfigs;
    for (const f of this.files.values()) {
      if (f.kind !== 'script' || !/\.tsx?$/i.test(f.rel) || /\.d\.ts$/i.test(f.rel)) continue;
      const config = tsconfigs.filter((c) => dirOf(c.rel) === '' || lowerKey(f.rel).startsWith(lowerKey(dirOf(c.rel)) + '/')).sort((a, b) => b.rel.length - a.rel.length)[0];
      const js = stripExt(f.rel) + '.js';
      if (config?.data.outFile) add(joinRel(dirOf(config.rel), config.data.outFile), f.rel, 'tsconfig outFile');
      else if (config?.data.outDir) {
        const cdir = dirOf(config.rel);
        const rootDir = joinRel(cdir, config.data.rootDir ?? '');
        const inside = rootDir ? (lowerKey(f.rel).startsWith(lowerKey(rootDir) + '/') ? f.rel.slice(rootDir.length + 1) : null) : f.rel;
        if (inside != null) add(joinRel(cdir, config.data.outDir, stripExt(inside) + '.js'), f.rel, 'tsconfig outDir');
        else add(js, f.rel, 'beside');
      } else add(js, f.rel, 'beside');
    }
    const compiledByConfig = new Set([...this.sources.values()].flatMap((list) => list.map((x) => x.file)));
    for (const f of this.files.values()) {
      if (f.kind !== 'style' || !/\.(less|scss)$/i.test(f.rel)) continue;
      if (posix.basename(f.rel).startsWith('_')) continue;
      // A LESS file beside a .css of its name compiles to it; one imported by others usually doesn't.
      const css = stripExt(f.rel) + '.css';
      if (!compiledByConfig.has(f.rel) && this.exists(css)) add(css, f.rel, 'beside');
    }
    for (const k of this.lower.keys()) {
      const m = /^(.*)\.min\.(js|css)$/.exec(k);
      if (m && this.lower.has(`${m[1]}.${m[2]}`)) add(this.lower.get(k), this.lower.get(`${m[1]}.${m[2]}`), 'minified');
    }
    // A compiled file that exists points at its source; the source knows what it becomes.
    this.outputs = new Map();
    for (const [k, list] of this.sources) {
      for (const s of list) {
        if (!this.outputs.has(s.file)) this.outputs.set(s.file, []);
        this.outputs.get(s.file).push(this.lower.get(k) ?? this.sourcePaths.get(k));
        const output = this.lower.get(k);
        if (output) this.edge(output, s.file, 'source', 0, { how: s.how });
      }
    }
  }

  /** The source files a served path comes from, following minified → plain → TypeScript/LESS. */
  sourcesOf(rel, seen = new Set()) {
    const list = this.sources.get(lowerKey(rel));
    if (!list || seen.has(lowerKey(rel))) return [];
    seen.add(lowerKey(rel));
    return list.flatMap((s) => {
      const deeper = this.sourcesOf(s.file, seen);
      return deeper.length ? deeper : [s];
    });
  }

  // Controllers and their actions; view components.
  linkControllers() {
    this.controllers = new Map();
    this.components = new Map();
    this.routes = [];
    this.areas = new Set();
    for (const f of this.files.values()) {
      if (f.kind !== 'cs' || !f.data) continue;
      for (const c of f.data.controllers) {
        const area = c.area ?? /(?:^|\/)Areas\/([^/]+)\//i.exec(f.rel)?.[1] ?? null;
        if (area) this.areas.add(area);
        const project = this.projectOf(f.rel);
        const key = lowerKey(`${project}|${area ?? ''}/${c.name}`);
        const entry = { ...c, area, file: f.rel, project };
        if (this.controllers.has(key)) entry.actions = [...this.controllers.get(key).actions, ...c.actions];
        this.controllers.set(key, entry);
      }
      for (const v of f.data.components) this.components.set(lowerKey(v.name), { ...v, file: f.rel });
      for (const r of f.data.routes) this.routes.push({ ...r, file: f.rel });
    }
    this.byName = new Map();
    for (const c of this.controllers.values()) {
      const k = lowerKey(c.name);
      if (!this.byName.has(k)) this.byName.set(k, []);
      this.byName.get(k).push(c);
    }
    // Ids carry the project only when more than one project has controllers.
    this.multiProject = new Set([...this.controllers.values()].map((c) => c.project)).size > 1;
    for (const f of this.files.values()) {
      const m = /(?:^|\/)Areas\/([^/]+)\/Views\//i.exec(f.rel);
      if (m) this.areas.add(m[1]);
    }
    // Inherited actions: a controller deriving from another of the project's gets its actions too.
    for (const c of this.controllers.values()) {
      let base = c.base && [...this.controllers.values()].find((o) => o.className === c.base.replace(/<.*$/, ''));
      for (let depth = 0; base && depth < 5; depth++) {
        for (const a of base.actions) if (!c.actions.some((x) => lowerKey(x.name) === lowerKey(a.name))) c.actions.push({ ...a, inherited: base.className });
        base = base.base && [...this.controllers.values()].find((o) => o.className === base.base.replace(/<.*$/, ''));
      }
    }
    // Each web project's conventional route defaults ({controller=Home}/{action=Index}).
    this.defaultRoutes = new Map();
    for (const r of this.routes) {
      const project = this.projectOf(r.file);
      if (r.defaults.controller && !this.defaultRoutes.has(project)) this.defaultRoutes.set(project, { controller: r.defaults.controller, action: r.defaults.action ?? 'Index' });
    }
    for (const c of this.controllers.values()) {
      for (const a of c.actions) {
        const id = this.actionId(c, a.name);
        if (this.nodes.has(id)) continue;
        this.nodes.set(id, { id, kind: 'action', file: c.file, line: a.line, controller: c, action: a });
        for (const v of a.views) {
          if (v.dynamic) {
            this.problem(c.file, v.line, `${c.className}.${a.method} returns View(${v.dynamic}): a view chosen at run time`);
            continue;
          }
          const found = this.resolveView(null, v.name, { controller: c.name, area: c.area, project: c.project, partial: v.partial });
          if (found.files.length) for (const to of found.files) this.edge(id, to, v.partial ? 'renders-partial' : 'renders', v.line, { how: found.how });
          else this.problem(c.file, v.line, `${c.className}.${a.method}: no view "${v.name}" found`);
        }
      }
    }
  }

  /** An action's node id: `action:[Project:][Area/]Controller/Action`. */
  actionId(c, action) {
    const project = this.multiProject ? `${posix.basename(c.project) || '.'}:` : '';
    return `action:${project}${c.area ? `${c.area}/` : ''}${c.name}/${action}`;
  }

  /**
   * The controller named, in `area` ('' or null: outside areas; null also falls back to any area),
   * preferring `project`'s.
   */
  controller(name, area = null, project = null) {
    const all = this.byName.get(lowerKey(String(name).replace(/Controller$/i, ''))) ?? [];
    const own = project != null ? all.filter((c) => c.project === project) : [];
    const pool = own.length ? own : all;
    return pool.find((c) => lowerKey(c.area ?? '') === lowerKey(area ?? '')) ?? (area == null ? pool[0] : null) ?? null;
  }

  /** An action's node: by area, controller and action name (any case), preferring `project`'s. */
  action(area, controller, action, project = null) {
    const c = this.controller(controller, area, project);
    if (!c) return null;
    const a = c.actions.find((x) => lowerKey(x.name) === lowerKey(action));
    return a ? this.nodes.get(this.actionId(c, a.name)) : null;
  }

  /**
   * A view name as MVC looks it up: a path (`~/Views/x.cshtml`, `../Shared/_x`) as written; a name in
   * the calling view's folder, the area's Views/<Controller> and Shared, then Views/<Controller>,
   * Views/Shared and Pages/Shared. `template` looks in EditorTemplates/DisplayTemplates of each.
   * Returns { files, how: 'path'|'search'|'guess' }; a guess is any view of that name in the project.
   */
  resolveView(from, name, { controller = null, area = null, project = null, template = null, partial = false } = {}) {
    if (!name) return { files: [], how: 'none' };
    project ??= from ? this.projectOf(from) : '';
    const withExt = (p) => (/\.(cs|vb)html$/i.test(p) ? p : `${p}.cshtml`);
    if (/^[~/]/.test(name)) {
      const hit = this.exists(joinRel(project, withExt(name.replace(/^~?\/+/, ''))));
      return { files: hit ? [hit] : [], how: 'path' };
    }
    if (name.includes('/') || /\.cshtml$/i.test(name)) {
      const candidates = [from && joinRel(dirOf(from), withExt(name)), joinRel(project, 'Views', withExt(name)), area && joinRel(project, 'Areas', area, 'Views', withExt(name))];
      for (const c of candidates) {
        const hit = c && this.exists(c);
        if (hit) return { files: [hit], how: 'path' };
      }
    }
    const folders = [];
    if (from) folders.push(dirOf(from));
    if (area) folders.push(joinRel(project, 'Areas', area, 'Views', controller ?? ''), joinRel(project, 'Areas', area, 'Views', 'Shared'));
    if (controller) folders.push(joinRel(project, 'Views', controller));
    folders.push(joinRel(project, 'Views', 'Shared'), joinRel(project, 'Pages', 'Shared'), joinRel(project, 'Pages'));
    for (const folder of folders) {
      const hit = this.exists(joinRel(folder, template ?? '', withExt(name)));
      if (hit) return { files: [hit], how: 'search' };
    }
    // Not where MVC looks by default (custom view locations, feature folders): any view of that name.
    const base = lowerKey(posix.basename(withExt(name)));
    const tail = template ? lowerKey(`${template}/${posix.basename(withExt(name))}`) : null;
    const guesses = [...this.files.values()].filter((f) => f.kind === 'view' && lowerKey(posix.basename(f.rel)) === base && (!tail || lowerKey(f.rel).endsWith(tail)) && (!project || this.projectOf(f.rel) === project)).map((f) => f.rel);
    const narrowed = controller ? guesses.filter((g) => lowerKey(g).includes(`/${lowerKey(controller)}/`)) : [];
    return { files: narrowed.length ? narrowed : guesses.length <= 3 ? guesses : [], how: guesses.length ? 'guess' : 'none', ...(guesses.length > 3 && !narrowed.length ? { ambiguous: guesses.length } : {}) };
  }

  /** The controller and area a view in Views/<Controller>/ or Areas/<Area>/Views/<Controller>/ belongs to. */
  viewPlace(rel) {
    const m = /(?:^|\/)(?:Areas\/([^/]+)\/)?Views\/([^/]+)\/[^/]+$/i.exec(rel);
    if (!m) return { area: /(?:^|\/)Areas\/([^/]+)\//i.exec(rel)?.[1] ?? null, controller: null };
    return { area: m[1] ?? null, controller: /^shared$/i.test(m[2]) ? null : m[2] };
  }

  // Views: layouts (their own and _ViewStart's), partials, templates, components, child actions,
  // links, scripts, styles and bundles.
  linkViews() {
    const views = [...this.files.values()].filter((f) => f.kind === 'view' && f.data);
    this.partialNames = new Set();
    for (const v of views) {
      const place = this.viewPlace(v.rel);
      const ctx = { ...place, project: this.projectOf(v.rel) };
      for (const p of v.data.partials) {
        const r = this.resolveView(v.rel, p.name, { ...ctx, template: p.template ?? null, partial: true });
        if (!r.files.length && p.template) continue; // a template that isn't there falls back to MVC's own
        if (!r.files.length) this.problem(v.rel, p.line, `partial "${p.name}" not found${r.ambiguous ? ` (${r.ambiguous} views share the name)` : ''}`);
        for (const to of r.files) {
          this.edge(v.rel, to, p.template ? 'template' : 'partial', p.line, { how: r.how, name: p.name });
          this.partialNames.add(to);
        }
      }
      for (const c of v.data.components) {
        const comp = this.components.get(lowerKey(c.name));
        const viewNames = comp?.views.length ? [...new Set(comp.views.map((x) => x.name))] : ['Default'];
        let found = false;
        for (const name of viewNames) {
          const r = this.resolveView(v.rel, `Components/${c.name}/${name}`, { ...ctx, partial: true });
          // resolveView treats a name with '/' as a path from the view's folder; components live under Shared too.
          const files = r.files.length ? r.files : this.resolveView(null, `Shared/Components/${c.name}/${name}`, ctx).files;
          for (const to of files) {
            this.edge(v.rel, to, 'component', c.line, { name: c.name, class: comp?.file ?? null });
            this.partialNames.add(to);
            found = true;
          }
        }
        if (comp) this.edge(v.rel, comp.file, 'component-class', c.line, { name: c.name });
        if (!found && !comp) this.problem(v.rel, c.line, `view component "${c.name}" not found`);
      }
      for (const a of v.data.actions) {
        const node = this.action(a.area ?? place.area, a.controller ?? place.controller ?? '', a.action, ctx.project) ?? (a.area ? null : this.action(null, a.controller ?? place.controller ?? '', a.action, ctx.project));
        if (node) this.edge(v.rel, node.id, 'child-action', a.line);
        else this.problem(v.rel, a.line, `child action ${a.controller ?? place.controller ?? '?'}/${a.action} not found`);
      }
      for (const l of v.data.links) {
        const node = l.url ? this.routeToAction(l.url, ctx.project)[0] : this.action(l.area ?? place.area, l.controller ?? place.controller ?? '', l.action, ctx.project) ?? this.action(null, l.controller ?? place.controller ?? '', l.action, ctx.project);
        if (node) this.edge(v.rel, node.id, 'link', l.line, { via: l.via });
      }
      this.linkAssets(v.rel, v.data);
      this.linkScriptRefs(v.rel, { calls: v.data.calls }, place);
      if (v.data.inline.script) this.linkScriptRefs(v.rel, v.data.inline.script, place);
    }
    // Layouts: what the view sets, else the nearest _ViewStart's (partials get none).
    this.viewStarts = new Map();
    for (const v of views) if (/(^|\/)_ViewStart\.cshtml$/i.test(v.rel)) this.viewStarts.set(lowerKey(dirOf(v.rel)), v);
    for (const v of views) {
      if (/(^|\/)_View(Start|Imports)\.cshtml$/i.test(v.rel)) continue;
      const layout = this.layoutOf(v);
      if (!layout) continue;
      const place = this.viewPlace(v.rel);
      const r = this.resolveView(v.rel, layout.value, { ...place, project: this.projectOf(v.rel) });
      if (r.files.length) this.edge(v.rel, r.files[0], 'layout', layout.line, { via: layout.from });
      else this.problem(layout.from, layout.line, `layout "${layout.value}" not found`);
    }
  }

  /** Whether a view is rendered as a partial (by name, by use, or never by an action as a page). */
  isPartial(rel) {
    if (posix.basename(rel).startsWith('_')) return true;
    if (/\/(EditorTemplates|DisplayTemplates|Components)\//i.test(rel)) return true;
    const by = this.reverse.get(rel) ?? [];
    if (by.some((e) => e.kind === 'renders')) return false;
    return by.some((e) => ['partial', 'renders-partial', 'component', 'template'].includes(e.kind));
  }

  /** The layout a view gets: { value, line, from } or null. */
  layoutOf(view) {
    if (view.data.layout !== undefined) return view.data.layout.value == null ? null : { ...view.data.layout, from: view.rel };
    if (this.isPartial(view.rel) || view.data.renderBody) return null;
    const project = lowerKey(this.projectOf(view.rel));
    for (let dir = lowerKey(dirOf(view.rel)); ; dir = dirOf(dir)) {
      const start = this.viewStarts.get(dir);
      if (start?.data.layout?.value) return { ...start.data.layout, from: start.rel };
      if (start?.data.layout && start.data.layout.value == null) return null;
      if (!dir || dir === project) break;
    }
    return null;
  }

  /** Script and style references of a view: <script>, <link>, bundles; each to files, sources and bundle members. */
  linkAssets(from, data) {
    for (const s of data.scripts) this.linkAsset(from, s.src, 'script', s.line, s.glob);
    for (const s of data.styles) this.linkAsset(from, s.href, 'style', s.line, s.glob);
    for (const b of data.bundles) {
      const bundle = this.bundles.get(lowerKey(b.path));
      if (bundle) this.edge(from, bundle.id, b.kind, b.line, { url: b.path });
      else this.linkAsset(from, b.path, b.kind, b.line);
    }
  }

  linkAsset(from, url, kind, line, glob = false) {
    if (/^(https?:)?\/\//i.test(url)) return this.edge(from, null, kind, line, { url, external: true });
    if (glob) {
      const files = this.appPaths(from, url).flatMap((p) => this.glob('', p));
      for (const f of files) this.edge(from, f, kind, line, { url });
      return null;
    }
    const bundle = this.bundles.get(lowerKey(url.replace(/[?#].*$/, '')));
    if (bundle) return this.edge(from, bundle.id, kind, line, { url });
    for (const p of this.appPaths(from, url)) {
      const hit = this.exists(p);
      if (hit) return this.edge(from, hit, kind, line, { url });
      // Not built yet (dist/, a .js from .ts, a .css from .less): the source stands in for it.
      const sources = this.sourcesOf(p);
      if (sources.length) {
        for (const s of sources) this.edge(from, s.file, kind, line, { url, built: p, how: s.how });
        return null;
      }
    }
    this.problem(from, line, `${kind} "${url}" not found in the project`);
    return this.edge(from, null, kind, line, { url, missing: true });
  }

  // MVC5 bundles (BundleConfig.cs) as nodes `bundle:~/bundles/x`, each to its members.
  linkBundles() {
    this.bundles = new Map();
    for (const f of this.files.values()) {
      if (f.kind !== 'cs' || !f.data) continue;
      const project = this.projectOf(f.rel);
      for (const b of f.data.bundles) {
        const id = `bundle:${b.path}`;
        this.bundles.set(lowerKey(b.path), { id, ...b, file: f.rel });
        this.nodes.set(id, { id, kind: 'bundle', file: f.rel, line: b.line, bundle: b });
        for (const inc of b.include) {
          const pattern = inc.path ? inc.path.replace(/^~\//, '') : `${inc.dir.replace(/^~\//, '').replace(/\/$/, '')}/${inc.deep ? '**/' : ''}${inc.pattern}`;
          let files = /[*{]/.test(pattern) ? this.glob(project, pattern) : [this.exists(joinRel(project, pattern))].filter(Boolean);
          // Bundles take the .min file in release, the plain one in debug: one of them is enough here.
          files = files.filter((x) => !/\.min\.(js|css)$/i.test(x) || !files.includes(x.replace(/\.min\.(js|css)$/i, '.$1')));
          let built = null;
          if (!files.length) {
            // Not built yet (site.css from site.less): its sources stand in for it.
            const sources = this.sourcesOf(joinRel(project, pattern));
            if (sources.length) {
              files = sources.map((s) => s.file);
              built = joinRel(project, pattern);
            }
          }
          if (!files.length) this.problem(f.rel, b.line, `bundle ${b.path}: nothing matches "${inc.path ?? `${inc.dir}/${inc.pattern}`}"`);
          for (const to of files) this.edge(id, to, b.kind, b.line, { url: inc.path ?? inc.dir, ...(built ? { built } : {}) });
        }
      }
    }
  }

  /** A module specifier from a script: relative, tsconfig baseUrl, or (AMD, references) anywhere it ends. */
  resolveModule(from, spec) {
    if (/^(https?:)?\/\//.test(spec)) return null;
    const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js'];
    const tryBase = (base) => {
      for (const e of exts) {
        const hit = this.exists(base + e);
        if (hit) return hit;
      }
      return null;
    };
    if (spec.startsWith('.')) return tryBase(joinRel(dirOf(from), spec));
    if (spec.startsWith('~/') || spec.startsWith('/')) {
      for (const p of this.appPaths(from, spec)) {
        const hit = tryBase(p);
        if (hit) return hit;
      }
      return null;
    }
    const config = (this.tsconfigs ?? []).filter((c) => dirOf(c.rel) === '' || lowerKey(from).startsWith(lowerKey(dirOf(c.rel)) + '/')).sort((a, b) => b.rel.length - a.rel.length)[0];
    if (config?.data.paths) {
      for (const [alias, targets] of Object.entries(config.data.paths)) {
        const re = new RegExp(`^${alias.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace('\\*', '(.*)').replace('*', '(.*)')}$`);
        const m = re.exec(spec);
        if (!m) continue;
        for (const t of targets) {
          const hit = tryBase(joinRel(dirOf(config.rel), config.data.baseUrl ?? '.', t.replace('*', m[1] ?? '')));
          if (hit) return hit;
        }
      }
    }
    if (config?.data.baseUrl) {
      const hit = tryBase(joinRel(dirOf(config.rel), config.data.baseUrl, spec));
      if (hit) return hit;
    }
    // A bare name could be an npm package; only a file of the project ending in it counts.
    if (!spec.includes('/') && !/\.(js|ts)$/.test(spec)) return null;
    const tail = lowerKey(spec.replace(/\.(js|ts)$/i, ''));
    const hits = [...this.lower.keys()].filter((k) => /\.(tsx?|jsx?)$/.test(k) && (stripExt(k).endsWith(`/${tail}`) || stripExt(k) === tail));
    return hits.length === 1 ? this.lower.get(hits[0]) : null;
  }

  linkScripts() {
    for (const f of this.files.values()) {
      if (f.kind !== 'script' || !f.data) continue;
      for (const imp of f.data.imports) {
        const to = this.resolveModule(f.rel, imp.spec);
        if (to) this.edge(f.rel, to, 'import', imp.line, { spec: imp.spec });
        else if (imp.spec.startsWith('.') || imp.kind === 'reference') this.problem(f.rel, imp.line, `import "${imp.spec}" not found`);
      }
      this.linkScriptRefs(f.rel, f.data);
    }
  }

  /**
   * A script's (or a view's) requests to the server as `calls` edges to actions, each with its method,
   * how it's made and the element its answer goes into; a route-shaped string elsewhere in a script
   * ('/Orders/Data' in a grid's options) is a call too, of unknown method. `place` is a view's
   * controller and area, for @Url.Action("Row") without a controller.
   */
  linkScriptRefs(rel, data, place = {}) {
    const project = this.projectOf(rel);
    for (const c of data.calls ?? []) {
      if (c.dynamic) continue;
      const node = c.url
        ? this.routeToAction(c.url, project)[0]
        : this.action(c.area ?? place.area ?? null, c.controller ?? place.controller ?? '', c.action, project) ?? this.action(null, c.controller ?? place.controller ?? '', c.action, project);
      const label = c.url ?? `${c.controller ?? place.controller ?? '?'}/${c.action}`;
      if (node) this.edge(rel, node.id, 'calls', c.line, { url: label, method: c.method ?? null, via: c.via, ...(c.target ? { target: c.target } : {}) });
      else if (c.action || /^\/(?!api\b)/i.test(c.url)) this.problem(rel, c.line, `request to ${label} reaches no action Pilot knows`);
    }
    for (const u of data.urls ?? []) {
      const node = this.routeToAction(u.url, project)[0];
      if (node) this.edge(rel, node.id, 'calls', u.line, { url: u.url, method: null, via: 'string' });
    }
  }

  resolveStyleImport(from, spec) {
    if (/^(https?:)?\/\//.test(spec)) return null;
    const dialect = /\.scss$/i.test(from) ? 'scss' : 'less';
    const base = spec.startsWith('~') ? spec.replace(/^~\/?/, '') : joinRel(dirOf(from), spec);
    const candidates = /\.(less|css|scss)$/i.test(base) ? [base] : [`${base}.${dialect}`, base, `${base}.css`];
    if (dialect === 'scss') candidates.push(joinRel(dirOf(base), `_${posix.basename(base)}.scss`));
    for (const c of candidates) {
      const hit = this.exists(c);
      if (hit) return hit;
    }
    for (const p of this.appPaths(from, spec)) for (const c of [p, `${p}.${dialect}`]) if (this.exists(c)) return this.exists(c);
    return null;
  }

  linkStyles() {
    for (const f of this.files.values()) {
      if (f.kind !== 'style' || !f.data) continue;
      for (const imp of f.data.imports) {
        const to = this.resolveStyleImport(f.rel, imp.spec);
        if (to) this.edge(f.rel, to, 'import', imp.line, { spec: imp.spec, options: imp.options });
        else if (!/^(https?:)?\/\//.test(imp.spec)) this.problem(f.rel, imp.line, `@import "${imp.spec}" not found`);
      }
    }
  }

  // Images: <img src>, url() in styles and style="…", to the image files (missing ones are problems).
  linkImages() {
    for (const f of this.files.values()) {
      if (!f.data) continue;
      const refs = f.kind === 'view' ? f.data.images ?? [] : f.kind === 'style' ? f.data.urls ?? [] : [];
      for (const [url, line] of refs) {
        const clean = url.replace(/[?#].*$/, '');
        if (!/\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i.test(clean)) continue;
        // A stylesheet's url() is relative to the CSS it compiles to, which usually sits beside it.
        const near = f.kind === 'style' && !/^[~/]/.test(clean) ? [joinRel(dirOf(f.rel), clean), ...(this.outputs.get(f.rel) ?? []).map((o) => joinRel(dirOf(o), clean))] : [];
        const hit = [...near, ...this.appPaths(f.rel, clean)].map((p) => this.exists(p)).find(Boolean);
        if (hit) this.edge(f.rel, hit, 'image', line, { url });
        else {
          this.edge(f.rel, null, 'image', line, { url, missing: true });
          this.problem(f.rel, line, `image "${url}" not found in the project`);
        }
      }
    }
  }

  // View models: the classes with properties, by name, for the views' @model.
  linkModels() {
    this.models = new Map();
    for (const f of this.files.values()) {
      if (f.kind !== 'cs' || !f.data?.models) continue;
      for (const m of f.data.models) if (!this.models.has(m.name)) this.models.set(m.name, { ...m, file: f.rel });
    }
  }

  // ─── Routes ───────────────────────────────────────────────────────────────────────────────────

  /** The actions a URL reaches: attribute routes first, then {area}/{controller}/{action}; `project`'s first. */
  routeToAction(url, project = null) {
    const all = this.routeToActionAll(url);
    return project == null ? all : [...all.filter((n) => n.controller.project === project), ...all.filter((n) => n.controller.project !== project)];
  }

  /** Attribute routes compiled once: [{ re, node }]. */
  attributeRoutes() {
    if (this._attrRoutes) return this._attrRoutes;
    const out = [];
    for (const node of this.nodes.values()) {
      if (node.kind !== 'action') continue;
      const { controller: c, action: a } = node;
      for (const r of a.routes.length ? a.routes : c.route ? [''] : []) {
        const template = r.startsWith('~/') || r.startsWith('/') ? r.replace(/^~?\/+/, '') : [c.route, r].filter(Boolean).join('/');
        const re = template
          .replace(/\[controller\]/gi, c.name)
          .replace(/\[action\]/gi, a.name)
          .replace(/\[area\]/gi, c.area ?? '')
          .split('/')
          .filter(Boolean)
          .map((seg) => (/^\{\*/.test(seg) ? '.*' : routeSegment(seg)))
          .join('/');
        try {
          out.push({ re: new RegExp(`^${re}$`, 'i'), node });
        } catch {
          // A template Pilot can't turn into a pattern: that action is found by name only.
        }
      }
    }
    this._attrRoutes = out;
    return out;
  }

  routeToActionAll(url) {
    const path = String(url)
      .replace(/^[a-z]+:\/\/[^/]+/i, '')
      .replace(/^~/, '')
      .replace(/[?#].*$/, '')
      .replace(/^\/+|\/+$/g, '');
    const segs = path ? path.split('/') : [];
    const hits = this.attributeRoutes()
      .filter((r) => r.re.test(path))
      .map((r) => r.node);
    if (hits.length) return hits;
    // Conventional routing, in each web project: [area/]controller/action, the project's defaults
    // filling what's missing. An attribute-routed action isn't reachable this way.
    const area = segs.length ? [...this.areas].find((a) => lowerKey(a) === lowerKey(segs[0])) : null;
    const attempts = [...(area ? [[area, segs.slice(1)]] : []), [null, segs], ...(lowerKey(segs[0] ?? '') === 'api' ? [[null, segs.slice(1)]] : [])];
    for (const [a, rest] of attempts) {
      if (rest.length > 3) continue;
      const named = rest[0] != null ? this.byName.get(lowerKey(rest[0])) ?? [] : [...this.defaultRoutes.values(), { controller: 'Home' }].flatMap((d) => this.byName.get(lowerKey(d.controller)) ?? []);
      for (const c of named) {
        if (c.abstract || c.route || lowerKey(c.area ?? '') !== lowerKey(a ?? '')) continue;
        const defaults = this.defaultRoutes.get(c.project) ?? { controller: 'Home', action: 'Index' };
        if (rest[0] == null && lowerKey(c.name) !== lowerKey(defaults.controller)) continue;
        const action = c.actions.find((x) => lowerKey(x.name) === lowerKey(rest[1] ?? defaults.action) && !x.routes.length);
        const node = action && this.nodes.get(this.actionId(c, action.name));
        if (node && !hits.includes(node)) hits.push(node);
      }
      if (hits.length) break;
    }
    return hits;
  }

  // ─── Symbols: classes, ids, attributes, variables, mixins, definitions ──────────────────────

  buildSymbols() {
    const sym = { classes: new Map(), ids: new Map(), attrs: new Map(), vars: new Map(), mixins: new Map(), defs: new Map(), widgets: [] };
    const seen = new Set();
    const put = (map, name, entry) => {
      // One place per file, line and role: a selector can be read twice on a line ($('.x') is also a '.x' literal).
      const key = `${name}|${entry.file}|${entry.line}|${entry.role}|${map === sym.ids ? '#' : map === sym.classes ? '.' : map === sym.attrs ? '[' : map === sym.vars ? '@' : map === sym.mixins ? 'm' : 'd'}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (!map.has(name)) map.set(name, []);
      map.get(name).push(entry);
    };
    // A compiled .js beside its .ts, or a .css beside its .less, says nothing its source doesn't.
    const compiled = (rel) => (this.sources.get(lowerKey(rel)) ?? []).some((s) => s.how !== 'minified' && s.how !== 'bundleconfig.json');
    for (const f of this.files.values()) {
      const d = f.data;
      if (!d) continue;
      const own = !compiled(f.rel);
      if (f.kind === 'view') {
        for (const [n, line] of d.classes) put(sym.classes, n, { file: f.rel, line, role: 'markup' });
        for (const [n, line] of d.ids) put(sym.ids, n, { file: f.rel, line, role: 'markup' });
        for (const [n, line] of d.attrs) put(sym.attrs, n, { file: f.rel, line, role: 'markup' });
        for (const h of d.handlers) put(sym.defs, h.fn.split('.').pop(), { file: f.rel, line: h.line, role: 'called', kind: h.event });
        for (const w of [...(d.widgets ?? []), ...(d.inline.script?.widgets ?? [])]) sym.widgets.push({ ...w, file: f.rel });
        const s = d.inline.script;
        if (s) {
          for (const [n, line] of s.classes) put(sym.classes, n, { file: f.rel, line, role: 'script' });
          for (const [n, line] of s.ids) put(sym.ids, n, { file: f.rel, line, role: 'script' });
          for (const [n, line] of s.attrs) put(sym.attrs, n, { file: f.rel, line, role: 'script' });
          for (const x of s.defs) put(sym.defs, x.name.split('.').pop(), { file: f.rel, line: x.line, role: 'def', kind: x.kind, name: x.name });
        }
        const st = d.inline.style;
        if (st) {
          for (const [n, line] of st.classes) put(sym.classes, n, { file: f.rel, line, role: 'style', selector: st.rules.find((r) => r.line === line)?.selector });
          for (const [n, line] of st.ids) put(sym.ids, n, { file: f.rel, line, role: 'style', selector: st.rules.find((r) => r.line === line)?.selector });
        }
      } else if (f.kind === 'script' && own) {
        for (const [n, line] of d.classes) put(sym.classes, n, { file: f.rel, line, role: 'script' });
        for (const [n, line] of d.ids) put(sym.ids, n, { file: f.rel, line, role: 'script' });
        for (const [n, line] of d.attrs) put(sym.attrs, n, { file: f.rel, line, role: 'script' });
        for (const x of d.defs) put(sym.defs, x.name.split('.').pop(), { file: f.rel, line: x.line, role: 'def', kind: x.kind, name: x.name });
        for (const w of d.widgets ?? []) sym.widgets.push({ ...w, file: f.rel });
      } else if (f.kind === 'style' && d.libraryClasses) {
        for (const n of d.libraryClasses) put(sym.classes, n, { file: f.rel, line: 0, role: 'style', vendor: true, selector: `.${n} (library)` });
      } else if (f.kind === 'style' && own) {
        const rule = (i) => (d.rules[i] ? `${d.rules[i].selector}${d.rules[i].media ? `  (in ${d.rules[i].media})` : ''}` : undefined);
        for (const [n, line, i] of d.classes) put(sym.classes, n, { file: f.rel, line, role: 'style', selector: rule(i), vendor: f.vendor });
        for (const [n, line, i] of d.ids) put(sym.ids, n, { file: f.rel, line, role: 'style', selector: rule(i), vendor: f.vendor });
        for (const v of d.vars) put(sym.vars, v.name, { file: f.rel, line: v.line, role: 'def', value: v.value });
        for (const [n, line] of d.varUses) put(sym.vars, n, { file: f.rel, line, role: 'use' });
        for (const m of d.mixins) put(sym.mixins, m.name.replace(/^[.#]/, ''), { file: f.rel, line: m.line, role: 'def', name: m.name });
        for (const [n, line] of d.mixinCalls) put(sym.mixins, n.replace(/^[.#]/, ''), { file: f.rel, line, role: 'use', name: n });
      }
    }
    this.symbols = sym;
  }

  // ─── Walking the graph ────────────────────────────────────────────────────────────────────────

  out(id) {
    return this.edges.get(id) ?? [];
  }

  in(id) {
    return this.reverse.get(id) ?? [];
  }

  /** What depends on `id`, breadth first, along the edges that carry a change (not links or calls). */
  dependents(id, { max = 100000 } = {}) {
    const CARRY = new Set(['layout', 'partial', 'template', 'component', 'child-action', 'renders', 'renders-partial', 'script', 'style', 'import', 'source']);
    const seen = new Map([[id, { id, depth: 0, via: null }]]);
    const queue = [id];
    while (queue.length && seen.size < max) {
      const cur = queue.shift();
      for (const e of this.in(cur)) {
        if (!CARRY.has(e.kind) || seen.has(e.from)) continue;
        seen.set(e.from, { id: e.from, depth: seen.get(cur).depth + 1, via: e });
        queue.push(e.from);
      }
    }
    seen.delete(id);
    return [...seen.values()];
  }
}

/** Builds (or refreshes from the cache) the index of the project at `root`. */
export function buildIndex(root, options = {}) {
  if (!existsSync(root)) throw new Error(`No folder ${root}`);
  return new ProjectIndex(root, options).build(options);
}
