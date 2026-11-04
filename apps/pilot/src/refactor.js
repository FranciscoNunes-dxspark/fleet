// The refactors Pilot suggests, done: a large stylesheet split into the files `split` proposes (and,
// when lessc or sass is installed, compiled before and after to show the CSS is the same), and a
// block of markup repeated across views extracted into one partial. Both preview by default, keep a
// backup in .pilot/backup when they write, and say what they changed.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, posix } from 'node:path';
import { split } from './analysis.js';
import { repeats } from './audit.js';
import { cssRules } from './live.js';
import { resolveTarget } from './queries.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Copies files into .pilot/backup/<time>/ before they change. Returns the folder. */
export function backup(root, files) {
  const dir = join(root, '.pilot', 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
  for (const f of files) {
    if (!existsSync(join(root, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(root, f), join(dir, f));
  }
  mkdirSync(join(root, '.pilot'), { recursive: true });
  if (!existsSync(join(root, '.pilot', '.gitignore'))) writeFileSync(join(root, '.pilot', '.gitignore'), '*\n');
  return dir;
}

// ─── Compiling, to check a split ──────────────────────────────────────────────────────────────

/** The LESS or Sass compiler for a file: the project's own (node_modules/.bin), else one on the PATH; null if none. */
export function findCompiler(root, file, env = process.env) {
  const name = /\.scss$/i.test(file) ? 'sass' : /\.less$/i.test(file) ? 'lessc' : null;
  if (!name) return null;
  const exe = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (let dir = dirname(join(root, file)); ; dir = dirname(dir)) {
    for (const e of exe) if (existsSync(join(dir, 'node_modules', '.bin', e))) return join(dir, 'node_modules', '.bin', e);
    if (dirname(dir) === dir) break;
  }
  for (const d of String(env.PATH ?? '').split(delimiter).filter(Boolean)) for (const e of exe) if (existsSync(join(d, e))) return join(d, e);
  return null;
}

function compile(compiler, path) {
  return execFileSync(compiler, [path], { cwd: dirname(path), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
}

/** Two compiled stylesheets compared: rules missing or extra, and selectors whose order changed. */
export function compareCss(before, after) {
  const rules = (css) => cssRules(css).map((r) => `${r.selector.replace(/\s+/g, ' ')} {${css.slice(css.indexOf('{', r.start) + 1, r.end - 1).replace(/\s+/g, ' ').trim()}}`);
  const a = rules(before);
  const b = rules(after);
  const count = (list) => list.reduce((m, r) => m.set(r, (m.get(r) ?? 0) + 1), new Map());
  const ca = count(a);
  const cb = count(b);
  const missing = [...ca].filter(([r, n]) => (cb.get(r) ?? 0) < n).map(([r]) => r);
  const extra = [...cb].filter(([r, n]) => (ca.get(r) ?? 0) < n).map(([r]) => r);
  // Order only matters between rules for the same class: those whose relative order changed.
  const classOrder = (list) => {
    const m = new Map();
    list.forEach((r, i) => {
      for (const c of r.slice(0, r.indexOf('{')).match(/\.-?[A-Za-z_][\w-]*/g) ?? []) m.set(c, [...(m.get(c) ?? []), r]);
    });
    return m;
  };
  const oa = classOrder(a);
  const ob = classOrder(b);
  const reordered = [...oa].filter(([c, list]) => list.length > 1 && JSON.stringify(list) !== JSON.stringify(ob.get(c) ?? [])).map(([c]) => c);
  return { rules: a.length, same: !missing.length && !extra.length, missing, extra, reordered };
}

// ─── Splitting a stylesheet ───────────────────────────────────────────────────────────────────

/**
 * Splits a stylesheet into the files `split` proposes, beside it: each block with the comments
 * above it, in the original order within each file; the file itself keeps its own imports and
 * gains the new imports. Previews unless `apply`; with a compiler, checks the CSS is unchanged
 * and puts everything back if not (unless `force`).
 */
export function splitApply(idx, target, { apply = false, force = false, compiler = undefined } = {}) {
  const plan = split(idx, target);
  if (plan.data.error || plan.data.imports) return { data: { error: plan.data.error ?? 'only imports' }, text: plan.data.error ? plan.text : `${plan.data.file} only imports other files: split one of them.` };
  const rel = plan.data.file;
  const ext = posix.extname(rel);
  const dir = posix.dirname(rel);
  const source = readFileSync(join(idx.root, rel), 'utf8');
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const f = idx.files.get(rel);
  const blocks = [...f.data.blocks].sort((a, b) => a.start - b.start);
  // Each block takes the comments and blank lines between it and the one before.
  const lead = new Map();
  let prev = 0;
  for (const b of blocks) {
    lead.set(b.start, prev + 1);
    prev = b.end;
  }
  const where = new Map();
  for (const g of plan.data.groups) for (const b of g.blocks) where.set(b.start, g.file);
  const files = new Map();
  const stays = [];
  for (const b of blocks) {
    const text = lines.slice(lead.get(b.start) - 1, b.end).join(eol).replace(/^(\s*\r?\n)+/, '');
    const to = where.get(b.start);
    if (!to) stays.push(text);
    else files.set(to, [...(files.get(to) ?? []), text]);
  }
  const tail = lines.slice(prev).join(eol).trim();
  // unused is imported last too: a split reorganises, it doesn't delete; that's a choice made after.
  const order = [...plan.data.groups.map((g) => g.file).filter((g) => !g.startsWith('unused')), ...plan.data.groups.map((g) => g.file).filter((g) => g.startsWith('unused'))];
  const created = [...files].map(([name, parts]) => ({ file: posix.join(dir, name), lines: parts.join(eol + eol).split(eol).length, text: `// Split from ${posix.basename(rel)} by Pilot.${eol}${parts.join(eol + eol)}${eol}` }));
  const exists = created.filter((c) => existsSync(join(idx.root, c.file)));
  const main = [
    ...stays,
    `// Split by Pilot: what was here is in these files, in an order that keeps the cascade.`,
    ...order.map((g) => `@import "${g.replace(new RegExp(`\\${ext}$`), '')}";${g.startsWith('unused') ? ' // rules no view or script uses: check, then delete the file and this line' : ''}`),
    ...(tail ? [tail] : []),
  ].join(eol) + eol;
  const lines2 = [`${apply ? 'Split' : 'Would split'} ${rel} (${lines.length} lines) into ${plural(created.length, 'file')}:`];
  for (const c of created) lines2.push(`  ${c.file} (${c.lines} lines)${exists.includes(c) ? '  ALREADY EXISTS' : ''}`);
  lines2.push('', `${rel} becomes:`, ...main.split(eol).map((l) => `  ${l}`));
  if (exists.length) {
    lines2.push('', `Not written: ${exists.map((e) => e.file).join(', ')} already exist. Move them aside first.`);
    return { data: { file: rel, created: created.map(({ text, ...c }) => c), main, error: 'exists' }, text: lines2.join('\n') };
  }
  if (!apply) {
    lines2.push('', 'Run again with --apply (apply: true) to write them; the original is backed up in .pilot/backup.');
    return { data: { file: rel, created: created.map(({ text, ...c }) => c), main, applied: false }, text: lines2.join('\n') };
  }
  const bak = backup(idx.root, [rel]);
  const comp = compiler === undefined ? findCompiler(idx.root, rel) : compiler;
  let check = null;
  let before = null;
  if (comp) {
    try {
      before = compile(comp, join(idx.root, rel));
    } catch (e) {
      check = { error: `compiling the original failed: ${String(e.stderr ?? e.message).slice(0, 300)}` };
    }
  }
  for (const c of created) {
    mkdirSync(dirname(join(idx.root, c.file)), { recursive: true });
    writeFileSync(join(idx.root, c.file), c.text);
  }
  writeFileSync(join(idx.root, rel), main);
  if (before != null) {
    try {
      check = compareCss(before, compile(comp, join(idx.root, rel)));
    } catch (e) {
      check = { error: `compiling the split failed: ${String(e.stderr ?? e.message).slice(0, 300)}` };
    }
  }
  const bad = check && (check.error || !check.same || check.reordered.length);
  if (bad && !force) {
    // Put everything back: a split that changes the CSS isn't the one asked for.
    copyFileSync(join(bak, rel), join(idx.root, rel));
    for (const c of created) rmSync(join(idx.root, c.file), { force: true });
    // And the folders made for them, if they're empty again.
    for (const d of [...new Set(created.map((c) => dirname(join(idx.root, c.file))))].sort((a, b) => b.length - a.length)) {
      try {
        if (!readdirSync(d).length) rmSync(d, { recursive: true });
      } catch {
        // Gone already.
      }
    }
    lines2.push('', 'Put back as it was: the compiled CSS would change.', ...(check.error ? [`  ${check.error}`] : [`  ${check.missing.length} rules missing, ${check.extra.length} extra, order changed for ${check.reordered.slice(0, 10).map((c) => c).join(' ') || 'nothing'}`]), 'Run with --force to keep the split anyway.');
    return { data: { file: rel, applied: false, check, error: 'css changed' }, text: lines2.join('\n') };
  }
  lines2.push('', `Written. The original is in ${bak.replace(idx.root, '').replace(/^[\\/]/, '')}.`);
  lines2.push(check ? (check.error ? `Couldn't check the CSS: ${check.error}` : check.same && !check.reordered.length ? `Checked with ${posix.basename(comp)}: the same ${check.rules} rules, in the same order where it matters.` : `Kept with --force: ${check.missing.length} rules missing, ${check.extra.length} extra, order changed for ${check.reordered.join(' ')}.`) : 'No lessc or sass found to check the compiled CSS: build the site and look at it, or install less (npm i -D less) and run again on the backup.');
  return { data: { file: rel, applied: true, backup: bak, created: created.map(({ text, ...c }) => c), check }, text: lines2.join('\n') };
}

// ─── Extracting a partial ─────────────────────────────────────────────────────────────────────

const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr|partial|vc:[\w-]+)$/i;

/** Opened minus closed elements in some lines of markup. */
export function tagDepth(lines) {
  let depth = 0;
  for (const m of lines.join('\n').matchAll(/<(\/?)([A-Za-z][\w:-]*)\b[^>]*?(\/?)>/g)) {
    if (VOID.test(m[2]) || m[3]) continue;
    depth += m[1] ? -1 : 1;
  }
  return depth;
}

/** A block's lines grown (or trimmed) until its elements open and close inside it. */
export function balance(all, start, end) {
  // Leading lines that only close something opened before the block don't belong to it.
  while (start < end && /^\s*<\/[\w:-]+>\s*$/.test(all[start - 1])) start++;
  let depth = tagDepth(all.slice(start - 1, end));
  while (depth > 0 && end < all.length && end - start < 400) {
    end++;
    depth = tagDepth(all.slice(start - 1, end));
  }
  return [start, end];
}

/** Whether a project is ASP.NET Core (a Web SDK project or a wwwroot), where <partial> is the way. */
function isCore(idx, rel) {
  const project = idx.projectOf(rel);
  if (idx.wwwroots.has(project.toLowerCase())) return true;
  const csproj = [...idx.files.values()].find((f) => f.kind === 'project' && posix.dirname(f.rel) === (project || '.'));
  try {
    return csproj ? /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(readFileSync(join(idx.root, csproj.rel), 'utf8')) : false;
  } catch {
    return false;
  }
}

/**
 * Block `n` of `repeats` (1 = the largest) made one partial: written once (in the views' folder, or
 * Views/Shared when they're in several), and each copy replaced by a call to it. When the copies
 * differ, the differences are listed and nothing is written without `force`.
 */
export function extractPartial(idx, n = 1, { name = null, apply = false, force = false, min = 6 } = {}) {
  const blocks = repeats(idx, { min }).data.blocks;
  const block = blocks[Number(n) - 1];
  if (!block) return { data: { error: 'no block' }, text: blocks.length ? `There are ${blocks.length} repeated blocks: give a number from 1 to ${blocks.length} (pilot repeats lists them).` : 'No repeated markup found.' };
  const places = block.places.map((p) => {
    const all = readFileSync(join(idx.root, p.file), 'utf8').split(/\r?\n/);
    const [start, end] = balance(all, ...p.ranges[0]);
    return { file: p.file, start, end, lines: all.slice(start - 1, end), all };
  });
  const indent = (ls) => Math.min(...ls.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
  const dedent = (ls) => {
    const k = indent(ls);
    return ls.map((l) => l.slice(k));
  };
  const first = dedent(places[0].lines);
  const differences = [];
  for (const p of places.slice(1)) {
    const d = dedent(p.lines);
    for (let i = 0; i < Math.max(d.length, first.length); i++) if ((d[i] ?? '').trim() !== (first[i] ?? '').trim()) differences.push({ file: p.file, line: p.start + i, first: (first[i] ?? '').trim(), here: (d[i] ?? '').trim() });
  }
  const partialName = (name ?? block.partial).replace(/\.cshtml$/i, '').replace(/^(?!_)/, '_');
  const folders = [...new Set(places.map((p) => posix.dirname(p.file)))];
  const project = idx.projectOf(places[0].file);
  const area = /(?:^|\/)Areas\/([^/]+)\//.exec(places[0].file)?.[1];
  const sameArea = places.every((p) => /(?:^|\/)Areas\/([^/]+)\//.exec(p.file)?.[1] === area);
  const folder = folders.length === 1 ? folders[0] : [project, ...(area && sameArea ? ['Areas', area] : []), 'Views', 'Shared'].filter(Boolean).join('/');
  const file = posix.join(folder, `${partialName}.cshtml`);
  const call = (p) => (isCore(idx, p.file) ? `<partial name="${partialName}" />` : `@Html.Partial("${partialName}")`);
  const model = first.some((l) => /@Model\b/.test(l)) ? 'It reads @Model: each view passes its own model, as Html.Partial and <partial> do without a model argument.' : null;
  const text = [`${apply ? 'Extracted' : 'Would extract'} ${block.lines} lines repeated in ${plural(places.length, 'view')} into ${file}:`, '', ...first.map((l) => `  ${l}`), '', 'Each copy becomes:'];
  for (const p of places) text.push(`  ${p.file}:${p.start}-${p.end} → ${call(p)}`);
  if (model) text.push('', model);
  if (existsSync(join(idx.root, file))) {
    text.push('', `${file} already exists: give another --name.`);
    return { data: { error: 'exists', file }, text: text.join('\n') };
  }
  if (differences.length) {
    text.push('', `The copies differ in ${plural(differences.length, 'line')} (the partial takes the first copy's):`, ...differences.slice(0, 12).map((d) => `  ${d.file}:${d.line}\n    first: ${d.first}\n    here:  ${d.here}`));
    if (!force) {
      text.push('', 'Not written: make the copies the same (or pass what differs through a model or ViewData), or run with --force to use the first copy everywhere.');
      return { data: { file, places: places.map(({ all, lines, ...p }) => p), differences, applied: false, ...(apply ? { error: 'copies differ' } : {}) }, text: text.join('\n') };
    }
  }
  if (!apply) {
    text.push('', 'Run again with --apply (apply: true) to write it; the views are backed up in .pilot/backup.');
    return { data: { file, places: places.map(({ all, lines, ...p }) => p), differences, partial: first.join('\n'), applied: false }, text: text.join('\n') };
  }
  const bak = backup(idx.root, places.map((p) => p.file));
  mkdirSync(dirname(join(idx.root, file)), { recursive: true });
  writeFileSync(join(idx.root, file), `${first.join('\n')}\n`);
  for (const p of places) {
    const lead = /^\s*/.exec(p.lines.find((l) => l.trim()) ?? '')[0];
    const eol = readFileSync(join(idx.root, p.file), 'utf8').includes('\r\n') ? '\r\n' : '\n';
    const next = [...p.all.slice(0, p.start - 1), `${lead}${call(p)}`, ...p.all.slice(p.end)];
    writeFileSync(join(idx.root, p.file), next.join(eol));
  }
  text.push('', `Written. The views as they were are in ${bak.replace(idx.root, '').replace(/^[\\/]/, '')}.`);
  return { data: { file, places: places.map(({ all, lines, ...p }) => p), differences, applied: true, backup: bak }, text: text.join('\n') };
}

export { resolveTarget };
