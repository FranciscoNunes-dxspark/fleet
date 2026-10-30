// What the views draw, and finding a package by what's typed. Pure.
import { theme } from './theme.js';
import { denied, licenceKind, rank } from './audit.js';
import { bumpOf, compareVersions } from './versions.js';

export const SEVERITY_LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** The colour a severity is drawn in (read while drawing, from the theme). */
export const severityTone = (s) => ({ critical: theme.del, high: theme.del, medium: theme.warn, low: theme.info })[s] ?? theme.dim;

/** The colour a licence's kind is drawn in. */
export const licenceTone = (kind) => ({ copyleft: theme.del, weak: theme.warn, unknown: theme.dim })[kind];

/** The colour of how far behind a package is. */
export const bumpTone = (bump) => ({ major: theme.del, minor: theme.warn, patch: theme.info })[bump];

/** A package's licence, from its lock file or what the registry said (`latest`: key → { license }). */
export const licenceOf = (p, latest) => p.license ?? latest?.get(p.key)?.license ?? null;

/** "name@version" as each ecosystem writes it. */
export const label = (p) => `${p.name}@${p.version}`;

/**
 * What the Packages view lists: every package, the `direct` ones, the `outdated` ones (once /outdated has
 * asked), or the `flagged` ones (an advisory, a licence the config denies or a copyleft one, deprecated),
 * from `manifest` (a path) only when one is given. Direct ones first, then by name.
 */
export function packageRows(packages, { filter = 'all', manifest = null, latest = null, found = [], deny = [] } = {}) {
  const vulnerable = new Set(found.map((f) => f.key));
  return packages
    .filter((p) => !manifest || p.where.some((w) => w.path === manifest))
    .filter((p) => {
      if (filter === 'direct') return p.direct;
      if (filter === 'outdated') return Boolean(bumpOf(p.version, latest?.get(p.key)?.latest));
      if (filter === 'flagged') {
        const l = licenceOf(p, latest);
        return vulnerable.has(p.key) || denied(l, deny) || licenceKind(l) === 'copyleft' || Boolean(latest?.get(p.key)?.deprecated);
      }
      return true;
    })
    .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export const FILTERS = ['all', 'direct', 'outdated', 'flagged'];

/** The findings the Vulnerabilities view lists: without the dev-only packages' unless `dev`. */
export const findingRows = (found, { dev = true } = {}) => found.filter((f) => dev || !f.pkg.dev);

/** The package `text` names (name or name@version; a name alone, the first of it), or null. */
export function findPackage(packages, text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const at = t.lastIndexOf('@');
  const [name, version] = at > 0 ? [t.slice(0, at), t.slice(at + 1)] : [t, null];
  const same = (p) => p.name.toLowerCase() === name.toLowerCase() && (!version || p.version === version);
  return packages.find(same) ?? null;
}

/** The finding `text` names: a package as findPackage takes it, or an advisory's id or alias. */
export function findFinding(found, text) {
  const t = String(text ?? '').trim().toLowerCase();
  if (!t) return null;
  const byAdvisory = found.find((f) => f.advisories.some((a) => a.id.toLowerCase() === t || a.aliases.some((x) => x.toLowerCase() === t)));
  if (byAdvisory) return byAdvisory;
  const p = findPackage(found.map((f) => f.pkg), t);
  return p ? found.find((f) => f.pkg === p) : null;
}

/** Findings without the advisories the config ignores (and without findings left with none). */
export function withoutIgnored(found, ignore = []) {
  if (!ignore.length) return found;
  const skip = new Set(ignore.map((s) => s.toLowerCase()));
  const out = [];
  for (const f of found) {
    const advisories = f.advisories.filter((a) => !skip.has(a.id.toLowerCase()) && !a.aliases.some((x) => skip.has(x.toLowerCase())));
    if (!advisories.length) continue;
    if (advisories.length === f.advisories.length) out.push(f);
    else {
      const fixed = advisories.map((a) => a.fixed).filter(Boolean).sort(compareVersions).at(-1) ?? null;
      out.push({ ...f, advisories, severity: advisories.reduce((w, a) => (rank(a.severity) < rank(w) ? a.severity : w), 'unknown'), fixed, unfixed: advisories.some((a) => !a.fixed) });
    }
  }
  return out;
}
