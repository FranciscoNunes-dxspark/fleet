// `pilot hook`: a Claude Code PostToolUse hook, run in the background after Claude edits or writes
// a file. It tells Claude what the edit reaches and what looks wrong (classes styled nowhere, a
// stylesheet no page loads, references that broke, accessibility), and with screenshots on
// (`pilot init --hook --shots`) takes the pages it reaches again and says how much each changed.
// Claude reads it on its next turn as `additionalContext`. `pilot init --hook` installs it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pagesReached } from './changes.js';
import { listShots, shot, slugOf, baseUrl } from './shots.js';
import { urlOf } from './queries.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The hook's settings: { shots } from .pilot/config.json. */
export function hookConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, '.pilot', 'config.json'), 'utf8')).hook ?? {};
  } catch {
    return {};
  }
}

/** What to tell Claude about an edit to `rel`: lines, or none when there's nothing worth saying. */
export async function afterEdit(idx, rel, { shots = false, take = shot } = {}) {
  const f = idx.files.get(rel);
  if (!f || f.vendor || !['view', 'script', 'style', 'cs'].includes(f.kind)) return [];
  const out = [];
  const { pages } = pagesReached(idx, rel);
  const urls = pages.map((p) => urlOf(idx, p)).filter(Boolean);
  if (urls.length) out.push(`Pilot: ${rel} is on ${plural(urls.length, 'page')}: ${urls.slice(0, 6).join(', ')}${urls.length > 6 ? ` +${urls.length - 6}` : ''}.`);
  else if (f.kind === 'style' && !idx.in(rel).some((e) => e.kind === 'import')) out.push(`Pilot: no page loads ${rel}, so changes to it won't show anywhere. Import it from a stylesheet a page loads, or link it in a layout.`);
  else if (f.kind === 'script') out.push(`Pilot: no page loads ${rel} (no <script>, bundle or import reaches it).`);
  const problems = idx.problems.filter((p) => p.file === rel);
  if (problems.length) out.push(`Unresolved in it: ${problems.slice(0, 5).map((p) => `line ${p.line}: ${p.message}`).join('; ')}.`);
  const d = f.data;
  if (f.kind === 'view' && d) {
    const unstyled = [...new Set(d.classes.map(([c]) => c))].filter((c) => !(idx.symbols.classes.get(c) ?? []).some((u) => u.role === 'style' || u.role === 'script'));
    if (unstyled.length) out.push(`Classes in it that no stylesheet in the project styles (a library from a CDN may; a new one needs a rule in a stylesheet this page loads): ${unstyled.slice(0, 10).map((c) => `.${c}`).join(' ')}.`);
    if (d.a11y?.length) out.push(`Accessibility in it: ${d.a11y.slice(0, 5).map((a) => `line ${a.line} ${a.what}`).join('; ')}.`);
    if (d.inlineStyles?.length) out.push(`${plural(d.inlineStyles.length, 'inline style')} (style="…"): prefer a class in the page's stylesheet.`);
  }
  if (f.kind === 'script' && d) {
    const loose = [...new Set(d.classes.map(([c]) => c))].filter((c) => !(idx.symbols.classes.get(c) ?? []).some((u) => u.role === 'markup' || u.role === 'style'));
    if (loose.length) out.push(`Classes it selects or sets that no view has and no stylesheet styles: ${loose.slice(0, 10).map((c) => `.${c}`).join(' ')}.`);
  }
  if (f.kind === 'style' && d) {
    const unused = [...new Set(d.classes.map(([c]) => c))].filter((c) => !(idx.symbols.classes.get(c) ?? []).some((u) => u.role === 'markup' || u.role === 'script'));
    if (unused.length) out.push(`Classes it styles that no view or script uses: ${unused.slice(0, 10).map((c) => `.${c}`).join(' ')}.`);
  }
  // Screenshots: only of pages that already have a "before", so the comparison means something.
  if (shots && urls.length && baseUrl(idx.root)) {
    const withBefore = urls.filter((u) => !/[{[]/.test(u) && listShots(idx.root, slugOf(u)).some((s) => s.label === 'before')).slice(0, 3);
    for (const u of withBefore) {
      try {
        const r = await take(idx, u, { as: 'after' });
        for (const s of r.data.shots ?? []) if (s.compare) out.push(`Screenshot ${u} at ${s.width}: ${(s.compare.share * 100).toFixed(2)}% changed against the before (${s.compare.diff}; read it to see).`);
      } catch (e) {
        out.push(`Screenshot of ${u} failed: ${e.message}`);
      }
    }
  }
  return out;
}

/** The hook itself: reads Claude Code's JSON on stdin, prints additionalContext JSON, or nothing. */
export async function runHook({ input, env = process.env, build }) {
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {
    return '';
  }
  const file = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!file) return '';
  const root = resolve(env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  const abs = isAbsolute(file) ? file : resolve(root, file);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || !existsSync(abs)) return '';
  const idx = build(root);
  const lines = await afterEdit(idx, idx.file(rel)?.rel ?? rel, { shots: !!hookConfig(root).shots });
  if (!lines.length) return '';
  const text = lines.join('\n').slice(0, 4000);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } });
}

/**
 * Adds the hook to the project's .claude/settings.json (beside any other hooks; a Pilot hook already
 * there is replaced): after Edit, Write and MultiEdit, `command hook` in the background.
 */
export function installHook(root, command, { shots = false } = {}) {
  const file = join(root, '.claude', 'settings.json');
  let json = {};
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw Object.assign(new Error(`${file} isn't valid JSON: fix it first.`), { usage: true });
    }
  }
  const mine = (h) => /\bpilot(\.exe|\.js)?["']?\s+hook\b/.test(h.command ?? '');
  const post = (json.hooks?.PostToolUse ?? []).map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !mine(h)) })).filter((m) => m.hooks.length);
  post.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `${command} hook`, async: true, timeout: 120 }] });
  json.hooks = { ...(json.hooks ?? {}), PostToolUse: post };
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  // Screenshots after edits are a choice of this machine's: kept in .pilot/config.json.
  const cfgFile = join(root, '.pilot', 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  } catch {
    // None yet.
  }
  mkdirSync(join(root, '.pilot'), { recursive: true });
  writeFileSync(cfgFile, `${JSON.stringify({ ...cfg, hook: { ...(cfg.hook ?? {}), shots } }, null, 2)}\n`);
  if (!existsSync(join(root, '.pilot', '.gitignore'))) writeFileSync(join(root, '.pilot', '.gitignore'), '*\n');
  return file;
}
