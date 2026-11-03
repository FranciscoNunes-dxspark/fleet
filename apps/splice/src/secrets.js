// Secrets in the history: the kit's secret rules (codescan.js) read over the lines each commit added, for
// /secrets, `splice security` and the check before a push (pushcheck.js). Pure but `readHistory`, which runs
// git and reads the working tree.
//
// A secret found is never kept whole: a finding's `excerpt` is codescan's, redacted. `readHistory` holds
// the value only while it looks for it in the working tree, and nothing it returns carries it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RULES, fileFindings, scanText } from '@fleet/kit/codescan.js';
import { countFindings, findingsLine, failingFindings, sortFindings } from '@fleet/kit/findings.js';
import { git } from './git.js';
import { splitArgs } from './parse.js';

export const SECRET_RULES = RULES.filter((r) => r.kind === 'secret');
// The commits read at most, newest first: a long history stays a matter of seconds.
export const HISTORY_MAX = 5000;
// Commits asked for in one git, so memory stays bounded and esc is heard between them.
const CHUNK = 200;
// A file's added text past this isn't read (generated or vendored); git already counts files over 2 MB as binary.
export const MAX_ADDED = 512 * 1024;
// codescan.js passes lock files by too: their integrity hashes look like keys.
const LOCK_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|packages\.lock\.json|composer\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/;

export const HISTORY_FORMAT = '%x1e%H%x1f%an%x1f%aI%x1f%s';

/**
 * `git log` arguments for the commits whose hashes come on stdin, in that order: the lines each adds (-U0),
 * renames followed so a renamed file isn't read again, files over 2 MB as binary. The prefixes are fixed
 * so a diff.noprefix or diff.mnemonicPrefix in the user's config doesn't change what's parsed.
 */
export function historyArgs() {
  return ['-c', 'core.bigFileThreshold=2m', 'log', '--stdin', '--no-walk=unsorted', '--no-ext-diff', '--no-color', '--no-textconv', '-M', '-p', '-U0', '--src-prefix=a/', '--dst-prefix=b/', `--format=${HISTORY_FORMAT}`];
}

/**
 * What /secrets and `splice security` read: nothing (the current branch, `HEAD`), `all` (every ref) or
 * revisions as git takes them (`main..feature`, `v1.0..`). { range } or { error }.
 */
export function historyRange(text = '') {
  const args = splitArgs(String(text ?? '').trim());
  if (!args.length) return { range: ['HEAD'], what: 'the current branch' };
  if (args.length === 1 && (args[0] === 'all' || args[0] === '--all')) return { range: ['--all'], what: 'every branch and tag' };
  // Revisions only: an option here could have git do something else (write a file, say).
  if (args.some((a) => a.startsWith('-'))) return { error: 'Give revisions (main..feature, v1.0..), all, or nothing for the current branch.' };
  return { range: args, what: args.join(' ') };
}

/** Parses historyArgs's output: [{ hash, author, date, subject, patch }]. */
export function parseHistoryLog(raw) {
  const out = [];
  for (const rec of String(raw).split('\x1e')) {
    if (!rec.includes('\x1f')) continue;
    const nl = rec.indexOf('\n');
    const [hash, author, date, subject] = (nl < 0 ? rec : rec.slice(0, nl)).split('\x1f');
    out.push({ hash, author: author ?? '', date: date ?? '', subject: subject ?? '', patch: nl < 0 ? '' : rec.slice(nl + 1) });
  }
  return out;
}

const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** A path as git writes it: in double quotes with C escapes (octal bytes for UTF-8) when it has odd characters. */
export function unquote(s) {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += oct.length - 1;
    } else bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

// "a/x" or "b/x" (or a quoted one) without its prefix; null for /dev/null.
const side = (s) => {
  const p = unquote(s.replace(/\t$/, ''));
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
};

// The new path from "diff --git a/x b/x": the two halves are the same when nothing was renamed.
function gitLinePath(rest) {
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") (.*)$/.exec(rest);
    return m ? side(m[2]) : null;
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  const m = / b\/(.*)$/.exec(rest);
  return m ? m[1] : null;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A commit's patch (-U0) as its files: [{ path, from, status (A M D R C), binary, added: [{ line, text }] }],
 * each added line with its number in the new file.
 */
export function diffFiles(patch) {
  const files = [];
  let f = null;
  let inHeader = false;
  let line = 0;
  for (const l of String(patch).split('\n')) {
    if (l.startsWith('diff --git ')) {
      f = { path: gitLinePath(l.slice(11)), from: null, status: 'M', binary: false, added: [] };
      files.push(f);
      inHeader = true;
      continue;
    }
    if (!f) continue;
    if (inHeader) {
      const h = HUNK.exec(l);
      if (h) {
        inHeader = false;
        line = Number(h[1]);
      } else if (l.startsWith('new file mode')) f.status = 'A';
      else if (l.startsWith('deleted file mode')) f.status = 'D';
      else if (l.startsWith('rename from ')) [f.from, f.status] = [unquote(l.slice(12)), 'R'];
      else if (l.startsWith('rename to ')) f.path = unquote(l.slice(10));
      else if (l.startsWith('copy from ')) [f.from, f.status] = [unquote(l.slice(10)), 'C'];
      else if (l.startsWith('copy to ')) f.path = unquote(l.slice(8));
      else if (l.startsWith('+++ ')) f.path = side(l.slice(4)) ?? f.path;
      else if (l.startsWith('Binary files ')) {
        f.binary = true;
        const m = /^Binary files (.*) and (.*) differ$/.exec(l);
        if (m) f.path = side(m[2]) ?? f.path;
      }
      continue;
    }
    const h = HUNK.exec(l);
    if (h) line = Number(h[1]);
    else if (l[0] === '+') f.added.push({ line: line++, text: l.slice(1) });
    else if (l[0] === ' ') line++;
  }
  return files;
}

/** The value a secret rule matched in `text` (as codescan.js takes it), or null. Only ever held in memory. */
function secretIn(ruleId, text) {
  const rule = SECRET_RULES.find((r) => r.id === ruleId);
  const m = rule?.pattern.exec(text);
  if (!m) return null;
  return m[rule.secret] ?? m[rule.secret + 1] ?? m[0];
}

// Lines of a file read for the rules at once: runs of added lines, each with what scanText needs around it.
// A run near the top keeps the file's first lines in place (a bilge-ignore-file there skips it); one further
// down gets 15 blank lines first, so a mention of bilge-ignore-file in it doesn't count as the file's.
function runs(added) {
  const out = [];
  for (const a of added) {
    const last = out.at(-1);
    if (last && a.line === last.start + last.lines.length) last.lines.push(a.text);
    else out.push({ start: a.line, lines: [a.text] });
  }
  return out;
}

/**
 * The secrets in one file of a commit: [{ finding, value }], `value` the secret itself (null for a file
 * that is one), for the caller to look for and drop. `path` relative, /-separated.
 */
function fileSecrets(file, commit) {
  const out = [];
  if (!file.path || file.status === 'D') return out;
  const about = { commit: commit.hash, author: commit.author, date: commit.date, subject: commit.subject };
  const make = (f) => {
    const { key, path, test, ...rest } = f;
    return { ...rest, where: file.path, ...about };
  };
  // A file that's a secret by being there (a key store), or a .env, added under this name.
  if (file.status !== 'M') for (const f of fileFindings(file.path)) out.push({ finding: make(f), value: null });
  if (file.binary || !file.added.length || LOCK_FILE.test(file.path)) return out;
  if (file.added.reduce((n, a) => n + a.text.length + 1, 0) > MAX_ADDED) return out;
  const byLine = new Map(file.added.map((a) => [a.line, a.text]));
  for (const run of runs(file.added)) {
    const pad = Math.min(run.start - 1, 15);
    const offset = run.start - 1 - pad;
    for (const f of scanText(file.path, `${'\n'.repeat(pad)}${run.lines.join('\n')}`, { rules: SECRET_RULES })) {
      const line = f.line + offset;
      out.push({ finding: { ...make(f), line }, value: secretIn(f.rule, byLine.get(line) ?? '') });
    }
  }
  return out;
}

const secretsOf = (commit) => diffFiles(commit.patch).flatMap((f) => fileSecrets(f, commit));

/** The secrets a commit adds, as findings with { commit, author, date, subject }: for the check before a push too. */
export const commitFindings = (commit) => secretsOf(commit).map((s) => s.finding);

// The same secret on the same line, met again (a rebased copy, a cherry-pick): reported once.
const sameKey = (f) => `${f.rule}\0${f.where}\0${f.excerpt}`;

/**
 * Reads the history for secrets: { root, range, findings, commits, truncated }. The findings are each
 * secret once, in the oldest commit read that added it, with `inTree`: whether the working tree still has
 * it. `onProgress(done, total)` as commits are read; `signal` stops it.
 */
export async function readHistory({ root, range = ['HEAD'], max = HISTORY_MAX, signal, onProgress, chunk = CHUNK }) {
  const run = (args, opts) => git(root, args, { signal, ...opts });
  // A repository with no commits yet has no history to read.
  if (range.length === 1 && range[0] === 'HEAD' && !(await run(['rev-parse', '--verify', '-q', 'HEAD'], { codes: [1] })).trim()) {
    return { root, range, findings: [], commits: 0, truncated: false };
  }
  const listed = (await run(['rev-list', `--max-count=${max + 1}`, '--no-merges', ...range, '--'])).split('\n').filter(Boolean);
  const hashes = listed.slice(0, max);
  const found = new Map();
  for (let i = 0; i < hashes.length; i += chunk) {
    const part = hashes.slice(i, i + chunk);
    const raw = await run(historyArgs(), { input: `${part.join('\n')}\n` });
    // Newest first, so a later (older) commit takes the place of a newer one with the same secret.
    for (const c of parseHistoryLog(raw)) for (const s of secretsOf(c)) found.set(sameKey(s.finding), s);
    onProgress?.(i + part.length, hashes.length);
  }
  const secrets = [...found.values()];
  // The tracked files, for a secret that isn't where it was added any more.
  const tracked = secrets.length ? await run(['ls-files', '-z']).catch((e) => (e.cancelled ? Promise.reject(e) : '')) : '';
  const findings = inWorkingTree(root, secrets, { others: () => tracked.split('\0').filter(Boolean).slice(0, MAX_TREE_FILES) });
  return { root, range, findings: sortFindings(findings), commits: hashes.length, truncated: listed.length > max };
}

/**
 * Each finding with `inTree`: whether the working tree still has it. A secret on a line is looked for in its
 * file, then, if not there (moved, or its file renamed), in the other files of `others()` (the tracked
 * ones, read once for all of them); a file found as a whole, at its path. Null when its file is too big to
 * look through. `read(file)` is a file's text, null when it's gone.
 */
export function inWorkingTree(root, secrets, { read = readText, others = () => [] } = {}) {
  const texts = new Map();
  const text = (path) => {
    if (!texts.has(path)) texts.set(path, read(join(root, path)));
    return texts.get(path);
  };
  const out = secrets.map(({ finding, value }) => {
    const t = text(finding.where);
    return { ...finding, inTree: t === undefined ? null : t !== null && (value == null || t.includes(value)) };
  });
  const missing = out.map((f, i) => (f.inTree === false && secrets[i].value != null ? i : -1)).filter((i) => i >= 0);
  if (!missing.length) return out;
  const values = new Map(missing.map((i) => [i, secrets[i].value]));
  for (const path of others()) {
    if (!values.size) break;
    const t = texts.has(path) ? texts.get(path) : read(join(root, path));
    if (!t) continue;
    for (const [i, v] of values) {
      if (!t.includes(v)) continue;
      out[i] = { ...out[i], inTree: true };
      values.delete(i);
    }
  }
  return out;
}

const MAX_TREE_FILE = 8 * 1024 * 1024;
// Files looked through for a secret that moved, at most.
const MAX_TREE_FILES = 20000;

// A working-tree file's text; null when it's gone, undefined for one too big to look through.
function readText(file) {
  try {
    if (!existsSync(file)) return null;
    if (statSync(file).size > MAX_TREE_FILE) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const day = (iso) => String(iso ?? '').slice(0, 10);
const place = (f) => (f.line ? `${f.where}:${f.line}` : f.where);
export const whereNow = (f) => (f.inTree ? 'still in the working tree' : f.inTree === null ? 'in a file too big to look through now' : 'only in the history');
const LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** The fix for a secret in the history, as text: rotate it, then how to take it out of the history. Never run. */
export function purgeText(f) {
  const file = f.rule === 'key-store' || f.rule === 'env-committed';
  return [
    '1. Rotate it. Once committed, it is anyone\'s who has a clone, whatever happens to the history now.',
    `   ${f.fix}`,
    '2. Take it out of the history too, if the repository is shared (this rewrites every commit since, so',
    '   everyone has to clone again or reset, and open pull requests need recreating):',
    ...(file
      ? [`     git filter-repo --invert-paths --path ${quoteArg(f.where)}`]
      : [
          '     write the secret into a file outside the repository, one line: <the secret>==>REDACTED',
          '     git filter-repo --replace-text <that file>',
        ]),
    '   then force-push every branch and tag, and ask the host to drop its cached copies (GitHub keeps',
    '   pull requests\' commits until support removes them). git filter-repo is a separate install',
    '   (pip install git-filter-repo). Splice never runs any of this for you.',
  ].join('\n');
}

const quoteArg = (s) => (/^[\w./-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** One finding whole, for the viewer (↵ in /secrets). */
export function secretDetail(f) {
  return [
    `${f.title}  ${place(f)}`,
    '',
    `Commit   ${f.commit.slice(0, 10)}  ${f.subject}`,
    `Author   ${f.author}, ${day(f.date)}`,
    ...(f.line ? [`Line     ${f.excerpt}`] : []),
    `Now      ${f.inTree ? 'still in the working tree: take it out of the code as well' : f.inTree === null ? 'its file is too big to look through for it now' : 'only in the history: removed since, but every clone still has it'}`,
    '',
    f.why,
    '',
    purgeText(f),
  ].join('\n');
}

/** The report `splice security` prints: each finding, its commit and whether it's still there, then the counts. */
export function historyText({ root, findings, commits, truncated, what = 'the current branch' }, { failOn = 'none' } = {}) {
  const lines = [`Secrets in ${what} of ${root}: ${commits} commit${commits === 1 ? '' : 's'} read${truncated ? ` (the newest ${commits}; more not read)` : ''}`];
  if (!findings.length) lines.push('Nothing found.');
  for (const f of sortFindings(findings)) {
    lines.push(`${(LABEL[f.severity] ?? '?').padEnd(5)}${f.title}  ${place(f)}`);
    lines.push(`     in ${f.commit.slice(0, 7)} ${f.subject} (${f.author}, ${day(f.date)}), ${whereNow(f)}`);
    if (f.fix) lines.push(`     ${f.fix}`);
  }
  const failing = failingFindings(findings, failOn);
  if (findings.length) lines.push('', `${findingsLine(countFindings(findings))}${failing.length ? ` · failing on ${failOn} and above` : ''}`);
  return `${lines.join('\n')}\n`;
}
