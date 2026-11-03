// The check before pushing: files too big for GitHub, and what look like secrets in the lines the commits
// add. Pure: the log arguments, parsing what git says, the scan and its report. actions.js runs it before
// P and /push, unless "Check before pushing" is off in /settings.
import { commitFindings } from './secrets.js';

export const MB = 1024 * 1024;
export const BIG_FILE = 50 * MB;
// GitHub refuses a push with a file over this.
export const HARD_LIMIT = 100 * MB;
// The commits looked at, newest first: enough for any branch, and a first push of a long history stays quick.
export const MAX_COMMITS = 300;

export const LOG_RECORD = '%x1e%H%x1f%s';

/**
 * `git log` arguments for the commits in `range` (rev-list arguments): their files' blob ids (--raw) and their
 * added lines (-U0). Files over 2 MB count as binary, so a huge file isn't printed line by line (its size
 * is still checked).
 */
export function pushLogArgs(range, { patch = true, max = MAX_COMMITS } = {}) {
  return [
    '-c',
    'core.bigFileThreshold=2m',
    'log',
    `--max-count=${max}`,
    '--no-merges',
    '--no-renames',
    '--no-ext-diff',
    '--raw',
    '--no-abbrev',
    ...(patch ? ['-p', '-U0', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'] : []),
    `--format=${LOG_RECORD}`,
    ...range,
    '--',
  ];
}

/**
 * The commits about to be pushed, as rev-list arguments. Pushing to the branch's upstream: what it doesn't
 * have yet. To another remote (`remote`), or a branch with no upstream: what no branch on that remote
 * (or on any remote) has.
 */
export function pushRange({ upstream = null, remote = null } = {}) {
  if (remote && !(upstream ?? '').startsWith(`${remote}/`)) return ['HEAD', '--not', `--remotes=${remote}`];
  if (upstream) return ['@{upstream}..HEAD'];
  return ['HEAD', '--not', '--remotes'];
}

/**
 * Parses pushLogArgs's output: [{ hash, subject, files: [{ path, blob, status }], patch }]. `blob` is the
 * file's new blob id (null when the commit deletes it).
 */
export function parsePushLog(raw) {
  const out = [];
  for (const rec of raw.split('\x1e')) {
    if (!rec.includes('\x1f')) continue;
    const nl = rec.indexOf('\n');
    const head = nl < 0 ? rec : rec.slice(0, nl);
    const body = nl < 0 ? '' : rec.slice(nl + 1);
    const [hash, subject] = head.split('\x1f');
    const files = [];
    const lines = body.split('\n');
    let i = 0;
    for (; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('diff --git ')) break;
      const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) (\w)\d*\t(.*)$/.exec(l);
      if (m) files.push({ path: m[3], blob: /^0+$/.test(m[1]) ? null : m[1], status: m[2] });
    }
    out.push({ hash, subject: subject ?? '', files, patch: lines.slice(i).join('\n') });
  }
  return out;
}

/** Parses `git cat-file --batch-check` ("<id> <type> <size>" a line) into id → size. */
export function parseBatchCheck(raw) {
  const sizes = new Map();
  for (const line of raw.split('\n')) {
    const [id, type, size] = line.split(' ');
    if (type && size && type !== 'missing') sizes.set(id, Number(size));
  }
  return sizes;
}

/** The blob ids to ask cat-file the sizes of, each once. */
export const blobIds = (commits) => [...new Set(commits.flatMap((c) => c.files.map((f) => f.blob).filter(Boolean)))];

/** The files at least `limit` bytes big, each path and version once: [{ path, size, hash, subject }]. */
export function bigFiles(commits, sizes, limit = BIG_FILE) {
  const seen = new Set();
  const out = [];
  for (const c of commits) {
    for (const f of c.files) {
      const size = f.blob ? sizes.get(f.blob) : null;
      if (size == null || size < limit || seen.has(f.blob)) continue;
      seen.add(f.blob);
      out.push({ path: f.path, size, hash: c.hash, subject: c.subject });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

/**
 * The added lines of a commit's patch (-U0) that hold a secret, by the kit's rules (secrets.js, as /secrets
 * reads the history), and the key stores and .env files it adds: findings with { hash, subject }, each
 * excerpt redacted.
 */
export const scanCommit = (commit) => commitFindings(commit).map((f) => ({ ...f, hash: commit.hash, subject: commit.subject }));

/** Everything the check found in the commits: { big, secrets, commits }. */
export function checkCommits(commits, sizes) {
  return { big: bigFiles(commits, sizes), secrets: commits.flatMap(scanCommit), commits: commits.length };
}

export const foundCount = (found) => found.big.length + found.secrets.length;

const mb = (n) => `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;

/** "a file over 50 MB and 2 possible secrets" */
export function foundSummary(found) {
  const parts = [];
  const { big, secrets } = found;
  if (big.length) parts.push(big.length === 1 ? 'a file over 50 MB' : `${big.length} files over 50 MB`);
  if (secrets.length) parts.push(secrets.length === 1 ? 'what looks like a secret' : `${secrets.length} things that look like secrets`);
  return parts.join(' and ');
}

/** The report for the viewer: each find, where it is, and what to do about it. */
export function pushCheckText(found) {
  const at = (x) => `${x.hash.slice(0, 7)} ${x.subject}`;
  const out = [];
  if (found.big.length) {
    out.push(`Big files (${found.big.length})`);
    for (const f of found.big) {
      out.push(`  ${f.path}  ${mb(f.size)}${f.size > HARD_LIMIT ? ', over GitHub\'s 100 MB limit: the push will be refused' : ''}`, `      in ${at(f)}`);
    }
    out.push(
      '',
      '  A file this size makes every clone slower, and GitHub refuses files over 100 MB. Take it out of the',
      '  commit (z undoes the last one; i in the graph edits an older one) and track it with Git LFS instead.',
      '',
    );
  }
  if (found.secrets.length) {
    out.push(`Possible secrets (${found.secrets.length})`);
    for (const s of found.secrets) out.push(`  ${s.line ? `${s.where}:${s.line}` : s.where}  ${s.title}${s.line ? `: ${s.excerpt}` : ''}`, `      in ${at(s)}`);
    out.push(
      '',
      '  Once pushed, a secret is out: anyone who can read the repository has it, in its history too. If it',
      '  is real, take it out of the commit before pushing (z undoes the last one; i in the graph edits an',
      '  older one), and if it was ever pushed, change it. /secrets looks through the whole history.',
      '',
    );
  }
  out.push(`Looked at ${found.commits} commit${found.commits === 1 ? '' : 's'}. "Check before pushing" in /settings turns this off.`);
  return out.join('\n');
}
