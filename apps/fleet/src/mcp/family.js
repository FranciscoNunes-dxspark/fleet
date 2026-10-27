// The family's own tools: what the apps did (the activity log), how their mascots feel (the moods)
// and what the project points at (its wiring, masked). All of it is the kit's family.js, read only.
import { APP_NAMES, PET_NAMES, projectAt, projectWiring, readActivity, readMoods } from '@fleet/kit/family.js';
import { count, line, sinceOf, stamp } from './bound.js';

export const familyTools = [
  {
    name: 'family_timeline',
    description:
      "What the family's apps did that changed something, newest first, from the shared activity log: Splice's commits and pushes, Bosun's restarts and crashes, Trawl's writes, Hail's sends, Sonar's restarts and swaps, Wharf's container actions. Each entry has when, which app, and what (never a secret).",
    inputSchema: {
      type: 'object',
      properties: {
        all_projects: { type: 'boolean', description: "Every project's entries, not only this project's (default false)" },
        since: { type: 'string', description: 'Only entries after this: an ISO time, or an age such as "90m", "2h", "3d"' },
        app: { type: 'string', description: 'Only this app: splice, trawl, sonar, bosun, hail, wharf, keel' },
        limit: { type: 'integer', description: 'At most this many entries (default 50, at most 500)' },
      },
    },
    run({ all_projects, since, app, limit }, ctx) {
      const max = count(limit, 50, 500);
      const want = app ? String(app).toLowerCase() : null;
      const entries = readActivity({ since: sinceOf(since), project: all_projects ? undefined : ctx.project, limit: want ? 5000 : max })
        .filter((e) => !want || e.app === want)
        .slice(0, max);
      if (!entries.length) return `Nothing in the family's activity log${all_projects ? '' : ` for ${ctx.project}`}${since ? ` since ${since}` : ''}.`;
      return entries.map((e) => `${stamp(e.at)}  ${APP_NAMES[e.app] ?? e.app}  ${e.kind !== 'info' ? `[${e.kind}] ` : ''}${line(e.text, 500)}${all_projects && e.project ? `  (${e.project})` : ''}`).join('\n');
    },
  },
  {
    name: 'family_moods',
    description: "How each app's mascot feels and why, from the last 15 minutes (or `minutes`): a quick read of what's wrong right now (a crashed process in Bosun, new exceptions in Sonar, a failed query in Trawl).",
    inputSchema: {
      type: 'object',
      properties: { minutes: { type: 'integer', description: 'How far back a mood still counts (default 15, at most 1440)' } },
    },
    run({ minutes }) {
      const moods = readMoods(null, { maxAge: count(minutes, 15, 1440) * 60_000 });
      if (!moods.length) return 'No app has said how it feels lately (none is running, or nothing happened).';
      return moods.map((m) => `${APP_NAMES[m.app] ?? m.app} (${PET_NAMES[m.app] ?? m.app}) is ${m.mood}${m.reason ? `: ${line(m.reason)}` : ''}  at ${stamp(m.at)}`).join('\n');
    },
  },
  {
    name: 'family_wiring',
    description:
      "What the project points at, as every app's /wiring shows it: addresses, hosts, ports and connection strings from its appsettings*.json, .env files and Hail's http-client env files, with passwords, keys and tokens masked; plus what each sibling would find there (the repository, a crew for Bosun, .http files for Hail, databases for Trawl).",
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Another folder than the project (relative to it, or absolute)' } } },
    run({ folder }, ctx) {
      const dir = ctx.resolve(folder);
      const p = projectAt(dir);
      const wiring = projectWiring(dir);
      const out = [`Project ${p.dir}`, `repository: ${p.repo ?? 'none'}`, `crew for Bosun: ${p.crew ? 'yes' : 'no'}`, `.http files: ${p.httpFiles.length ? p.httpFiles.map((f) => ctx.relative(f)).join(', ') : 'none'}`];
      if (p.databases.length) out.push(`databases: ${p.databases.map((d) => `${d.name} (${d.source}): ${d.kind} ${d.server}${d.port ? `:${d.port}` : ''}${d.database ? `/${d.database}` : ''}${d.entra ? ', Entra sign-in' : ''}`).join('; ')}`);
      out.push('', wiring.length ? 'Wiring:' : 'Wiring: nothing found (no appsettings*.json, .env or http-client env files with addresses here).');
      let source = null;
      for (const w of wiring) {
        if (w.source !== source) out.push(`  ${(source = w.source)}`);
        out.push(`    ${w.key} = ${line(w.value)}`);
      }
      return out.join('\n');
    },
  },
];
