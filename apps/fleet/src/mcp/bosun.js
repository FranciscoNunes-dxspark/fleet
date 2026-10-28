// Bosun's side: the crew lives inside the Bosun app, so what's read here is its recording of each run
// (recorder.js: every line each process said and every change of its state, under
// ~/.bosun/sessions/<project>/), the current run's included, written a quarter of a second behind.
import { readFileSync } from 'node:fs';
import { repoRoot, requestIdIn } from '@fleet/kit/family.js';
import { ToolError } from '@fleet/kit/mcp.js';
import { count, line, stamp, tail } from './bound.js';

const bosun = () => Promise.all([import('../../../bosun/src/recorder.js'), import('../../../bosun/src/replay.js')]).then(([r, p]) => ({ ...r, ...p }));

// A recording written to in the last minute is taken for a run still going.
const LIVE_MS = 60_000;

/** The project's recordings (the folder's, else its repository's), newest first, with the folder they're for. */
async function sessionsOf(ctx, folder) {
  const { listSessions } = await bosun();
  const dir = ctx.resolve(folder);
  for (const d of [dir, repoRoot(dir)].filter(Boolean)) {
    const list = listSessions(d);
    if (list.length) return { dir: d, list };
  }
  throw new ToolError(`Bosun has no recorded runs for ${dir}: run the crew in Bosun there first (recording is on unless Settings turned it off).`);
}

/** One recording read back: { file, session, procs (as at its end), live }. */
async function readSession(ctx, { folder, session }) {
  const { parseSession, Replayer } = await bosun();
  const { dir, list } = await sessionsOf(ctx, folder);
  const pick = list[count(session, 1, list.length) - 1] ?? list[0];
  const parsed = parseSession(readFileSync(pick.file, 'utf8'));
  const procs = new Replayer(parsed, { keep: 5000 }).at(Infinity);
  return { dir, list, pick, parsed, procs, live: pick === list[0] && Date.now() - (pick.ended ?? 0) < LIVE_MS };
}

const sessionArg = { session: { type: 'integer', description: 'Which recorded run: 1 is the newest (default), 2 the one before…' } };
const folderArg = { folder: { type: 'string', description: "The project's folder, if not the one this server runs for" } };

const findProc = (procs, name) => {
  const n = String(name ?? '').toLowerCase();
  const p = procs.find((x) => x.name.toLowerCase() === n) ?? procs.find((x) => x.name.toLowerCase().startsWith(n));
  if (!p) throw new ToolError(`No process called ${name}. The crew: ${procs.map((x) => x.name).join(', ') || '(none)'}.`);
  return p;
};

export const bosunTools = [
  {
    name: 'bosun_crew',
    description:
      "The project's processes as Bosun ran them in its latest recorded run (still running, or the last one): each one's state (running, crashed with its exit code, stopped, restarting, gave up), port and whether it's open, health, the trouble it last reported and its last line. Also lists the earlier recorded runs.",
    inputSchema: { type: 'object', properties: { ...sessionArg, ...folderArg } },
    async run(args, ctx) {
      const { dir, list, pick, parsed, procs, live } = await readSession(ctx, args);
      const out = [
        `Bosun's run for ${dir}, started ${stamp(pick.start)}, ${live ? 'being recorded now (the crew is running in Bosun)' : `last written ${stamp(pick.ended)}`}${parsed.cut ? '; the recording stopped at its size limit' : ''}.`,
        '',
      ];
      for (const p of procs) {
        const state = [
          p.status,
          p.code != null && p.status !== 'running' ? `exit ${p.code}` : null,
          p.port ? `port ${p.port}${p.portOpen === true ? ' open' : p.portOpen === false ? ' not open' : ''}` : null,
          p.health ? `health ${p.health}` : null,
          p.gaveUp ? 'gave up restarting' : null,
          p.tests ? `tests ${p.tests.state}${p.tests.failed ? ` (${p.tests.failed} failed)` : ''}` : null,
        ].filter(Boolean);
        out.push(`${p.name}: ${state.join(', ')}${p.spec?.run ? `  — runs: ${line(p.spec.run, 200)}` : ''}`);
        if (p.trouble) out.push(`  trouble: ${line(p.trouble)}`);
        const last = p.lines.at(-1);
        if (last) out.push(`  last line (${stamp(last.at)}): ${line(last.text)}`);
      }
      if (!procs.length) out.push('No processes in this recording.');
      if (list.length > 1) out.push('', 'Recorded runs (session numbers for the other bosun tools):', ...list.slice(0, 10).map((s, i) => `  ${i + 1}: started ${stamp(s.start)}, ${Math.round(s.bytes / 1024)} KB`));
      return out.join('\n');
    },
  },
  {
    name: 'bosun_log',
    description: "The last lines one of Bosun's processes wrote (stdout and stderr, stderr marked !), from the latest recorded run or an earlier one.",
    inputSchema: {
      type: 'object',
      properties: {
        process: { type: 'string', description: 'The process name, from bosun_crew' },
        lines: { type: 'integer', description: 'How many of the last lines (default 100, at most 2000)' },
        ...sessionArg,
        ...folderArg,
      },
      required: ['process'],
    },
    async run(args, ctx) {
      const { procs } = await readSession(ctx, args);
      const p = findProc(procs, args.process);
      const lines = p.lines.slice(-count(args.lines, 100, 2000));
      if (!lines.length) return `${p.name} said nothing in this run.`;
      return tail(lines.map((l) => `${stamp(l.at).slice(11)} ${l.err ? '!' : ' '} ${line(l.text, 1000)}`).join('\n'));
    },
  },
  {
    name: 'bosun_search',
    description:
      "Searches every process's lines in a recorded run of Bosun's crew: by text (case-insensitive), or by a request id (x-request-id, requestId, a traceparent's trace id, an operation id), as Bosun's /take of a log line does. Newest matches last.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text the line contains' },
        request_id: { type: 'string', description: 'A request or trace id the line names' },
        process: { type: 'string', description: "Only this process's lines" },
        limit: { type: 'integer', description: 'At most this many matches (default 100, at most 1000)' },
        ...sessionArg,
        ...folderArg,
      },
    },
    async run(args, ctx) {
      const { text, request_id: id, process: only, limit } = args;
      if (!text && !id) throw new ToolError('Give `text` or `request_id` to look for.');
      const { procs } = await readSession(ctx, args);
      const pool = only ? [findProc(procs, only)] : procs;
      const want = String(text ?? '').toLowerCase();
      const hits = pool
        .flatMap((p) => p.lines.map((l) => ({ ...l, p: p.name })))
        .filter((l) => (!want || l.text.toLowerCase().includes(want)) && (!id || l.text.includes(id) || requestIdIn(l.text) === id))
        .sort((a, b) => a.at - b.at);
      if (!hits.length) return 'No line matches.';
      const max = count(limit, 100, 1000);
      return `${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > max ? `, the last ${max}` : ''}:\n${hits
        .slice(-max)
        .map((l) => `${stamp(l.at).slice(11)} ${l.p} ${l.err ? '!' : ' '} ${line(l.text, 1000)}`)
        .join('\n')}`;
    },
  },
];
