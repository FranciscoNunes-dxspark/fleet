// keel security: the security review of Azure DevOps projects (server/domain/devopssecurity.js)
// without the screen, for a pipeline or Fleet's security overview. It prints the findings (or the
// kit's securityJson with --json) and its exit code says whether one is as bad as --fail-on (high
// unless given): 0 fine, 1 found, 2 couldn't run. A secret's value never reaches the output: the
// review keeps only its name and a redacted excerpt, and the JSON leaves excerpts out too.
import { failingFindings, findingsText, parseFailOn, securityJson } from '@fleet/kit/findings.js';

/** { project, json, failOn } from the arguments after `keel security`; an `error` when they don't add up. */
export function parseSecurityArgs(args) {
  const opts = { project: null, json: false, failOn: 'high' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on') {
      const v = parseFailOn(args[++i]);
      if (!v) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
      opts.failOn = v;
    } else if (a.startsWith('--fail-on=')) {
      const v = parseFailOn(a.slice('--fail-on='.length));
      if (!v) return { ...opts, error: '--fail-on is one of critical, high, medium, low, none' };
      opts.failOn = v;
    } else if (a === '--demo' || a === '--mock') continue;
    else if (a.startsWith('-')) return { ...opts, error: `Unknown option ${a}` };
    else opts.project = opts.project ? `${opts.project} ${a}` : a;
  }
  return opts;
}

/** What couldn't be read, as lines: "Commerce: service connections (Azure DevOps refused …)". */
const gapLines = (gaps) => gaps.map((g) => `${g.projectName ? `${g.projectName}: ` : ''}couldn't read ${g.what} (${String(g.error).split('\n')[0]})`);

/**
 * Runs `keel security [project] [--json] [--fail-on level]` over `service` (cli/service.js's, or
 * remote.js's through a Keel server); resolves the exit code. `target` names what was reviewed when
 * no project is given (the organization's address).
 */
export async function runSecurity(args, { service, target = 'tracked projects', write = (s) => process.stdout.write(s), now } = {}) {
  const opts = parseSecurityArgs(args);
  if (opts.error) {
    write(`keel security: ${opts.error}\n`);
    return 2;
  }
  try {
    const review = await service.devopsSecurity({ project: opts.project ?? undefined, fresh: true });
    if (!review.projects.length) {
      write(opts.project ? `keel security: no Azure DevOps project called ${opts.project}.\n` : 'keel security: no tracked Azure DevOps projects. Name one: keel security <project>.\n');
      return 2;
    }
    const names = review.projects.map((p) => p.projectName);
    // Keel's own fields stay out: the organization key is kept, the link and the variable name are in `where` and the fix.
    const findings = review.findings.map(({ webUrl, variable, ...f }) => f);
    if (opts.json) {
      const extra = { projects: names, ...(review.gaps.length ? { gaps: review.gaps.map((g) => ({ project: g.projectName, what: g.what, error: String(g.error).split('\n')[0] })) } : {}) };
      write(`${JSON.stringify(securityJson({ app: 'keel', check: 'devops', target: opts.project ?? target, findings, extra, ...(now ? { now } : {}) }), null, 2)}\n`);
    } else {
      write(findingsText(findings, { failOn: opts.failOn, header: `Azure DevOps security review: ${names.join(', ')}` }));
      const gaps = gapLines(review.gaps);
      if (gaps.length) write(`\nNot reviewed:\n${gaps.map((l) => `  ${l}`).join('\n')}\n`);
    }
    return failingFindings(findings, opts.failOn).length ? 1 : 0;
  } catch (e) {
    write(`keel security: ${String(e.message).split('\n')[0]}\n`);
    return 2;
  }
}
