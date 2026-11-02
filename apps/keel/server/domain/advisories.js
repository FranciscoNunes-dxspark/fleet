// The advisory watch's rules (advisories.js runs it): which of a repository's files are lock
// files, what OSV's answer means for them, what is new since the last look, and the inbox
// entries new advisories become. Pure, so every rule can be tested with hand-made records.
import { keyOf, parseNpmLock, parseNugetLock } from '@fleet/kit/lockfiles.js';
import { rank, severityOf } from '@fleet/kit/osv.js';

// npm's and NuGet's. Yarn's and pnpm's aren't read yet (the README says so).
export const LOCK_FILES = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'packages.lock.json': 'NuGet' };
export const MAX_LOCK_FILES = 50;
// What can be chosen as the least severe advisory to be told about.
export const MIN_SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const DEFAULT_MIN_SEVERITY = 'high';
// A new advisory stays in the inbox this long (then it's on the Insights page only).
export const RECENT_DAYS = 7;
const DAY = 86_400_000;

const baseName = (p) => String(p).split('/').pop();

/**
 * The lock files among a repository's file paths: shallowest first (the repository's own
 * before a sample's), never inside node_modules, at most `max`. `more` says some were left out.
 */
export function pickLockFiles(paths, max = MAX_LOCK_FILES) {
  const found = [...new Set(paths)]
    .filter((p) => LOCK_FILES[baseName(p)] && !/(^|\/)node_modules\//.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return { files: found.slice(0, max), more: found.length > max };
}

/** A lock file's packages, by its name. Throws when the text isn't the JSON it should be. */
export function parseLockFile(path, text) {
  return LOCK_FILES[baseName(path)] === 'NuGet' ? parseNugetLock(text) : parseNpmLock(text);
}

// Dotted numbers compared part by part; a pre-release tag is ignored, which is close enough to
// pick the fix in the range a version is in (Bilge has the full comparers).
const parts = (v) => String(v).split(/[-+]/)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** The version that fixes advisory `record` for `pkg`: the end of the range it's in, else the next fix after it, else null. */
export function fixedIn(record, pkg) {
  const same = (name) => (pkg.ecosystem === 'NuGet' ? String(name).toLowerCase() === pkg.name.toLowerCase() : name === pkg.name);
  const fixes = [];
  for (const a of record.affected || []) {
    if (String(a.package?.ecosystem).toLowerCase() !== pkg.ecosystem.toLowerCase() || !same(a.package?.name)) continue;
    for (const range of a.ranges || []) {
      if (range.type === 'GIT') continue;
      let introduced = '0';
      for (const e of range.events || []) {
        if (e.introduced !== undefined) introduced = e.introduced;
        if (e.fixed === undefined) continue;
        fixes.push(e.fixed);
        if (compareVersions(pkg.version, introduced) >= 0 && compareVersions(pkg.version, e.fixed) < 0) return e.fixed;
      }
    }
  }
  return fixes.filter((f) => compareVersions(f, pkg.version) > 0).sort(compareVersions)[0] || null;
}

/** Every package once (by keyOf, with `key`), and the lock files each was found in. */
export function uniquePackages(lockFiles) {
  const out = new Map();
  for (const f of lockFiles) {
    for (const p of f.packages) {
      const key = keyOf(p);
      if (!out.has(key)) out.set(key, { ...p, key, paths: [] });
      if (!out.get(key).paths.includes(f.path)) out.get(key).paths.push(f.path);
    }
  }
  return [...out.values()];
}

const summaryOf = (r) => r.summary || String(r.details || '').split('\n').find((l) => l.trim())?.trim() || '';

/**
 * What OSV said about the packages, one finding per advisory and package version, worst first.
 * `ids` is osv.query's answer (key → [id]), `records` osv.vulns' (id → record).
 */
export function findingsOf(packages, ids, records) {
  const out = [];
  for (const p of packages) {
    for (const id of ids.get(p.key) || []) {
      const r = records.get(id);
      if (!r) continue;
      const { severity, score } = severityOf(r);
      out.push({
        id, ecosystem: p.ecosystem, package: p.name, version: p.version, direct: !!p.direct,
        severity, ...(score != null ? { score } : {}), summary: summaryOf(r).slice(0, 300),
        fixed: fixedIn(r, p), path: p.paths[0], ...(r.aliases?.length ? { aliases: r.aliases.slice(0, 4) } : {}),
      });
    }
  }
  return sortAdvisories(out);
}

/** Worst first, then the higher score, then by package. */
export const sortAdvisories = (list) => list.sort((a, b) => rank(a.severity) - rank(b.severity) || (b.score ?? 0) - (a.score ?? 0) || a.package.localeCompare(b.package) || a.id.localeCompare(b.id));

export const findingKey = (f) => `${f.id}:${f.ecosystem}:${f.package}@${f.version}`;

/**
 * This look's findings against the last one's (`previous`: the repository's stored entry, or
 * null): each keeps when it was first seen, and `added` holds the ones that weren't there. A
 * repository never read before takes a baseline: everything is marked as such and nothing is new.
 */
export function mergeAdvisories(previous, findings, now = new Date().toISOString()) {
  const baseline = !previous?.checkedAt;
  const before = new Map((previous?.advisories || []).map((a) => [findingKey(a), a]));
  const added = [];
  const advisories = findings.map((f) => {
    const old = before.get(findingKey(f));
    if (old) return { ...f, firstSeen: old.firstSeen, ...(old.baseline ? { baseline: true } : {}) };
    const fresh = { ...f, firstSeen: now, ...(baseline ? { baseline: true } : {}) };
    if (!baseline) added.push(fresh);
    return fresh;
  });
  return { advisories, added, baseline };
}

/** Does an advisory of `severity` reach `min`? An unknown severity never does. */
export const atLeast = (severity, min = DEFAULT_MIN_SEVERITY) => severity !== 'unknown' && rank(severity) <= rank(MIN_SEVERITIES.includes(min) ? min : DEFAULT_MIN_SEVERITY);

// Whole sentences, so they translate (client/src/locales/pt/server.js).
const TITLE = {
  critical: '{package} {version} has a critical security advisory',
  high: '{package} {version} has a high-severity security advisory',
  medium: '{package} {version} has a medium-severity security advisory',
  low: '{package} {version} has a low-severity security advisory',
};
const fill = (text, params) => text.replace(/\{(\w+)\}/g, (m, k) => params[k] ?? m);

/**
 * The inbox entries for new advisories: the ones found after a repository's baseline, in the
 * last `days`, at least as severe as `minSeverity`. They are all "high" in the inbox, since the
 * person chose to be told about them, so the live updates, push and channels pick them up as
 * they do any new urgent entry. `repos` are [{ repo, entry }] (entry: what advisories.js stores).
 */
export function advisoryAttention(repos, { minSeverity = DEFAULT_MIN_SEVERITY, now = Date.now(), days = RECENT_DAYS } = {}) {
  const out = [];
  for (const { repo, entry } of repos) {
    for (const a of entry?.advisories || []) {
      if (a.baseline || !atLeast(a.severity, minSeverity) || now - Date.parse(a.firstSeen) > days * DAY) continue;
      out.push({
        key: `advisory:${repo.projectId}/${repo.id}:${findingKey(a)}`,
        kind: 'advisory',
        severity: 'high',
        title: fill(TITLE[a.severity], { package: a.package, version: a.version }),
        context: `${repo.projectName} / ${repo.name} · ${a.path}`,
        reasons: [
          { code: 'advisory', severity: 'high', text: a.summary ? `${a.id}: ${a.summary}` : a.id },
          { code: 'advisory-fix', severity: 'medium', text: a.fixed ? fill('Fixed in {version}', { version: a.fixed }) : 'No fixed version yet' },
        ],
        at: a.firstSeen,
        target: { type: 'advisory', projectId: repo.projectId, repoId: repo.id },
        webUrl: `https://osv.dev/vulnerability/${encodeURIComponent(a.id)}`,
      });
    }
  }
  return out;
}
