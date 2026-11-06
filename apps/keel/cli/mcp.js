// `keel mcp`: Keel as an MCP server over stdio, so Claude Code can see delivery the way Keel does:
// the Line, the Inbox, pull requests with their risk, pipeline runs and why they failed, what's
// waiting to ship, production and DORA. It only reads: every tool is a question, never a change.
// It runs on the same service as the terminal app (cli/service.js in this process, or remote.js
// through a Keel server), and its answers are the terminal app's own words (format.js, runs.js,
// reports.js, line.js), as plain text. Nothing secret is in them: Keel's services never return a
// PAT, a key or a webhook, and logs are the failed steps' last lines, as the run viewer shows.
import { ToolError, mcpHandler, quietConsole, serveMcp } from '@fleet/kit/mcp.js';
import { relTime } from '@fleet/kit/text.js';
import { VERSION } from './open.js';
import { lineOf } from '../server/line.js';
import { STAGE_NAME, cardAge, cardKind, reasonText as cardReason } from './line.js';
import { DEPLOY_STATE, HEALTH, KIND, SEVERITY, branch, monitorFullText, monitorNumbers, monitorRows, monitorState, pipelineSummary, prFullText, prState, riskFor, wiFullText } from './format.js';
import { runText } from './runs.js';
import { doraScope, doraText } from './reports.js';

const INSTRUCTIONS = `Keel is a tech lead's console for Azure DevOps (and GitHub): pull requests, work items, pipelines, deployments and production, across the projects the user tracks in Keel.
Start with line for where change is stuck, or inbox for what needs the user now. Pull requests, pipelines and production list first; pull_request, pipeline_run, production (with a monitor) and work_item go into one.
Every tool only reads. Pull request numbers and work item ids are those of Azure DevOps (or GitHub); a pipeline or monitor is named by its name or part of it.`;

const STAGES = Object.keys(STAGE_NAME);
// The changes listed per environment waiting to ship: enough to say what's in it, not a changelog.
const SHIP_CHANGES = 15;
const ro = { readOnlyHint: true, openWorldHint: true };
const limit = (n, dflt, max) => Math.max(1, Math.min(max, Number.isFinite(Number(n)) ? Math.floor(Number(n)) : dflt));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (iso, now) => (iso ? `${relTime(Date.parse(iso), now)} ago` : '');

const TOOLS = [
  {
    name: 'line',
    description: 'The Line: where change stands, from planned to live (Planned, Building, In review, Merged, Deploying, Live). Each stage with how many cards it holds, how many are stuck, and its most stuck cards with why and for how long.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: { type: 'string', enum: STAGES, description: 'Only this stage, with more of its cards' },
        cards: { type: 'number', description: 'Cards to show per stage (default 5, or 25 for one stage)' },
      },
    },
    annotations: { title: 'The Line', ...ro },
  },
  {
    name: 'inbox',
    description: "The user's Inbox: one ranked list of what needs them across every tracked project (reviews waiting on them, stale or rejected pull requests, blocked items, P1 bugs, failing pipelines, approvals, production issues, new security advisories), each with its reasons.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(KIND), description: 'Only this kind of item' },
        limit: { type: 'number', description: 'At most this many items (default 25)' },
      },
    },
    annotations: { title: 'Inbox', ...ro },
  },
  {
    name: 'pull_requests',
    description: 'Active pull requests across tracked repositories, riskiest first: number, title, repository, branches, author, age, review state and risk score (0 to 100). Use pull_request for one in full.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only those whose title, repository, branch or author contains this text' },
        mine: { type: 'boolean', description: "Only the user's own and those waiting on their review" },
        limit: { type: 'number', description: 'At most this many (default 30)' },
      },
    },
    annotations: { title: 'Pull requests', ...ro },
  },
  {
    name: 'pull_request',
    description: 'One pull request in full: its state and what it waits on, its risk score with every reason, description, policies, reviewers and votes, linked work items, changed files and recent comments.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The pull request number' },
        repo: { type: 'string', description: 'Its repository, when the number alone is ambiguous or the pull request is no longer active' },
      },
      required: ['id'],
    },
    annotations: { title: 'Pull request', ...ro },
  },
  {
    name: 'pipelines',
    description: "Tracked pipelines, failing first, each judged on its own branch: health, pass rate, how many runs in a row failed, when it was last green, and what's running now.",
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only pipelines whose name, project or repository contains this text' },
        failing: { type: 'boolean', description: 'Only failing and unstable ones' },
      },
    },
    annotations: { title: 'Pipelines', ...ro },
  },
  {
    name: 'pipeline_run',
    description: "One pipeline run in full: its stages, jobs and steps, the failed steps' errors and the last lines of their logs, tests, approvals it waits on and the commits it built. Without a run, the one running now or else the latest; with failed, the latest failed run.",
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: { type: 'string', description: 'The pipeline: its name or part of it' },
        run: { type: 'string', description: 'A recent run: its number (e.g. 20261104.3) or id' },
        failed: { type: 'boolean', description: 'The latest failed run instead of the latest one' },
      },
      required: ['pipeline'],
    },
    annotations: { title: 'Pipeline run', ...ro },
  },
  {
    name: 'waiting_to_ship',
    description: "For each production environment, what's merged but not deployed yet: the pull requests and direct commits since the last successful deploy, the work items they deliver, any deploy under way, and how long the oldest change has waited.",
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: 'Only environments whose name contains this text' },
      },
    },
    annotations: { title: 'Waiting to ship', ...ro },
  },
  {
    name: 'production',
    description: 'Production monitors, the ones that need attention first: state (up, degraded, down, deploying), response time, uptime, failure rate and issues. With a monitor: that one in full, with what is failing most, recent deploys and what is waiting to ship to it.',
    inputSchema: {
      type: 'object',
      properties: {
        monitor: { type: 'string', description: 'One monitor: its name or part of it' },
      },
    },
    annotations: { title: 'Production', ...ro },
  },
  {
    name: 'dora',
    description: "The four DORA measures (deployment frequency, lead time for changes, change failure rate, time to restore) against the period before, with their bands and how each was counted, then a line per project and team.",
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'The period, in days (default 30, at most 180)' },
        scope: { type: 'string', description: 'A project or team (its name or part of it); everything when left out' },
        production: { type: 'string', description: 'The production environment or stage names to count, comma-separated, when not the ones Keel finds' },
      },
    },
    annotations: { title: 'DORA', ...ro },
  },
  {
    name: 'work_item',
    description: 'One work item in full: type, state, assignee, priority, iteration, tags, description, acceptance criteria, parent and children, linked pull requests and comments.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The work item id' },
        org: { type: 'string', description: 'Its organization, when Keel tracks several and the id is in more than one' },
      },
      required: ['id'],
    },
    annotations: { title: 'Work item', ...ro },
  },
];

/** Why Keel can't place what's waiting for an environment (service.js whyUnknown), in words. */
function whyUnknown(why) {
  switch (why?.reason) {
    case 'otherBranch': return `it deploys from ${why.branch}, but its last good deploy (${why.label}) came from ${why.other}`;
    case 'none': return 'it has no deploys in the last 90 days';
    case 'noSuccess': return `none of its last ${why.count} deploys succeeded`;
    default: return "its deploys don't say which commit they shipped";
  }
}

/** The one entry of `list` whose name (`nameOf`) is `want`, else contains it; a ToolError naming the choices when none or several do. */
function pick(list, want, nameOf, what) {
  const q = String(want ?? '').trim().toLowerCase();
  if (!q) throw new ToolError(`Name a ${what}.`);
  const exact = list.filter((x) => nameOf(x).toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const near = list.filter((x) => nameOf(x).toLowerCase().includes(q));
  if (near.length === 1) return near[0];
  const names = (near.length ? near : list).map(nameOf).slice(0, 15).join(', ');
  throw new ToolError(near.length ? `Several ${what}s match "${want}": ${names}. Name one more fully.` : `No ${what} matches "${want}". There are: ${names || 'none'}.`);
}

/** The Keel MCP server over `service`: `{ handle, tools }`, `tools` the functions behind each tool. */
export function createServer({ service, now = () => Date.now() }) {
  const tools = {
    async line({ stage, cards } = {}) {
      if (stage && !STAGES.includes(stage)) throw new ToolError(`stage is one of ${STAGES.join(', ')}.`);
      const t = now();
      const { stages } = await lineOf(service, t);
      const n = limit(cards, stage ? 25 : 5, 100);
      const out = [];
      for (const s of stages.filter((x) => !stage || x.id === stage)) {
        const stuck = [s.stuck.bad ? `${s.stuck.bad} badly stuck` : '', s.stuck.warn ? `${s.stuck.warn} stuck` : ''].filter(Boolean).join(', ');
        out.push(`${STAGE_NAME[s.id]}: ${plural(s.count, 'card')}${stuck ? ` (${stuck})` : ''}${s.tone === 'bad' ? ' · red' : s.tone === 'warn' ? ' · amber' : ''}`);
        for (const c of s.cards.slice(0, n)) {
          const why = cardReason(c.reason);
          const age = c.kind !== 'monitor' && c.age ? cardAge(c, t) : '';
          out.push(`  ${c.stuck === 'bad' ? '✗' : c.stuck === 'warn' ? '!' : '·'} ${cardKind(c)}: ${c.title}${c.sub ? ` (${c.sub})` : ''}${why ? ` · ${why}` : ''}${age ? ` · ${age}` : ''}${c.person?.displayName ? ` · ${c.person.displayName}` : ''}${c.mine ? ' · yours' : ''}`);
        }
        if (s.cards.length > n) out.push(`  … ${s.cards.length - n} more`);
      }
      return out.join('\n');
    },

    async inbox({ kind, limit: max } = {}) {
      const att = await service.attention();
      const items = (att.items ?? []).filter((i) => !kind || i.kind === kind);
      if (!items.length) return kind ? `Nothing of kind ${kind} in the Inbox.` : 'The Inbox is empty: nothing needs the user right now.';
      const n = limit(max, 25, 200);
      const out = [`${plural(items.length, 'item')}${att.summary?.high ? `, ${att.summary.high} to act on now` : ''}${att.snoozedCount ? ` (${att.snoozedCount} snoozed, not shown)` : ''}`];
      for (const i of items.slice(0, n)) {
        out.push('', `[${(SEVERITY[i.severity] ?? SEVERITY.low).label}] ${KIND[i.kind] ?? i.kind}: ${i.title}`);
        if (i.context) out.push(`  ${i.context}`);
        for (const r of i.reasons ?? []) out.push(`  - ${r.text}`);
      }
      if (items.length > n) out.push('', `… ${items.length - n} more`);
      return out.join('\n');
    },

    async pull_requests({ filter, mine, limit: max } = {}) {
      const [{ prs }, risks] = await Promise.all([service.pullRequests(), service.prRisks().then((r) => r.risks).catch(() => [])]);
      const q = String(filter ?? '').trim().toLowerCase();
      const list = prs
        .filter((p) => p.status === 'active')
        .filter((p) => !mine || p.isMine || p.needsMyReview)
        .filter((p) => !q || [p.title, p.repoName, p.projectName, branch(p.sourceBranch), branch(p.targetBranch), p.author?.displayName].some((s) => String(s ?? '').toLowerCase().includes(q)))
        .map((p) => ({ p, risk: riskFor(risks, p) }))
        .sort((a, b) => (b.risk?.score ?? -1) - (a.risk?.score ?? -1) || (b.p.ageHours ?? 0) - (a.p.ageHours ?? 0));
      if (!list.length) return 'No active pull requests match.';
      const n = limit(max, 30, 200);
      const t = now();
      const out = [`${plural(list.length, 'active pull request')}, riskiest first`];
      for (const { p, risk } of list.slice(0, n)) {
        out.push(`!${p.id} ${p.title}${p.isDraft ? ' (draft)' : ''}`);
        out.push(`  ${p.projectName} / ${p.repoName} · ${branch(p.sourceBranch)} → ${branch(p.targetBranch)} · ${p.author?.displayName ?? 'someone'}, ${ago(p.createdAt, t)} · ${prState(p).label}${risk ? ` · risk ${risk.score} (${risk.level})` : ''}${p.needsMyReview ? ' · waiting on your review' : p.isMine ? ' · yours' : ''}`);
      }
      if (list.length > n) out.push(`… ${list.length - n} more`);
      return out.join('\n');
    },

    async pull_request({ id, repo } = {}) {
      const num = Number(id);
      if (!Number.isInteger(num)) throw new ToolError('id is the pull request number.');
      const [{ prs, repos = [] }, risks] = await Promise.all([service.pullRequests(), service.prRisks().then((r) => r.risks).catch(() => [])]);
      const q = String(repo ?? '').trim().toLowerCase();
      const matches = prs.filter((p) => p.id === num && (!q || p.repoName.toLowerCase().includes(q)));
      let where = matches[0];
      if (matches.length > 1) throw new ToolError(`!${num} is in several repositories: ${matches.map((p) => `${p.projectName}/${p.repoName}`).join(', ')}. Name the repo.`);
      if (!where) {
        // Not active any more: found through its repository.
        if (!q) throw new ToolError(`No active pull request !${num}. If it's closed or merged, name its repo too.`);
        const r = pick(repos, repo, (x) => x.name, 'repository');
        where = { projectId: r.projectId, repoId: r.id, id: num };
      }
      const pr = await service.pullRequest(where.projectId, where.repoId, num);
      return prFullText(pr, now(), riskFor(risks, { ...pr, org: where.org }));
    },

    async pipelines({ filter, failing } = {}) {
      const rows = await service.pipelines();
      const q = String(filter ?? '').trim().toLowerCase();
      const ORDER = { failing: 0, unstable: 1, unknown: 2, healthy: 3 };
      const list = rows
        .filter((r) => !failing || r.health === 'failing' || r.health === 'unstable')
        .filter((r) => !q || [r.definition.name, r.projectName, r.repoName].some((s) => String(s ?? '').toLowerCase().includes(q)))
        .sort((a, b) => (ORDER[a.health] ?? 2) - (ORDER[b.health] ?? 2) || a.definition.name.localeCompare(b.definition.name));
      if (!list.length) return 'No tracked pipelines match.';
      const t = now();
      const out = [];
      for (const r of list) {
        out.push(`${r.definition.name}: ${(HEALTH[r.health] ?? HEALTH.unknown).label}${r.branch ? ` on ${branch(r.branch)}` : ''}`);
        out.push(`  ${r.projectName}${r.repoName ? ` / ${r.repoName}` : ''}${pipelineSummary(r, t) ? ` · ${pipelineSummary(r, t)}` : ''}`);
        for (const run of r.running ?? []) out.push(`  running now: ${run.buildNumber} on ${branch(run.sourceBranch)}`);
      }
      return out.join('\n');
    },

    async pipeline_run({ pipeline, run: want, failed } = {}) {
      const row = pick(await service.pipelines(), pipeline, (r) => r.definition.name, 'pipeline');
      let run = row.running?.[0] ?? row.lastRun ?? row.latest;
      const w = String(want ?? '').trim();
      if (w || failed) {
        const { runs } = await service.pipelineRuns(row.projectId, row.definition.id);
        run = w ? runs.find((r) => r.buildNumber === w || String(r.id) === w) : runs.find((r) => r.result === 'failed');
        if (!run) throw new ToolError(w ? `${row.definition.name} has no recent run ${w}. Its latest: ${runs.slice(0, 5).map((r) => r.buildNumber).join(', ') || 'none'}.` : `${row.definition.name} has no failed run among its last ${runs.length}.`);
      }
      if (!run) throw new ToolError(`${row.definition.name} hasn't run yet.`);
      const details = await service.runDetails(row.projectId, run.id);
      return runText(row, run, details, now()).text;
    },

    async waiting_to_ship({ environment } = {}) {
      const { targets = [] } = await service.undeployed();
      const q = String(environment ?? '').trim().toLowerCase();
      const list = targets.filter((x) => !q || String(x.name).toLowerCase().includes(q));
      if (!list.length) return q ? `No production environment matches "${environment}".` : 'No production environments found: link a production monitor to what deploys it, or name a release stage Production.';
      const t = now();
      const out = [];
      for (const x of list) {
        if (x.unknown) {
          out.push(`${x.name} (${x.projectName}): Keel can't tell what's waiting: ${x.untracked ? 'the repository it deploys is not tracked' : whyUnknown(x.why)}`);
          continue;
        }
        out.push(`${x.name} (${x.projectName}${x.branch ? `, ${x.devBranch ? `${x.devBranch} → ` : ''}${x.branch}` : ''}): ${x.waiting ? `${plural(x.waiting, 'change')} waiting${x.oldestAt ? `, the oldest merged ${ago(x.oldestAt, t)}` : ''}` : 'nothing waiting, all deployed'}`);
        if (x.lastDeploy) out.push(`  last deploy: ${x.lastDeploy.label ?? ''}${x.lastDeploy.at ? ` ${ago(x.lastDeploy.at, t)}` : ''}`.trimEnd());
        if (x.deploy) out.push(`  ${DEPLOY_STATE[x.deploy.state] ?? 'Deploying'}: ${x.deploy.label}`);
        const changes = [
          ...(x.pullRequests ?? []).map((p) => `  !${p.id} ${p.title}${p.author ? ` · ${p.author}` : ''}${p.mergedAt ? ` · merged ${ago(p.mergedAt, t)}` : ''}`),
          ...(x.directCommits ?? []).map((c) => `  ${String(c.id).slice(0, 7)} ${c.subject ?? c.message ?? ''}${c.author?.name ? ` · ${c.author.name}` : ''} (pushed without a pull request)`),
        ];
        out.push(...changes.slice(0, SHIP_CHANGES));
        if (changes.length > SHIP_CHANGES) out.push(`  … ${changes.length - SHIP_CHANGES} more`);
        if (x.workItems?.length) out.push(`  delivers: ${x.workItems.map((w) => `${w.type} ${w.id} ${w.title}`).join('; ')}`);
      }
      return out.join('\n');
    },

    async production({ monitor } = {}) {
      const { monitors = [] } = await service.production();
      if (!monitors.length) return 'No production monitors are set up (the web app: Settings → Production monitors).';
      if (monitor) {
        const m = pick(monitors, monitor, (x) => x.name, 'monitor');
        const target = m.targetKey ? (await service.undeployed().catch(() => ({ targets: [] }))).targets.find((x) => x.key === m.targetKey) ?? null : null;
        return monitorFullText(m, target, now());
      }
      const out = [];
      for (const m of monitorRows(monitors)) {
        out.push(`${m.name}: ${monitorState(m).label}${monitorNumbers(m) ? ` · ${monitorNumbers(m)}` : ''}${m.url ? ` · ${m.url}` : ''}`);
        for (const i of m.issues ?? []) out.push(`  - ${i.text}`);
      }
      return out.join('\n');
    },

    async dora({ days, scope, production } = {}) {
      const d = limit(days, 30, 180);
      const dora = await service.dora(d, production ? { production: String(production) } : {});
      const s = doraScope(dora, scope ?? '');
      if (!s) throw new ToolError(`No project or team matches "${scope}". There are: ${dora.scopes.slice(1).map((x) => x.name).join(', ') || 'none'}.`);
      return doraText(dora, s);
    },

    async work_item({ id, org } = {}) {
      const num = Number(id);
      if (!Number.isInteger(num)) throw new ToolError('id is the work item id.');
      try {
        return wiFullText(await service.workItem(num, org || undefined), now());
      } catch (e) {
        if (e.status === 404) throw new ToolError(`No work item ${num} in the tracked projects.`);
        throw e;
      }
    },
  };

  const handle = mcpHandler({
    name: 'keel',
    version: VERSION,
    instructions: INSTRUCTIONS,
    tools: TOOLS,
    call: (name, args) => (Object.hasOwn(tools, name) ? tools[name](args) : undefined),
  });
  return { handle, tools };
}

/** Serves Keel's tools on stdin/stdout, one JSON-RPC message a line; anything else goes to stderr. */
export function serve({ service, input = process.stdin, output = process.stdout, describe = '' }) {
  quietConsole();
  const server = createServer({ service });
  serveMcp({ handle: server.handle, input, output });
  process.stderr.write(`keel ${VERSION} MCP server ready${describe ? ` (${describe})` : ''}\n`);
}

