// What Pilot answers, over a ProjectIndex. Each query returns { data, text }: `data` for --json, and
// `text` written for Claude to read: short lines, every place as `file:line`, the most useful first,
// long lists cut with a count of what was left out.
import { posix } from 'node:path';
import { lineText } from './text.js';
import { pageModel, pageModelText } from './analysis.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const lower = (s) => String(s).toLowerCase();
const at = (file, line) => (line ? `${file}:${line}` : file);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Up to `max` of `list` turned to lines by `fn`, with a line saying how many more there were. */
function cut(list, max, fn, indent = '  ') {
  const lines = list.slice(0, max).map(fn);
  if (list.length > max) lines.push(`${indent}… ${list.length - max} more`);
  return lines;
}

/** A node's place: a file, or an action's controller file and line. */
export function where(idx, id) {
  const node = idx.nodes.get(id);
  if (node) return at(node.file, node.line);
  return id;
}

export function actionLabel(idx, id) {
  const n = idx.nodes.get(id);
  if (!n || n.kind !== 'action') return id;
  const { controller: c, action: a } = n;
  const verbs = a.verbs.length ? ` [${a.verbs.join(',')}]` : '';
  const flags = [a.childOnly && 'child-only', c.api && 'api', a.inherited && `from ${a.inherited}`].filter(Boolean);
  return `${c.area ? `${c.area}/` : ''}${c.className}.${a.method}${verbs}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

/** The URL an action answers on, as people type it. */
export function urlOf(idx, id) {
  const n = idx.nodes.get(id);
  if (!n) return null;
  const { controller: c, action: a } = n;
  if (a.routes.length || c.route) {
    const r = a.routes[0] ?? '';
    const t = r.startsWith('~/') || r.startsWith('/') ? r.replace(/^~?\//, '') : [c.route, r].filter(Boolean).join('/');
    return '/' + t.replace(/\[controller\]/gi, c.name).replace(/\[action\]/gi, a.name).replace(/\[area\]/gi, c.area ?? '');
  }
  const d = idx.defaultRoutes.get(c.project) ?? { controller: 'Home', action: 'Index' };
  const isDefault = lower(c.name) === lower(d.controller) && lower(a.name) === lower(d.action);
  if (isDefault && !c.area) return '/';
  return `/${c.area ? `${c.area}/` : ''}${c.name}${lower(a.name) === lower(d.action) ? '' : `/${a.name}`}`;
}

// ─── Finding what the user named ──────────────────────────────────────────────────────────────

/**
 * What a target names: a file (any path form), a URL or route ('/Orders/Edit/5', 'Orders/Edit',
 * 'Admin/Users/Index'), an action ('OrdersController.Edit', 'Orders.Edit'), or a view's name.
 * Returns { actions: [id], files: [rel], candidates: [rel] }.
 */
export function resolveTarget(idx, target) {
  const t = String(target ?? '').trim();
  const file = idx.file(t);
  if (file) return { actions: [], files: [file.rel], candidates: [] };
  const dotted = /^(?:(\w+)[/.])?(\w+?)(?:Controller)?\.(\w+)$/.exec(t);
  if (dotted && !/\.(cshtml|cs|ts|js|less|css|scss)$/i.test(t)) {
    const node = idx.action(dotted[1] ?? null, dotted[2], dotted[3]);
    if (node) return { actions: [node.id], files: [], candidates: [] };
  }
  if (t.startsWith('action:')) return { actions: idx.nodes.has(t) ? [t] : [], files: [], candidates: [] };
  if (/^(https?:\/\/|~?\/)|^[A-Za-z][\w-]*(\/[\w-]*)+\/?$/.test(t) || t === '/') {
    const hits = idx.routeToAction(t);
    if (hits.length) return { actions: hits.map((n) => n.id), files: [], candidates: [] };
  }
  // A file's tail or a view's name: 'Orders/Edit.cshtml', '_Header', 'site.less'.
  const tail = lower(t.replace(/\\/g, '/'));
  const matches = [...idx.files.keys()].filter((rel) => {
    const l = lower(rel);
    return l.endsWith(`/${tail}`) || l === tail || l.endsWith(`/${tail}.cshtml`) || posix.basename(l).replace(/\.[^.]+$/, '') === tail;
  });
  if (matches.length === 1) return { actions: [], files: matches, candidates: [] };
  return { actions: [], files: [], candidates: matches };
}

function notFound(target, r) {
  if (r.candidates.length) {
    const text = [`"${target}" matches ${r.candidates.length} files; name one:`, ...cut(r.candidates, 25, (c) => `  ${c}`)].join('\n');
    return { data: { error: 'ambiguous', candidates: r.candidates }, text };
  }
  return { data: { error: 'not found' }, text: `Nothing found for "${target}". Try find, or a path from the project root.` };
}

// ─── overview ─────────────────────────────────────────────────────────────────────────────────

export function overview(idx) {
  const files = [...idx.files.values()];
  const count = (pred) => files.filter(pred).length;
  const views = files.filter((f) => f.kind === 'view');
  const layouts = views.filter((v) => v.data?.renderBody);
  const special = (v) => /(^|\/)_View(Start|Imports)\.cshtml$/i.test(v.rel);
  const partials = views.filter((v) => !special(v) && !v.data?.renderBody && idx.isPartial(v.rel));
  const actions = [...idx.nodes.values()].filter((n) => n.kind === 'action');
  const scripts = files.filter((f) => f.kind === 'script');
  const styles = files.filter((f) => f.kind === 'style');
  const imported = new Set([...idx.reverse.keys()]);
  const rootStyles = styles.filter((s) => !s.vendor && /\.(less|scss)$/i.test(s.rel) && !idx.in(s.rel).some((e) => e.kind === 'import'));
  const layoutUse = layouts
    .map((l) => ({ file: l.rel, views: idx.in(l.rel).filter((e) => e.kind === 'layout').length }))
    .sort((a, b) => b.views - a.views);
  const configs = files.filter((f) => f.kind === 'config' && f.data).map((f) => `${f.rel} (${f.data.type})`);
  const data = {
    root: idx.root,
    projects: idx.projects.length ? idx.projects.map((p) => p || '.') : ['.'],
    areas: [...idx.areas],
    counts: {
      files: files.length,
      views: views.length,
      layouts: layouts.length,
      partials: partials.length,
      controllers: idx.controllers.size,
      actions: actions.length,
      viewComponents: idx.components.size,
      bundles: idx.bundles.size,
      typescript: count((f) => /\.tsx?$/i.test(f.rel) && !f.vendor),
      javascript: count((f) => /\.(m?js|jsx)$/i.test(f.rel) && !f.vendor),
      less: count((f) => /\.less$/i.test(f.rel) && !f.vendor),
      scss: count((f) => /\.scss$/i.test(f.rel) && !f.vendor),
      css: count((f) => /\.css$/i.test(f.rel) && !f.vendor),
      vendor: count((f) => f.vendor),
      problems: idx.problems.length,
    },
    layouts: layoutUse,
    rootStylesheets: rootStyles.map((s) => s.rel),
    bundles: [...idx.bundles.values()].map((b) => ({ path: b.path, kind: b.kind, members: idx.out(b.id).length, file: at(b.file, b.line) })),
    configs,
    index: idx.stats,
  };
  void imported;
  void scripts;
  const c = data.counts;
  const lines = [
    `Project ${idx.root}`,
    `  web projects: ${data.projects.join(', ')}${data.areas.length ? `   areas: ${data.areas.join(', ')}` : ''}`,
    `  ${plural(c.views, 'view')} (${plural(c.layouts, 'layout')}, ${plural(c.partials, 'partial')}), ${plural(c.controllers, 'controller')} with ${plural(c.actions, 'action')}, ${plural(c.viewComponents, 'view component')}`,
    `  ${c.typescript} TypeScript, ${c.javascript} JavaScript, ${c.less} LESS, ${c.scss} SCSS, ${c.css} CSS files of the project's own; ${c.vendor} library files`,
    `  ${plural(c.bundles, 'bundle')}; build configs: ${configs.length ? configs.join(', ') : 'none'}`,
  ];
  if (layoutUse.length) lines.push('', 'Layouts (views using each):', ...cut(layoutUse, 15, (l) => `  ${l.file}  ${l.views}`));
  if (rootStyles.length) lines.push('', 'Top-level stylesheets (imported by nothing):', ...cut(rootStyles, 15, (s) => `  ${s.rel}${idx.outputs.get(s.rel) ? ` → ${idx.outputs.get(s.rel).join(', ')}` : ''}`));
  if (data.bundles.length) lines.push('', 'Bundles:', ...cut(data.bundles, 20, (b) => `  ${b.path} (${b.kind}, ${plural(b.members, 'file')})  ${b.file}`));
  lines.push('', `${plural(c.problems, 'unresolved reference')} (problems lists them). Indexed ${c.files} files in ${idx.stats.ms} ms (${idx.stats.cached} from the cache).`);
  lines.push('Next: page <url|Controller.Action> for everything a page is made of; file <path> for one file; selector <.class|#id> before changing a style.');
  return { data, text: lines.join('\n') };
}

// ─── page: everything a request draws ─────────────────────────────────────────────────────────

/** The layout chain of a view, innermost first: [{ file, line, from }]. */
export function layoutChain(idx, rel) {
  const chain = [];
  const seen = new Set([rel]);
  let cur = rel;
  for (;;) {
    const e = idx.out(cur).find((x) => x.kind === 'layout');
    if (!e || seen.has(e.to)) break;
    chain.push({ file: e.to, line: e.line, from: e.via ?? cur });
    seen.add(e.to);
    cur = e.to;
  }
  return chain;
}

const sectionAt = (data, line) => data?.sections.find((s) => line >= s.line && line <= s.end)?.name ?? null;

/**
 * The page a view makes, as a tree from the outermost layout down, with the assets in the order the
 * browser meets them. Each tree node is { type: 'root'|'body'|'section'|'partial'|'template'|
 * 'component'|'child-action'|'view', file?, action?, name?, from?, line?, how?, again?, own, depth,
 * children }; `own` marks what belongs to this page rather than to its layouts (the view, what it
 * renders, and its sections' content). Returns { chain, root, tree: [text lines], assets, warnings,
 * files: Map(file → own) }.
 */
export function renderTree(idx, view, { depth: maxDepth = 8 } = {}) {
  const chain = layoutChain(idx, view);
  const outer = [view, ...chain.map((c) => c.file)].reverse();
  const assets = [];
  const warnings = [];
  const shown = new Set();
  const files = new Map();
  const ITEM_KINDS = new Set(['partial', 'template', 'component', 'child-action', 'script', 'style']);
  const seen = (file, own) => files.set(file, (files.get(file) ?? false) || own);

  const draw = (rel, childIndex, section, depth, own, parent) => {
    const f = idx.files.get(rel);
    seen(rel, own);
    if (!f?.data || depth > maxDepth) return;
    const items = idx
      .out(rel)
      .filter((e) => ITEM_KINDS.has(e.kind) && sectionAt(f.data, e.line) === section)
      .map((e) => ({ line: e.line, e }));
    if (childIndex != null) {
      if (f.data.renderBody && section == null) items.push({ line: f.data.renderBody, body: true });
      for (const r of f.data.renderSections) if (sectionAt(f.data, r.line) === section) items.push({ line: r.line, section: r });
    }
    items.sort((a, b) => a.line - b.line);
    for (const it of items) {
      const child = childIndex != null ? outer[childIndex] : null;
      const next = childIndex != null && childIndex + 1 < outer.length ? childIndex + 1 : null;
      // What the view itself puts in the layout's body or sections is the page's own.
      const childOwn = own || child === view;
      if (it.body) {
        const node = { type: 'body', file: child, own: childOwn, depth, children: [] };
        parent.children.push(node);
        draw(child, next, null, depth + 1, childOwn, node);
      } else if (it.section) {
        const def = idx.files.get(child)?.data?.sections.find((s) => lower(s.name) === lower(it.section.name));
        if (def) {
          const node = { type: 'section', name: it.section.name, file: child, line: def.line, own: childOwn, depth, children: [] };
          parent.children.push(node);
          draw(child, next, def.name, depth + 1, childOwn, node);
        } else if (it.section.required) warnings.push(`${at(rel, it.section.line)}: section "${it.section.name}" is required but ${child} doesn't define it`);
      } else {
        const e = it.e;
        if (e.kind === 'script' || e.kind === 'style') {
          for (const a of expandAsset(idx, e)) assets.push({ ...a, from: at(rel, e.line), section, own });
          continue;
        }
        if (e.kind === 'child-action') {
          const node = { type: 'child-action', action: e.to, from: rel, line: e.line, own, depth, children: [] };
          parent.children.push(node);
          for (const r of idx.out(e.to).filter((x) => x.kind === 'renders' || x.kind === 'renders-partial')) {
            const again = shown.has(r.to);
            const v = { type: 'view', file: r.to, own, depth: depth + 1, again, children: [] };
            node.children.push(v);
            if (!again) {
              shown.add(r.to);
              draw(r.to, null, null, depth + 2, own, v);
            }
          }
          continue;
        }
        const again = shown.has(e.to);
        const node = { type: e.kind, name: e.name ?? null, file: e.to, from: rel, line: e.line, how: e.how, again, own, depth, children: [] };
        parent.children.push(node);
        if (!again) {
          shown.add(e.to);
          draw(e.to, null, null, depth + 1, own, node);
        }
      }
    }
  };
  const root = { type: 'root', file: outer[0], own: outer[0] === view, depth: 0, children: [] };
  draw(outer[0], outer.length > 1 ? 1 : null, null, 0, outer[0] === view, root);
  return { chain, root, tree: treeLines(idx, root), assets, warnings, files };
}

/** A render tree as the text lines `page` prints. */
export function treeLines(idx, root) {
  const lines = [root.file];
  const walk = (node, prefix) => {
    for (const n of node.children) {
      if (n.type === 'body') {
        lines.push(`${prefix}▸ body ← ${n.file}`);
        walk(n, prefix + '  ');
      } else if (n.type === 'section') {
        lines.push(`${prefix}▸ section ${n.name} ← ${at(n.file, n.line)}`);
        walk(n, prefix + '  ');
      } else if (n.type === 'child-action') {
        lines.push(`${prefix}├ child action ${actionLabel(idx, n.action)} (${where(idx, n.action)})  @ ${at(n.from, n.line)}`);
        for (const v of n.children) {
          lines.push(`${prefix}│  └ ${v.file}`);
          walk(v, prefix + '│    ');
        }
      } else {
        const label = n.type === 'component' ? `component ${n.name}` : n.type === 'template' ? `template ${n.name}` : `partial ${n.name ?? ''}`.trim();
        lines.push(`${prefix}├ ${label} → ${n.file}${n.how === 'guess' ? ' (guessed)' : ''}  @ ${at(n.from, n.line)}${n.again ? ' (again)' : ''}`);
        walk(n, prefix + '│  ');
      }
    }
  };
  walk(root, '  ');
  return lines;
}

/** A script or style edge as what's loaded: the file, its sources (TypeScript, LESS) and bundle members. */
export function expandAsset(idx, e) {
  if (e.external) return [{ kind: e.kind, url: e.url, external: true }];
  if (e.missing) return [{ kind: e.kind, url: e.url, missing: true }];
  const node = idx.nodes.get(e.to);
  if (node?.kind === 'bundle') {
    return idx.out(e.to).map((m) => (m.built
      ? { kind: e.kind, url: e.url, bundle: node.bundle.path, bundleAt: at(node.file, node.line), file: m.built, built: true, vendor: false, sources: [m.to] }
      : { kind: e.kind, url: e.url, bundle: node.bundle.path, bundleAt: at(node.file, node.line), file: m.to, vendor: idx.files.get(m.to)?.vendor ?? false, sources: idx.sourcesOf(m.to).map((s) => s.file) }));
  }
  const vendor = idx.files.get(e.to)?.vendor ?? false;
  const sources = e.built ? [] : idx.sourcesOf(e.to).map((s) => s.file);
  return [{ kind: e.kind, url: e.url, file: e.built ?? e.to, built: e.built ? true : undefined, vendor, sources: e.built ? [e.to] : sources }];
}

function assetLine(a) {
  if (a.external) return `${a.url} (external)`;
  if (a.missing) return `${a.url} (NOT FOUND)`;
  const via = a.bundle ? ` via bundle ${a.bundle}` : '';
  const src = a.sources?.length ? ` ← edit ${a.sources.join(', ')}` : '';
  return `${a.file}${a.built ? ' (built, not in the tree)' : ''}${a.vendor ? ' [library]' : ''}${src}${via}`;
}

export function page(idx, target) {
  const r = resolveTarget(idx, target);
  let actions = r.actions;
  let views = [];
  if (r.files.length) {
    const f = idx.files.get(r.files[0]);
    if (f.kind !== 'view') return file(idx, target);
    views = [f.rel];
    actions = idx.in(f.rel).filter((e) => e.kind === 'renders' || e.kind === 'renders-partial').map((e) => e.from);
  } else if (actions.length) {
    views = [...new Set(actions.flatMap((id) => idx.out(id).filter((e) => e.kind === 'renders' || e.kind === 'renders-partial').map((e) => e.to)))];
  } else return notFound(target, r);

  const lines = [];
  const data = { target, actions: [], views: [] };
  for (const id of actions) {
    const n = idx.nodes.get(id);
    data.actions.push({ id, label: actionLabel(idx, id), at: where(idx, id), url: urlOf(idx, id) });
    lines.push(`Action  ${actionLabel(idx, id)}  ${where(idx, id)}   ${urlOf(idx, id)}`);
    for (const rd of n.action.redirects) lines.push(`        redirects to ${rd.controller ? `${rd.controller}/` : ''}${rd.action} @ ${at(n.file, rd.line)}`);
    if (n.action.json && !n.action.views.length) lines.push('        returns JSON, no view');
  }
  if (!views.length) lines.push('No view: the action returns data or redirects.');
  for (const v of views) {
    const f = idx.files.get(v);
    const tree = renderTree(idx, v);
    data.views.push({ view: v, model: f.data?.model?.type ?? null, layouts: tree.chain, tree: tree.tree, assets: tree.assets, warnings: tree.warnings });
    lines.push('', `View    ${v}${f.data?.model ? `  (@model ${f.data.model.type})` : ''}${f.data?.title ? `  title "${f.data.title}"` : ''}`);
    if (tree.chain.length) for (const l of tree.chain) lines.push(`Layout  ${l.file}  (set in ${at(l.from, l.line)})`);
    else if (!idx.isPartial(v)) lines.push('Layout  none');
    lines.push('', 'Render tree (outermost first; @ is where it is rendered from):', ...tree.tree.map((l) => `  ${l}`));
    const scripts = tree.assets.filter((a) => a.kind === 'script');
    const styles = tree.assets.filter((a) => a.kind === 'style');
    if (styles.length) lines.push('', 'Styles, in order:', ...styles.map((a, i) => `  ${i + 1}. ${assetLine(a)}   (${a.from})`));
    if (scripts.length) lines.push('', 'Scripts, in order:', ...scripts.map((a, i) => `  ${i + 1}. ${assetLine(a)}   (${a.from}${a.section ? `, section ${a.section}` : ''})`));
    if (tree.warnings.length) lines.push('', 'Warnings:', ...tree.warnings.map((w) => `  ${w}`));
    const dyn = [v, ...tree.chain.map((c) => c.file)].flatMap((x) => (idx.files.get(x)?.data?.dynamic ?? []).map((d) => `${at(x, d.line)} ${d.what}`));
    if (dyn.length) lines.push('', 'Decided at run time (not followed):', ...cut(dyn, 10, (d) => `  ${d}`));
    const model = pageModel(idx, v);
    Object.assign(data.views.at(-1), { scripts: model.scripts, calls: model.calls, widgets: model.widgets, metrics: model.metrics });
    lines.push(...pageModelText(idx, model));
  }
  return { data, text: lines.join('\n') };
}

// ─── file: one file in context ────────────────────────────────────────────────────────────────

/** The entry points (actions) that end up drawing `rel`, and how many views and layouts lie between. */
export function reach(idx, rel) {
  const deps = idx.dependents(rel);
  const actions = deps.filter((d) => idx.nodes.get(d.id)?.kind === 'action' && !idx.nodes.get(d.id).action.childOnly);
  const views = deps.filter((d) => idx.files.get(d.id)?.kind === 'view');
  return { deps, actions, views };
}

function edgeLine(idx, e, dir) {
  const other = dir === 'out' ? e.to : e.from;
  const otherAt = dir === 'out' ? (idx.nodes.has(other) ? where(idx, other) : other) : at(e.from, e.line);
  const label = idx.nodes.get(other)?.kind === 'action' ? `${actionLabel(idx, other)} ${where(idx, other)}` : otherAt ?? e.url;
  const how = e.how === 'guess' ? ' (guessed)' : '';
  const here = dir === 'out' && e.line ? `  @ line ${e.line}` : '';
  return `  ${e.kind.padEnd(14)} ${label ?? e.url}${e.external ? ` ${e.url} (external)` : ''}${e.missing ? ` ${e.url} (NOT FOUND)` : ''}${how}${here}`;
}

export function file(idx, target, { classes: showClasses = true } = {}) {
  const r = resolveTarget(idx, target);
  if (!r.files.length) {
    if (r.actions.length) return page(idx, target);
    return notFound(target, r);
  }
  const f = idx.files.get(r.files[0]);
  const d = f.data;
  const lines = [`${f.rel}  (${f.kind}${f.vendor ? ', library' : ''}${f.skipped ? `, ${f.skipped}` : ''})`];
  const data = { file: f.rel, kind: f.kind, vendor: f.vendor };
  const outs = idx.out(f.rel);
  const ins = idx.in(f.rel);
  const outputs = idx.outputs.get(f.rel) ?? [];
  const sources = idx.sourcesOf(f.rel);
  if (sources.length) lines.push(`  built from ${sources.map((s) => `${s.file} (${s.how})`).join(', ')}: edit that instead`);
  if (outputs.length) lines.push(`  builds to ${outputs.join(', ')}`);

  if (f.kind === 'view' && d) {
    const chain = layoutChain(idx, f.rel);
    data.model = d.model?.type ?? null;
    data.layouts = chain;
    data.partial = idx.isPartial(f.rel);
    if (d.model) lines.push(`  @model ${d.model.type}`);
    lines.push(`  ${data.partial ? 'partial' : d.renderBody ? 'layout' : 'view'}${chain.length ? `; layouts ${chain.map((c) => c.file).join(' → ')}` : ''}`);
    if (d.sections.length) lines.push(`  defines sections ${d.sections.map((s) => `${s.name} (${s.line}-${s.end})`).join(', ')}`);
    if (d.renderSections.length) lines.push(`  renders sections ${d.renderSections.map((s) => `${s.name}${s.required ? ' (required)' : ''} @${s.line}`).join(', ')}`);
    if (d.renderBody) lines.push(`  @RenderBody() at line ${d.renderBody}`);
  }
  if (f.kind === 'cs' && d) {
    for (const c of d.controllers) {
      lines.push(`  controller ${c.area ? `${c.area}/` : ''}${c.name}  line ${c.line}${c.route ? `  [Route("${c.route}")]` : ''}`);
      for (const a of c.actions) {
        const views = a.views.map((v) => (v.dynamic ? `View(${v.dynamic})?` : `${v.partial ? 'PartialView' : 'View'}("${v.name}")`)).join(', ');
        const id = idx.actionId({ ...c, project: idx.projectOf(f.rel), area: c.area ?? /(?:^|\/)Areas\/([^/]+)\//i.exec(f.rel)?.[1] ?? null }, a.name);
        const rendered = idx.out(id).filter((e) => e.kind.startsWith('renders')).map((e) => e.to);
        lines.push(`    ${a.method}${a.name !== a.method ? ` (as ${a.name})` : ''}${a.verbs.length ? ` [${a.verbs.join(',')}]` : ''} line ${a.line}  ${urlOf(idx, id) ?? ''}${views ? `  → ${rendered.length ? rendered.join(', ') : views}` : a.json ? '  → JSON' : ''}`);
      }
    }
    for (const c of d.components) lines.push(`  view component ${c.name} line ${c.line}  → views ${(c.views.length ? c.views.map((v) => v.name) : ['Default']).join(', ')}`);
    for (const b of d.bundles) lines.push(`  bundle ${b.path} (${b.kind}) line ${b.line}: ${idx.out(`bundle:${b.path}`).map((e) => e.to).join(', ') || 'no files'}`);
  }
  if (f.kind === 'script' && d) {
    data.defs = d.defs;
    if (d.defs.length) lines.push('  defines:', ...cut(d.defs, 25, (x) => `    ${x.kind} ${x.name}  line ${x.line}`, '    '));
  }
  if (f.kind === 'style' && d) {
    data.vars = d.vars;
    if (d.vars.length) lines.push(`  variables: ${d.vars.slice(0, 30).map((v) => `${v.name} (${v.line})`).join(', ')}${d.vars.length > 30 ? ` … ${d.vars.length - 30} more` : ''}`);
    if (d.mixins.length) lines.push(`  mixins: ${d.mixins.slice(0, 30).map((m) => `${m.name} (${m.line})`).join(', ')}`);
    lines.push(`  ${plural(d.rules.length, 'rule')}`);
  }

  const shownOut = outs.filter((e) => e.kind !== 'source');
  if (shownOut.length) lines.push('', 'Uses:', ...cut(shownOut, 40, (e) => edgeLine(idx, e, 'out')));
  const shownIn = ins.filter((e) => e.kind !== 'source');
  if (shownIn.length) lines.push('', 'Used by:', ...cut(shownIn, 40, (e) => `  ${e.kind.padEnd(14)} ${idx.nodes.has(e.from) ? `${idx.nodes.get(e.from).kind === 'action' ? actionLabel(idx, e.from) : e.from} ${where(idx, e.from)}` : at(e.from, e.line)}`));

  const { actions, views } = reach(idx, sources[0]?.file === f.rel ? f.rel : f.rel);
  data.pages = actions.map((a) => ({ action: actionLabel(idx, a.id), url: urlOf(idx, a.id) }));
  if (actions.length) lines.push('', `Shown on ${plural(actions.length, 'page')} (through ${plural(views.length, 'view')}):`, ...cut(actions, 15, (a) => `  ${urlOf(idx, a.id)}  ${actionLabel(idx, a.id)}`));
  else if (f.kind === 'view' || f.kind === 'script' || f.kind === 'style') lines.push('', 'No page found that draws or loads it (dynamic, unused, or loaded some way Pilot does not follow).');

  if (showClasses && d && (f.kind === 'view' || f.kind === 'script')) {
    const own = f.kind === 'view' ? [...d.classes, ...(d.inline.script?.classes ?? [])] : d.classes;
    const names = [...new Set(own.map(([n]) => n))];
    const styledIn = (n) => (idx.symbols.classes.get(n) ?? []).filter((u) => u.role === 'style');
    const rows = names.map((n) => ({ name: n, styles: styledIn(n) }));
    data.classes = rows.map((r) => ({ name: r.name, styledIn: r.styles.map((s) => at(s.file, s.line)) }));
    if (rows.length) {
      lines.push('', `Classes (${rows.length}) and where they are styled:`);
      lines.push(...cut(rows, 40, (r) => `  .${r.name}  ${r.styles.length ? r.styles.filter((s) => !s.vendor).slice(0, 3).map((s) => at(s.file, s.line)).join(', ') + (r.styles.some((s) => s.vendor) ? ' +library' : '') || 'library only' : '(no style found)'}`));
    }
    const ids = [...new Set((f.kind === 'view' ? d.ids : d.ids).map(([n]) => n))];
    if (ids.length) lines.push(`Ids: ${ids.slice(0, 40).map((i) => `#${i}`).join(' ')}`);
  }
  if (f.kind === 'view' && d?.handlers.length) {
    lines.push('', 'Event attributes call:');
    for (const h of d.handlers.slice(0, 20)) {
      const defs = (idx.symbols.defs.get(h.fn.split('.').pop()) ?? []).filter((x) => x.role === 'def');
      lines.push(`  ${h.event}="${h.fn}()" line ${h.line} → ${defs.length ? defs.slice(0, 3).map((x) => at(x.file, x.line)).join(', ') : 'definition not found'}`);
    }
  }
  if (d?.dynamic?.length) lines.push('', 'Decided at run time (not followed):', ...cut(d.dynamic, 10, (x) => `  line ${x.line}: ${x.what}`));
  const problems = idx.problems.filter((p) => p.file === f.rel);
  if (problems.length) lines.push('', 'Problems:', ...cut(problems, 15, (p) => `  line ${p.line}: ${p.message}`));
  return { data, text: lines.join('\n') };
}

// ─── impact: what a change to a file reaches ──────────────────────────────────────────────────

export function impact(idx, target) {
  const r = resolveTarget(idx, target);
  if (!r.files.length) return notFound(target, r);
  const rel = r.files[0];
  const { deps, actions, views } = reach(idx, rel);
  const layouts = views.filter((v) => idx.files.get(v.id)?.data?.renderBody);
  const others = deps.filter((d) => idx.nodes.get(d.id)?.kind !== 'action' && idx.files.get(d.id)?.kind !== 'view');
  const lines = [`Changing ${rel} reaches ${plural(actions.length, 'page')}, ${plural(views.length, 'view')} (${plural(layouts.length, 'layout')}), ${plural(others.length, 'other file')}.`];
  const path = (d) => {
    const steps = [];
    let cur = d;
    for (let i = 0; cur?.via && i < 12; i++) {
      steps.push(`${cur.via.kind}`);
      cur = deps.find((x) => x.id === cur.via.to) ?? null;
    }
    return steps.reverse().join(' ← ');
  };
  if (layouts.length) lines.push('', 'Layouts (every view using them changes):', ...cut(layouts, 15, (l) => `  ${l.id}  (${idx.in(l.id).filter((e) => e.kind === 'layout').length} views)`));
  if (others.length) lines.push('', 'Files that include it:', ...cut(others, 25, (o) => `  ${o.id}  via ${o.via.kind} @ ${at(o.via.from, o.via.line)}`));
  if (views.length) lines.push('', 'Views:', ...cut(views.filter((v) => !layouts.includes(v)), 30, (v) => `  ${v.id}  (${path(v)})`));
  if (actions.length) lines.push('', 'Pages:', ...cut(actions, 40, (a) => `  ${(urlOf(idx, a.id) ?? '').padEnd(28)} ${actionLabel(idx, a.id)}`));
  return { data: { file: rel, pages: actions.map((a) => ({ id: a.id, url: urlOf(idx, a.id) })), views: views.map((v) => v.id), files: others.map((o) => o.id) }, text: lines.join('\n') };
}

// ─── selector: a class or id everywhere ───────────────────────────────────────────────────────

const ROLE_TITLE = { style: 'Styled in', markup: 'Marked up in', script: 'Used by scripts in' };

export function selector(idx, query, { vendor = false, snippets = true } = {}) {
  const q = String(query ?? '').trim();
  const kind = q.startsWith('#') ? 'ids' : q.startsWith('[') ? 'attrs' : q.startsWith('.') ? 'classes' : 'both';
  const name = kind === 'attrs' ? q.replace(/^\[|\]$/g, '').replace(/[=~^$*|].*$/, '').trim() : q.replace(/^[.#]/, '').trim();
  const pattern = /[*?]/.test(name) ? new RegExp(`^${name.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
  const maps = kind === 'both' ? [['classes', '.'], ['ids', '#']] : [[kind, kind === 'ids' ? '#' : kind === 'attrs' ? '' : '.']];
  if (pattern) {
    // A wildcard: the names that match, each with its counts.
    const rows = [];
    for (const [m, sigil] of maps) for (const [n, uses] of idx.symbols[m]) if (pattern.test(n)) rows.push({ name: `${sigil}${n}`, styled: uses.filter((u) => u.role === 'style').length, markup: uses.filter((u) => u.role === 'markup').length, script: uses.filter((u) => u.role === 'script').length });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { data: { query: q, matches: rows }, text: [`${rows.length} names match ${q} (styled / markup / scripts):`, ...cut(rows, 80, (r) => `  ${r.name.padEnd(32)} ${r.styled} / ${r.markup} / ${r.script}`)].join('\n') };
  }
  const data = { query: q, results: [] };
  const lines = [];
  const textOf = new Map();
  const snippet = (file, line) => {
    if (!snippets) return '';
    try {
      if (!textOf.has(file)) textOf.set(file, readFileSync(join(idx.root, file), 'utf8'));
      return `   ${lineText(textOf.get(file), line, 110)}`;
    } catch {
      return '';
    }
  };
  for (const [m, sigil] of maps) {
    const exact = idx.symbols[m].get(name) ?? [];
    const uses = exact.length ? exact : [...idx.symbols[m]].find(([n]) => lower(n) === lower(name))?.[1] ?? [];
    if (!uses.length) continue;
    data.results.push({ name: `${sigil}${name}`, uses });
    lines.push(`${sigil}${name}:`);
    for (const role of ['style', 'markup', 'script']) {
      let list = uses.filter((u) => u.role === role);
      const libs = list.filter((u) => u.vendor);
      if (!vendor) list = list.filter((u) => !u.vendor);
      if (!list.length && !libs.length) {
        if (role === 'style') lines.push('  Styled in: nowhere in the project (a library, or not styled)');
        continue;
      }
      lines.push(`  ${ROLE_TITLE[role]} (${list.length}):`);
      lines.push(...cut(list, 40, (u) => `    ${at(u.file, u.line)}${u.selector ? `  ${u.selector}` : snippet(u.file, u.line)}`, '    '));
      if (libs.length && !vendor) lines.push(`    + ${plural(libs.length, 'rule')} in libraries (${[...new Set(libs.map((l) => l.file))].slice(0, 3).join(', ')}); vendor: true lists them`);
    }
  }
  if (!data.results.length) lines.push(`${q} isn't used, styled or scripted anywhere Pilot can see. A name built at run time ('btn-' + kind) isn't seen.`);
  return { data, text: lines.join('\n') };
}

// ─── style symbols: LESS/SCSS variables and mixins, CSS custom properties ────────────────────

export function styleSymbol(idx, query) {
  const q = String(query ?? '').trim();
  const isMixin = /^[.#]/.test(q) || (!/^[@$]|^--/.test(q) && !idx.symbols.vars.has(`@${q}`) && idx.symbols.mixins.has(q));
  const key = isMixin ? q.replace(/^[.#]/, '') : /^[@$]|^--/.test(q) ? q : idx.symbols.vars.has(`@${q}`) ? `@${q}` : `$${q}`;
  const uses = (isMixin ? idx.symbols.mixins : idx.symbols.vars).get(key) ?? [];
  if (!uses.length) return { data: { query: q, uses: [] }, text: `${q}: no definition or use found.` };
  const defs = uses.filter((u) => u.role === 'def');
  const used = uses.filter((u) => u.role === 'use');
  const lines = [`${isMixin ? `mixin .${key}` : key}`];
  lines.push(`  Defined (${defs.length}):`, ...cut(defs, 10, (u) => `    ${at(u.file, u.line)}${u.value ? `  = ${u.value}` : ''}`, '    '));
  const byFile = new Map();
  for (const u of used) byFile.set(u.file, [...(byFile.get(u.file) ?? []), u.line]);
  lines.push(`  Used (${used.length} times in ${plural(byFile.size, 'file')}):`, ...cut([...byFile], 40, ([f, ls]) => `    ${f}: lines ${ls.slice(0, 12).join(', ')}${ls.length > 12 ? '…' : ''}`, '    '));
  // Which top-level stylesheets pull the definition in.
  const roots = new Set();
  for (const d of defs) {
    for (const dep of [{ id: d.file }, ...idx.dependents(d.file)]) {
      const f = idx.files.get(dep.id);
      if (f?.kind === 'style' && !idx.in(dep.id).some((e) => e.kind === 'import') && !idx.sourcesOf(dep.id).length) roots.add(dep.id);
    }
  }
  if (roots.size) lines.push(`  Compiled into: ${[...roots].map((r) => `${r}${idx.outputs.get(r) ? ` → ${idx.outputs.get(r).join(', ')}` : ''}`).join('; ')}`);
  return { data: { query: q, defs, uses: used, roots: [...roots] }, text: lines.join('\n') };
}

// ─── find: anything by name ───────────────────────────────────────────────────────────────────

export function find(idx, query, { limit = 40 } = {}) {
  const q = lower(String(query ?? '').trim());
  if (!q) return { data: { results: [] }, text: 'find needs a name.' };
  const results = [];
  const score = (name) => {
    const n = lower(name);
    return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : -1;
  };
  const add = (name, kind, place, extra = '') => {
    const s = score(name);
    if (s >= 0) results.push({ s, name, kind, place, extra });
  };
  for (const n of idx.nodes.values()) {
    if (n.kind === 'action') {
      const full = `${n.controller.area ? `${n.controller.area}/` : ''}${n.controller.name}.${n.action.name}`;
      const s = [score(full), score(n.action.name)].filter((x) => x >= 0);
      if (s.length) results.push({ s: Math.min(...s), name: full, kind: 'action', place: at(n.file, n.line), extra: urlOf(idx, n.id) });
    } else if (n.kind === 'bundle') add(n.bundle.path, 'bundle', at(n.file, n.line));
  }
  for (const c of idx.controllers.values()) add(c.className, 'controller', at(c.file, c.line));
  for (const c of idx.components.values()) add(c.name, 'view component', at(c.file, c.line));
  for (const f of idx.files.values()) {
    const base = posix.basename(f.rel).replace(/\.[^.]+$/, '');
    const s = Math.min(...[score(base), score(f.rel) === -1 ? -1 : 3].filter((x) => x >= 0), 99);
    if (s < 99) results.push({ s, name: f.rel, kind: f.kind + (f.vendor ? ' (library)' : ''), place: f.rel, extra: '' });
  }
  for (const [name, list] of idx.symbols.defs) for (const d of list) if (d.role === 'def') add(d.name ?? name, d.kind, at(d.file, d.line));
  for (const [name, list] of idx.symbols.vars) for (const d of list) if (d.role === 'def') add(name, 'style variable', at(d.file, d.line), d.value);
  for (const [name, list] of idx.symbols.mixins) for (const d of list) if (d.role === 'def') add(`.${name}`, 'mixin', at(d.file, d.line));
  for (const m of ['classes', 'ids']) {
    for (const [name, list] of idx.symbols[m]) {
      if (score(name) === 0) add(`${m === 'ids' ? '#' : '.'}${name}`, m === 'ids' ? 'id' : 'class', `${list.length} places`, 'selector lists them');
    }
  }
  results.sort((a, b) => a.s - b.s || a.name.length - b.name.length);
  const seen = new Set();
  const unique = results.filter((r) => {
    const k = `${r.kind}|${r.name}|${r.place}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { data: { query, results: unique.slice(0, limit) }, text: unique.length ? [`${unique.length} matches for "${query}":`, ...cut(unique, limit, (r) => `  ${r.kind.padEnd(16)} ${r.name.padEnd(34)} ${r.place === r.name ? '' : r.place}${r.extra ? `  ${r.extra}` : ''}`)].join('\n') : `Nothing named like "${query}".` };
}

// ─── problems ─────────────────────────────────────────────────────────────────────────────────

export function problems(idx, { filter = '', limit = 100 } = {}) {
  const f = lower(filter);
  const list = idx.problems.filter((p) => !f || lower(p.file).includes(f) || lower(p.message).includes(f));
  const dynamic = [...idx.files.values()].flatMap((x) => (x.data?.dynamic ?? []).map((d) => ({ file: x.rel, line: d.line, message: `decided at run time: ${d.what}` }))).filter((p) => !f || lower(p.file).includes(f));
  const lines = [`${plural(list.length, 'unresolved reference')}${dynamic.length ? `, ${dynamic.length} decided at run time` : ''}:`, ...cut(list, limit, (p) => `  ${at(p.file, p.line)}  ${p.message}`)];
  if (dynamic.length) lines.push('', 'Decided at run time:', ...cut(dynamic, 30, (p) => `  ${at(p.file, p.line)}  ${p.message.replace('decided at run time: ', '')}`));
  return { data: { problems: list, dynamic }, text: lines.join('\n') };
}

// ─── routes ───────────────────────────────────────────────────────────────────────────────────

export function routes(idx, { filter = '' } = {}) {
  const f = lower(filter);
  const rows = [...idx.nodes.values()]
    .filter((n) => n.kind === 'action')
    .map((n) => ({ url: urlOf(idx, n.id), action: actionLabel(idx, n.id), at: where(idx, n.id), views: idx.out(n.id).filter((e) => e.kind.startsWith('renders')).map((e) => e.to) }))
    .filter((r) => !f || lower(`${r.url} ${r.action} ${r.views.join(' ')}`).includes(f))
    .sort((a, b) => a.url.localeCompare(b.url));
  return { data: { routes: rows }, text: [`${plural(rows.length, 'action')}:`, ...cut(rows, 200, (r) => `  ${r.url.padEnd(30)} ${r.action.padEnd(40)} ${r.views.join(', ') || '(no view)'}`)].join('\n') };
}
