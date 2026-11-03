// Security findings, the same way in every app: one shape, the counts, --fail-on, the JSON a pipeline
// (and Fleet's security overview) reads, SARIF for GitHub's and Azure DevOps' code scanning, and the
// text a headless command prints. Pure.
//
// A finding is { rule, severity, title, where, line?, why?, fix?, excerpt?, kind? }:
// - `rule` a stable id (`tls-off`, `nsg-open-ssh`), what an ignore list names;
// - `severity` one of SEVERITIES (osv.js's: critical, high, medium, low, unknown);
// - `where` what it's about, as a person would find it: a path (relative, /-separated), a URL, a host,
//   an Azure resource id, a pipeline; `line` with a path;
// - `why` and `fix` a sentence each; `excerpt` what was seen, never a secret (redact it first).
// Apps may add fields of their own; these are the ones read here and by Fleet.
import { SEVERITIES, rank } from './osv.js';

export { SEVERITIES, rank };

/** { critical: n, high: n, medium: n, low: n, unknown: n }. */
export function countFindings(list) {
  const out = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of list) out[f.severity in out ? f.severity : 'unknown']++;
  return out;
}

/** "2 critical · 5 high", the severities there are, worst first; '' for none. */
export const findingsLine = (counts) => SEVERITIES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ');

/** Worst first, then by where and line. */
export const sortFindings = (list) => [...list].sort((a, b) => rank(a.severity) - rank(b.severity) || String(a.where).localeCompare(String(b.where)) || (a.line ?? 0) - (b.line ?? 0));

/** Without what `ignore` names: a rule's id, or `rule:where` for that rule on that one thing. */
export function withoutIgnoredFindings(list, ignore = []) {
  const set = new Set(ignore);
  return list.filter((f) => !set.has(f.rule) && !set.has(`${f.rule}:${f.where}`));
}

/** The value --fail-on takes: a severity or none; null when `value` isn't one. */
export function parseFailOn(value) {
  const v = String(value ?? '').toLowerCase();
  return v === 'none' || (SEVERITIES.includes(v) && v !== 'unknown') ? v : null;
}

/** The findings as bad as `failOn` or worse (none for 'none'): a headless command exits 1 when there are any. */
export const failingFindings = (list, failOn = 'high') => (failOn === 'none' ? [] : list.filter((f) => f.severity !== 'unknown' && rank(f.severity) <= rank(failOn)));

/** "path:line", or `where` alone. */
export const findingPlace = (f) => (f.line ? `${f.where}:${f.line}` : String(f.where));

/**
 * The JSON a headless security command prints with --json, the same for every app so Fleet can add
 * them up: { app, check, target, at, counts, findings }. `excerpt` is left out unless `excerpts`, as
 * build logs are read widely.
 */
export function securityJson({ app, check, target, findings, extra = {}, excerpts = false, now = new Date() }) {
  const list = sortFindings(findings).map((f) => (excerpts ? f : Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'excerpt'))));
  return { app, check, target, at: now.toISOString(), counts: countFindings(findings), ...extra, findings: list };
}

/** Whether a finding's `where` is a file in the repository: relative, not a URL, not an Azure resource id or a host. */
export const looksLikeFile = (f) => {
  const w = String(f.where ?? '');
  if (!w || /^\w[\w+.-]*:\/\//.test(w) || w.startsWith('/') || /\s/.test(w)) return false;
  return Boolean(f.line) || w.includes('/') || /\.[\w-]+$/.test(w) || /^(Dockerfile|Containerfile|Makefile)$/.test(w);
};

const SARIF_LEVEL = { critical: 'error', high: 'error', medium: 'warning', low: 'note', unknown: 'note' };
// GitHub orders code scanning alerts by this number (0-10) when it's given.
const SECURITY_SEVERITY = { critical: '9.5', high: '8.0', medium: '5.5', low: '2.0', unknown: '0.0' };

/**
 * SARIF 2.1.0 for GitHub's code scanning (upload-sarif) and Azure DevOps' SARIF viewer: one rule per
 * distinct `rule`, one result per finding. A finding whose `where` isn't a file (a URL, a resource)
 * keeps it in the message and points at `fallback` (the repository's root, by default), as SARIF
 * results need a location.
 */
export function toSarif({ tool, version = '0.0.0', uri, findings, isFile = looksLikeFile, fallback = '.' }) {
  const rules = new Map();
  for (const f of findings) {
    if (rules.has(f.rule)) continue;
    rules.set(f.rule, {
      id: f.rule,
      name: f.rule.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase()),
      shortDescription: { text: f.title },
      ...(f.why ? { fullDescription: { text: f.why } } : {}),
      ...(f.fix ? { help: { text: f.fix } } : {}),
      defaultConfiguration: { level: SARIF_LEVEL[f.severity] ?? 'note' },
      properties: { 'security-severity': SECURITY_SEVERITY[f.severity] ?? '0.0', tags: ['security', ...(f.kind ? [f.kind] : [])] },
    });
  }
  const ids = [...rules.keys()];
  const results = sortFindings(findings).map((f) => {
    const file = isFile(f);
    return {
      ruleId: f.rule,
      ruleIndex: ids.indexOf(f.rule),
      level: SARIF_LEVEL[f.severity] ?? 'note',
      message: { text: `${f.title}${file ? '' : ` (${f.where})`}${f.fix ? `. ${f.fix}` : ''}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: file ? String(f.where) : fallback }, ...(file && f.line ? { region: { startLine: f.line } } : {}) } }],
      partialFingerprints: { primaryLocationLineHash: `${f.rule}:${f.where}:${f.line ?? 0}` },
    };
  });
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: tool, version, ...(uri ? { informationUri: uri } : {}), rules: [...rules.values()] } }, results }],
  };
}

const LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/** The findings as a headless command prints them: severity, title, where, then the fix; the counts last. */
export function findingsText(findings, { failOn = 'none', header = '' } = {}) {
  const list = sortFindings(findings);
  const lines = header ? [header] : [];
  if (!list.length) lines.push('Nothing found.');
  for (const f of list) {
    lines.push(`${LABEL[f.severity] ?? '?'}`.padEnd(5) + `${f.title}  ${findingPlace(f)}`);
    if (f.fix) lines.push(`     ${f.fix}`);
  }
  const failing = failingFindings(list, failOn);
  if (list.length) lines.push('', `${findingsLine(countFindings(list))}${failing.length ? ` · failing on ${failOn} and above` : ''}`);
  return `${lines.join('\n')}\n`;
}
