// A bundled package's known advisories, from OSV through the kit's osv.js (the same database Bilge
// asks), said as the package detail shows them. Pure.
import { severityOf, rank } from '@fleet/kit/osv.js';
import { compareVersions } from './packages.js';

/**
 * The fixed version for `version` from an OSV record's ranges for `name`: the first `fixed` after the
 * version (or after an `introduced` it is past), or null when none says.
 */
export function fixedIn(record, name, version) {
  const fixes = [];
  for (const a of record.affected ?? []) {
    if (a.package?.name !== name) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) fixes.push(e.fixed);
  }
  return fixes.filter((f) => compareVersions(f, version) > 0).sort(compareVersions)[0] ?? null;
}

/** An OSV record as the detail lists it: { id, aliases, summary, severity, score?, fixed, url }. */
export function advisoryOf(record, name, version) {
  const { severity, score } = severityOf(record);
  return {
    id: record.id,
    aliases: record.aliases ?? [],
    summary: String(record.summary ?? record.details ?? '').split('\n')[0].slice(0, 200),
    severity,
    ...(score != null ? { score } : {}),
    fixed: fixedIn(record, name, version),
    url: `https://osv.dev/vulnerability/${record.id}`,
  };
}

/** A package's advisories, worst first, from OSV's ids for it and the records. */
export function advisoriesFor(name, version, ids = [], details = new Map()) {
  return ids
    .map((id) => details.get(id))
    .filter(Boolean)
    .map((r) => advisoryOf(r, name, version))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
}
