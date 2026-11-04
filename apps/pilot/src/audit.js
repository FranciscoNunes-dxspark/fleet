// The project's housekeeping, read from the index: what nothing uses (dead code), where the styles
// drift from their own design system (colours that have a variable, near-identical colours,
// breakpoints, z-index, !important, inline styles), markup repeated across views that could be one
// partial, accessibility problems the markup alone shows, and what each page loads and weighs.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { actionLabel, urlOf } from './queries.js';
import { pageModel } from './analysis.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const at = (file, line) => (line ? `${file}:${line}` : file);
function cut(list, max, fn, indent = '  ') {
  const lines = list.slice(0, max).map(fn);
  if (list.length > max) lines.push(`${indent}… ${list.length - max} more`);
  return lines;
}
const own = (idx, kind) => [...idx.files.values()].filter((f) => f.kind === kind && !f.vendor && f.data);
const isTest = (rel) => /(^|\/)(tests?|specs?|__tests__)\/|\.(spec|test)\.[jt]sx?$/i.test(rel);

// ─── Dead code ────────────────────────────────────────────────────────────────────────────────

/** Whether anything that is itself used loads, imports or renders `rel` (built files followed to their source). */
function used(idx, rel, seen = new Set()) {
  if (seen.has(rel)) return false;
  seen.add(rel);
  for (const e of idx.in(rel)) {
    if (['script', 'style', 'import', 'partial', 'template', 'component', 'layout', 'renders', 'renders-partial'].includes(e.kind)) return true;
    if (e.kind === 'source' && (used(idx, e.from, seen) || idx.bundleOutputs.has(e.from.toLowerCase()))) return true;
  }
  return false;
}

export function deadCode(idx) {
  const views = [];
  for (const f of own(idx, 'view')) {
    if (/(^|\/)_View(Start|Imports)\.cshtml$/i.test(f.rel) || /(^|\/)Pages\//i.test(f.rel)) continue;
    if (used(idx, f.rel)) continue;
    // Templates are found by the model's type (EditorFor(m => m.Date)), which Pilot can't see.
    const maybe = /\/(EditorTemplates|DisplayTemplates)\//i.test(f.rel) ? 'a template, used by type' : f.data.renderBody ? 'a layout no view uses' : null;
    views.push({ file: f.rel, lines: f.lines, maybe });
  }
  const files = (kind) => own(idx, kind)
    .filter((f) => !isTest(f.rel) && !used(idx, f.rel))
    // A file only compiled into another (site.css from site.less) is used when that one is.
    .filter((f) => !(idx.outputs.get(f.rel) ?? []).some((o) => idx.exists(o) && used(idx, idx.exists(o))))
    .map((f) => ({ file: f.rel, lines: f.lines }));
  const scripts = files('script');
  const styles = files('style').filter((s) => !idx.in(s.file).some((e) => e.kind === 'import'));
  const unusedSymbols = (map) => [...map].filter(([, uses]) => uses.some((u) => u.role === 'def') && !uses.some((u) => u.role === 'use')).map(([name, uses]) => ({ name, at: uses.filter((u) => u.role === 'def').map((u) => at(u.file, u.line)) }));
  const vars = unusedSymbols(idx.symbols.vars).filter((v) => !v.name.startsWith('--'));
  const mixins = unusedSymbols(idx.symbols.mixins);
  const classes = [...idx.symbols.classes]
    .filter(([, uses]) => uses.some((u) => u.role === 'style' && !u.vendor) && !uses.some((u) => u.role === 'markup' || u.role === 'script'))
    .map(([name, uses]) => ({ name, at: uses.filter((u) => u.role === 'style' && !u.vendor).map((u) => at(u.file, u.line)) }));
  const lines = [
    `Nothing Pilot can see uses: ${plural(views.length, 'view')}, ${plural(scripts.length, 'script')}, ${plural(styles.length, 'stylesheet')}, ${plural(vars.length, 'variable')}, ${plural(mixins.length, 'mixin')}, ${plural(classes.length, 'styled class', 'styled classes')}.`,
    'Check before deleting: a name built at run time, a view returned by View(name) or a file loaded from outside the project isn\'t seen.',
  ];
  if (views.length) lines.push('', 'Views no action returns and no view renders:', ...cut(views, 60, (v) => `  ${v.file} (${v.lines ?? '?'} lines)${v.maybe ? `  maybe used: ${v.maybe}` : ''}`));
  if (scripts.length) lines.push('', 'Scripts nothing loads or imports:', ...cut(scripts, 40, (s) => `  ${s.file} (${s.lines ?? '?'} lines)`));
  if (styles.length) lines.push('', 'Stylesheets nothing loads or imports:', ...cut(styles, 40, (s) => `  ${s.file} (${s.lines ?? '?'} lines)`));
  if (vars.length) lines.push('', 'Variables defined and never used:', ...cut(vars, 40, (v) => `  ${v.name}  ${v.at.join(', ')}`));
  if (mixins.length) lines.push('', 'Mixins defined and never used:', ...cut(mixins, 40, (m) => `  .${m.name}  ${m.at.join(', ')}`));
  if (classes.length) lines.push('', 'Classes styled but used by no view or script:', ...cut(classes, 60, (c) => `  .${c.name}  ${c.at.slice(0, 3).join(', ')}`));
  return { data: { views, scripts, styles, vars, mixins, classes }, text: lines.join('\n') };
}

// ─── Design consistency ───────────────────────────────────────────────────────────────────────

/** A colour as #rrggbb (or #rrggbbaa), or its rgb()/hsl() text tidied; null if it isn't one. */
export function normalizeColor(c) {
  const s = String(c).trim().toLowerCase();
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) return `#${[...m[1]].map((x) => x + x).join('')}`.replace(/^(#[0-9a-f]{6})ff$/, '$1');
  m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) return s.replace(/^(#[0-9a-f]{6})ff$/, '$1');
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*(1|1\.0+))?\s*\)$/.exec(s);
  if (m) return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  return /^(rgba?|hsla?)\(/.test(s) ? s.replace(/\s+/g, '') : null;
}
const rgb = (hex) => (/^#[0-9a-f]{6}$/.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);

export function design(idx) {
  // What people write: a built .css says again what its .less says.
  const styles = own(idx, 'style').filter((f) => !idx.sourcesOf(f.rel).some((s) => s.how !== 'minified' && s.how !== 'bundleconfig.json'));
  // Variables holding a colour: literal uses of that colour could name the variable.
  const varOf = new Map();
  for (const f of styles) for (const v of f.data.vars) {
    const c = normalizeColor(v.value.replace(/\s*!default\s*$/, ''));
    if (c) varOf.set(c, [...(varOf.get(c) ?? []), v.name]);
  }
  const colorUses = new Map();
  for (const f of styles) for (const [c, line, prop] of f.data.colors ?? []) {
    const n = normalizeColor(c);
    if (!n) continue;
    if (!colorUses.has(n)) colorUses.set(n, []);
    colorUses.get(n).push({ file: f.rel, line, prop });
  }
  const useVariable = [...colorUses].filter(([c]) => varOf.has(c)).map(([color, uses]) => ({ color, variables: varOf.get(color), uses })).sort((a, b) => b.uses.length - a.uses.length);
  // Colours that look alike: less than 3% apart in RGB, each a candidate to merge into one.
  const hexes = [...new Set([...colorUses.keys(), ...varOf.keys()])].filter((c) => rgb(c));
  const near = [];
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) {
      const [a, b] = [rgb(hexes[i]), rgb(hexes[j])];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d > 0 && d < 13) near.push({ a: hexes[i], b: hexes[j], distance: Math.round(d), uses: (colorUses.get(hexes[i])?.length ?? 0) + (colorUses.get(hexes[j])?.length ?? 0) });
    }
  }
  near.sort((x, y) => x.distance - y.distance || y.uses - x.uses);
  const breakpoints = new Map();
  for (const f of styles) for (const [prelude, line] of f.data.media ?? []) {
    for (const m of prelude.matchAll(/(min|max)-width\s*:\s*([\d.]+)(px|em|rem)/g)) {
      const key = `${m[1]}-width ${m[2]}${m[3]}`;
      breakpoints.set(key, [...(breakpoints.get(key) ?? []), at(f.rel, line)]);
    }
    for (const m of prelude.matchAll(/(min|max)-width\s*:\s*(@[\w-]+|\$[\w-]+)/g)) {
      const key = `${m[1]}-width ${m[2]}`;
      breakpoints.set(key, [...(breakpoints.get(key) ?? []), at(f.rel, line)]);
    }
  }
  const bp = [...breakpoints].map(([query, places]) => ({ query, places })).sort((a, b) => b.places.length - a.places.length);
  const zindex = new Map();
  for (const f of styles) for (const [v, line] of f.data.zindex ?? []) zindex.set(v, [...(zindex.get(v) ?? []), at(f.rel, line)]);
  const z = [...zindex].map(([value, places]) => ({ value, places })).sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
  const important = styles.map((f) => ({ file: f.rel, count: (f.data.important ?? []).length })).filter((x) => x.count).sort((a, b) => b.count - a.count);
  const inline = own(idx, 'view').map((f) => ({ file: f.rel, places: f.data.inlineStyles ?? [] })).filter((x) => x.places.length).sort((a, b) => b.places.length - a.places.length);

  const lines = [`${plural(colorUses.size, 'distinct colour')} written out in stylesheets, ${plural(varOf.size, 'colour variable')}; ${plural(bp.length, 'breakpoint')}, ${plural(z.length, 'z-index value')}, ${important.reduce((n, x) => n + x.count, 0)} !important, ${inline.reduce((n, x) => n + x.places.length, 0)} inline styles in views.`];
  if (useVariable.length) lines.push('', 'Colours written out that a variable already holds (use the variable):', ...cut(useVariable, 25, (u) => `  ${u.color} → ${u.variables.join(' / ')}  (${plural(u.uses.length, 'place')}: ${u.uses.slice(0, 3).map((x) => at(x.file, x.line)).join(', ')}${u.uses.length > 3 ? ' …' : ''})`));
  if (near.length) lines.push('', 'Colours that look the same (merge into one):', ...cut(near, 20, (n) => `  ${n.a} ≈ ${n.b}  (${n.uses} uses)${varOf.has(n.a) || varOf.has(n.b) ? `  variable: ${[...(varOf.get(n.a) ?? []), ...(varOf.get(n.b) ?? [])].join(', ')}` : ''}`));
  const top = [...colorUses].sort((a, b) => b[1].length - a[1].length).filter(([c]) => !varOf.has(c));
  if (top.length) lines.push('', 'Most used colours without a variable:', ...cut(top, 12, ([c, uses]) => `  ${c}  ${plural(uses.length, 'use')}`));
  if (bp.length) lines.push('', 'Breakpoints (@media widths): few and named is the aim:', ...cut(bp, 25, (b) => `  ${b.query.padEnd(24)} ${plural(b.places.length, 'place')}${b.places.length === 1 ? `  ${b.places[0]}` : ''}`));
  if (z.length) lines.push('', 'z-index values, highest first:', ...cut(z, 25, (x) => `  ${String(x.value).padEnd(8)} ${x.places.slice(0, 3).join(', ')}${x.places.length > 3 ? ` +${x.places.length - 3}` : ''}`));
  if (important.length) lines.push('', '!important by file:', ...cut(important, 15, (x) => `  ${String(x.count).padStart(4)}  ${x.file}`));
  if (inline.length) lines.push('', 'Inline style="…" in views:', ...cut(inline, 20, (x) => `  ${String(x.places.length).padStart(4)}  ${x.file}  e.g. line ${x.places[0][0]}: ${x.places[0][1]}`));
  return { data: { useVariable, near, colors: Object.fromEntries([...colorUses].map(([c, u]) => [c, u.length])), variables: Object.fromEntries(varOf), breakpoints: bp, zindex: z, important, inline }, text: lines.join('\n') };
}

// ─── Repeated markup ──────────────────────────────────────────────────────────────────────────

/** A markup line reduced to its shape: Razor expressions and text between tags made alike. */
function shape(line) {
  return line
    .trim()
    .replace(/@\((?:[^()]|\([^()]*\))*\)|@[\w.]+(?:\((?:[^()]|\([^()]*\))*\))?/g, '@x')
    .replace(/>([^<>@]+)</g, '>t<')
    .replace(/\s+/g, ' ');
}

/** Blocks of `min` or more lines of markup shaped alike in two or more views: candidates for one partial. */
export function repeats(idx, { min = 6 } = {}) {
  const windows = new Map();
  for (const f of own(idx, 'view')) {
    let text;
    try {
      text = readFileSync(join(idx.root, f.rel), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').map((l, i) => ({ s: shape(l), n: i + 1 })).filter((l) => l.s && !/^[{}]$|^@\{$|^<\/\w+>$/.test(l.s));
    for (let i = 0; i + min <= lines.length; i++) {
      const win = lines.slice(i, i + min);
      // Only windows that are mostly markup, and not trivially short.
      if (win.filter((l) => l.s.includes('<')).length < min / 2 || win.reduce((n, l) => n + l.s.length, 0) < min * 12) continue;
      const key = win.map((l) => l.s).join('\n');
      if (!windows.has(key)) windows.set(key, []);
      windows.get(key).push({ file: f.rel, start: win[0].n, end: win[win.length - 1].n });
    }
  }
  // Windows shared by the same views join into blocks.
  const clusters = new Map();
  for (const [key, occ] of windows) {
    const files = [...new Set(occ.map((o) => o.file))];
    if (files.length < 2) continue;
    const id = files.sort().join('|');
    if (!clusters.has(id)) clusters.set(id, { files, ranges: new Map(), sample: key });
    const c = clusters.get(id);
    for (const o of occ) c.ranges.set(o.file, [...(c.ranges.get(o.file) ?? []), [o.start, o.end]]);
  }
  const found = [...clusters.values()].map((c) => {
    const ranges = [...c.ranges].map(([file, rs]) => {
      const merged = [];
      for (const r of rs.sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
      }
      return { file, ranges: merged };
    });
    const size = Math.max(...ranges.map((r) => Math.max(...r.ranges.map(([a, b]) => b - a + 1))));
    const cls = /class="([\w-]+)/.exec(c.sample)?.[1];
    const name = cls ? `_${cls.replace(/(^|[-_])(\w)/g, (_, __, ch) => ch.toUpperCase())}` : '_Shared';
    return { files: c.files.length, lines: size, places: ranges, partial: name, sample: c.sample.split('\n').slice(0, 4).join('\n') };
  }).sort((a, b) => b.lines * b.files - a.lines * a.files);
  const lines = [`${plural(found.length, 'block')} of markup repeated across views (${min}+ lines shaped alike):`];
  for (const r of found.slice(0, 30)) {
    lines.push('', `  ~${r.lines} lines in ${r.files} views: could be a partial like ${r.partial}.cshtml`);
    for (const p of r.places.slice(0, 6)) lines.push(`    ${p.file}:${p.ranges.map(([a, b]) => `${a}-${b}`).join(', ')}`);
    if (r.places.length > 6) lines.push(`    … ${r.places.length - 6} more views`);
  }
  if (found.length > 30) lines.push('', `  … ${found.length - 30} more`);
  return { data: { min, blocks: found }, text: lines.join('\n') };
}

// ─── Accessibility ────────────────────────────────────────────────────────────────────────────

export const A11Y_RULES = {
  'img-alt': 'Images need alt text (alt="" for decoration).',
  'input-label': 'Form fields need a label: <label for>, asp-for, aria-label or aria-labelledby.',
  'empty-button': 'Buttons need text or an aria-label (an icon alone says nothing).',
  'empty-link': 'Links need text or an aria-label.',
  'click-no-keyboard': 'A clickable element that isn\'t a button or link needs role="button" and tabindex="0" (or be a <button>).',
  'tabindex-positive': 'A tabindex above 0 breaks the natural tab order.',
  'html-lang': 'The <html> element needs a lang attribute.',
  'duplicate-id': 'An id must be unique in the page.',
};

export function a11y(idx, { rule = '' } = {}) {
  const issues = [];
  for (const f of own(idx, 'view')) {
    // An editor template's field is labelled by the view using it (LabelFor beside EditorFor).
    const template = /\/EditorTemplates\//i.test(f.rel);
    for (const x of f.data.a11y ?? []) if ((!rule || x.rule === rule) && !(template && x.rule === 'input-label')) issues.push({ ...x, file: f.rel });
  }
  const byRule = new Map();
  for (const x of issues) byRule.set(x.rule, [...(byRule.get(x.rule) ?? []), x]);
  const byFile = new Map();
  for (const x of issues) byFile.set(x.file, (byFile.get(x.file) ?? 0) + 1);
  const lines = [`${plural(issues.length, 'accessibility problem')} the markup shows, in ${plural(byFile.size, 'view')} (a static read: check a page in a browser with Lantern or axe too):`];
  for (const [r, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
    lines.push('', `${r} (${list.length}): ${A11Y_RULES[r] ?? ''}`, ...cut(list, rule ? 200 : 8, (x) => `  ${at(x.file, x.line)}  ${x.what}`));
  }
  if (byFile.size) lines.push('', 'Views with the most:', ...cut([...byFile].sort((a, b) => b[1] - a[1]), 10, ([f, n]) => `  ${String(n).padStart(4)}  ${f}`));
  return { data: { issues, rules: A11Y_RULES }, text: lines.join('\n') };
}

// ─── Page weight ──────────────────────────────────────────────────────────────────────────────

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
/** A library's name without its version or .min: jquery-3.4.1.min.js → jquery. */
const libName = (file) => posix.basename(file).toLowerCase().replace(/\.(min\.)?(js|css)$/, '').replace(/[-.@]?v?\d+(\.\d+)*(-[\w.]+)?$/, '').replace(/\.(min|bundle|slim)$/, '');

/** What a page loads, in bytes as the files are on disk (built files where they exist, else their sources). */
export function pageWeight(idx, view) {
  const model = pageModel(idx, view);
  const items = [];
  for (const a of model.tree.assets) {
    if (a.external) {
      items.push({ kind: a.kind, url: a.url, external: true, bytes: 0 });
      continue;
    }
    if (a.missing) continue;
    const built = idx.files.get(a.file);
    const sources = (a.sources ?? []).map((s) => idx.files.get(s)).filter(Boolean);
    const bytes = built ? built.size : sources.reduce((n, s) => n + s.size, 0);
    items.push({ kind: a.kind, file: a.file, bytes, estimate: !built, vendor: a.vendor, own: a.own });
  }
  const seen = new Map();
  const duplicates = [];
  for (const it of items.filter((x) => x.file)) {
    const key = `${it.kind}:${libName(it.file)}`;
    if (seen.has(key)) duplicates.push({ name: libName(it.file), files: seen.get(key) === it.file ? [it.file] : [seen.get(key), it.file] });
    else seen.set(key, it.file);
  }
  const sum = (k) => items.filter((x) => x.kind === k).reduce((n, x) => n + x.bytes, 0);
  return { items, scripts: sum('script'), styles: sum('style'), total: sum('script') + sum('style'), external: items.filter((x) => x.external).length, duplicates };
}

export function weight(idx, { filter = '', limit = 40 } = {}) {
  const rows = [];
  const loads = new Map();
  for (const n of idx.nodes.values()) {
    if (n.kind !== 'action' || n.action.childOnly || n.controller.api) continue;
    for (const r of idx.out(n.id).filter((e) => e.kind === 'renders')) {
      const url = urlOf(idx, n.id);
      if (filter && !`${url} ${r.to}`.toLowerCase().includes(filter.toLowerCase())) continue;
      const w = pageWeight(idx, r.to);
      rows.push({ url, label: actionLabel(idx, n.id), view: r.to, ...w });
      for (const it of w.items.filter((x) => x.file)) loads.set(it.file, { bytes: it.bytes, pages: (loads.get(it.file)?.pages ?? 0) + 1, kind: it.kind });
    }
  }
  rows.sort((a, b) => b.total - a.total);
  const heaviest = [...loads].sort((a, b) => b[1].bytes - a[1].bytes);
  const dup = rows.filter((r) => r.duplicates.length);
  const lines = [`What ${plural(rows.length, 'page')} load, as the files are on disk (before gzip; ~ where only the sources exist):`];
  lines.push(...cut(rows, limit, (r) => `  ${kb(r.total).padStart(8)}  ${(r.url ?? '').padEnd(28)} scripts ${kb(r.scripts)}, styles ${kb(r.styles)}${r.items.some((x) => x.estimate) ? ' ~' : ''}${r.external ? `, +${r.external} external` : ''}${r.duplicates.length ? `  DUPLICATE ${r.duplicates.map((d) => d.name).join(', ')}` : ''}`));
  if (dup.length) lines.push('', 'The same library loaded twice on a page:', ...cut(dup, 20, (r) => `  ${r.url}: ${r.duplicates.map((d) => `${d.name} (${d.files.length === 1 ? `${d.files[0]}, twice` : d.files.join(' and ')})`).join('; ')}`));
  if (heaviest.length) lines.push('', 'Heaviest files, and how many pages load them:', ...cut(heaviest, 15, ([f, x]) => `  ${kb(x.bytes).padStart(8)}  ${f}  (${plural(x.pages, 'page')})`));
  return { data: { pages: rows.map(({ items, ...r }) => ({ ...r, items })), files: heaviest.map(([file, x]) => ({ file, ...x })) }, text: lines.join('\n') };
}
