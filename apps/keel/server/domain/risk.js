// A pull request's risk, 0 to 100, as the reasons that add up to it: how big it is, whether it
// changes places that changed a lot lately, what it touches (dependencies, infrastructure as code,
// database migrations, pipelines, auth and security), source changed with no tests, how many code
// owners have to sign it off, and whether its author has worked in these places before. Every
// weight is in RISK_WEIGHTS, documented in the README; the score is their sum, capped at 100.
import { DAY, sameIdentity } from './prs.js';

export const RISK_WEIGHTS = {
  // Lines changed (added and removed), as [up to, points]; only GitHub says how many.
  lines: [[50, 0], [200, 5], [500, 10], [1000, 15], [Infinity, 20]],
  // Files changed, as [up to, points].
  files: [[5, 0], [15, 4], [40, 8], [Infinity, 12]],
  // A folder is hot when this many commits touched it in the last `churnDays` days; each hot one it
  // changes adds `churnEach`, up to `churnMax`.
  churnCommits: 10,
  churnDays: 30,
  churnEach: 4,
  churnMax: 12,
  // What it touches, each counted once however many files do.
  dependencies: 10,
  infrastructure: 12,
  migrations: 12,
  pipelines: 8,
  security: 12,
  // Source files changed and no test changed with them.
  noTests: 10,
  // Each required reviewer (a code owner, or a group a branch policy adds) adds this, up to `ownersMax`.
  ownerEach: 3,
  ownersMax: 9,
  // The author has no commits in any of the folders it changes in the history read (180 days), or in only some.
  newAuthor: 10,
  partlyNewAuthor: 5,
  // The score's level: high from here, medium from there, else low.
  high: 60,
  medium: 30,
};

// What a path is, by its name alone.
const KINDS = {
  dependencies: [
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|package\.json)$/i,
    /(^|\/)(packages\.lock\.json|packages\.config|directory\.packages\.props|[^/]+\.csproj|[^/]+\.fsproj|[^/]+\.vbproj|nuget\.config|global\.json)$/i,
    /(^|\/)(go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile|gemfile\.lock|composer\.json|composer\.lock|requirements[^/]*\.txt|pipfile(\.lock)?|poetry\.lock|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile)$/i,
  ],
  infrastructure: [
    /\.(tf|tfvars|bicep|bicepparam)$/i,
    /(^|\/)(azuredeploy[^/]*\.json|[^/]+\.arm\.json|maintemplate\.json|[^/]*\.parameters\.json)$/i,
    /(^|\/)(arm|bicep|terraform|infra|infrastructure|iac)\/.+\.(json|ya?ml)$/i,
  ],
  migrations: [
    /(^|\/)(migrations?|db\/migrate|dbmigrations?|flyway|liquibase|changelogs?)\//i,
    /(^|\/)v\d+(_\d+)*__[^/]+\.sql$/i,
    /\.sql$/i,
  ],
  pipelines: [
    /(^|\/)azure-pipelines[^/]*\.ya?ml$/i,
    /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i,
    /(^|\/)\.azuredevops\/.+\.ya?ml$/i,
    /(^|\/)(pipelines?|\.pipelines|ci|\.ci|build)\/[^/]+\.ya?ml$/i,
    /(^|\/)(\.gitlab-ci\.yml|jenkinsfile|[^/]+\.pipeline\.ya?ml)$/i,
  ],
  security: [
    /(^|\/|[-_.])(auth|authn|authz|authentication|authorization|security|identity|login|signin|sign-in|oauth|oidc|saml|sso|jwt|tokens?|crypto|cryptography|encryption|secrets?|passwords?|permissions?|rbac|acl|csrf|cors)([-_./]|$)/i,
  ],
};
const TEST = /(^|\/)(tests?|specs?|__tests__|testing|e2e|cypress|playwright)\/|([._-](test|tests|spec|specs)\.[a-z0-9]+$)|(tests?\.(cs|fs|vb)$)|(_test\.(go|py)$)|(^|\/)test_[^/]+\.py$/i;
const SOURCE = /\.(cs|fs|vb|java|kt|kts|scala|go|rs|py|rb|php|js|jsx|mjs|cjs|ts|tsx|vue|svelte|swift|m|mm|c|cc|cpp|h|hpp|dart|ex|exs|sql)$/i;

/** What a path is (dependencies, infrastructure, migrations, pipelines, security), as a list of kinds. */
export function pathKinds(path) {
  const p = String(path || '');
  return Object.keys(KINDS).filter((k) => KINDS[k].some((re) => re.test(p)));
}

/** Whether a path is a test, and whether it is source code a test would cover. */
export const isTest = (path) => TEST.test(String(path || ''));
export const isSource = (path) => SOURCE.test(String(path || '')) && !isTest(path) && !pathKinds(path).includes('migrations');

const step = (table, n) => table.find(([upTo]) => n <= upTo)[1];
const folderOf = (path) => {
  const p = String(path || '');
  return p.slice(0, p.lastIndexOf('/')) || '/';
};

// Reasons as templates the web app translates (t(text, params)) and the terminal fills.
export const REASONS = {
  lines: '{n} lines changed in {files} files',
  files: '{files} files changed (line counts not known)',
  churn: 'Changes {n} folders that changed often lately (commits in {days} days: {where})',
  churnOne: 'Changes a folder that changed often lately (commits in {days} days: {where})',
  dependencies: 'Changes dependencies ({files})',
  infrastructure: 'Changes infrastructure as code ({files})',
  migrations: 'Changes database migrations ({files})',
  pipelines: 'Changes CI or pipeline definitions ({files})',
  security: 'Touches auth or security code ({files})',
  noTests: 'Changes {n} source files and no tests',
  owners: 'Needs {n} code owners to approve',
  ownersOne: 'Needs a code owner to approve',
  newAuthor: '{name} has no commits in these folders in the last {days} days',
  partlyNewAuthor: '{name} has no commits in {n} of these {total} folders in the last {days} days',
  noFiles: 'Its files could not be read, so only its reviewers count',
};

/** A reason in English, its {placeholders} filled. */
export const reasonText = (r) => r.text.replace(/\{(\w+)\}/g, (m, k) => String(r.params?.[k] ?? m));

const listed = (paths, n = 2) => {
  const names = paths.map((p) => p.split('/').pop());
  return names.length > n ? `${names.slice(0, n).join(', ')} +${names.length - n}` : names.join(', ');
};

// A commit is the author's when its email is their sign-in name or email, or its name is theirs.
const byAuthor = (author) => (c) => {
  const email = String(c.author?.email || '').toLowerCase();
  const ids = [author?.uniqueName, author?.email].filter(Boolean).map((x) => String(x).toLowerCase());
  return (email && ids.includes(email)) || (!!c.author?.name && c.author.name === author?.displayName) || sameIdentity(c.author, author);
};
const isMerge = (c) => /^(Merged PR \d+:|Merge pull request #\d+ from )/.test(c.message || '');

/**
 * pr: a pull request (its author and reviewers); files: [{ path, lines? }] (null when they couldn't
 * be read); history: [{ dir, commits }] the commits that touched each folder it changes, newest first
 * (the last 180 days). Returns { score, level, reasons: [{ id, points, text, params }] }, the
 * reasons biggest first.
 */
export function scorePr({ pr, files, history = [], now = Date.now(), weights = RISK_WEIGHTS, historyDays = 180 }) {
  const w = weights;
  const reasons = [];
  // `one` picks the reason's wording for a count of one ("a folder" rather than "1 folders").
  const add = (id, points, params, one = false) => points > 0 && reasons.push({ id, points, text: REASONS[one ? `${id}One` : id], params });

  if (files) {
    const paths = files.map((f) => f.path).filter(Boolean);
    const known = files.filter((f) => Number.isFinite(f.lines));
    if (known.length && known.length === files.length) {
      const lines = known.reduce((n, f) => n + f.lines, 0);
      add('lines', Math.max(step(w.lines, lines), step(w.files, paths.length)), { n: lines, files: paths.length });
    } else {
      add('files', step(w.files, paths.length), { files: paths.length });
    }

    const since = now - w.churnDays * DAY;
    const hot = history
      .map((h) => ({ dir: h.dir, n: (h.commits || []).filter((c) => !isMerge(c) && Date.parse(c.author?.date) >= since).length }))
      .filter((h) => h.n >= w.churnCommits)
      .sort((a, b) => b.n - a.n);
    add('churn', Math.min(w.churnMax, hot.length * w.churnEach), { n: hot.length, days: w.churnDays, where: hot.slice(0, 2).map((h) => `${h.dir} ${h.n}`).join(', ') }, hot.length === 1);

    for (const kind of Object.keys(KINDS)) {
      const hits = paths.filter((p) => pathKinds(p).includes(kind));
      if (hits.length) add(kind, w[kind], { files: listed(hits) });
    }

    const source = paths.filter(isSource);
    if (source.length && !paths.some(isTest)) add('noTests', w.noTests, { n: source.length });

    const dirs = [...new Set(paths.map(folderOf))];
    const read = history.filter((h) => dirs.includes(h.dir) || dirs.some((d) => d.startsWith(`${h.dir}/`)));
    if (pr.author && read.length) {
      const fresh = read.filter((h) => !(h.commits || []).some((c) => !isMerge(c) && byAuthor(pr.author)(c)));
      const name = pr.author.displayName || 'The author';
      if (fresh.length === read.length) add('newAuthor', w.newAuthor, { name, days: historyDays });
      else if (fresh.length) add('partlyNewAuthor', w.partlyNewAuthor, { name, n: fresh.length, total: read.length, days: historyDays });
    }
  } else {
    reasons.push({ id: 'noFiles', points: 0, text: REASONS.noFiles, params: {} });
  }

  const owners = (pr.reviewers || []).filter((r) => r.isRequired && !sameIdentity(r, pr.author));
  add('owners', Math.min(w.ownersMax, owners.length * w.ownerEach), { n: owners.length }, owners.length === 1);

  const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0));
  return {
    score,
    level: score >= w.high ? 'high' : score >= w.medium ? 'medium' : 'low',
    reasons: reasons.sort((a, b) => b.points - a.points),
  };
}
