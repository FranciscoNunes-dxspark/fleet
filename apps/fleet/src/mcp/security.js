// security_overview: the last overview of the project's security (security.js, kept when `fleet
// security` or the host's panel ran the checks), read only: running them is the person's to start, as
// Hail's scan sends requests and the cloud checks use their sign-in.
import { findingPlace, findingsLine } from '@fleet/kit/findings.js';
import { loadOverview, securityConfig } from '../security.js';
import { count, line, stamp } from './bound.js';

export const securityTools = [
  {
    name: 'security_overview',
    description:
      "The project's security as the family last checked it (fleet security, or the prefix and S in Fleet): each app's check (Bilge: dependencies, code and supply chain; Splice: secrets in the git history; Chart: infrastructure as code; and when set up Hail's web scan, Sonar's Azure setup, Locker's secrets, Mooring's servers, Wharf's containers, Keel's Azure DevOps) with its counts, then the findings worst first: severity, app, title, where, and the fix. Secrets are never in it. It doesn't run the checks; say when it's old.",
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: "Only this app's findings: bilge, splice, chart, hail, sonar, locker, mooring, wharf, keel" },
        severity: { type: 'string', description: 'Only findings this bad or worse: critical, high, medium, low (default all)' },
        limit: { type: 'integer', description: 'At most this many findings (default 50, at most 500)' },
      },
    },
    run({ app, severity, limit }, ctx) {
      const { root } = securityConfig(ctx.project);
      const o = loadOverview(root);
      if (!o) return `No security overview for ${root} yet: \`fleet security\` in the project (or the prefix and S, then r, in Fleet) makes one.`;
      const order = ['critical', 'high', 'medium', 'low', 'unknown'];
      const worst = severity ? order.indexOf(String(severity).toLowerCase()) : order.length - 1;
      const want = app ? String(app).toLowerCase() : null;
      const out = [`Security of ${o.project}, checked ${stamp(Date.parse(o.at))}${o.environment ? ` (${o.environment.name}${o.environment.prod ? ', production' : ''})` : ''}: ${findingsLine(o.counts) || 'nothing found'}`];
      for (const c of o.checks) out.push(`  ${c.label}: ${c.ok ? findingsLine(c.counts) || 'nothing found' : `couldn't run: ${line(c.error)}`}`);
      for (const l of o.left ?? []) out.push(`  ${l.app}: not run (${l.why})`);
      const list = o.findings.filter((f) => (!want || f.app === want) && order.indexOf(f.severity) <= (worst < 0 ? order.length - 1 : worst));
      const max = count(limit, 50, 500);
      out.push('');
      for (const f of list.slice(0, max)) out.push(`${f.severity.toUpperCase()}  ${f.app}  ${line(f.title)}  ${findingPlace(f)}${f.fix ? `\n    fix: ${line(f.fix, 400)}` : ''}`);
      if (list.length > max) out.push(`… ${list.length - max} more (raise limit, or narrow by app or severity)`);
      return out.join('\n');
    },
  },
];
