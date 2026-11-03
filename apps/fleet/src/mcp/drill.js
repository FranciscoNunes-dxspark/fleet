// Drill's side: what the project's tests did in the runs Drill kept (its history, ~/.drill/history,
// DRILL_HOME), read through Drill's own flaky.js. It never runs a test: running them is the person's to
// start, in Drill or with `drill run --json`.
import { count, line, stamp } from './bound.js';

const drill = () => import('../../../drill/src/flaky.js');

export const drillTools = [
  {
    name: 'drill_tests',
    description:
      "The project's tests as Drill last ran them: when, how many passed and failed, each test that failed in the latest run (runner, file and line, suite, name), and the flaky ones (passed and failed in the last 10 runs). Nothing is run here; when there's no history, say to run the tests in Drill (or `drill run --json`). Failure messages aren't kept between runs: ask the person, or Drill, for those.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'At most this many failed tests (default 50, at most 500)' },
      },
    },
    async run({ limit }, ctx) {
      const { loadHistory, flakyTests } = await drill();
      const history = loadHistory(ctx.project);
      const last = history.runs.at(-1);
      if (!last) return `Drill has no runs kept for ${ctx.project}: run the tests in Drill, or \`drill run --json\` there.`;
      const results = Object.entries(last.results);
      const failed = results.filter(([, r]) => r === 'f').map(([id]) => ({ id, ...(history.tests[id] ?? {}) }));
      const passed = results.length - failed.length;
      const out = [`Last run ${stamp(last.at)} (${history.runs.length} kept): ${passed} passed, ${failed.length} failed`];
      const max = count(limit, 50, 500);
      if (failed.length) out.push('', 'Failed:');
      for (const t of failed.slice(0, max)) out.push(`  ${t.runner ?? '?'}  ${t.file ?? '?'}${t.line ? `:${t.line}` : ''}  ${line([...[t.suite ?? []].flat(), t.name].filter(Boolean).join(' › ') || t.id, 300)}`);
      if (failed.length > max) out.push(`  … ${failed.length - max} more (raise limit)`);
      const flaky = flakyTests(history);
      if (flaky.length) {
        out.push('', 'Flaky (passed and failed in the last runs):');
        for (const f of flaky.slice(0, 20)) out.push(`  ${f.file ?? '?'}  ${line(f.name ?? f.id, 200)}  ${f.passes ?? '?'} passed, ${f.fails ?? '?'} failed`);
      }
      return out.join('\n');
    },
  },
];
