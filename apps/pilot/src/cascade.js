// `pilot cascade <page> <selector>`: every rule that can style a class or id on a page, in the order
// the browser applies them (stylesheets as the page loads them, each with its LESS imports inlined
// where they're imported), with each rule's specificity, its declarations, and which value wins for
// each property if every rule matches the element. Rules in stylesheets the page doesn't load are
// listed apart: the usual reason a change "doesn't show".
import { pageModel } from './analysis.js';
import { actionLabel, resolveTarget, urlOf } from './queries.js';
import { selectorTokens } from './parse/script.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** A selector's specificity as [ids, classes/attributes/pseudo-classes, elements/pseudo-elements]. */
export function specificity(selector) {
  let s = ` ${selector} `.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, ' ');
  s = s.replace(/:(?:not|is|has|matches)\(/g, ' ').replace(/\)/g, ' ');
  let c = 0;
  s = s.replace(/::[\w-]+|:(?:before|after|first-line|first-letter)\b/g, () => {
    c++;
    return ' ';
  });
  const a = (s.match(/#-?[A-Za-z_][\w-]*/g) ?? []).length;
  const b = (s.match(/\.-?[A-Za-z_][\w-]*|\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?/g) ?? []).length;
  c += (s.replace(/\[[^\]]*\]/g, ' ').match(/(?:^|[\s>+~,(])(?:[a-zA-Z][\w-]*)/g) ?? []).length;
  return [a, b, c];
}
const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

/** The rules of a stylesheet and what it imports, in the order they reach the browser. */
function orderedRules(idx, file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const f = idx.files.get(file);
  if (!f?.data?.rules) return [];
  const events = [
    ...f.data.rules.map((rule) => ({ line: rule.line, rule })),
    ...idx.out(file).filter((e) => e.kind === 'import' && e.to && !/reference/.test(e.options ?? '')).map((e) => ({ line: e.line, import: e.to })),
  ].sort((a, b) => a.line - b.line);
  return events.flatMap((ev) => (ev.import ? orderedRules(idx, ev.import, seen).map((r) => ({ ...r, via: [file, ...(r.via ?? [])] })) : [{ file, rule: ev.rule }]));
}

export function cascade(idx, target, sel) {
  const s = String(sel ?? '').trim();
  const t = /^([.#])?(-?[A-Za-z_][\w-]*)$/.exec(s);
  if (!t) return { data: { error: 'usage' }, text: 'cascade needs a page and a class or id: pilot cascade /Orders .btn-save' };
  const kind = t[1] === '#' ? 'ids' : 'classes';
  const name = t[2];
  const shown = `${t[1] ?? '.'}${name}`;
  const r = resolveTarget(idx, target);
  const view = r.files.find((f) => idx.files.get(f)?.kind === 'view') ?? (r.actions[0] && idx.out(r.actions[0]).find((e) => e.kind.startsWith('renders'))?.to);
  if (!view) return { data: { error: 'not found' }, text: `"${target}" isn't a page Pilot knows.` };
  const model = pageModel(idx, view);
  const page = r.actions[0] ? `${urlOf(idx, r.actions[0])} (${actionLabel(idx, r.actions[0])})` : view;

  // The page's stylesheets in load order, each expanded into its imports.
  const ordered = [];
  const loaded = new Set();
  for (const a of model.tree.assets.filter((x) => x.kind === 'style' && !x.external && !x.missing)) {
    for (const src of a.sources?.length ? a.sources : [a.file]) {
      if (loaded.has(src)) continue;
      for (const item of orderedRules(idx, src)) {
        loaded.add(item.file);
        ordered.push({ ...item, sheet: src, bundle: a.bundle ?? null });
      }
      loaded.add(src);
    }
  }
  // Inline <style> blocks of the page's views come after the stylesheets in the head.
  for (const v of model.views) for (const rule of idx.files.get(v.file)?.data?.inline.style?.rules ?? []) ordered.push({ file: v.file, rule, sheet: `${v.file} <style>`, inline: true });

  const matches = (rule) => rule.selector.split(/,\s*/).filter((x) => selectorTokens(x)[kind].includes(name));
  const rows = [];
  ordered.forEach((item, order) => {
    const sels = matches(item.rule);
    if (!sels.length) return;
    const spec = sels.map(specificity).sort(cmp).at(-1);
    const exact = sels.some((x) => x.trim() === shown);
    rows.push({ order, file: item.file, line: item.rule.line, selector: sels.join(', '), specificity: spec, media: item.rule.media ?? null, props: item.rule.props ?? [], via: item.via ?? [], sheet: item.sheet, conditional: !exact || !!item.rule.media });
  });

  // Each property's winner, if every rule applies: !important first, then specificity, then order.
  const winners = new Map();
  for (const row of rows) {
    for (const p of row.props) {
      const cand = { row, p };
      const best = winners.get(p.p);
      const beats = !best || (p.i ? 1 : 0) - (best.p.i ? 1 : 0) > 0 || ((p.i ? 1 : 0) === (best.p.i ? 1 : 0) && (cmp(row.specificity, best.row.specificity) > 0 || (cmp(row.specificity, best.row.specificity) === 0 && row.order > best.row.order)));
      if (beats) winners.set(p.p, cand);
    }
  }
  // Rules for it in stylesheets this page never loads.
  const elsewhere = (idx.symbols[kind].get(name) ?? []).filter((u) => u.role === 'style' && !u.vendor && !loaded.has(u.file) && !model.views.some((v) => v.file === u.file));

  const spec = (x) => `(${x.join(',')})`;
  const lines = [`${shown} on ${page}: ${plural(rows.length, 'rule')} in the order the browser applies them${rows.length ? '' : ' (none in the stylesheets it loads)'}:`];
  rows.forEach((row, i) => {
    const via = row.via.length ? `  via ${[...row.via, row.file].map((f) => f.split('/').pop()).join(' → ')}` : '';
    lines.push(`  ${i + 1}. ${row.file}:${row.line}  ${row.selector}  ${spec(row.specificity)}${row.media ? `  ${row.media}` : ''}${via}`);
    for (const p of row.props) {
      const w = winners.get(p.p);
      const won = w.row === row && w.p === p;
      lines.push(`       ${p.p}: ${p.v}${p.i ? ' !important' : ''}${won ? '' : `   ← overridden by ${w.row.file.split('/').pop()}:${w.p.l}`}`);
    }
  });
  if (winners.size) {
    lines.push('', 'What wins, if every rule applies to the element:');
    for (const [prop, w] of [...winners].sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`  ${prop}: ${w.p.v}${w.p.i ? ' !important' : ''}  (${w.row.file}:${w.p.l}${w.row.conditional ? `, only ${w.row.media ? w.row.media : `for ${w.row.selector}`}` : ''})`);
  }
  if (elsewhere.length) lines.push('', `Not loaded on this page (a change there won't show here):`, ...elsewhere.slice(0, 20).map((u) => `  ${u.file}:${u.line}  ${u.selector ?? ''}`));
  const sheets = [...new Set(ordered.map((o) => o.sheet))];
  lines.push('', `The page's stylesheets, in order: ${sheets.join(', ') || 'none found'}.`);
  return { data: { page, selector: shown, rules: rows, winners: Object.fromEntries([...winners].map(([k, w]) => [k, { value: w.p.v, important: !!w.p.i, file: w.row.file, line: w.p.l }])), elsewhere, sheets }, text: lines.join('\n') };
}
