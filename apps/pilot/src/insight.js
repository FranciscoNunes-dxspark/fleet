// What Pilot can tell about a project beyond its graph: how much of it Pilot understood (doctor),
// which view models the views use and which of their properties they read (models), the text
// written into views rather than through resources (texts), the images (missing, unused, heavy),
// and the project's own style guide: its colours, variables, type, breakpoints and components.
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { design } from './audit.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const at = (file, line) => (line ? `${file}:${line}` : file);
const pct = (n, total) => (total ? `${Math.round((100 * n) / total)}%` : '–');
function cut(list, max, fn, indent = '  ') {
  const lines = list.slice(0, max).map(fn);
  if (list.length > max) lines.push(`${indent}… ${list.length - max} more`);
  return lines;
}
const own = (idx, kind) => [...idx.files.values()].filter((f) => f.kind === kind && !f.vendor && f.data);

// ─── doctor ───────────────────────────────────────────────────────────────────────────────────

/** A problem or dynamic reference reduced to its pattern: names and expressions made alike. */
const pattern = (s) => s.replace(/"[^"]*"/g, '"…"').replace(/\(([^()]|\([^()]*\))*\)/g, '(…)').replace(/<script src="[^"]*">/, '<script src="@…">').replace(/<link href="[^"]*">/, '<link href="@…">').replace(/[A-Z]\w+(Controller)\.\w+/g, '…$1.…');

/** How much of the project Pilot understood, by kind of reference, and the patterns it missed. */
export function doctor(idx) {
  const files = [...idx.files.values()];
  const edges = [...idx.edges.values()].flat();
  const count = (kinds, pred = () => true) => edges.filter((e) => kinds.includes(e.kind) && pred(e)).length;
  const problemsOf = (re) => idx.problems.filter((p) => re.test(p.message)).length;
  const dynamicOf = (re) => files.reduce((n, f) => n + (f.data?.dynamic ?? []).filter((d) => re.test(d.what)).length, 0);
  const calls = files.flatMap((f) => [...(f.data?.calls ?? []), ...(f.data?.inline?.script?.calls ?? [])]);
  const rows = [
    { what: 'partials and templates', found: count(['partial', 'template'], (e) => e.how !== 'guess'), guessed: count(['partial', 'template'], (e) => e.how === 'guess'), missing: problemsOf(/^partial /), dynamic: dynamicOf(/Partial|RenderPage/) },
    { what: 'view components', found: count(['component']), guessed: 0, missing: problemsOf(/^view component/), dynamic: dynamicOf(/^Component\./) },
    { what: 'child actions', found: count(['child-action']), guessed: 0, missing: problemsOf(/^child action/), dynamic: dynamicOf(/Html\.(Render)?Action/) },
    { what: 'layouts', found: count(['layout']), guessed: 0, missing: problemsOf(/^layout /), dynamic: 0 },
    { what: 'views returned by actions', found: count(['renders', 'renders-partial'], (e) => e.how !== 'guess'), guessed: count(['renders', 'renders-partial'], (e) => e.how === 'guess'), missing: problemsOf(/: no view "/), dynamic: problemsOf(/a view chosen at run time/) },
    { what: 'scripts and styles loaded', found: count(['script', 'style'], (e) => e.to && !e.missing), guessed: 0, missing: count(['script', 'style'], (e) => e.missing), dynamic: dynamicOf(/^<(script|link)/) },
    { what: 'imports', found: count(['import']), guessed: 0, missing: problemsOf(/^(import|@import) /), dynamic: 0 },
    { what: 'server requests', found: count(['calls'], (e) => e.via !== 'string'), guessed: 0, missing: problemsOf(/reaches no action/), dynamic: calls.filter((c) => c.dynamic).length },
    { what: 'images', found: count(['image'], (e) => e.to), guessed: 0, missing: count(['image'], (e) => e.missing), dynamic: 0 },
  ].map((r) => ({ ...r, total: r.found + r.guessed + r.missing + r.dynamic }));
  const total = rows.reduce((n, r) => n + r.total, 0);
  const found = rows.reduce((n, r) => n + r.found, 0);
  // What it couldn't follow, grouped by shape, most common first.
  const groups = new Map();
  const add = (key, example) => groups.set(key, { key, count: (groups.get(key)?.count ?? 0) + 1, examples: [...(groups.get(key)?.examples ?? []), example].slice(0, 3) });
  for (const p of idx.problems) add(pattern(p.message.replace(/^[^:]+: /, (m) => (/Controller\./.test(m) ? '' : m))), at(p.file, p.line));
  for (const f of files) for (const d of f.data?.dynamic ?? []) add(`run time: ${pattern(d.what)}`, `${at(f.rel, d.line)} ${d.what}`);
  for (const f of files) for (const c of [...(f.data?.calls ?? []), ...(f.data?.inline?.script?.calls ?? [])]) if (c.dynamic) add(`request to a URL in a variable: ${c.via}(…)`, `${at(f.rel, c.line)} ${c.via}(${c.dynamic})`);
  const patterns = [...groups.values()].sort((a, b) => b.count - a.count);
  // Signs of a structure Pilot only guesses at.
  const hints = [];
  const outside = own(idx, 'view').filter((v) => !/(^|\/)(Views|Pages)\//i.test(v.rel));
  if (outside.length) hints.push(`${plural(outside.length, 'view')} outside Views/ and Pages/ (feature folders?): found by name, as guesses. e.g. ${outside[0].rel}`);
  const csText = own(idx, 'cs').map((f) => f.rel);
  for (const f of csText) {
    let text = '';
    try {
      text = readFileSync(join(idx.root, f), 'utf8');
    } catch {
      continue;
    }
    if (/ViewLocationFormats|IViewLocationExpander|ViewLocationExpanders/.test(text)) hints.push(`Custom view locations in ${f}: Pilot looks in MVC's usual folders, then guesses by name.`);
  }
  if (!idx.controllers.size) hints.push('No controllers found: is this the web project\'s folder (or the solution\'s)?');
  const skipped = files.filter((f) => f.skipped || f.error);
  if (skipped.length) hints.push(`${plural(skipped.length, 'file')} not read (too large or unreadable): ${skipped.slice(0, 3).map((f) => f.rel).join(', ')}`);
  const score = total ? Math.round((100 * found) / total) : 100;
  const lines = [`Pilot followed ${pct(found, total)} of ${total} references in ${plural(files.length, 'file')} (${plural(idx.controllers.size, 'controller')}, ${plural(own(idx, 'view').length, 'view')}).`, ''];
  lines.push(`  ${'what'.padEnd(28)} ${'found'.padStart(6)} ${'guessed'.padStart(8)} ${'missing'.padStart(8)} ${'run time'.padStart(9)}`);
  for (const r of rows) lines.push(`  ${r.what.padEnd(28)} ${String(r.found).padStart(6)} ${String(r.guessed).padStart(8)} ${String(r.missing).padStart(8)} ${String(r.dynamic).padStart(9)}`);
  if (patterns.length) lines.push('', 'What it couldn\'t follow, by pattern (most common first):', ...cut(patterns, 20, (p) => `  ${String(p.count).padStart(4)}  ${p.key}\n        e.g. ${p.examples.join('; ')}`));
  if (hints.length) lines.push('', 'Notes:', ...hints.map((h) => `  ${h}`));
  lines.push('', 'Send this to whoever maintains Pilot: a pattern that recurs is one it can learn.');
  return { data: { score, total, found, rows, patterns, hints }, text: lines.join('\n') };
}

// ─── View models ──────────────────────────────────────────────────────────────────────────────

/** The class a view's @model names: IEnumerable<Shop.OrderRow> → OrderRow. */
export const modelName = (type) => String(type).replace(/^(?:I?Enumerable|I?List|ICollection|IReadOnlyList|PagedList|IPagedList)\s*<\s*(.+)>\s*$/, '$1').replace(/\?$/, '').split('.').pop().replace(/<.*$/, '').trim();

export function models(idx, { filter = '' } = {}) {
  const props = (m, seen = new Set()) => {
    if (!m || seen.has(m.name)) return [];
    seen.add(m.name);
    return [...m.props, ...props(idx.models.get(m.base), seen)];
  };
  const byModel = new Map();
  const untyped = [];
  for (const v of own(idx, 'view')) {
    if (!v.data.model) {
      if (v.data.modelUses?.length) untyped.push(v.rel);
      continue;
    }
    const name = modelName(v.data.model.type);
    if (!byModel.has(name)) byModel.set(name, { name, type: v.data.model.type, views: [] });
    byModel.get(name).views.push({ file: v.rel, line: v.data.model.line, uses: [...new Set((v.data.modelUses ?? []).map(([p]) => p))] });
  }
  const rows = [...byModel.values()]
    .filter((r) => !filter || r.name.toLowerCase().includes(filter.toLowerCase()))
    .map((r) => {
      const cls = idx.models.get(r.name);
      const all = props(cls);
      const used = new Set(r.views.flatMap((v) => v.uses));
      const collection = /Enumerable|List|Collection/.test(r.type);
      return {
        ...r,
        class: cls ? { file: cls.file, line: cls.line } : null,
        properties: all.map((p) => ({ ...p, used: used.has(p.name) })),
        unused: all.filter((p) => !used.has(p.name)).map((p) => p.name),
        // Read in a view but not on the class (nor its bases in the project): a typo, or a base class outside it.
        unknown: cls && !collection ? [...used].filter((u) => !all.some((p) => p.name === u)) : [],
      };
    })
    .sort((a, b) => b.views.length - a.views.length);
  const lines = [`${plural(rows.length, 'view model')} used by views${untyped.length ? `; ${plural(untyped.length, 'view')} read Model without @model` : ''}:`];
  for (const r of rows) {
    lines.push('', `${r.name}${r.class ? `  ${at(r.class.file, r.class.line)}` : '  (class not found in the project)'}  used by ${plural(r.views.length, 'view')}`);
    for (const v of r.views.slice(0, 8)) lines.push(`  ${v.file}: ${v.uses.length ? v.uses.join(', ') : '(no property read)'}`);
    if (r.unused.length) lines.push(`  never read by a view: ${r.unused.join(', ')}`);
    if (r.unknown.length) lines.push(`  read but not on the class: ${r.unknown.join(', ')}`);
  }
  return { data: { models: rows, untyped }, text: lines.join('\n') };
}

// ─── Hard-coded text ──────────────────────────────────────────────────────────────────────────

export function texts(idx, { filter = '' } = {}) {
  const views = own(idx, 'view')
    .filter((v) => !filter || v.rel.toLowerCase().includes(filter.toLowerCase()))
    .map((v) => ({ file: v.rel, texts: (v.data.texts ?? []).map(([text, line, where]) => ({ text, line, where })), localized: v.data.localized ?? 0 }))
    .filter((v) => v.texts.length || v.localized);
  const total = views.reduce((n, v) => n + v.texts.length, 0);
  const localizing = views.filter((v) => v.localized).length;
  const lines = [`${plural(total, 'piece')} of text written into ${plural(views.filter((v) => v.texts.length).length, 'view')}; ${plural(localizing, 'view')} use resources or a localizer.`];
  if (!localizing) lines.push('No view goes through resources: this is the text a translation would need to cover.');
  const sorted = [...views].sort((a, b) => b.texts.length - a.texts.length);
  for (const v of sorted.slice(0, 40)) {
    if (!v.texts.length) continue;
    lines.push('', `${v.file} (${v.texts.length}${v.localized ? `, ${v.localized} localized` : ''}):`, ...cut(v.texts, 6, (t) => `  line ${t.line}${t.where !== 'text' ? ` [${t.where}]` : ''}: ${t.text}`));
  }
  return { data: { total, localizing, views: sorted }, text: lines.join('\n') };
}

// ─── Images ───────────────────────────────────────────────────────────────────────────────────

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function images(idx, { large = 200 * 1024 } = {}) {
  const all = [...idx.files.values()].filter((f) => f.kind === 'image');
  const missing = [...idx.edges.values()].flat().filter((e) => e.kind === 'image' && e.missing).map((e) => ({ file: e.from, line: e.line, url: e.url }));
  const unused = all.filter((f) => !f.vendor && !idx.in(f.rel).some((e) => e.kind === 'image') && !/favicon|apple-touch|mstile|android-chrome/i.test(f.rel)).map((f) => ({ file: f.rel, bytes: f.size }));
  const heavy = all.filter((f) => f.size >= large).sort((a, b) => b.size - a.size).map((f) => ({ file: f.rel, bytes: f.size, uses: idx.in(f.rel).filter((e) => e.kind === 'image').length }));
  const lines = [`${plural(all.length, 'image')}: ${missing.length} references to missing ones, ${unused.length} nothing in the views or styles uses, ${heavy.length} over ${kb(large)}.`];
  if (missing.length) lines.push('', 'Referenced but not in the project:', ...cut(missing, 40, (m) => `  ${at(m.file, m.line)}  ${m.url}`));
  if (heavy.length) lines.push('', 'Heavy (compress, resize, or serve WebP/AVIF):', ...cut(heavy, 30, (h) => `  ${kb(h.bytes).padStart(8)}  ${h.file}${h.uses ? '' : '  (unused?)'}`));
  if (unused.length) lines.push('', 'Not used by any view or stylesheet (a script or the database may still name them):', ...cut(unused, 40, (u) => `  ${u.file} (${kb(u.bytes)})`));
  return { data: { count: all.length, missing, unused, heavy }, text: lines.join('\n') };
}

// ─── Style guide ──────────────────────────────────────────────────────────────────────────────

const GENERIC = new Set(['is', 'has', 'js', 'no', 'col', 'row', 'text', 'bg', 'pull', 'clearfix', 'active', 'disabled', 'open', 'show', 'hide', 'hidden', 'fade', 'in']);

/** The project's own design system, as its stylesheets and views have it. */
export function styleguide(idx) {
  const d = design(idx).data;
  const kindOf = (value) => (/^#|rgba?\(|hsla?\(|^(darken|lighten|fade|mix|tint|shade|saturate|desaturate|spin)\(/i.test(value) ? 'colour' : /\b(px|rem|em|%|vh|vw)\b|^\d/.test(value) ? 'size' : /sans|serif|mono|font|"|'/i.test(value) ? 'font' : 'other');
  const variables = [];
  for (const [name, uses] of idx.symbols.vars) {
    const def = uses.find((u) => u.role === 'def');
    if (!def || name.startsWith('--') === false && !/^[@$]/.test(name)) continue;
    variables.push({ name, value: def.value, kind: kindOf(def.value ?? ''), uses: uses.filter((u) => u.role === 'use').length, at: at(def.file, def.line) });
  }
  variables.sort((a, b) => b.uses - a.uses);
  const fonts = new Map();
  const sizes = new Map();
  for (const f of own(idx, 'style')) {
    if (idx.sourcesOf(f.rel).some((s) => s.how !== 'minified' && s.how !== 'bundleconfig.json')) continue;
    for (const [v] of f.data.fonts ?? []) fonts.set(v, (fonts.get(v) ?? 0) + 1);
    for (const [v] of f.data.fontSizes ?? []) sizes.set(v, (sizes.get(v) ?? 0) + 1);
  }
  // Components: families of classes (.btn, .btn-save, .btn-primary) styled and used, with an example of their markup.
  const families = new Map();
  for (const [cls, uses] of idx.symbols.classes) {
    const styled = uses.some((u) => u.role === 'style' && !u.vendor);
    const marked = uses.filter((u) => u.role === 'markup');
    if (!styled || !marked.length) continue;
    const prefix = cls.toLowerCase().split(/[-_]/)[0];
    if (prefix.length < 3 || GENERIC.has(prefix)) continue;
    if (!families.has(prefix)) families.set(prefix, { name: prefix, classes: [], uses: 0, example: null });
    const fam = families.get(prefix);
    fam.classes.push(cls);
    fam.uses += marked.length;
    fam.example ??= marked[0];
  }
  const snippet = (u) => {
    try {
      const lines = readFileSync(join(idx.root, u.file), 'utf8').split('\n');
      return lines.slice(u.line - 1, u.line + 3).join('\n').trim();
    } catch {
      return '';
    }
  };
  const components = [...families.values()]
    .filter((f) => f.classes.length >= 2 || f.uses >= 3)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 40)
    .map((f) => ({ ...f, classes: f.classes.sort(), example: f.example ? { file: f.example.file, line: f.example.line, markup: snippet(f.example) } : null }));
  const widgetKinds = new Map();
  for (const w of idx.symbols.widgets) widgetKinds.set(`${w.kind}|${w.lib}`, (widgetKinds.get(`${w.kind}|${w.lib}`) ?? 0) + 1);
  const data = {
    colours: variables.filter((v) => v.kind === 'colour'),
    sizes: variables.filter((v) => v.kind === 'size'),
    otherVariables: variables.filter((v) => v.kind === 'font' || v.kind === 'other'),
    literalColours: Object.entries(d.colors).filter(([c]) => !d.variables[c]).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([value, uses]) => ({ value, uses })),
    fonts: [...fonts].sort((a, b) => b[1] - a[1]).map(([value, uses]) => ({ value, uses })),
    fontSizes: [...sizes].sort((a, b) => b[1] - a[1]).map(([value, uses]) => ({ value, uses })),
    breakpoints: d.breakpoints,
    components,
    widgets: [...widgetKinds].map(([k, n]) => ({ kind: k.split('|')[0], lib: k.split('|')[1], count: n })).sort((a, b) => b.count - a.count),
  };
  const lines = ['The project\'s style guide, as its stylesheets and views have it. Reuse these before adding new values.'];
  if (data.colours.length) lines.push('', 'Colour variables:', ...cut(data.colours, 30, (v) => `  ${v.name.padEnd(24)} ${String(v.value).padEnd(22)} ${plural(v.uses, 'use')}`));
  if (data.literalColours.length) lines.push('', 'Colours written out (no variable):', ...cut(data.literalColours, 12, (c) => `  ${c.value.padEnd(24)} ${plural(c.uses, 'use')}`));
  if (data.sizes.length) lines.push('', 'Size variables:', ...cut(data.sizes, 25, (v) => `  ${v.name.padEnd(24)} ${String(v.value).padEnd(22)} ${plural(v.uses, 'use')}`));
  if (data.fonts.length) lines.push('', 'Fonts:', ...cut(data.fonts, 10, (f) => `  ${f.value}  (${f.uses})`));
  if (data.fontSizes.length) lines.push('', `Font sizes: ${data.fontSizes.slice(0, 20).map((f) => `${f.value} (${f.uses})`).join(', ')}`);
  if (data.breakpoints.length) lines.push('', `Breakpoints: ${data.breakpoints.map((b) => `${b.query} (${b.places.length})`).join(', ')}`);
  if (components.length) lines.push('', 'Components (class families styled and used), with an example:', ...cut(components, 25, (c) => `  .${c.name}: ${c.classes.slice(0, 8).map((x) => `.${x}`).join(' ')}  (${plural(c.uses, 'use')})${c.example ? `\n      e.g. ${at(c.example.file, c.example.line)}: ${c.example.markup.split('\n')[0].slice(0, 100)}` : ''}`));
  if (data.widgets.length) lines.push('', `UI libraries: ${data.widgets.map((w) => `${w.kind} (${w.lib}) ×${w.count}`).join(', ')}`);
  return { data, text: lines.join('\n') };
}
