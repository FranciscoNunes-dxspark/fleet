// What OSV's advisories mean for the packages found: how bad each one is, the version that fixes it, and
// the findings the Vulnerabilities view lists; and what kind of licence a package has. Pure.
import { compareVersions } from './versions.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'];
export const rank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
};

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
};

// CVSS 3.1's own rounding up to one decimal, which avoids floating point's near misses.
const roundUp = (x) => {
  const n = Math.round(x * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
};

/** A CVSS 3.0 or 3.1 vector's base score (CVSS:3.1/AV:N/AC:L/…), or null when it isn't one. */
export function cvss3Score(vector) {
  const m = Object.fromEntries(
    String(vector ?? '')
      .split('/')
      .map((p) => p.split(':')),
  );
  if (!/^3\.[01]$/.test(m.CVSS ?? '')) return null;
  const changed = m.S === 'C';
  const av = WEIGHTS.AV[m.AV];
  const ac = WEIGHTS.AC[m.AC];
  const ui = WEIGHTS.UI[m.UI];
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const [c, i, a] = [m.C, m.I, m.A].map((x) => WEIGHTS.CIA[x]);
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploit) : impact + exploit, 10));
}

/** The severity a score falls in. */
export function severityOfScore(score) {
  if (score == null) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return score > 0 ? 'low' : 'unknown';
}

/**
 * How bad an OSV advisory is: { severity, score? }. GitHub's own word first (database_specific.severity:
 * LOW, MODERATE, HIGH, CRITICAL), then the CVSS 3 vector's score.
 */
export function severityOf(vuln) {
  const vector = (vuln.severity ?? []).find((s) => /^CVSS_V3/.test(s.type))?.score;
  const score = cvss3Score(vector);
  const said = String(vuln.database_specific?.severity ?? '').toLowerCase();
  const word = said === 'moderate' ? 'medium' : said;
  if (SEVERITIES.includes(word) && word !== 'unknown') return { severity: word, ...(score != null ? { score } : {}) };
  return { severity: severityOfScore(score), ...(score != null ? { score } : {}) };
}

const sameName = (ecosystem, a, b) => (ecosystem === 'NuGet' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/**
 * The version that fixes `vuln` for package `pkg` ({ ecosystem, name, version }): the end of the range
 * its version is in, else the lowest fix above it; null when there is none yet.
 */
export function fixedIn(vuln, pkg) {
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
          if ((introduced === '0' || compareVersions(pkg.version, introduced) >= 0) && compareVersions(pkg.version, e.fixed) < 0) return e.fixed;
        }
      }
    }
  }
  return fixes.filter((f) => compareVersions(f, pkg.version) > 0).sort(compareVersions)[0] ?? null;
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
    const fixed = fixes.filter(Boolean).sort(compareVersions).at(-1) ?? null;
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
