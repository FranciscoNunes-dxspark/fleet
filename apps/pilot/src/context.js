// `pilot context <page>`: the code that matters for one page, gathered in priority order into one
// Markdown document that fits a budget, so Claude reads what it needs and nothing else: the view and
// the partials it renders whole, the controller actions (the page's and those its requests reach),
// the parts of its scripts that touch its markup or call the server, the CSS rules for the classes
// it uses, and its layouts last. What doesn't fit is listed by name.
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { matchBrace } from './text.js';
import { pageModel } from './analysis.js';
import { actionLabel, resolveTarget, urlOf } from './queries.js';

const LANG = { '.cshtml': 'cshtml', '.cs': 'csharp', '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.less': 'less', '.scss': 'scss', '.css': 'css' };

/** [start, end] ranges merged where they overlap or nearly touch. */
export function mergeRanges(ranges, gap = 2) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + gap) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** The lines of an action's method: from its line to the end of its body. */
export function methodRange(lines, line) {
  const text = lines.join('\n');
  let offset = 0;
  for (let i = 1; i < line; i++) offset += lines[i - 1].length + 1;
  const brace = text.indexOf('{', offset);
  const arrow = text.indexOf('=>', offset);
  const semi = text.indexOf(';', offset);
  let end;
  if (arrow !== -1 && (brace === -1 || arrow < brace) && semi !== -1) end = semi;
  else if (brace !== -1) end = matchBrace(text, brace);
  else return [line, Math.min(lines.length, line + 20)];
  const endLine = text.slice(0, end).split('\n').length;
  // Its attributes ([HttpPost]) sit just above it.
  let start = line;
  while (start > 1 && /^\s*\[.*\]\s*$/.test(lines[start - 2])) start--;
  return [start, Math.min(endLine, line + 400)];
}

export function context(idx, target, { budget = 60000 } = {}) {
  const r = resolveTarget(idx, target);
  let view = r.files.find((f) => idx.files.get(f)?.kind === 'view');
  let actions = r.actions;
  if (!view && actions.length) view = idx.out(actions[0]).find((e) => e.kind.startsWith('renders'))?.to;
  if (view && !actions.length) actions = idx.in(view).filter((e) => e.kind.startsWith('renders')).map((e) => e.from);
  if (!view) return { data: { error: 'not found' }, text: `"${target}" isn't a page Pilot knows (a URL, Controller.Action or view).` };
  const model = pageModel(idx, view);
  const cache = new Map();
  const linesOf = (rel) => {
    if (!cache.has(rel)) {
      try {
        cache.set(rel, readFileSync(join(idx.root, rel), 'utf8').split('\n'));
      } catch {
        cache.set(rel, []);
      }
    }
    return cache.get(rel);
  };

  // Candidates in priority order: { file, ranges: [[a, b]] | null (whole), why }.
  const items = [];
  const whole = (file, why) => items.push({ file, ranges: null, why });
  whole(view, 'the view');
  for (const v of model.views) if (v.own && v.file !== view) whole(v.file, 'rendered by the page');
  const actionItem = (id, why) => {
    const n = idx.nodes.get(id);
    if (n) items.push({ file: n.file, ranges: [methodRange(linesOf(n.file), n.line)], why: `${why}: ${actionLabel(idx, id)}` });
  };
  for (const id of actions) actionItem(id, 'the action');
  for (const c of model.calls.filter((x) => x.own)) {
    actionItem(c.action, `answers ${c.method ?? ''} ${c.request} from ${c.from}:${c.line}`.replace(/\s+/g, ' '));
    for (const ret of c.returns) whole(ret.file, `returned to ${c.from}:${c.line}`);
  }
  // Scripts: whole when small, else what touches the page: its classes and ids, its requests, its widgets.
  const ownClasses = new Set();
  const ownIds = new Set();
  for (const v of model.views.filter((x) => x.own)) {
    const d = idx.files.get(v.file)?.data;
    for (const [c] of d?.classes ?? []) ownClasses.add(c);
    for (const [i] of d?.ids ?? []) ownIds.add(i);
  }
  for (const s of model.scripts.filter((x) => x.own && !x.vendor)) {
    const d = idx.files.get(s.file)?.data;
    if (!d) continue;
    if ((s.lines ?? 0) <= 150) {
      whole(s.file, s.imported ? 'imported by the page\'s scripts' : 'loaded by the page');
      continue;
    }
    const hits = [...d.classes.filter(([c]) => ownClasses.has(c)), ...d.ids.filter(([i]) => ownIds.has(i))].map(([, l]) => l);
    hits.push(...d.calls.map((c) => c.line), ...d.widgets.map((w) => w.line));
    if (hits.length) items.push({ file: s.file, ranges: mergeRanges(hits.map((l) => [Math.max(1, l - 6), l + 6]), 3), why: 'the parts touching the page\'s markup, requests and widgets' });
  }
  // Styles: the rules styling the page's own classes and ids, in the stylesheets it loads.
  const ruleRanges = new Map();
  for (const [map, names] of [[idx.symbols.classes, ownClasses], [idx.symbols.ids, ownIds]]) {
    for (const n of names) {
      for (const u of map.get(n) ?? []) {
        if (u.role !== 'style' || u.vendor) continue;
        const rule = idx.files.get(u.file)?.data?.rules?.find((x) => x.line === u.line);
        if (!ruleRanges.has(u.file)) ruleRanges.set(u.file, []);
        ruleRanges.get(u.file).push([u.line, Math.min(rule?.end ?? u.line, u.line + 60)]);
      }
    }
  }
  for (const [file, ranges] of ruleRanges) items.push({ file, ranges: mergeRanges(ranges, 1), why: 'rules for the page\'s classes and ids' });
  for (const l of model.tree.chain) whole(l.file, 'a layout around the page');

  // Fill the budget in order; a range already given isn't given again.
  const given = new Map();
  const parts = [];
  const omitted = [];
  let used = 0;
  const header = [
    `# Context for ${actions.map((a) => urlOf(idx, a)).join(', ') || view}`,
    '',
    `${actions.map((a) => actionLabel(idx, a)).join(', ')} → ${view}${model.tree.chain.length ? `, in ${model.tree.chain.map((c) => c.file).join(' → ')}` : ''}. Complexity ${model.metrics.score}/100. Paths are from ${idx.root}; each block says its lines.`,
  ].join('\n');
  used += header.length;
  for (const it of items) {
    const lines = linesOf(it.file);
    if (!lines.length) continue;
    const ranges = it.ranges ?? [[1, lines.length]];
    const have = given.get(it.file) ?? [];
    const fresh = ranges.filter(([a, b]) => !have.some(([x, y]) => a >= x && b <= y));
    if (!fresh.length) continue;
    const blocks = fresh.map(([a, b]) => {
      const code = lines.slice(a - 1, b).join('\n');
      return `### ${it.file}:${a}-${b}\n_${it.why}_\n\n\`\`\`${LANG[extname(it.file).toLowerCase()] ?? ''}\n${code}\n\`\`\``;
    });
    const size = blocks.reduce((n, b) => n + b.length + 2, 0);
    if (used + size > budget) {
      omitted.push({ file: it.file, lines: fresh.reduce((n, [a, b]) => n + b - a + 1, 0), why: it.why });
      continue;
    }
    used += size;
    parts.push(...blocks);
    given.set(it.file, [...have, ...fresh]);
  }
  const tail = omitted.length ? ['', '## Left out (over the budget)', ...omitted.map((o) => `- ${o.file} (${o.lines} lines): ${o.why}`)] : [];
  const text = [header, '', ...parts.flatMap((p) => [p, '']), ...tail].join('\n').trimEnd();
  return { data: { view, actions, files: [...given].map(([file, ranges]) => ({ file, ranges })), omitted, used, chars: text.length }, text };
}
