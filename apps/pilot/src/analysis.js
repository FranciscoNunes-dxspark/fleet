// What Pilot works out on top of the graph: a page's full model (its views, scripts and their
// imports, the requests they make and what each returns, the widgets on it, its metrics and a
// complexity score), the inventory of widgets, how to split a large stylesheet, the path between any
// two things, and the neighbourhood of a node as a graph for the UI. Each query returns { data, text }
// like those in queries.js.
import { posix } from 'node:path';
import { actionLabel, renderTree, resolveTarget, urlOf, where } from './queries.js';

const lower = (s) => String(s).toLowerCase();
const at = (file, line) => (line ? `${file}:${line}` : file);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
function cut(list, max, fn, indent = '  ') {
  const lines = list.slice(0, max).map(fn);
  if (list.length > max) lines.push(`${indent}… ${list.length - max} more`);
  return lines;
}

// ─── The page model ───────────────────────────────────────────────────────────────────────────

/** Widget kinds weighed by how much they add to a page's behaviour, for the complexity score. */
export const WIDGET_WEIGHT = {
  'data table': 3, calendar: 3, 'rich editor': 3, framework: 3, chart: 2, map: 2, wizard: 2, tree: 2, upload: 2, realtime: 2,
  select: 1, 'date picker': 1, modal: 1, tabs: 1, form: 1, autocomplete: 1, sortable: 1, accordion: 0.5, table: 0.5, validation: 0.5,
  tooltip: 0.25, notifications: 0.25, pagination: 0.5,
};

/** The kinds of node in the graph: a view's role, a script, a style, an action, a bundle, C#. */
export function nodeType(idx, id) {
  const node = idx.nodes.get(id);
  if (node) return node.kind;
  const f = idx.files.get(id);
  if (!f) return 'missing';
  if (f.kind === 'view') return f.data?.renderBody ? 'layout' : idx.isPartial(id) ? 'partial' : 'view';
  return f.kind;
}

/** The scripts a set of scripts brings in through their imports, each once. */
function importClosure(idx, files) {
  const seen = new Set(files);
  const queue = [...files];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of idx.out(cur)) {
      if (e.kind === 'import' && e.to && !seen.has(e.to) && idx.files.get(e.to)?.kind === 'script') {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return [...seen];
}

/** What a request reaches: the action, the views or partials it returns (with their own partials), or JSON. */
export function callResult(idx, e) {
  const node = idx.nodes.get(e.to);
  const rendered = idx.out(e.to).filter((x) => x.kind === 'renders' || x.kind === 'renders-partial');
  return {
    action: e.to,
    label: actionLabel(idx, e.to),
    at: where(idx, e.to),
    url: urlOf(idx, e.to),
    returns: rendered.map((r) => ({
      file: r.to,
      partial: r.kind === 'renders-partial' || idx.isPartial(r.to),
      includes: idx.out(r.to).filter((x) => ['partial', 'template', 'component'].includes(x.kind)).map((x) => x.to),
    })),
    json: !!node?.action.json,
    redirects: node?.action.redirects ?? [],
  };
}

/**
 * Everything about the page a view makes: the render tree, the views in it (own or the layouts'),
 * the scripts it loads with their imports, the requests those scripts and views make and what each
 * returns, the widgets, the metrics and the score. Cached on the index until it's linked again.
 */
export function pageModel(idx, view) {
  idx._pages ??= new Map();
  if (idx._linkedAt !== idx.builtAt) {
    idx._pages.clear();
    idx._linkedAt = idx.builtAt;
  }
  if (idx._pages.has(view)) return idx._pages.get(view);
  const tree = renderTree(idx, view);
  const views = [...tree.files].map(([file, own]) => ({ file, own }));
  const ownViews = new Set(views.filter((v) => v.own).map((v) => v.file));

  // Scripts: what the page loads (the sources of built files), then everything they import.
  const loaded = new Map();
  for (const a of tree.assets) {
    if (a.kind !== 'script' || a.external || a.missing) continue;
    for (const f of a.sources?.length ? a.sources : [a.file]) if (idx.files.has(f)) loaded.set(f, (loaded.get(f) ?? false) || a.own);
  }
  const scripts = [];
  for (const [file, own] of loaded) {
    for (const f of importClosure(idx, [file])) {
      const prev = scripts.find((s) => s.file === f);
      if (prev) prev.own ||= own;
      else scripts.push({ file: f, own, imported: f !== file, vendor: idx.files.get(f)?.vendor ?? false, lines: idx.files.get(f)?.lines ?? null });
    }
  }
  const styles = tree.assets.filter((a) => a.kind === 'style');
  const ownScripts = new Set(scripts.filter((s) => s.own).map((s) => s.file));

  // Requests made by the views (data-ajax, htmx, Ajax.BeginForm, inline scripts) and the scripts.
  const calls = [];
  for (const file of [...views.map((v) => v.file), ...scripts.map((s) => s.file)]) {
    for (const e of idx.out(file)) {
      if (e.kind !== 'calls') continue;
      const own = ownViews.has(file) || ownScripts.has(file);
      calls.push({ from: file, line: e.line, method: e.method ?? null, request: e.url, via: e.via, target: e.target ?? null, own, ...callResult(idx, e) });
    }
  }
  // Where each call's answer lands: the element its target names, in the page's views.
  const marked = (sel) => {
    const m = /^([#.])([\w-]+)/.exec(sel ?? '');
    if (!m) return [];
    const uses = idx.symbols[m[1] === '#' ? 'ids' : 'classes'].get(m[2]) ?? [];
    return uses.filter((u) => u.role === 'markup' && tree.files.has(u.file)).map((u) => at(u.file, u.line));
  };
  for (const c of calls) if (c.target) c.targetIn = marked(c.target);

  // Widgets in the page's views and scripts, with the markup they bind to.
  const inPage = new Set([...views.map((v) => v.file), ...scripts.filter((s) => !s.vendor).map((s) => s.file)]);
  const widgets = idx.symbols.widgets
    .filter((w) => inPage.has(w.file))
    .map((w) => ({ ...w, own: ownViews.has(w.file) || ownScripts.has(w.file), boundTo: w.target ? marked(w.target) : [] }));

  const metrics = pageMetrics(idx, { tree, views, scripts, calls, widgets });
  const model = { view, tree, views, scripts, styles, calls, widgets, metrics };
  idx._pages.set(view, model);
  return model;
}

/** Depth of the page's own part of a render tree. */
function ownDepth(node, base = null) {
  let best = 0;
  for (const c of node.children) {
    const start = base ?? (c.own ? c.depth : null);
    if (c.own && ['partial', 'template', 'component', 'child-action', 'view'].includes(c.type)) best = Math.max(best, c.depth - (start ?? c.depth) + 1);
    best = Math.max(best, ownDepth(c, c.own ? start : null));
  }
  return best;
}

/**
 * The numbers behind a page's complexity, its own part (the view, what it renders and its scripts)
 * scored, the layouts' shown beside it. score is 0–100: each measure adds by its log, so ten partials
 * weigh more than one but not ten times more; see SCORE for the weights.
 */
export function pageMetrics(idx, { tree, views, scripts, calls, widgets }) {
  const lines = (f) => idx.files.get(f)?.lines ?? 0;
  const own = views.filter((v) => v.own);
  const classes = new Set();
  let dynamic = 0;
  let inlineScript = 0;
  for (const v of own) {
    const d = idx.files.get(v.file)?.data;
    if (!d) continue;
    for (const [c] of d.classes) classes.add(c);
    dynamic += d.dynamic.length;
    inlineScript += d.inline.script ? 1 : 0;
  }
  const ownScripts = scripts.filter((s) => s.own && !s.vendor);
  const ownWidgets = widgets.filter((w) => w.own);
  const m = {
    views: own.length,
    depth: ownDepth(tree.root),
    markupLines: own.reduce((n, v) => n + lines(v.file), 0),
    scripts: ownScripts.length,
    scriptLines: ownScripts.reduce((n, s) => n + (s.lines ?? 0), 0),
    libraries: scripts.filter((s) => s.vendor).length,
    styles: tree.assets.filter((a) => a.kind === 'style' && a.own).length,
    widgets: ownWidgets.length,
    widgetWeight: round(ownWidgets.reduce((n, w) => n + (WIDGET_WEIGHT[w.kind] ?? 1), 0)),
    requests: calls.filter((c) => c.own).length,
    childActions: countNodes(tree.root, (n) => n.type === 'child-action' && n.own),
    components: countNodes(tree.root, (n) => n.type === 'component' && n.own),
    classes: classes.size,
    dynamic,
    inlineScripts: inlineScript,
    layoutViews: views.length - own.length,
    layoutLines: views.filter((v) => !v.own).reduce((n, v) => n + lines(v.file), 0),
  };
  const parts = SCORE.map(([key, label, f]) => ({ key, label, value: m[key], points: round(f(m[key] ?? 0)) }));
  const raw = parts.reduce((n, p) => n + p.points, 0);
  const score = Math.round(100 * (1 - Math.exp(-raw / 120)));
  return { ...m, raw: round(raw), score, level: level(score), parts };
}

const log2 = (x) => Math.log2(1 + x);
/** [metric, what it is, points]: the score's weights. */
export const SCORE = [
  ['views', 'views and partials', (v) => 8 * log2(v)],
  ['depth', 'nesting depth', (v) => 3 * v],
  ['markupLines', 'markup lines', (v) => 8 * log2(v / 40)],
  ['scriptLines', 'script lines', (v) => 10 * log2(v / 80)],
  ['widgetWeight', 'widgets', (v) => 3 * v],
  ['requests', 'server requests', (v) => 3 * v],
  ['childActions', 'child actions', (v) => 4 * v],
  ['components', 'view components', (v) => 3 * v],
  ['dynamic', 'names decided at run time', (v) => 2 * v],
  ['classes', 'distinct classes', (v) => 3 * log2(v / 15)],
];

export const level = (score) => (score < 30 ? 'simple' : score < 55 ? 'moderate' : score < 75 ? 'complex' : 'very complex');

function countNodes(node, pred) {
  return node.children.reduce((n, c) => n + (pred(c) ? 1 : 0) + countNodes(c, pred), 0);
}

/** The text `page` adds for a model: requests, widgets and the score. */
export function pageModelText(idx, model) {
  const lines = [];
  if (model.calls.length) {
    lines.push('', 'Requests the page makes (and what answers them):');
    for (const c of model.calls) {
      const answer = c.returns.length
        ? c.returns.map((r) => `${r.partial ? 'partial' : 'view'} ${r.file}${r.includes.length ? ` (+ ${r.includes.map((x) => posix.basename(x)).join(', ')})` : ''}`).join(', ')
        : c.json ? 'JSON' : c.redirects.length ? `redirect to ${c.redirects.map((r) => r.action).join(', ')}` : 'no view';
      const into = c.target ? ` → into ${c.target}${c.targetIn?.length ? ` (${c.targetIn[0]})` : ''}` : '';
      lines.push(`  ${at(c.from, c.line)}  ${c.method ?? '?'} ${c.request} → ${c.label} ${c.at} → ${answer}${into}${c.own ? '' : '  [layout]'}`);
    }
  }
  if (model.widgets.length) {
    lines.push('', 'Components on the page:');
    const sorted = [...model.widgets].sort((a, b) => (WIDGET_WEIGHT[b.kind] ?? 1) - (WIDGET_WEIGHT[a.kind] ?? 1));
    lines.push(...cut(sorted, 30, (w) => `  ${w.kind.padEnd(13)} ${w.lib}${w.target ? ` on ${w.target}` : ''}  ${at(w.file, w.line)}${w.boundTo.length ? ` → ${w.boundTo[0]}` : ''}${w.own ? '' : '  [layout]'}`));
  }
  const m = model.metrics;
  lines.push('', `Complexity ${m.score}/100 (${m.level}): ${m.views} own views, depth ${m.depth}, ${m.markupLines} markup lines, ${m.scripts} scripts (${m.scriptLines} lines), ${m.widgets} widgets, ${m.requests} requests, ${m.childActions} child actions, ${m.components} components; the layouts add ${m.layoutViews} views.`);
  return lines;
}

// ─── complexity ───────────────────────────────────────────────────────────────────────────────

/** Every page (action with a view) with its score, highest first. */
export function complexity(idx, { filter = '', limit = 60 } = {}) {
  const rows = [];
  const seen = new Set();
  for (const node of idx.nodes.values()) {
    if (node.kind !== 'action' || node.action.childOnly || node.controller.api) continue;
    for (const r of idx.out(node.id).filter((e) => e.kind === 'renders')) {
      const key = `${node.id}|${r.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = { action: node.id, label: actionLabel(idx, node.id), url: urlOf(idx, node.id), view: r.to };
      if (filter && !lower(`${row.url} ${row.label} ${row.view}`).includes(lower(filter))) continue;
      const m = pageModel(idx, r.to).metrics;
      rows.push({ ...row, score: m.score, level: m.level, metrics: m });
    }
  }
  rows.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  const avg = rows.length ? Math.round(rows.reduce((n, r) => n + r.score, 0) / rows.length) : 0;
  const text = [
    `${plural(rows.length, 'page')}, average complexity ${avg}/100 (score: views, depth, markup, scripts, widgets, requests):`,
    ...cut(rows, limit, (r) => `  ${String(r.score).padStart(3)} ${r.level.padEnd(12)} ${(r.url ?? '').padEnd(28)} ${r.view}  (${r.metrics.views} views, ${r.metrics.scriptLines} script lines, ${r.metrics.widgets} widgets, ${r.metrics.requests} requests)`),
  ];
  return { data: { pages: rows, average: avg }, text: text.join('\n') };
}

// ─── widgets ──────────────────────────────────────────────────────────────────────────────────

/** The project's widgets by kind and library, with where each is and the pages it's on. */
export function widgets(idx, { kind = '', pages: withPages = true } = {}) {
  const k = lower(kind);
  const list = idx.symbols.widgets.filter((w) => !k || lower(w.kind).includes(k) || lower(w.lib).includes(k));
  const pagesOf = new Map();
  const pages = (file) => {
    if (!pagesOf.has(file)) pagesOf.set(file, idx.dependents(file).filter((d) => idx.nodes.get(d.id)?.kind === 'action' && !idx.nodes.get(d.id).action.childOnly).map((d) => urlOf(idx, d.id)));
    return pagesOf.get(file);
  };
  const byKind = new Map();
  for (const w of list) {
    if (!byKind.has(w.kind)) byKind.set(w.kind, new Map());
    const libs = byKind.get(w.kind);
    if (!libs.has(w.lib)) libs.set(w.lib, []);
    // The markup a widget's target names (#orders → the view that has id="orders").
    const t = /^([#.])([\w-]+)/.exec(w.target ?? '');
    const boundTo = t ? (idx.symbols[t[1] === '#' ? 'ids' : 'classes'].get(t[2]) ?? []).filter((u) => u.role === 'markup').slice(0, 5).map((u) => at(u.file, u.line)) : [];
    libs.get(w.lib).push({ ...w, boundTo, ...(withPages ? { pages: pages(w.file) } : {}) });
  }
  const kinds = [...byKind]
    .map(([name, libs]) => ({ kind: name, count: [...libs.values()].reduce((n, l) => n + l.length, 0), libs: [...libs].map(([lib, places]) => ({ lib, count: places.length, places })) }))
    .sort((a, b) => (WIDGET_WEIGHT[b.kind] ?? 1) - (WIDGET_WEIGHT[a.kind] ?? 1) || b.count - a.count);
  const lines = [`${plural(list.length, 'widget')} in ${plural(kinds.length, 'kind')}:`];
  for (const g of kinds) {
    lines.push('', `${g.kind} (${g.count}):`);
    for (const l of g.libs) {
      lines.push(`  ${l.lib} (${l.count})`);
      lines.push(...cut(l.places, k ? 40 : 6, (p) => `    ${at(p.file, p.line)}${p.target ? `  on ${p.target}` : ''}${p.pages?.length ? `  pages: ${p.pages.slice(0, 4).join(', ')}${p.pages.length > 4 ? ` +${p.pages.length - 4}` : ''}` : ''}`, '    '));
    }
  }
  return { data: { kinds }, text: lines.join('\n') };
}

// ─── split: a large stylesheet into files ─────────────────────────────────────────────────────

const GENERIC = new Set(['is', 'has', 'js', 'no', 'u', 'm', 'p', 'col', 'row', 'text', 'bg', 'd', 'w', 'h', 'mt', 'mb', 'ml', 'mr', 'pt', 'pb', 'pl', 'pr', 'active', 'disabled', 'open', 'show', 'hide', 'hidden', 'selected', 'fade', 'in', 'pull', 'clearfix', 'container']);
const slug = (s) => lower(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'misc';

/** Where a view sits, for grouping styles: the layout, a shared partial or component, or a controller's pages. */
function placeOf(idx, file) {
  const f = idx.files.get(file);
  if (f?.kind !== 'view') return null;
  if (f.data?.renderBody) return { key: 'layout', file: 'layout' };
  const comp = /\/Components\/([^/]+)\//i.exec(file);
  if (comp) return { key: `component:${comp[1]}`, file: `components/${slug(comp[1])}` };
  const m = /(?:^|\/)(?:Areas\/([^/]+)\/)?Views\/([^/]+)\/([^/]+)$/i.exec(file);
  if (!m) return { key: `view:${file}`, file: `pages/${slug(posix.basename(file, '.cshtml'))}` };
  const name = posix.basename(file).replace(/\.cshtml$/i, '').replace(/^_/, '');
  if (/^shared$/i.test(m[2]) || /Templates$/i.test(posix.dirname(file))) {
    // A shared partial used by the layout is part of the layout's look.
    if (idx.in(file).some((e) => e.kind === 'partial' && idx.files.get(e.from)?.data?.renderBody)) return { key: 'layout', file: 'layout' };
    return { key: `shared:${name}`, file: `components/${slug(name)}` };
  }
  return { key: `page:${m[1] ? `${m[1]}/` : ''}${m[2]}`, file: `pages/${m[1] ? `${slug(m[1])}-` : ''}${slug(m[2])}` };
}

/** The family a class belongs to by its prefix: btn-primary → btn, order-table → order. */
const prefixOf = (cls) => {
  const p = lower(cls).split(/[-_]/)[0];
  return p.length >= 3 && !GENERIC.has(p) ? p : null;
};

/**
 * How to split a stylesheet: each top-level block given a file by what it is (variables, mixins,
 * fonts, animations, element styles) or by where its classes are used (one controller's pages, one
 * shared partial or component, the layout, a family of classes used across pages), with the line
 * ranges, an import order that keeps the cascade, and the rules whose classes nothing uses.
 */
export function split(idx, target) {
  const r = resolveTarget(idx, target);
  const rel = r.files[0];
  const f = rel && idx.files.get(rel);
  if (!f || f.kind !== 'style' || !f.data) return { data: { error: 'not a stylesheet' }, text: `${target}: not a stylesheet Pilot has read.` };
  const d = f.data;
  const ext = posix.extname(rel);
  const total = f.lines ?? 0;
  // A file that only imports others: say which of those are worth splitting.
  const imports = d.blocks.filter((b) => b.type === 'import');
  if (imports.length && d.blocks.length - imports.length <= 2) {
    const children = idx.out(rel).filter((e) => e.kind === 'import').map((e) => ({ file: e.to, lines: idx.files.get(e.to)?.lines ?? 0 })).sort((a, b) => b.lines - a.lines);
    return {
      data: { file: rel, imports: children },
      text: [`${rel} only imports ${plural(children.length, 'file')}; split the largest:`, ...cut(children, 20, (c) => `  ${String(c.lines).padStart(6)} lines  ${c.file}`)].join('\n'),
    };
  }
  const header = (line) => [...d.headers].reverse().find((h) => h.line <= line)?.title ?? null;
  const usageOf = new Map();
  const usage = (cls) => {
    if (!usageOf.has(cls)) {
      const uses = (idx.symbols.classes.get(cls) ?? []).filter((u) => u.role === 'markup' || u.role === 'script');
      usageOf.set(cls, uses);
    }
    return usageOf.get(cls);
  };
  const assignments = d.blocks.map((b) => {
    const base = { start: b.start, end: b.end, lines: b.end - b.start + 1, selector: b.selector, header: header(b.start) };
    if (b.type === 'import') return { ...base, group: '(stays)', file: null, why: 'import' };
    if (b.type === 'var') return { ...base, group: 'variables', file: 'base/variables', why: 'variable' };
    if (b.type === 'mixin') return { ...base, group: 'mixins', file: 'base/mixins', why: 'mixin definition' };
    if (b.type === 'font-face') return { ...base, group: 'fonts', file: 'base/fonts', why: '@font-face' };
    if (b.type === 'keyframes') return { ...base, group: 'animations', file: 'base/animations', why: '@keyframes' };
    if (b.type === 'statement') return { ...base, group: '(stays)', file: null, why: 'statement' };
    const classes = [...new Set(d.classes.slice(b.classes?.[0] ?? 0, b.classes?.[1] ?? 0).map(([c]) => c))];
    const ids = [...new Set(d.ids.slice(b.ids?.[0] ?? 0, b.ids?.[1] ?? 0).map(([i]) => i))];
    if (!classes.length && !ids.length) return { ...base, group: 'base', file: 'base/elements', why: 'element selectors only', classes };
    const places = new Map();
    let used = 0;
    for (const c of classes) {
      const uses = usage(c);
      if (uses.length) used++;
      for (const u of uses) {
        const p = placeOf(idx, u.file) ?? (u.role === 'script' ? { key: `script:${u.file}`, file: null } : null);
        if (p) places.set(p.key, { ...p, n: (places.get(p.key)?.n ?? 0) + 1 });
      }
    }
    for (const i of ids) for (const u of (idx.symbols.ids.get(i) ?? []).filter((x) => x.role === 'markup')) {
      const p = placeOf(idx, u.file);
      if (p) places.set(p.key, { ...p, n: (places.get(p.key)?.n ?? 0) + 1 });
    }
    const viewPlaces = [...places.values()].filter((p) => p.file);
    if (!used && !viewPlaces.length) return { ...base, group: 'unused', file: 'unused', why: `no view or script uses ${classes.slice(0, 3).map((c) => `.${c}`).join(', ') || ids.map((i) => `#${i}`).join(', ')}`, classes };
    if (viewPlaces.length === 1) {
      const p = viewPlaces[0];
      return { ...base, group: p.key, file: p.file, why: `used only in ${p.key.replace(/^(\w+):/, '$1 ')}`, classes };
    }
    const pages = viewPlaces.filter((p) => p.key.startsWith('page:'));
    if (viewPlaces.every((p) => p.key === 'layout' || p.key.startsWith('shared:') || p.key.startsWith('component:')) && viewPlaces.some((p) => p.key === 'layout')) {
      return { ...base, group: 'layout', file: 'layout', why: 'used by the layout and its shared partials', classes };
    }
    // Used across pages: a component family by the classes' common prefix, else the section heading.
    const prefixes = new Map();
    for (const c of classes) {
      const p = prefixOf(c);
      if (p) prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
    }
    const [top] = [...prefixes].sort((a, b) => b[1] - a[1]);
    if (top && top[1] >= Math.max(1, classes.length / 2)) return { ...base, group: `family:${top[0]}`, file: `components/${top[0]}`, why: `.${top[0]}-* used on ${plural(viewPlaces.length, 'place')}`, classes };
    if (base.header) return { ...base, group: `section:${slug(base.header)}`, file: `common/${slug(base.header)}`, why: `shared by ${pages.length || viewPlaces.length} places; under "${base.header}"`, classes };
    return { ...base, group: 'common', file: 'common/shared', why: `shared by ${plural(viewPlaces.length, 'place')}`, classes };
  });

  // Groups, in an order that keeps the cascade: base first, then layout, components, pages.
  const ORDER = (file) => (file?.startsWith('base/variables') ? 0 : file?.startsWith('base/mixins') ? 1 : file?.startsWith('base/fonts') ? 2 : file?.startsWith('base/') ? 3 : file === 'layout' ? 4 : file?.startsWith('common/') ? 5 : file?.startsWith('components/') ? 6 : file?.startsWith('pages/') ? 7 : 8);
  const groups = new Map();
  for (const a of assignments) {
    if (!a.file) continue;
    if (!groups.has(a.file)) groups.set(a.file, { file: `${a.file}${ext}`, blocks: [], lines: 0, why: new Set(), first: a.start });
    const g = groups.get(a.file);
    g.blocks.push(a);
    g.lines += a.lines;
    g.why.add(a.why);
  }
  const list = [...groups.values()]
    .map((g) => ({ ...g, why: [...g.why].slice(0, 3), ranges: mergeRanges(g.blocks), share: total ? Math.round((100 * g.lines) / total) : 0, order: ORDER(g.file.replace(ext, '')) }))
    .sort((a, b) => a.order - b.order || b.lines - a.lines);

  // Moving rules changes their order: a class styled in two groups depends on which comes later.
  const owners = new Map();
  for (const a of assignments) for (const c of a.classes ?? []) {
    if (!owners.has(c)) owners.set(c, new Set());
    if (a.file) owners.get(c).add(`${a.file}${ext}`);
  }
  const orderSensitive = [...owners].filter(([, s]) => s.size > 1).map(([c, s]) => ({ class: c, files: [...s] }));
  const pageOnly = list.filter((g) => g.file.startsWith('pages/'));

  const lines = [`Splitting ${rel} (${total} lines, ${d.blocks.length} top-level blocks${d.headers.length ? `, ${plural(d.headers.length, 'section heading')}` : ''}) into ${plural(list.length, 'file')}:`];
  for (const g of list) {
    lines.push(`  ${g.file.padEnd(32)} ${String(g.lines).padStart(5)} lines (${String(g.share).padStart(2)}%)  ${g.why.join('; ')}`);
    lines.push(`      lines ${g.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).slice(0, 12).join(', ')}${g.ranges.length > 12 ? ` … +${g.ranges.length - 12}` : ''}`);
  }
  lines.push('', `Then ${rel} keeps its own imports and becomes, in this order (the cascade stays as it was within each file):`);
  for (const g of list.filter((x) => !x.file.startsWith('unused'))) lines.push(`  @import "${g.file.replace(ext, '')}";`);
  if (groups.has('unused')) lines.push('', `unused${ext}: rules whose classes no view or script uses. Check for classes built at run time before deleting them.`);
  if (pageOnly.length) lines.push('', `Page-only styles (${pageOnly.reduce((n, g) => n + g.lines, 0)} lines) could be loaded only on their pages, in a section or bundle of their own, instead of everywhere.`);
  if (orderSensitive.length) lines.push('', `Order-sensitive: ${plural(orderSensitive.length, 'class', 'classes')} styled in more than one new file; keep the import order above:`, ...cut(orderSensitive, 10, (o) => `  .${o.class}: ${o.files.join(', ')}`));
  return { data: { file: rel, lines: total, headers: d.headers, groups: list.map(({ blocks, ...g }) => ({ ...g, blocks: blocks.map(({ classes, ...b }) => ({ ...b, classes: (classes ?? []).slice(0, 12) })) })), orderSensitive }, text: lines.join('\n') };
}

/** Block ranges merged where they touch or only blank lines and comments lie between (gaps under 3). */
function mergeRanges(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  const out = [];
  for (const b of sorted) {
    const last = out[out.length - 1];
    if (last && b.start - last[1] <= 3) last[1] = Math.max(last[1], b.end);
    else out.push([b.start, b.end]);
  }
  return out;
}

/** The stylesheets, largest first, with what each holds: to pick one to split. */
export function stylesheets(idx) {
  const rows = [...idx.files.values()]
    .filter((f) => f.kind === 'style' && !f.vendor && f.data && !idx.sourcesOf(f.rel).length)
    .map((f) => ({ file: f.rel, lines: f.lines ?? 0, rules: f.data.rules.length, blocks: f.data.blocks.length, headers: f.data.headers.length, imports: idx.out(f.rel).filter((e) => e.kind === 'import').length, importedBy: idx.in(f.rel).filter((e) => e.kind === 'import').length }))
    .sort((a, b) => b.lines - a.lines);
  return { data: { stylesheets: rows }, text: [`${plural(rows.length, 'stylesheet')}, largest first:`, ...cut(rows, 40, (r) => `  ${String(r.lines).padStart(6)} lines ${String(r.rules).padStart(5)} rules  ${r.file}${r.importedBy ? '' : '  (top level)'}`)].join('\n') };
}

// ─── path: how two things are connected ───────────────────────────────────────────────────────

/** A node id for a target: an action, a file, a bundle. */
function nodeFor(idx, target) {
  if (idx.nodes.has(target) || idx.files.has(target)) return target;
  const r = resolveTarget(idx, target);
  return r.actions[0] ?? r.files[0] ?? null;
}

/** The shortest chain of edges between two things, in either direction: orders.ts → calls → Orders.Row → renders → _OrderRow. */
export function path(idx, from, to) {
  const a = nodeFor(idx, from);
  const b = nodeFor(idx, to);
  if (!a || !b) return { data: { error: 'not found' }, text: `Not found: ${!a ? from : to}` };
  // Forward first (how things flow: a view loads a script that calls an action that returns a
  // partial); either way only when there's no forward chain.
  const search = (both) => {
    const prev = new Map([[a, null]]);
    const queue = [a];
    while (queue.length && !prev.has(b)) {
      const cur = queue.shift();
      const next = idx.out(cur).map((x) => ({ e: x, next: x.to, dir: 'out' }));
      if (both) next.push(...idx.in(cur).map((x) => ({ e: x, next: x.from, dir: 'in' })));
      for (const e of next) {
        if (!e.next || prev.has(e.next)) continue;
        prev.set(e.next, { from: cur, ...e });
        queue.push(e.next);
      }
      if (prev.size > 200000) break;
    }
    return prev.has(b) ? prev : null;
  };
  const prev = search(false) ?? search(true);
  if (!prev) return { data: { from: a, to: b, steps: [] }, text: `No connection between ${a} and ${b}.` };
  const steps = [];
  for (let cur = b; prev.get(cur); cur = prev.get(cur).from) steps.unshift(prev.get(cur));
  const label = (id) => (idx.nodes.get(id)?.kind === 'action' ? `${actionLabel(idx, id)} (${where(idx, id)})` : id);
  const text = [label(a)];
  for (const s of steps) {
    const how = `${s.e.kind}${s.e.method ? ` ${s.e.method}` : ''}${s.e.url ? ` ${s.e.url}` : ''}`;
    const atLine = s.e.line ? ` @ ${at(idx.nodes.get(s.e.from)?.file ?? s.e.from, s.e.line)}` : '';
    text.push(s.dir === 'out' ? `  ↓ ${how}${atLine}` : `  ↑ ${how} (used by)${atLine}`, label(s.next));
  }
  return { data: { from: a, to: b, steps: steps.map((s) => ({ from: s.from, to: s.next, kind: s.e.kind, direction: s.dir, line: s.e.line, file: s.e.from, method: s.e.method ?? null, url: s.e.url ?? null })) }, text: text.join('\n') };
}

// ─── graph: a node's neighbourhood, for the UI ────────────────────────────────────────────────

/** A node's label, type and place, for drawing. */
export function nodeInfo(idx, id) {
  const type = nodeType(idx, id);
  const node = idx.nodes.get(id);
  const f = idx.files.get(id);
  if (node?.kind === 'action') return { id, type, label: `${node.controller.name}.${node.action.name}`, sub: urlOf(idx, id), file: node.file, line: node.line };
  if (node?.kind === 'bundle') return { id, type, label: node.bundle.path, sub: `${node.bundle.kind} bundle`, file: node.file, line: node.line };
  return { id, type, label: posix.basename(id), sub: posix.dirname(id), file: f ? id : null, lines: f?.lines ?? null, vendor: f?.vendor ?? false };
}

/**
 * The neighbourhood of `focus` to `depth` steps each way: nodes with their `layer` (negative for
 * what uses it, positive for what it uses) and the edges between them. `kinds` limits the edge kinds;
 * `max` caps the nodes, nearest first.
 */
export function graph(idx, focus, { depth = 2, kinds = null, max = 250, vendor = false } = {}) {
  const start = nodeFor(idx, focus);
  if (!start) return { data: { error: 'not found' }, text: `Not found: ${focus}` };
  const allowed = kinds ? new Set(kinds) : null;
  const ok = (e) => (!allowed || allowed.has(e.kind)) && e.to && (vendor || !idx.files.get(e.to)?.vendor);
  // Outward along what it uses (+1 a step) and inward along what uses it (−1), each on its own;
  // a node reached both ways sits on the nearer side (the action rendering a view is on its left
  // even when the view's script also calls it).
  const reach = (dir) => {
    const dist = new Map();
    let frontier = [start];
    for (let step = 1; step <= depth && dist.size < max; step++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of dir > 0 ? idx.out(cur) : idx.in(cur)) {
          if (!ok(e)) continue;
          const other = dir > 0 ? e.to : e.from;
          if (other === start || dist.has(other) || dist.size >= max) continue;
          dist.set(other, step);
          next.push(other);
        }
      }
      frontier = next;
    }
    return dist;
  };
  const outward = reach(1);
  const inward = reach(-1);
  const layer = new Map([[start, 0]]);
  for (const id of new Set([...outward.keys(), ...inward.keys()])) {
    if (layer.size >= max) break;
    const o = outward.get(id) ?? Infinity;
    const i = inward.get(id) ?? Infinity;
    layer.set(id, i < o ? -i : o);
  }
  const nodes = [...layer].map(([id, l]) => ({ ...nodeInfo(idx, id), layer: l }));
  const ids = new Set(layer.keys());
  const edges = [];
  for (const id of ids) for (const e of idx.out(id)) if (ids.has(e.to) && ok(e)) edges.push({ from: id, to: e.to, kind: e.kind, line: e.line, ...(e.method ? { method: e.method } : {}), ...(e.target ? { target: e.target } : {}) });
  return { data: { focus: start, nodes, edges, truncated: layer.size >= max }, text: `${plural(nodes.length, 'node')}, ${plural(edges.length, 'edge')} around ${start}.` };
}
