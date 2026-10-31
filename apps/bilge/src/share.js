// What Bilge hands its siblings (family.js), and the report it writes. Pure.
// A package's place in a manifest goes to Splice as a `file` context: with its line, Splice blames it
// (who brought the package in, and when); without, the file's history.
import { countLine } from './audit.js';
import { SEVERITY_LABEL, label } from './rows.js';

/** The `file` context for where `pkg` is in manifest `path` (a package's `where` entry), or the manifest alone. */
export function fileData(where) {
  return { path: where.path, ...(where.line ? { line: where.line } : {}) };
}

/**
 * The audit as Markdown, for a pull request or a ticket: the counts, then a table of the findings
 * worst first, then the manifests read.
 */
export function markdownReport({ name, manifests, packages, found, when = new Date() }) {
  const c = {};
  for (const f of found) c[f.severity] = (c[f.severity] ?? 0) + 1;
  const lines = [`# Dependencies of ${name}`, '', `${packages.length} packages in ${manifests.length} manifest${manifests.length === 1 ? '' : 's'}, checked against OSV on ${when.toISOString().slice(0, 10)}.`, ''];
  if (!found.length) lines.push('No known vulnerabilities.');
  else {
    lines.push(`**${countLine(c)}**`, '', '| Severity | Package | Advisory | Fixed in | Where |', '| --- | --- | --- | --- | --- |');
    for (const f of found) {
      for (const a of f.advisories) {
        const id = a.aliases.find((x) => x.startsWith('CVE-')) ? `[${a.id}](${a.url}) (${a.aliases.find((x) => x.startsWith('CVE-'))})` : `[${a.id}](${a.url})`;
        lines.push(`| ${SEVERITY_LABEL[a.severity]} | \`${label(f.pkg)}\`${f.pkg.direct ? '' : ' (transitive)'} | ${id} ${a.summary.replace(/\|/g, '\\|')} | ${a.fixed ?? 'no fix yet'} | ${f.pkg.where.map((w) => w.path).join(', ')} |`);
      }
    }
  }
  lines.push('', '## Manifests', '', ...manifests.map((m) => `- \`${m.path}\` (${m.ecosystem}, ${m.packages.length} packages)${m.note ? `: ${m.note}` : ''}`));
  return `${lines.join('\n')}\n`;
}
