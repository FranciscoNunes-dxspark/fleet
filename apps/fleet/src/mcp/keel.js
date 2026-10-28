// Keel's side: the Inbox, pull requests and pipelines through Keel's own service layer, as its
// terminal app reads them: in-process from Azure DevOps (local mode, the same .env and data folder),
// or from the team's Keel when this computer signed in to one (`keel login`). It runs in a worker
// process of its own (`fleet --mcp-worker keel`, worker.js), because the kit's per-process state
// must say it's Keel there, and Keel's server config reads the environment once, on import. The
// tool definitions are here, without importing Keel, so the server can list them without the worker.
import { join } from 'node:path';
import { ToolError } from '@fleet/kit/mcp.js';
import { count, line } from './bound.js';

const limitArg = (dflt, max) => ({ limit: { type: 'integer', description: `At most this many (default ${dflt}, at most ${max})` } });

export const KEEL_TOOLS = [
  {
    name: 'keel_inbox',
    description: "Keel's Inbox: what needs the tech lead's attention across the tracked Azure DevOps (and GitHub) projects, most severe first: stale or blocked pull requests, failing pipelines, work items, each with its reasons and link.",
    inputSchema: { type: 'object', properties: { ...limitArg(50, 300) } },
  },
  {
    name: 'keel_prs',
    description: "Active pull requests in the tracked repositories, as Keel shows them: number, title, repository, author, age, review state and what it waits on, conflicts, and link.",
    inputSchema: {
      type: 'object',
      properties: {
        mine: { type: 'boolean', description: 'Only those I opened' },
        review: { type: 'boolean', description: 'Only those waiting for my review' },
        repo: { type: 'string', description: 'Only this repository (name)' },
        ...limitArg(50, 300),
      },
    },
  },
  {
    name: 'keel_pipelines',
    description: "The tracked pipelines and their health (failing, flaky, passing…), each with its latest run (result, branch, who, when), pass rate and failing streak. With `failing`, only those failing now.",
    inputSchema: { type: 'object', properties: { failing: { type: 'boolean', description: 'Only the failing ones' }, ...limitArg(100, 500) } },
  },
  {
    name: 'keel_pipeline_runs',
    description: "One pipeline's recent runs: number, status and result, branch, who started it, when, and link.",
    inputSchema: {
      type: 'object',
      properties: { pipeline: { type: 'string', description: 'The pipeline name, from keel_pipelines' }, project: { type: 'string', description: 'Its project, when the name is in several' }, ...limitArg(20, 100) },
      required: ['pipeline'],
    },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: true } }));

/**
 * Keel's service as its terminal app would build it, read-only and without the production monitors'
 * background checks (which openKeel starts). Settles the environment first, as Keel's cli.jsx does.
 * Throws a ToolError that says what to do when Keel isn't set up on this computer.
 */
export async function openKeelForReading({ demo = false } = {}) {
  const { ROOT } = await import('../../../keel/server/root.js');
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch {
    // No .env file: the real environment only.
  }
  if (demo) process.env.AZDO_MOCK = '1';
  const isOn = (v) => /^(1|true|yes)$/i.test(v || '');
  const remote = await import('../../../keel/cli/remote.js');
  const server = !demo && remote.serverUrlFrom(process.env.KEEL_SERVER);
  if (server) {
    if (!process.env.KEEL_TOKEN?.trim()) throw new ToolError(`Keel isn't signed in to ${server} on this computer: open Keel once (keel login) and sign in.`);
    try {
      return (await remote.connectKeel({ server, token: process.env.KEEL_TOKEN.trim() })).service;
    } catch (e) {
      throw new ToolError(`Couldn't reach Keel at ${server}: ${e.message}. Open Keel once to sign in again.`);
    }
  }
  // Keel's config falls back to its demo organization when none is set; Claude must never take that for real.
  if (!isOn(process.env.AZDO_MOCK) && !process.env.AZDO_ORG_URL?.trim())
    throw new ToolError(`Keel isn't set up on this computer: open Keel once (fleet keel, or keel) to name your Azure DevOps organization, or sign in to your team's Keel. Its settings are in ${join(ROOT, '.env')}.`);
  if (!isOn(process.env.AZDO_MOCK) && !process.env.AZDO_PAT?.trim()) process.env.AZDO_AUTH ||= 'az';
  const [{ config }, { createService }, { createMultiService }, { createOrgStore }, { createSettingsStore, defaultSettingsFile }, { providerFor }, { azureDevOpsToken }] = await Promise.all([
    import('../../../keel/server/config.js'),
    import('../../../keel/server/service.js'),
    import('../../../keel/server/multiorg.js'),
    import('../../../keel/server/orgs.js'),
    import('../../../keel/server/settings.js'),
    import('../../../keel/server/providers.js'),
    import('../../../keel/server/azdo/azcli.js'),
  ]);
  if (config.authMode === 'login') throw new ToolError('This Keel uses accounts (AUTH_MODE=login): sign in to it with keel login <address>.');
  const token = !config.mock && !config.pat ? azureDevOpsToken() : undefined;
  const settings = createSettingsStore(defaultSettingsFile());
  const entries = createOrgStore()
    .all()
    .map((org) => ({ org, service: createService({ provider: providerFor(org, { azToken: token }), settings, monitoring: null, org }) }));
  return createMultiService(entries);
}

const when = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '—');
const ageOf = (hours) => (hours == null ? '' : hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`);

/** The tools' work over `service` (Keel's, or its remote shape): name → run(args). */
export function keelHandlers(service) {
  return {
    async keel_inbox({ limit }) {
      const { items = [], snoozedCount = 0 } = await service.attention();
      if (!items.length) return `Nothing needs attention${snoozedCount ? ` (${snoozedCount} snoozed)` : ''}.`;
      const max = count(limit, 50, 300);
      return [
        `${items.length} item${items.length === 1 ? '' : 's'} need attention${snoozedCount ? ` (${snoozedCount} snoozed)` : ''}${items.length > max ? `; the first ${max}` : ''}:`,
        ...items.slice(0, max).map((i) => `[${i.severity}] ${i.kind}: ${line(i.title, 200)}\n    ${line(i.context, 200)}\n    ${(i.reasons ?? []).map((r) => r.text).join('; ')}${i.webUrl ? `\n    ${i.webUrl}` : ''}`),
      ].join('\n');
    },
    async keel_prs({ mine, review, repo, limit }) {
      const { prs = [] } = await service.pullRequests();
      const r = repo ? String(repo).toLowerCase() : null;
      const shown = prs.filter((p) => (!mine || p.isMine) && (!review || p.needsMyReview) && (!r || String(p.repoName).toLowerCase() === r));
      if (!shown.length) return 'No active pull requests match.';
      const max = count(limit, 50, 300);
      return shown
        .slice(0, max)
        .map((p) => {
          const waits = p.flow?.waiting?.names?.length ? `, waiting on ${p.flow.waiting.names.join(', ')}` : '';
          return `!${p.id} ${line(p.title, 200)}\n    ${p.projectName}/${p.repoName}  ${p.sourceBranch} → ${p.targetBranch}  by ${p.author?.displayName ?? '?'}, ${ageOf(p.ageHours)} old${p.isDraft ? ', draft' : ''}\n    ${p.reviewState ?? ''}${p.approvals != null ? `, ${p.approvals} approval${p.approvals === 1 ? '' : 's'}` : ''}${waits}${p.hasConflicts ? ', MERGE CONFLICTS' : ''}${p.readyToMerge ? ', ready to merge' : ''}\n    ${p.webUrl ?? ''}`;
        })
        .concat(shown.length > max ? [`… and ${shown.length - max} more`] : [])
        .join('\n');
    },
    async keel_pipelines({ failing, limit }) {
      const all = await service.pipelines();
      const shown = failing ? all.filter((p) => p.health === 'failing') : all;
      if (!shown.length) return failing ? 'No tracked pipeline is failing.' : 'No tracked pipelines.';
      const max = count(limit, 100, 500);
      return shown
        .slice(0, max)
        .map((p) => {
          const r = p.latest ?? p.lastRun;
          return `${p.definition?.name} (${p.projectName}${p.repoName ? `/${p.repoName}` : ''})  ${p.health ?? '?'}${p.failStreak ? `, ${p.failStreak} failed in a row` : ''}${p.passRate != null ? `, pass rate ${Math.round(p.passRate * (p.passRate <= 1 ? 100 : 1))}%` : ''}${p.running ? ', running now' : ''}\n    latest: ${r ? `${r.buildNumber} ${r.status}${r.result ? `/${r.result}` : ''} on ${r.sourceBranch} by ${r.requestedFor?.displayName ?? '?'}, ${when(r.finishedAt ?? r.startedAt ?? r.queuedAt)}` : 'none'}\n    ${r?.webUrl ?? p.webUrl ?? ''}`;
        })
        .concat(shown.length > max ? [`… and ${shown.length - max} more`] : [])
        .join('\n');
    },
    async keel_pipeline_runs({ pipeline, project, limit }) {
      const all = await service.pipelines();
      const n = String(pipeline ?? '').toLowerCase();
      const pr = project ? String(project).toLowerCase() : null;
      const found = all.filter((p) => String(p.definition?.name).toLowerCase() === n && (!pr || String(p.projectName).toLowerCase() === pr || p.projectId === project));
      if (!found.length) throw new ToolError(`No tracked pipeline called ${pipeline}. keel_pipelines lists them.`);
      if (found.length > 1) throw new ToolError(`${pipeline} is in several projects (${found.map((p) => p.projectName).join(', ')}): name the project.`);
      const p = found[0];
      const { runs = [] } = await service.pipelineRuns(p.projectId, p.definition.id);
      if (!runs.length) return `${p.definition.name} has no runs.`;
      return [
        `${p.definition.name} (${p.projectName}), ${p.health ?? ''}:`,
        ...runs.slice(0, count(limit, 20, 100)).map((r) => `${r.buildNumber}  ${r.status}${r.result ? `/${r.result}` : ''}  ${r.sourceBranch}  by ${r.requestedFor?.displayName ?? '?'} (${r.reason ?? '?'})  ${when(r.startedAt ?? r.queuedAt)} → ${when(r.finishedAt)}  ${r.webUrl ?? ''}`),
      ].join('\n');
    },
  };
}
