// `pilot rename .old .new` (or #old #new): a class or id renamed everywhere Pilot knows it is used:
// the rules styling it, the views marking it up (class, id, for, href="#…", @class in helpers), and
// the scripts selecting or toggling it. A preview by default; `apply` writes the files. Where text
// can't be safely replaced it warns instead: a LESS name built with `&-suffix`, a name built at run
// time ('btn-' + kind), a name the new one would collide with, a built file to rebuild.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `line` with every whole `name` inside its quoted strings replaced (class="a old", '#old', "old"). */
export function replaceInQuotes(line, name, next) {
  const token = new RegExp(`(?<![\\w-])${esc(name)}(?![\\w-])`, 'g');
  return line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (q) => q.replace(token, next));
}

/** `line` with `.name` (or `#name`) in its selectors replaced. */
export function replaceInSelector(line, sigil, name, next) {
  return line.replace(new RegExp(`${esc(sigil)}${esc(name)}(?![\\w-])`, 'g'), `${sigil}${next}`);
}

export function rename(idx, from, to, { apply = false } = {}) {
  const m = /^([.#])?(-?[A-Za-z_][\w-]*)$/.exec(String(from ?? '').trim());
  const n = /^([.#])?(-?[A-Za-z_][\w-]*)$/.exec(String(to ?? '').trim());
  if (!m || !n) return { data: { error: 'usage' }, text: 'rename needs a class or id and its new name: pilot rename .old-name .new-name (or #old #new).' };
  const sigil = m[1] ?? n[1] ?? '.';
  const kind = sigil === '#' ? 'ids' : 'classes';
  const [old, next] = [m[2], n[2]];
  if (old === next) return { data: { error: 'same' }, text: 'The new name is the old one.' };
  const uses = (idx.symbols[kind].get(old) ?? []).filter((u) => !u.vendor);
  const warnings = [];
  if (!uses.length) return { data: { error: 'unused', changes: [] }, text: `${sigil}${old} isn't styled, marked up or scripted anywhere Pilot can see.` };
  if (idx.symbols[kind].has(next)) warnings.push(`${sigil}${next} already exists (${idx.symbols[kind].get(next).length} places): the two would merge.`);

  const byFile = new Map();
  for (const u of uses) {
    if (!byFile.has(u.file)) byFile.set(u.file, new Map());
    byFile.get(u.file).set(u.line, u.role);
  }
  const changes = [];
  const writes = [];
  for (const [file, lines] of byFile) {
    const text = readFileSync(join(idx.root, file), 'utf8');
    const all = text.split('\n');
    let touched = false;
    for (const [line, role] of [...lines].sort((a, b) => a[0] - b[0])) {
      const before = all[line - 1];
      if (before == null) continue;
      let after = role === 'style' ? replaceInSelector(before, sigil, old, next) : replaceInQuotes(before, old, next);
      // Markup and scripts also name an id bare (id="old", for="old") and as a selector in a string: both are in quotes.
      if (role !== 'style' && after === before) after = replaceInSelector(before, sigil, old, next);
      if (after === before) {
        warnings.push(role === 'style'
          ? `${file}:${line}: ${sigil}${old} is built here (a LESS & or a mixin), not written out; rename it by hand: ${before.trim()}`
          : `${file}:${line}: ${sigil}${old} isn't written out here as a whole name; check by hand: ${before.trim()}`);
        continue;
      }
      all[line - 1] = after;
      touched = true;
      changes.push({ file, line, role, before: before.trim(), after: after.trim() });
    }
    if (touched) writes.push([file, all.join('\n')]);
  }
  // Names built at run time from a prefix: 'old-' + x, `old-${x}`, "old" + suffix.
  const prefix = new RegExp(`['"\`]${esc(old)}-?['"\`]\\s*\\+|\`${esc(old)}-?\\$\\{|['"\`][\\w-]*-['"\`]\\s*\\+\\s*['"\`]?${esc(old.split('-').pop())}\\b`);
  for (const f of idx.files.values()) {
    if (f.vendor || !['view', 'script'].includes(f.kind) || !f.data) continue;
    let text;
    try {
      text = readFileSync(join(idx.root, f.rel), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(old.split('-')[0])) continue;
    text.split('\n').forEach((l, i) => {
      if (prefix.test(l)) warnings.push(`${f.rel}:${i + 1}: may build ${sigil}${old} at run time: ${l.trim().slice(0, 120)}`);
    });
  }
  // Built files carry the old name until they're built again.
  const rebuild = [...new Set(changes.flatMap((c) => idx.outputs.get(c.file) ?? []))].filter((o) => idx.exists(o));
  if (rebuild.length) warnings.push(`Rebuild ${rebuild.join(', ')} (or let the build do it): they still hold ${sigil}${old}.`);

  if (apply) for (const [file, text] of writes) writeFileSync(join(idx.root, file), text);
  const lines = [`${apply ? 'Renamed' : 'Would rename'} ${sigil}${old} → ${sigil}${next}: ${plural(changes.length, 'line')} in ${plural(writes.length, 'file')}.${apply ? '' : ' Run again with --apply (apply: true) to write them.'}`];
  for (const c of changes) lines.push(`  ${c.file}:${c.line}  [${c.role}]`, `    - ${c.before.slice(0, 160)}`, `    + ${c.after.slice(0, 160)}`);
  if (warnings.length) lines.push('', 'Check by hand:', ...warnings.map((w) => `  ${w}`));
  return { data: { from: `${sigil}${old}`, to: `${sigil}${next}`, applied: apply, changes, warnings }, text: lines.join('\n') };
}
