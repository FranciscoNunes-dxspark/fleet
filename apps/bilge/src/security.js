// Bilge's three checks in the kit's findings.js shape, for `bilge security`, --sarif and /sarif: the
// audit's advisories, the Code view's findings and the supply chain's. Pure.
import { toSarif } from '@fleet/kit/findings.js';
import { label } from './rows.js';

/**
 * The audit's findings (audit.js's, one per vulnerable package) as one finding per advisory: `rule`
 * the advisory's id (GHSA-…, or OSV's own), `where` the manifest it was found in first and `line` the
 * package's line there. The package's own fields ride along.
 */
export function auditFindings(found) {
  return found.flatMap((f) => {
    const at = f.pkg.where.find((w) => !w.path.startsWith('image ')) ?? f.pkg.where[0] ?? { path: '' };
    return f.advisories.map((a) => ({
      rule: a.id,
      severity: a.severity,
      title: `${label(f.pkg)}: ${a.summary}`,
      where: at.path,
      ...(at.line ? { line: at.line } : {}),
      why: `${a.id}${a.aliases.length ? ` (${a.aliases.join(', ')})` : ''} against ${label(f.pkg)}, ${f.pkg.direct ? 'a direct dependency' : 'brought in by another package'}${f.pkg.dev ? ', for development only' : ''}.`,
      fix: a.fixed ? `Move ${f.pkg.name} to ${a.fixed} or later.` : `No version of ${f.pkg.name} fixes ${a.id} yet.`,
      kind: 'dependency',
      package: f.pkg.name,
      version: f.pkg.version,
      ecosystem: f.pkg.ecosystem,
      ...(a.aliases.length ? { aliases: a.aliases } : {}),
      fixed: a.fixed ?? null,
      url: a.url,
    }));
  });
}

/** The Code view's findings (codescan.js's) in the shared shape: without `key` and `path`, and `line` only where there is one. */
export const codeFindings = (list) => list.map(({ key, path, line, ...f }) => ({ ...f, where: f.where ?? path, ...(line ? { line } : {}) }));

/** SARIF for GitHub's and Azure DevOps' code scanning, from findings in the shared shape. */
export const sarifOf = (findings, version) => toSarif({ tool: 'Bilge', version, uri: 'https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/bilge', findings });
