// What OSV's advisories mean for the packages found: how bad each one is, the version that fixes it, and
// the findings the Vulnerabilities view lists; and what kind of licence a package has. Pure.
import { comparerFor } from './versions.js';
import { SEVERITIES, rank, severityOf } from '@fleet/kit/osv.js';

export { SEVERITIES, rank, cvss3Score, severityOfScore, severityOf } from '@fleet/kit/osv.js';

const sameName = (ecosystem, a, b) => (ecosystem === 'NuGet' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/**
 * The version that fixes `vuln` for package `pkg` ({ ecosystem, name, version }): the end of the range
 * its version is in, else the lowest fix above it; null when there is none yet.
 */
export function fixedIn(vuln, pkg) {
  const compare = comparerFor(pkg.ecosystem);
  const fixes = [];
  for (const affected of vuln.affected ?? []) {
    const p = affected.package ?? {};
    if (String(p.ecosystem).toLowerCase() !== pkg.ecosystem.toLowerCase() || !sameName(pkg.ecosystem, p.name, pkg.name)) continue;
    for (const range of affected.ranges ?? []) {
      if (range.type === 'GIT') continue;
      let introduced = '0';
      for (const e of range.events ?? []) {
        if (e.introduced !== undefined) introduced = e.introduced;
        if (e.fixed !== undefined) {
          fixes.push(e.fixed);
          if ((introduced === '0' || compare(pkg.version, introduced) >= 0) && compare(pkg.version, e.fixed) < 0) return e.fixed;
        }
      }
    }
  }
  return fixes.filter((f) => compare(f, pkg.version) > 0).sort(compare)[0] ?? null;
}

/** An advisory as Bilge shows it, for package `pkg`. */
export function advisory(vuln, pkg) {
  const aliases = [...(vuln.aliases ?? [])].sort((a, b) => Number(b.startsWith('CVE-')) - Number(a.startsWith('CVE-')));
  const summary = vuln.summary || String(vuln.details ?? '').split('\n').find((l) => l.trim())?.trim() || '(no summary)';
  const refs = vuln.references ?? [];
  return {
    id: vuln.id,
    aliases,
    summary,
    ...severityOf(vuln),
    fixed: fixedIn(vuln, pkg),
    url: `https://osv.dev/vulnerability/${vuln.id}`,
    advisoryUrl: refs.find((r) => r.type === 'ADVISORY')?.url ?? refs[0]?.url ?? null,
    published: vuln.published ?? null,
  };
}

/**
 * The findings: one per vulnerable package and version, its advisories worst first, with the worst
 * severity and the version that fixes them all (`fixed`; `unfixed` when one of them has no fix yet).
 * `ids` is OSV's answer (key → [ids]), `details` the advisories by id. Worst first, then by name.
 */
export function findings(packages, ids, details) {
  const out = [];
  for (const pkg of packages) {
    const list = (ids.get(pkg.key) ?? []).map((id) => details.get(id)).filter(Boolean).map((v) => advisory(v, pkg));
    if (!list.length) continue;
    list.sort((a, b) => rank(a.severity) - rank(b.severity) || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));
    const fixes = list.map((a) => a.fixed);
    const fixed = fixes.filter(Boolean).sort(comparerFor(pkg.ecosystem)).at(-1) ?? null;
    out.push({ key: pkg.key, pkg, advisories: list, severity: list[0].severity, fixed, unfixed: fixes.some((f) => !f) });
  }
  return out.sort((a, b) => rank(a.severity) - rank(b.severity) || Number(b.pkg.direct) - Number(a.pkg.direct) || a.pkg.name.localeCompare(b.pkg.name));
}

/** How many findings of each severity: { critical, high, medium, low, unknown }. */
export function counts(list) {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of list) out[f.severity]++;
  return out;
}

/** "2 critical · 5 high", the severities there are, worst first; '' for none. */
export function countLine(c) {
  return SEVERITIES.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(' · ');
}

const COPYLEFT = /\b(A?GPL|SSPL|EUPL|OSL|CPAL|RPL|QPL|Sleepycat|CC-BY-SA|CC-BY-NC)/i;
const WEAK = /\b(LGPL|MPL|EPL|CDDL|CPL|MS-RL)/i;
const UNKNOWN = /^(|UNKNOWN|NOASSERTION|SEE LICEN[CS]E IN .*|UNLICENSED)$/i;

/**
 * What kind of licence an SPDX expression (or a licence's name or address) is: 'copyleft', 'weak'
 * copyleft (LGPL, MPL, EPL…), 'permissive', or 'unknown' (none given, UNLICENSED, a file of its own). An
 * "OR" takes the friendliest choice; anything else the strictest part.
 */
export function licenceKind(licence) {
  const s = String(licence ?? '').trim().replace(/^\(|\)$/g, '');
  if (UNKNOWN.test(s)) return 'unknown';
  if (/\s+OR\s+/i.test(s)) {
    const kinds = s.split(/\s+OR\s+/i).map(licenceKind);
    return ['permissive', 'weak', 'copyleft', 'unknown'].find((k) => kinds.includes(k));
  }
  if (WEAK.test(s)) return COPYLEFT.test(s.replace(/LGPL/gi, '')) ? 'copyleft' : 'weak';
  if (COPYLEFT.test(s)) return 'copyleft';
  return 'permissive';
}

/**
 * Whether a package's licence is one the config's `deny` list names (SPDX ids, any case, a prefix like
 * "GPL-" covering its versions). With an "OR", only when every choice is.
 */
export function denied(licence, deny = []) {
  const s = String(licence ?? '').toLowerCase().replace(/^\(|\)$/g, '');
  if (!s || !deny.length) return false;
  if (/\s+or\s+/.test(s)) return s.split(/\s+or\s+/).every((part) => denied(part, deny));
  return deny.some((d) => s.split(/[\s()]+/).some((part) => part && part !== 'and' && part !== 'with' && part.startsWith(String(d).toLowerCase())));
}
