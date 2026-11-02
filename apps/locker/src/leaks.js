// /leaks: values that look like secrets in the checkout, the files git would commit and the lines its
// history added (the last N commits, or since a date), read a batch of commits at a time through the
// kit's run.js so it can be stopped. What counts: a key Locker knows to be a secret (from the folder's
// settings, the app's Key Vault references and the vault) given a literal value, and the shapes secrets
// have (storage account keys, connection string passwords, private keys, JWTs, GitHub, Azure DevOps and
// AWS keys, SAS signatures). A value found is masked before anything holds it for showing: a finding
// keeps the line with every value found in it masked, never the value.
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { run } from '@fleet/kit/run.js';
import { fit } from '@fleet/kit/text.js';
import { MASK, copiedNote, isSecretName, maskValue, redactSecrets, repoRoot, takeLine } from '@fleet/kit/family.js';
import { theme } from './theme.js';
import { isReference, normKey } from './keys.js';
import { rotateSecret } from './rotate.js';

/** The shapes secrets have, each { what, re } with the secret in the regex's last group. */
export const PATTERNS = [
  { what: 'storage account key', re: /\bAccountKey=([A-Za-z0-9+/]{20,}={0,2})/g },
  { what: 'connection string password', re: /\b(?:Password|Pwd)\s*=\s*("[^"]+"|'[^']+'|[^;"'\s]+)/gi },
  { what: 'private key', re: /(-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----)/g },
  { what: 'JWT', re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g },
  { what: 'GitHub token', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  // Azure DevOps' newer tokens say so (AZDO at a fixed place); the older 52-character ones only by what is around them.
  { what: 'Azure DevOps token', re: /\b([A-Za-z0-9]{52}AZDO[A-Za-z0-9]{4})\b/g },
  { what: 'Azure DevOps token', re: /\b([a-z2-7]{52})\b/g, near: /\b(pat|devops|ado|vsts|azure|token)\b/i },
  { what: 'AWS access key', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g },
  { what: 'AWS secret key', re: /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi },
  { what: 'SAS signature', re: /[?&;]sig=([A-Za-z0-9%+/=]{16,})/g },
];

// A value that is only a placeholder, a reference or a variable, not a secret.
const PLACEHOLDER = /^(|true|false|null|none|changeme|change-me|xxx+|\*+|•+|<[^>]*>|\{\{.*\}\}|\$\{.*\}|\$[A-Z_]+|%[A-Z_]+%|your[-_ ].*|example.*|todo)$/i;

/**
 * The keys Locker knows hold secrets, normKey'd: the folder's keys whose names say so, the app's
 * settings that are Key Vault references, and the vault's secrets.
 */
export function secretKeys({ local = [], columns = [], vaultSecrets = [] } = {}) {
  const out = new Set();
  for (const s of local) for (const e of s.entries ?? []) if (isSecretName(e.key)) out.add(normKey(e.key));
  for (const c of columns) if (c.kind === 'app') for (const e of c.entries ?? []) if (isReference(e.value)) out.add(normKey(e.key));
  for (const s of vaultSecrets) out.add(normKey(s.name));
  return out;
}

/** The last part of a key, as a JSON file names it inside its section: Db:Password → password. */
const leaf = (norm) => norm.split(':').pop();

// key = value, key: value, "key": "value" (a .env line, YAML, JSON, code).
const ASSIGN = /(["']?)([A-Za-z_][A-Za-z0-9_:.\-]*)\1\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\$\{[^}]*\}|[^\s,;}#]+)/g;

const unquote = (v) => (/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

/**
 * What in one line looks like a secret: [{ what, key, value }], `key` the setting's name for a known
 * key (and null for a shape). `known` is secretKeys'; `example` (an example file) leaves known keys out,
 * since its values are only examples.
 */
export function findSecrets(text, known = new Set(), { example = false } = {}) {
  const line = String(text ?? '');
  const out = [];
  const seen = new Set();
  const add = (what, key, value) => {
    const v = unquote(String(value ?? '').trim());
    if (PLACEHOLDER.test(v) || v.length < 4 || isReference(v) || seen.has(v)) return;
    seen.add(v);
    out.push({ what, key, value: v });
  };
  // The shapes first: a connection string's Password= is better named as one than by its key's last part.
  for (const p of PATTERNS) {
    if (p.near && !p.near.test(line)) continue;
    for (const m of line.matchAll(p.re)) add(p.what, null, m[m.length - 1]);
  }
  if (!example && known.size) {
    // A JSON file names a key by its last part inside its section: only a last part that names a secret counts.
    const leaves = new Set([...known].map(leaf).filter((l) => isSecretName(l)));
    for (const m of line.matchAll(ASSIGN)) {
      const norm = normKey(m[2]);
      if (known.has(norm) || leaves.has(norm)) add(m[2], m[2], m[3]);
    }
  }
  return out;
}

/** A value as a finding shows it: maskValue's, or the mask whole when maskValue would leave it. */
export function masked(key, value) {
  const m = maskValue(key ?? 'secret', value);
  return m === value || m.includes(value) ? MASK : m;
}

/** The line a finding shows: every value found in it masked, trimmed and cut to `max` characters. */
export function maskedLine(text, found, max = 160) {
  let s = String(text ?? '');
  for (const f of [...found].sort((a, b) => b.value.length - a.value.length)) s = s.split(f.value).join(MASK);
  s = redactSecrets(s).trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Whether a file's name says its values are only examples (.env.example, appsettings.sample.json). */
export const isExampleFile = (path) => /(^|[\\/.])(example|sample|template)s?([\\/.]|$)/i.test(String(path ?? ''));

/**
 * `git log -p --pretty=fuller --date=iso-strict --unified=0`'s text, as the lines each commit added:
 * [{ commit, author, date, subject, file, line, text }].
 */
export function addedLines(log) {
  const out = [];
  let c = null;
  let file = null;
  let at = 0;
  let inMessage = false;
  // A +++ line names the file only right after its --- line; elsewhere it is an added line starting ++.
  let header = false;
  for (const raw of String(log ?? '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    let m;
    if ((m = /^commit ([0-9a-f]{7,64})\b/.exec(l))) {
      c = { commit: m[1], author: '', date: '', subject: '' };
      file = null;
      inMessage = false;
      continue;
    }
    if (!c) continue;
    if (!file && (m = /^Author:\s+(.*?)\s*(?:<[^>]*>)?$/.exec(l))) c.author = m[1];
    else if (!file && (m = /^AuthorDate:\s+(\S+)/.exec(l))) c.date = m[1];
    else if (!file && l === '' && !inMessage && c.date) inMessage = true;
    else if (inMessage && !c.subject && l.startsWith('    ')) c.subject = l.trim();
    else if (l.startsWith('diff --git ')) {
      inMessage = false;
      file = null;
      header = true;
    } else if (header && l.startsWith('--- ')) continue;
    else if (header && (m = /^\+\+\+ (?:b\/)?(.*)$/.exec(l))) {
      file = m[1] === '/dev/null' ? null : m[1].replace(/^"(.*)"$/, '$1');
      header = false;
    } else if ((m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l))) at = Number(m[1]);
    else if (file && l.startsWith('+')) out.push({ ...c, file, line: at++, text: l.slice(1) });
  }
  return out;
}

/** Findings in some lines ({ file, line, text, commit?, … }): one per value, each with its line masked. */
export function scanLines(lines, known) {
  const out = [];
  for (const l of lines) {
    const found = findSecrets(l.text, known, { example: isExampleFile(l.file) });
    if (!found.length) continue;
    const shown = maskedLine(l.text, found);
    for (const f of found) out.push({ file: l.file, line: l.line, commit: l.commit ?? null, author: l.author ?? '', date: l.date ?? '', subject: l.subject ?? '', what: f.what, key: f.key, masked: masked(f.key, f.value), text: shown });
  }
  return out;
}

/** What /leaks reads of the history: { count } (the last N commits) or { since } (a date git takes); null when it isn't either. */
export function parseSince(arg, { count = 200 } = {}) {
  const s = String(arg ?? '').trim();
  if (!s) return { count };
  if (/^\d{1,6}$/.test(s)) return Number(s) > 0 ? { count: Number(s) } : null;
  // Only what a date can be: it goes into a command line.
  return /^[\w:. -]{1,40}$/.test(s) ? { since: s } : null;
}

const GIT = 'git -c core.quotepath=off -c color.ui=never';
const BATCH = 25;

/**
 * Scans the checkout at `root`: the working tree's files git would commit, then the history, `BATCH`
 * commits at a time. `onBatch({ findings, commits, done })` hears each part as it's read; `signal` stops it.
 */
export async function scanRepo(root, { known = new Set(), range = { count: 200 }, signal, onBatch = () => {}, runner = run } = {}) {
  const findings = [];
  const listed = await runner(`${GIT} ls-files -z -co --exclude-standard`, { cwd: root, signal });
  const files = listed.stdout.split('\0').filter(Boolean);
  const tree = [];
  for (const f of files) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    let text;
    try {
      const p = join(root, f);
      if (statSync(p).size > 1_000_000) continue;
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    // A file with a NUL in it is binary.
    if (text.includes('\0')) continue;
    text.split('\n').forEach((t, i) => tree.push({ file: f, line: i + 1, text: t.replace(/\r$/, '') }));
  }
  findings.push(...scanLines(tree, known));
  onBatch({ findings, commits: 0, done: false });
  let commits = 0;
  const limit = range.count ?? Infinity;
  const since = range.since ? ` "--since=${range.since}"` : '';
  for (let skip = 0; skip < limit; skip += BATCH) {
    const n = Math.min(BATCH, limit - skip);
    let r;
    try {
      r = await runner(`${GIT} log -p --no-ext-diff --unified=0 --pretty=fuller --date=iso-strict --skip=${skip} -n ${n}${since}`, { cwd: root, signal });
    } catch (e) {
      // A checkout with no commits yet has no history to read.
      if (!e.cancelled && /does not have any commits|bad default revision/i.test(e.message)) break;
      throw e;
    }
    const lines = addedLines(r.stdout);
    const heads = (r.stdout.match(/^commit [0-9a-f]+/gm) ?? []).length;
    commits += heads;
    findings.push(...scanLines(lines, known));
    onBatch({ findings, commits, done: false });
    if (heads < n) break;
  }
  onBatch({ findings, commits, done: true });
  return { findings, commits, files: files.length };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (s) => String(s ?? '').split('\n')[0];

// Said wherever findings are listed: what to do about one.
const FIX = 'Removing a secret from git history needs a rewrite (git filter-repo, then a force push everyone takes), and every copy already made keeps it. Rotating it is the fix.';

/** The vault secret a finding's key is (by name, or the secret the app's reference to that key names), or null. */
export function vaultSecretFor(data, key) {
  if (!key) return null;
  const norm = normKey(key);
  const vaultCol = data.columns.findIndex((c) => c.kind === 'vault');
  if (vaultCol >= 0) {
    const row = data.matrix.rows.find((r) => r.norm === norm || r.norm.endsWith(`:${norm}`));
    const name = row?.cells[vaultCol]?.key;
    if (name) return name;
  }
  return data.vaultData?.secrets?.find((s) => normKey(s.name) === norm)?.name ?? null;
}

/**
 * /leaks [since]: the scan, listed as it's read (a batch of commits at a time; esc stops it). ↵ shows a
 * finding, t hands Splice its commit (or its file, for the working tree's), r rotates it when it's a vault secret.
 */
export async function leaks(ctx, arg) {
  const range = parseSince(arg);
  if (!range) return ctx.note('/leaks takes a number of commits (the last 200 without one) or a date git takes (2026-01-31, "2 weeks ago").', 'error') ?? false;
  const root = repoRoot(ctx.cwd());
  if (!root) return ctx.note(`${ctx.cwd()} isn't in a git checkout: /leaks reads git's history.`, 'error') ?? false;
  const data = ctx.data;
  const known = secretKeys({ local: data.local, columns: data.columns, vaultSecrets: data.vaultData?.secrets ?? [] });
  const where = range.since ? `since ${range.since}` : `the last ${plural(range.count, 'commit')}`;
  let found = [];
  let commits = 0;
  let done = false;
  let closed = false;
  let shown = null;

  const secretOf = (f) => vaultSecretFor(ctx.data, f.key);
  const toSplice = (f) => {
    const line = f.commit ? takeLine('commit', { repo: basename(root), hash: f.commit, subject: f.subject }) : takeLine('file', { path: f.file, line: f.line });
    ctx.copy(line, 'a line for Splice');
    ctx.note(copiedNote('splice', line), 'ok');
  };
  const rotate = (f) => {
    const name = secretOf(f);
    if (!name) return ctx.note(`${f.key ?? f.what} isn't a secret in ${ctx.data.vault?.name ?? 'the vault'}: rotate it where it was issued.`, 'error');
    if (!done) return ctx.note('Wait for the scan to finish (esc stops it), then r rotates it.', 'error');
    closed = true;
    ctx.closeOverlay();
    return rotateSecret(ctx, name);
  };
  const details = (f) => {
    const name = secretOf(f);
    const rows = [
      ['what', f.key ? `${f.key} (a key the settings keep secret)` : f.what],
      ['where', `${f.file}:${f.line}`],
      ['commit', f.commit ? `${f.commit.slice(0, 10)} ${f.subject}` : 'the working tree (not committed yet)'],
      ...(f.commit ? [['author', f.author], ['date', f.date.slice(0, 19).replace('T', ' ')]] : []),
      ['value', f.masked],
      ['line', f.text],
    ];
    const fix = name ? `${FIX} r rotates ${name}.` : f.commit ? `${FIX} Make a new one where it was issued, and turn this one off.` : 'Not committed yet: take it out of the file (or keep the file out of git), and rotate it if it was ever shared.';
    ctx.showText(`${f.key ?? f.what} in ${f.file}`, [...rows.map(([k, v]) => `${k.padEnd(8)}${v}`), '', fix].join('\n'), {
      lines: [...rows.map(([k, v]) => [{ text: k.padEnd(8), color: theme.dim }, { text: v, color: k === 'value' ? theme.del : undefined }]), [], [{ text: fix, color: theme.warn }], [], [{ text: `t copies it for Splice${name ? ' · r rotates it' : ''} · esc back to the list`, color: theme.dim }]],
      onKey: (input) => (input === 't' ? (toSplice(f), true) : input === 'r' && name ? (rotate(f), true) : false),
      // Back to the list: after the viewer's own close, so it isn't closed with it.
      onClose: () => setTimeout(() => show({ again: true }), 0),
    });
  };
  const picker = () => ({
    title: `Secrets in ${basename(root)}: the working tree and ${where} (${found.length}${done ? '' : `, ${plural(commits, 'commit')} read…`})`,
    hint: '↵ details · t Splice · r rotate it',
    empty: done ? `Nothing that looks like a secret in the working tree or ${where}.` : 'Reading…',
    items: found.map((f) => ({
      f,
      segments: [
        { text: fit(f.commit ? f.commit.slice(0, 8) : 'worktree', 9), color: f.commit ? theme.info : theme.warn },
        { text: fit(`${f.file}:${f.line}`, 36), strong: true },
        { text: `  ${fit(f.key ?? f.what, 24)}`, color: theme.accent },
        { text: `  ${fit(f.author, 14)}`, color: theme.dim },
        { text: `  ${f.date.slice(0, 10)}`, color: theme.dim },
        { text: `  ${f.masked}`, color: theme.del },
      ],
    })),
    onPick: ({ f }) => details(f),
    keys: { t: ({ f }) => toSplice(f), r: ({ f }) => rotate(f) },
    onClose: () => {
      closed = true;
      if (!done) ctx.cancel();
    },
  });
  // The list again with what has been read, the cursor where it was; only while it is the one showing.
  const show = ({ again = false } = {}) => {
    if (closed || (shown && !again && !ctx.isShowing(shown))) return;
    const next = picker();
    next.index = shown?.index;
    shown = next;
    ctx.showPicker(next);
  };
  show();
  const r = await ctx.task(
    `Looking for secrets in ${basename(root)}: the working tree and ${where}`,
    async (signal) => {
      const res = await scanRepo(root, {
        known,
        range,
        signal,
        onBatch: (b) => {
          found = b.findings;
          commits = b.commits;
          done = b.done;
          show();
        },
      });
      return { stdout: `${plural(res.findings.length, 'value')} that look like secrets in ${plural(res.files, 'file')} and ${plural(res.commits, 'commit')}${res.findings.length ? `\n${FIX}` : ''}` };
    },
    { label: 'Scanning' },
  );
  if (!r.ok && !r.error?.cancelled) ctx.note(`Couldn't read ${basename(root)}'s history: ${firstLine(r.error?.message)}`, 'error');
  done = true;
  show();
  return r.ok;
}
