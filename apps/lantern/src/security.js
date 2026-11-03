// Lantern's findings as SARIF, for GitHub's and Azure DevOps' code scanning: every finding is about a
// URL, not a file, so each points at the repository's root with the URL in its message (the kit's
// toSarif does that). Pure.
import { toSarif } from '@fleet/kit/findings.js';

/** SARIF from findings in the shared shape; the category rides along as the rule's tag. */
export const sarifOf = (findings, version) => toSarif({ tool: 'Lantern', version, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/lantern', findings: findings.map((f) => ({ ...f, kind: f.kind ?? f.category })) });

/** Without what `ignore` names: a rule, or rule:where (the page's URL, or a host). */
export function withoutIgnored(list, ignore = []) {
  const set = new Set(ignore);
  return list.filter((f) => !set.has(f.rule) && !set.has(`${f.rule}:${f.where}`) && !(f.host && set.has(`${f.rule}:${f.host}`)));
}
