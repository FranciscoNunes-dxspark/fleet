// Composes the provider (real or mock), the cache and the lead's settings into
// the views the API serves. Everything here is scoped to *tracked* projects
// and repos, so the app only ever looks at what the lead cares about.
import { config } from './config.js';
import { Cache } from './cache.js';
import { createSettingsStore, defaultSettingsFile, pruneSnoozed } from './settings.js';
import { createAzdoProvider } from './azdo/provider.js';
import { createMockProvider } from './mock/provider.js';
import { DAY, HOUR, enrichPR, sameIdentity } from './domain/prs.js';
import { releaseHealth } from './domain/releases.js';
import { pipelineHealth } from './domain/pipelines.js';
import { buildWorkload } from './domain/workload.js';
import { buildAttention, isBlocked } from './domain/attention.js';
import { buildInsights } from './domain/insights.js';
import { buildChangelog } from './domain/changelog.js';
import { buildEpicTree } from './domain/epics.js';
import { commitRefs, mergeCommits } from './domain/commits.js';
import { deployMarkers, evaluateMonitor, runningDeploy, targetKeyOf } from './domain/production.js';
import { buildDelivery } from './domain/delivery.js';
import { buildSummary, weekRange } from './domain/summary.js';
import { buildFlow, buildSprintScope } from './domain/flow.js';
import { changedFolders, suggestReviewers } from './domain/reviewers.js';
import { findFlakyTests } from './domain/tests.js';

const MIN = 60_000;
// Classic release stages that are production by their name; monitors can point at any stage or pipeline.
const PROD_STAGE = /\b(prod|production|prd|live)\b/i;
// Lead time is measured over this many recent deploys per environment (each costs one commits call, then cached).
const LEAD_TIME_DEPLOYS = 30;

/** Backlog order, then id; items without a rank go last. */
const byBacklogOrder = (a, b) => {
  const ra = a.backlogOrder ?? Infinity;
  const rb = b.backlogOrder ?? Infinity;
  return ra === rb ? a.id - b.id : ra < rb ? -1 : 1;
};

/**
 * Which column (and lane, and Doing/Done half) a card sits in on a team board.
 * Azure DevOps stores the column per board; cards never moved on the board
 * have none yet and show in the first column their state maps to.
 */
export function placeOnBoard(board, w) {
  const f = w.boardFields || {};
  let column = f[board.fields.column] || null;
  if (!column || !board.columns.some((c) => c.name === column)) {
    const byState = board.columns.find((c) => c.stateMappings[w.type] === w.state);
    const byCategory = w.stateCategory === 'Completed'
      ? board.columns.find((c) => c.columnType === 'outgoing')
      : w.stateCategory === 'Proposed' ? board.columns.find((c) => c.columnType === 'incoming') : board.columns.find((c) => c.columnType === 'inProgress');
    column = (byState || byCategory || board.columns[0])?.name || null;
  }
  return { column, done: !!f[board.fields.done], lane: f[board.fields.lane] || null };
}

/** A single commit's subject, or a readable version of the branch name. */
export function suggestTitle(branch, commits = []) {
  if (commits.length === 1) return commits[0].message.split('\n')[0].trim().slice(0, 400);
  const leaf = branch.split('/').pop() || branch;
  const words = leaf.replace(/^(\d+[-_]?)+/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : branch;
}

// Settings used to hold one team (teamId/teamName); read either shape.
export const teamsOf = (cfg = {}) => (Array.isArray(cfg.teams)
  ? cfg.teams.filter((t) => t?.id)
  : cfg.teamId ? [{ id: cfg.teamId, name: cfg.teamName }] : []);

/**
 * Everything one person sees. In local and demo mode there's a single one; with
 * sign-in, each signed-in user gets their own (their PAT, settings and cache).
 */
export function createService({
  provider = config.mock ? createMockProvider() : createAzdoProvider(),
  settings: store = createSettingsStore(defaultSettingsFile()),
  // Shared production monitoring (one per server); null when not running.
  monitoring = null,
  // The Azure DevOps organization this service talks to: { key, name, url, primary }.
  // With several organizations there is one service each (see multiorg.js).
  org = null,
} = {}) {
  // Inbox keys and snoozes of other organizations carry their key, so #4107 in
  // one never hides #4107 in another; the primary's stay as they always were.
  const keyPrefix = org && !org.primary ? `${org.key}/` : '';
  const cache = new Cache(MIN);
  const cached = (key, fn, ttl) => cache.get(key, fn, ttl);

  const me = () => cached('me', () => provider.me(), 60 * MIN);
  const allProjects = () => cached('projects', () => provider.listProjects(), 10 * MIN);

  let seeding;
  async function ensureSeeded() {
    if (org && !org.primary) return; // AZDO_PROJECTS names projects of the primary organization
    const settings = await store.load();
    if (!settings.firstRun) return;
    seeding ??= (async () => {
      const projects = await allProjects();
      const wanted = config.mock
        ? projects
        : projects.filter((p) => config.seedProjects.some((n) => n.toLowerCase() === p.name.toLowerCase()));
      if (!wanted.length) return;
      const entries = await Promise.all(wanted.map(async (p) => {
        const teams = await provider.listTeams(p.id).catch(() => []);
        const team = teams.find((t) => t.name === `${p.name} Team`) || teams[0];
        return [p.id, { name: p.name, tracked: true, repos: 'all', teams: team ? [{ id: team.id, name: team.name }] : [], scopeToTeamArea: false }];
      }));
      await store.save({ projects: Object.fromEntries(entries) });
    })();
    await seeding;
  }

  async function tracked() {
    await ensureSeeded();
    const settings = await store.load();
    const projects = await allProjects();
    return projects
      .filter((p) => settings.projects[p.id]?.tracked)
      .map((p) => ({ ...p, ...settings.projects[p.id], name: p.name, teams: teamsOf(settings.projects[p.id]) }));
  }

  /** Current iteration + area paths for one team. */
  const teamScope = (p, team) => cached(`scope:${p.id}:${team.id}:${p.scopeToTeamArea}`, async () => {
    const [iteration, areas] = await Promise.all([
      provider.getCurrentIteration(p.id, team.id).catch(() => null),
      p.scopeToTeamArea ? provider.getTeamAreas(p.id, team.id).catch(() => null) : null,
    ]);
    // Azure DevOps reports an iteration as "current" even when it ended years
    // ago or has no dates at all; only a dated iteration covering today is live.
    if (iteration) {
      const start = Date.parse(iteration.startDate);
      const finish = Date.parse(iteration.finishDate);
      iteration.status = !Number.isFinite(start) || !Number.isFinite(finish) ? 'undated'
        : Date.now() > finish + DAY ? 'ended'
          : Date.now() < start ? 'future' : 'live';
    }
    return { iteration, areaPaths: areas?.length ? areas : null };
  }, 10 * MIN);

  /**
   * Project-wide scope across all of its selected teams: the union of their
   * area paths (when limited to team areas) and every team's iteration.
   */
  async function scope(p) {
    const scopes = await Promise.all(p.teams.map((t) => teamScope(p, t)));
    const areas = scopes.flatMap((s) => s.areaPaths || []);
    const limited = p.scopeToTeamArea && p.teams.length && scopes.every((s) => s.areaPaths);
    return {
      iterations: scopes.map((s, i) => s.iteration && { ...s.iteration, team: p.teams[i] }).filter(Boolean),
      areaPaths: limited ? [...new Map(areas.map((a) => [`${a.value}|${a.includeChildren}`, a])).values()] : null,
    };
  }

  async function currentIterationPaths() {
    const scopes = await Promise.all((await tracked()).map(scope));
    return [...new Set(scopes.flatMap((s) => s.iterations).filter((it) => it.status === 'live').map((it) => it.path))];
  }

  const repos = () => cached('repos', async () => {
    const list = await Promise.all((await tracked()).map(async (p) => {
      const rs = await provider.listRepos(p.id);
      return p.repos === 'all' || !Array.isArray(p.repos) ? rs : rs.filter((r) => p.repos.includes(r.id));
    }));
    return list.flat();
  }, 10 * MIN);

  async function assertTrackedRepo(repoId) {
    if (!(await repos()).some((r) => r.id === repoId)) {
      throw Object.assign(new Error('That repository isn\'t one of your tracked repos'), { status: 400 });
    }
  }

  async function inTrackedRepos(list) {
    const ids = new Set((await repos()).map((r) => r.id));
    return list.filter((x) => !x.repoId || ids.has(x.repoId));
  }

  const activePRs = () => cached('prs:active', async () => {
    const [who, projects] = await Promise.all([me(), tracked()]);
    const lists = await Promise.all(projects.map((p) => provider.listPullRequests(p.id, { status: 'active' })));
    const now = Date.now();
    return (await inTrackedRepos(lists.flat())).map((pr) => enrichPR(pr, who, now));
  });

  const closedPRs = (days) => cached(`prs:closed:${days}`, async () => {
    const closedAfter = new Date(Date.now() - days * DAY).toISOString();
    const lists = await Promise.all((await tracked()).map((p) => provider.listPullRequests(p.id, { status: 'all', closedAfter })));
    return inTrackedRepos(lists.flat().filter((p) => p.status !== 'active'));
  }, 5 * MIN);

  // Types people create from Keel: backlog and task types, not test or code-review artifacts.
  const NOT_CREATABLE = new Set(['Test Case', 'Test Plan', 'Test Suite', 'Shared Steps', 'Shared Parameter', 'Code Review Request', 'Code Review Response', 'Feedback Request', 'Feedback Response']);
  const TYPE_ORDER = ['User Story', 'Product Backlog Item', 'Requirement', 'Issue', 'Bug', 'Task', 'Feature', 'Epic'];
  const creatableTypes = (stateMap) => Object.keys(stateMap || {})
    .filter((t) => !NOT_CREATABLE.has(t))
    .sort((a, b) => ((TYPE_ORDER.indexOf(a) + 1 || 99) - (TYPE_ORDER.indexOf(b) + 1 || 99)) || a.localeCompare(b));

  const openItems = () => cached('wi:open', async () => {
    const lists = await Promise.all((await tracked()).map(async (p) => {
      const [{ areaPaths }, types] = await Promise.all([scope(p), workTypes(p)]);
      const items = await provider.queryWorkItems(p.id, { open: true, areaPaths, ...(types ? { types } : {}) });
      return items.map((w) => ({ ...w, projectId: p.id }));
    }));
    return lists.flat();
  });

  // A team's board configuration (columns, WIP, types); null when unavailable.
  const teamBoards = (projectId, teamId) => cached(`boards:${projectId}:${teamId}`, () => provider.getBoards(projectId, teamId).catch((err) => {
    console.warn(`[boards] ${err.message}`);
    return null;
  }), 10 * MIN);

  // Every work item type the project's backlogs use (custom ones like "Error" or
  // "Support" included), from the first team's backlog configuration.
  async function workTypes(p) {
    const cfg = p.teams[0] ? await teamBoards(p.id, p.teams[0].id) : null;
    return cfg?.workTypes?.length ? cfg.workTypes : null;
  }

  const stateMaps = () => cached('states', async () => {
    const projects = await tracked();
    const maps = await Promise.all(projects.map((p) => provider.getStateMap(p.id).catch(() => ({}))));
    return Object.fromEntries(projects.map((p, i) => [p.id, maps[i]]));
  }, 30 * MIN);

  // Every build in tracked projects (any repo): also used to map release artifacts to repos.
  const rawBuilds = () => cached('builds:raw', async () => {
    const settings = await store.load();
    const days = settings.thresholds.buildLookbackDays;
    const lists = await Promise.all((await tracked()).map((p) => provider.listBuilds(p.id, { sinceDays: days })));
    return lists.flat();
  });

  // Definitions change rarely; the Refresh button (or 10 minutes) picks up new ones.
  const definitions = () => cached('defs', async () => {
    const lists = await Promise.all((await tracked()).map((p) => provider.listDefinitions(p.id).catch(() => [])));
    return lists.flat();
  }, 10 * MIN);

  const pipelines = () => cached('builds', async () => {
    const [builds, repoList, defs] = await Promise.all([rawBuilds(), repos(), definitions()]);
    return pipelineHealth(await inTrackedRepos(builds), repoList, await inTrackedRepos(defs));
  });

  /** Classic release pipelines in tracked projects, limited to tracked repos via their artifacts. */
  const releases = () => cached('builds:releases', async () => {
    const [projects, builds, repoList] = await Promise.all([tracked(), rawBuilds(), repos()]);
    const repoOfBuildDef = new Map(builds.filter((b) => b.repoId).map((b) => [`${b.projectId}:${b.definition.id}`, b.repoId]));
    const tracked_ = new Set(repoList.map((r) => r.id));
    const lists = await Promise.all(projects.map((p) => provider.listReleases(p.id, p.name).catch((err) => {
      console.warn(`[releases] ${p.name}: ${err.message}`);
      return [];
    })));
    return lists.flat()
      .filter((d) => {
        const repoIds = d.artifacts.map((a) => (a.type === 'Build' ? repoOfBuildDef.get(`${d.projectId}:${a.sourceId}`) : /git/i.test(a.type) ? a.sourceId : null)).filter(Boolean);
        // Unknown origin (no recent builds, other artifact types): keep it rather than hide it.
        return !repoIds.length || repoIds.some((id) => tracked_.has(id));
      })
      .map((d) => ({ ...d, key: `${d.projectId}:release:${d.id}`, health: releaseHealth(d.stages) }));
  });

  /** Production monitors with their deploy markers and health verdict. */
  async function production() {
    if (!monitoring) return [];
    const [rels, pipes, builds] = await Promise.all([releases().catch(() => []), pipelines().catch(() => []), rawBuilds().catch(() => [])]);
    return monitoring.status().map((m) => {
      const sources = { releases: rels, pipelines: pipes, builds };
      const markers = deployMarkers(m, sources);
      const deploy = runningDeploy(m, sources);
      return { ...m, targetKey: targetKeyOf(m.link), markers, deploy, ...evaluateMonitor(m, markers, Date.now(), deploy) };
    });
  }

  /**
   * Where production is: the release stages and pipelines production monitors
   * are linked to (named after the monitor), plus classic release stages
   * named like production (Production, Prod, PRD, Live).
   */
  async function productionTargets() {
    const [rels, pipes, projects] = await Promise.all([releases().catch(() => []), pipelines().catch(() => []), allProjects()]);
    const projectName = (id) => projects.find((p) => p.id === id)?.name || null;
    const found = new Map();
    const add = (t) => t.key && !found.has(t.key) && found.set(t.key, t);
    for (const m of monitoring ? monitoring.status() : []) {
      const link = m.link;
      if (!link) continue;
      if (link.type === 'release') {
        add({ key: targetKeyOf(link), type: 'release', projectId: link.projectId, projectName: projectName(link.projectId), definitionId: link.definitionId, stage: link.stage || null, name: m.name });
      } else {
        const row = pipes.find((x) => x.projectId === link.projectId && x.definition.id === link.definitionId);
        add({ key: targetKeyOf(link), type: 'pipeline', projectId: link.projectId, projectName: projectName(link.projectId), definitionId: link.definitionId, branch: row?.branch || null, name: m.name });
      }
    }
    for (const d of rels) {
      for (const st of d.stages) {
        if (!PROD_STAGE.test(st.name)) continue;
        const link = { type: 'release', projectId: d.projectId, definitionId: d.id, stage: st.name };
        add({ ...link, key: targetKeyOf(link), projectName: d.projectName, name: `${d.name} · ${st.name}` });
      }
    }
    return [...found.values()];
  }

  /** One environment's deploys over the last `days` days, newest first, each with the commit it shipped. */
  const deployHistory = (target, days) => cached(`builds:deploys:${target.key}:${days}`, async () => {
    const since = new Date(Date.now() - days * DAY).toISOString();
    return (await provider.listDeployments(target, { since })).filter((d) => d.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, 5 * MIN);

  // What one commit has over another never changes.
  const commitsBetween = (projectId, repoId, from, to) => cached(`between:${repoId}:${from}:${to}`, () => provider.listCommitsBetween(projectId, repoId, from, to), 24 * 60 * MIN);

  /** The deploy before `i` in a newest-first history that shipped code from the same repo. */
  const previousDeploy = (history, i) => history.slice(i + 1).find((d) => d.status === 'succeeded' && d.commit && d.repoId === history[i].repoId);

  /**
   * A list of commits (one repo, newest first) as people read it: the merged
   * pull requests with the commits they brought, the commits pushed without
   * one, the work items they mention and who wrote them.
   */
  async function describeChanges(repo, raw) {
    const commits = mergeCommits([{ repo, commits: raw }]);
    const ids = [...new Set(commits.flatMap((c) => c.workItemIds))].slice(0, 50);
    // Each merged PR with the commits it brought; what's left was pushed without a PR.
    const merges = commits.filter((c) => c.prId).slice(0, 30);
    const [items, prCommitIds] = await Promise.all([
      ids.length ? provider.getWorkItems(ids).catch(() => []) : [],
      Promise.all(merges.map((c) => cached(`prcommits:${repo.id}:${c.prId}`, () => provider.getPullRequestCommitIds(repo.projectId, repo.id, c.prId), 24 * 60 * MIN).catch(() => []))),
    ]);
    const inPr = new Set([...merges.map((c) => c.id), ...prCommitIds.flat()]);
    return {
      commits,
      pullRequests: merges.map((c, i) => {
        const own = new Set(prCommitIds[i]);
        return {
          id: c.prId,
          title: c.subject.replace(/^Merged PR \d+:\s*/, ''),
          author: c.author?.name || null,
          projectId: c.projectId,
          repoId: c.repoId,
          webUrl: repo.webUrl ? `${repo.webUrl}/pullrequest/${c.prId}` : null,
          mergedAt: c.author?.date || null,
          // The merge commit first, then the PR's own commits.
          commits: [c, ...commits.filter((x) => own.has(x.id) && x.id !== c.id)],
        };
      }),
      directCommits: commits.filter((c) => !inPr.has(c.id)),
      workItems: items.map(({ id, type, title, state, stateCategory, assignedTo, webUrl }) => ({ id, type, title, state, stateCategory, assignedTo: assignedTo?.displayName || null, webUrl })),
      authors: [...new Set(commits.map((c) => c.author?.name).filter(Boolean))],
    };
  }

  /** Pending approvals from classic releases and YAML environment checks, in one list. */
  const approvals = () => cached('builds:approvals', async () => {
    const [projects, who, builds] = await Promise.all([tracked(), me(), rawBuilds()]);
    const lists = await Promise.all(projects.map(async (p) => {
      const running = builds.filter((b) => b.projectId === p.id && b.status !== 'completed');
      const [classic, yaml] = await Promise.all([
        provider.listReleaseApprovals(p.id, p.name).catch(() => []),
        provider.listPipelineApprovals(p.id, p.name, running).catch(() => []),
      ]);
      return [...classic, ...yaml];
    }));
    return lists.flat().map((a) => {
      const forMe = a.approvers.some((x) => sameIdentity(x, who));
      return {
        ...a,
        key: `${a.kind}:${a.id}`,
        forMe,
        // Classic approvals: you, or a group you might be in (Azure DevOps has the final say).
        canDecide: a.canDecide ?? (forMe || a.approvers.some((x) => x.isContainer)),
      };
    }).sort((x, y) => Date.parse(x.createdOn) - Date.parse(y.createdOn));
  }, 30 * 1000);

  const people = () => cached('people', async () => {
    const pairs = (await tracked()).flatMap((p) => p.teams.map((t) => [p.id, t.id]));
    const lists = await Promise.all(pairs.map(([pid, tid]) => provider.listTeamMembers(pid, tid).catch(() => [])));
    const byId = new Map();
    for (const m of lists.flat()) byId.set(m.id, m);
    if (!byId.size) {
      // No teams configured: infer the team from who is authoring PRs and owning items.
      const [prs, items] = await Promise.all([activePRs(), openItems()]);
      for (const x of [...prs.map((p) => p.author), ...items.map((w) => w.assignedTo)]) if (x && !x.isContainer) byId.set(x.id, x);
    }
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, 10 * MIN);

  async function workload() {
    const [settings, prs, items, team, paths] = await Promise.all([store.load(), activePRs(), openItems(), people(), currentIterationPaths()]);
    return buildWorkload({ people: team, prs, items, thresholds: settings.thresholds, blockedTag: settings.blockedTag, currentIterationPaths: paths });
  }

  return {
    provider,
    settingsStore: store,
    invalidate: (prefix) => cache.invalidate(prefix),
    org,
    /** Tracked projects of this organization (for the multi-organization layer). */
    trackedProjects: () => tracked(),
    allProjects: () => allProjects(),

    async meta() {
      const settings = await store.load();
      const [who, projects] = await Promise.all([me(), tracked()]);
      return {
        mock: config.mock,
        mockReason: config.mockReason,
        orgUrl: provider.orgUrl,
        org: org || null,
        me: who,
        refreshSeconds: settings.refreshSeconds,
        prefs: settings.prefs || {},
        thresholds: settings.thresholds,
        autoComplete: settings.autoComplete,
        blockedTag: settings.blockedTag,
        trackedProjects: projects.map((p) => ({ id: p.id, name: p.name, teams: p.teams })),
      };
    },

    async attention() {
      const [settings, prs, items, pipes, load, paths, rels, appr, prod] = await Promise.all([
        store.load(), activePRs(), openItems(), pipelines(), workload(), currentIterationPaths(),
        releases().catch(() => []), approvals().catch(() => []), production().catch(() => []),
      ]);
      if (!keyPrefix) return buildAttention({ prs, items, pipelines: pipes, workload: load, settings, currentIterationPaths: paths, releases: rels, approvals: appr, production: prod });
      // This organization's snoozes, without the prefix, then its keys with it.
      const mine = Object.fromEntries(Object.entries(settings.snoozed || {}).filter(([k]) => k.startsWith(keyPrefix)).map(([k, v]) => [k.slice(keyPrefix.length), v]));
      const result = buildAttention({ prs, items, pipelines: pipes, workload: load, settings: { ...settings, snoozed: mine }, currentIterationPaths: paths, releases: rels, approvals: appr, production: prod });
      return { ...result, items: result.items.map((i) => ({ ...i, key: keyPrefix + i.key })) };
    },

    async snooze(key, days) {
      const settings = await store.load();
      const snoozed = pruneSnoozed(settings.snoozed);
      if (days > 0) snoozed[key] = new Date(Date.now() + days * DAY).toISOString();
      else delete snoozed[key];
      await store.save({ snoozed });
    },

    async clearSnoozes() {
      await store.save({ snoozed: {} });
    },

    people,

    repos: () => repos(),

    async branches(projectId, repoId) {
      await assertTrackedRepo(repoId);
      const list = await cached(`branches:${repoId}`, () => provider.listBranches(projectId, repoId), 2 * MIN);
      // Recently pushed first (newest on top), then the rest alphabetically.
      return [...list].sort((a, b) => (b.pushedAt ? Date.parse(b.pushedAt) : 0) - (a.pushedAt ? Date.parse(a.pushedAt) : 0) || a.name.localeCompare(b.name));
    },

    async compare(projectId, repoId, source, target) {
      await assertTrackedRepo(repoId);
      if (!source || !target) throw Object.assign(new Error('Pick a source and a target branch'), { status: 400 });
      const result = await provider.compareBranches(projectId, repoId, source, target);
      // Suggest work items from the branch name (feature/12345-x) and commit messages (#123, AB#123).
      const ids = new Set();
      for (const m of source.matchAll(/(?:^|[/_-])(\d{3,7})(?=$|[/_-])/g)) ids.add(Number(m[1]));
      for (const c of result.commits) for (const m of c.message.matchAll(/(?:AB)?#(\d{2,7})\b/g)) ids.add(Number(m[1]));
      const found = ids.size ? await provider.getWorkItems([...ids].slice(0, 15)).catch(() => []) : [];
      return {
        ...result,
        suggestedTitle: suggestTitle(source, result.commits),
        suggestedWorkItems: found.map(({ id, title, type, state, stateCategory }) => ({ id, title, type, state, stateCategory })),
      };
    },

    /**
     * Reviewers to suggest for a change to `paths` going into `target`: people
     * on the team who committed in the same folders in the last 180 days,
     * fewer reviews owed first among equals. `exclude`: ids already on it;
     * `author`: who wrote it (you, for a new pull request).
     */
    async suggestReviewers(projectId, repoId, { paths = [], target, exclude = [], author } = {}) {
      await assertTrackedRepo(repoId);
      const folders = changedFolders(paths.slice(0, 2000).map(String));
      const since = new Date(Date.now() - 180 * DAY).toISOString();
      const [histories, team, load, who] = await Promise.all([
        Promise.all(folders.map(async (f) => ({
          ...f,
          commits: await cached(`history:${repoId}:${target || ''}:${f.dir}`, () => provider.listCommits(projectId, repoId, { branch: target || undefined, path: f.dir, since, top: 100 }), 30 * MIN).catch(() => []),
        }))),
        people(),
        workload().catch(() => []),
        me(),
      ]);
      return { suggestions: suggestReviewers({ histories, people: team, load, exclude: [author || who.id, ...exclude] }) };
    },

    /**
     * Recent commits: every tracked repo on its default branch, or one repo on
     * any branch. A repo that can't be read (empty, no access) is listed in
     * `failed` rather than failing the page.
     */
    async commits({ repoId, branch, days = 14 } = {}) {
      const list = (await repos()).filter((r) => r.defaultBranch);
      const chosen = repoId ? list.filter((r) => r.id === repoId) : list;
      if (repoId && !chosen.length) throw Object.assign(new Error('That repository isn\'t one of your tracked repos'), { status: 400 });
      const ref = repoId && branch ? String(branch) : null;
      const since = new Date(Date.now() - days * DAY).toISOString();
      const failed = [];
      const perRepo = await Promise.all(chosen.map(async (repo) => {
        try {
          const commits = await cached(`commits:${repo.id}:${ref || ''}:${days}`, () => provider.listCommits(repo.projectId, repo.id, { branch: ref || undefined, since }), 2 * MIN);
          return { repo, commits };
        } catch (err) {
          failed.push({ repoId: repo.id, repoName: repo.name, error: err.message });
          return { repo, commits: [] };
        }
      }));
      return { commits: mergeCommits(perRepo), days, branch: ref, failed };
    },

    /**
     * What a production deploy shipped: the commits since the previous
     * successful deploy of the same environment, and the pull requests and
     * work items they mention.
     */
    async deployChanges(projectId, targetKey, deployId) {
      const target = (await productionTargets()).find((x) => x.key === targetKey && x.projectId === projectId);
      if (!target) throw Object.assign(new Error('Unknown production environment'), { status: 404 });
      const history = await deployHistory(target, 90);
      const i = history.findIndex((d) => String(d.id) === String(deployId));
      if (i < 0) throw Object.assign(new Error('That deploy is older than 90 days, or unknown'), { status: 404 });
      const deploy = history[i];
      const previous = previousDeploy(history, i);
      const base = { target: { key: target.key, name: target.name, projectName: target.projectName }, deploy, previous: previous ? { id: previous.id, label: previous.label, at: previous.at } : null };
      if (!deploy.commit || !deploy.repoId) return { ...base, commits: [], pullRequests: [], workItems: [], authors: [], unknown: true };
      const repo = (await repos()).find((r) => r.id === deploy.repoId) || { id: deploy.repoId, name: '', projectId: target.projectId, projectName: target.projectName };
      const raw = !previous ? [await provider.getCommit(repo.projectId, repo.id, deploy.commit)]
        : previous.commit === deploy.commit ? []
          : await commitsBetween(repo.projectId, repo.id, previous.commit, deploy.commit);
      return {
        ...base,
        repo: { id: repo.id, name: repo.name, projectId: repo.projectId },
        // No earlier deploy in the last 90 days: only the deployed commit itself is known.
        partial: !previous,
        redeploy: !!previous && previous.commit === deploy.commit,
        ...(await describeChanges(repo, raw)),
      };
    },

    /**
     * What's waiting to ship: for each production environment, the commits on
     * its branch (the repo's default, or the pipeline's own) since the last
     * successful deploy, with their pull requests and work items.
     */
    async undeployed() {
      const [targets, repoList] = await Promise.all([productionTargets(), repos()]);
      const results = await Promise.all(targets.map(async (t) => {
        const head = { key: t.key, name: t.name, projectId: t.projectId, projectName: t.projectName };
        let history;
        try {
          history = await deployHistory(t, 90);
        } catch (err) {
          return { ...head, error: err.message };
        }
        const last = history.find((d) => d.status === 'succeeded' && d.commit && d.repoId);
        if (!last) return { ...head, unknown: true, lastDeploy: null };
        const repo = repoList.find((r) => r.id === last.repoId);
        const lastDeploy = { id: last.id, label: last.label, at: last.at, by: last.by, webUrl: last.webUrl };
        if (!repo) return { ...head, unknown: true, untracked: true, lastDeploy };
        const branch = t.branch || repo.defaultBranch;
        try {
          const [tip] = await cached(`commits:tip:${repo.id}:${branch}`, () => provider.listCommits(repo.projectId, repo.id, { branch, top: 1 }), 2 * MIN);
          const raw = !tip || tip.id === last.commit ? [] : await commitsBetween(repo.projectId, repo.id, last.commit, tip.id);
          const changes = await describeChanges(repo, raw);
          const oldest = changes.commits.reduce((min, c) => Math.min(min, Date.parse(c.author?.date) || Infinity), Infinity);
          return {
            ...head,
            branch,
            repo: { id: repo.id, name: repo.name, projectId: repo.projectId },
            lastDeploy,
            ...changes,
            oldestAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
          };
        } catch (err) {
          return { ...head, lastDeploy, error: err.message };
        }
      }));
      return { targets: results };
    },

    /**
     * Each production environment's deploys over `days` days, with the lead
     * time (commit to production, in hours) of the commits each recent
     * successful deploy shipped. Environments that can't be read are skipped.
     */
    async deliveryData(days) {
      const targets = await productionTargets();
      const results = await Promise.all(targets.map(async (t) => {
        let history;
        try {
          history = await deployHistory(t, days + 30); // a month more, to find the deploy before the first one
        } catch (err) {
          console.warn(`[delivery] ${t.name}: ${err.message}`);
          return null;
        }
        const since = Date.now() - days * DAY;
        const deploys = await Promise.all(history.map(async (d, i) => {
          const out = { id: d.id, label: d.label, at: d.at, status: d.status, webUrl: d.webUrl, target: t.name };
          if (d.status !== 'succeeded' || Date.parse(d.at) < since || !d.commit) return out;
          const recentIndex = history.slice(0, i).filter((x) => x.status === 'succeeded').length;
          const prev = previousDeploy(history, i);
          if (recentIndex >= LEAD_TIME_DEPLOYS || !prev || prev.commit === d.commit) return out;
          const commits = await commitsBetween(t.projectId, d.repoId, prev.commit, d.commit).catch(() => []);
          return { ...out, leadTimes: commits.map((c) => (Date.parse(d.at) - Date.parse(c.author?.date)) / HOUR).filter((h) => h >= 0) };
        }));
        return { key: t.key, name: t.name, projectName: t.projectName, deploys };
      }));
      return results.filter(Boolean);
    },

    async delivery(days) {
      return buildDelivery({ targets: await this.deliveryData(days), days });
    },

    /** Raw material for one week's summary (see domain/summary.js). */
    async summaryData({ from }) {
      const days = Math.ceil((Date.now() - from) / DAY) + 1;
      const [settings, projects, open, merged, targets] = await Promise.all([store.load(), tracked(), openItems(), closedPRs(days), productionTargets()]);
      const finished = await cached(`wi:done:${days}`, async () => {
        const lists = await Promise.all(projects.map(async (p) => {
          const { areaPaths } = await scope(p);
          const items = await provider.queryWorkItems(p.id, { doneWithinDays: days, areaPaths, categories: ['requirement', 'bug', 'feature', 'epic'] });
          return items.map((w) => ({ ...w, projectId: p.id }));
        }));
        return lists.flat();
      }, 5 * MIN);
      const deploys = (await Promise.all(targets.map((t) => deployHistory(t, days).then((list) => list.map((d) => ({ ...d, target: t.name }))).catch(() => [])))).flat();
      return {
        finished,
        merged,
        deploys,
        blocked: open.filter((w) => isBlocked(w, settings.blockedTag)),
        inProgress: open.filter((w) => w.stateCategory === 'InProgress').length,
      };
    },

    async summary(week) {
      const range = weekRange(week);
      if (range.from < Date.now() - 180 * DAY) throw Object.assign(new Error('Summaries go back 26 weeks'), { status: 400 });
      return buildSummary({ ...range, ...(await this.summaryData(range)) });
    },

    /** Raw material for work item flow: backlog items and bugs finished in the last `days` days, and open work now. */
    async flowData(days) {
      const [projects, open] = await Promise.all([tracked(), openItems()]);
      const finished = await cached(`flow:done:${days}`, async () => {
        const lists = await Promise.all(projects.map(async (p) => {
          const { areaPaths } = await scope(p);
          const items = await provider.queryWorkItems(p.id, { doneWithinDays: days, areaPaths, categories: ['requirement', 'bug'] });
          return items.map((w) => ({ ...w, projectId: p.id }));
        }));
        return lists.flat();
      }, 5 * MIN);
      return { finished, open };
    },

    async flow(days) {
      return buildFlow({ ...(await this.flowData(days)), days });
    },

    /**
     * Each tracked team's live sprint: what it held at the end of its first
     * day, what it holds now, and what came over unfinished from the sprint
     * before (WIQL ASOF, so moves in and out of the sprint count).
     */
    async sprints() {
      const projects = await tracked();
      const pairs = projects.flatMap((p) => p.teams.map((team) => ({ p, team })));
      const rows = await Promise.all(pairs.map(async ({ p, team }) => {
        const { iteration } = await teamScope(p, team);
        if (!iteration || iteration.status !== 'live') return null;
        try {
          const areaPaths = await cached(`areas:${p.id}:${team.id}`, () => provider.getTeamAreas(p.id, team.id).catch(() => null), 10 * MIN);
          const base = { areaPaths, categories: ['requirement', 'bug'] };
          const iterations = await cached(`iterations:${p.id}:${team.id}`, () => provider.listIterations(p.id, team.id), 30 * MIN);
          const start = Date.parse(iteration.startDate);
          const previous = iterations.filter((it) => Date.parse(it.finishDate) < start).pop() || null;
          // The end of the first day: planning happens then, so changes after it are scope change.
          const committedAt = new Date(Math.min(Date.now(), start + DAY)).toISOString();
          const ids = (c, ttl) => cached(`flow:ids:${p.id}:${JSON.stringify(c)}`, () => provider.queryWorkItemIds(p.id, { ...base, ...c }), ttl);
          const [startIds, prevOpenIds, items] = await Promise.all([
            ids({ iterationPath: iteration.path, asOf: committedAt }, committedAt < new Date().toISOString() ? 60 * MIN : MIN),
            // Open in the previous sprint at the end of its last day (and before this one began).
            previous ? ids({ iterationPath: previous.path, open: true, asOf: new Date(Math.min(Date.parse(previous.finishDate) + DAY, start) - MIN).toISOString() }, 60 * MIN) : [],
            cached(`flow:sprint:${p.id}:${team.id}:${iteration.path}`, () => provider.queryWorkItems(p.id, { ...base, iterationPath: iteration.path }), 2 * MIN),
          ]);
          const gone = startIds.filter((id) => !items.some((w) => w.id === id));
          const removed = gone.length ? await provider.getWorkItems(gone.slice(0, 200)).catch(() => []) : [];
          return buildSprintScope({
            project: { id: p.id, name: p.name },
            team,
            iteration,
            previous,
            startIds,
            prevOpenIds,
            items,
            removed,
          });
        } catch (err) {
          console.warn(`[sprints] ${p.name} / ${team.name}: ${err.message}`);
          return { project: { id: p.id, name: p.name }, team, iteration: { name: iteration.name, path: iteration.path }, error: err.message };
        }
      }));
      return { sprints: rows.filter(Boolean) };
    },

    /** One commit with its whole message and changed files (commits never change, so it's kept a while). */
    async commit(projectId, repoId, commitId) {
      await assertTrackedRepo(repoId);
      const c = await cached(`commit:${repoId}:${commitId}`, () => provider.getCommit(projectId, repoId, commitId), 60 * MIN);
      return { ...c, ...commitRefs(c.message) };
    },

    async createPullRequest(input) {
      const settings = await store.load();
      const { projectId, repoId, source, target } = input;
      await assertTrackedRepo(repoId);
      const title = String(input.title || '').trim();
      const description = String(input.description || '');
      const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
      if (!source || !target) throw bad('Pick a source and a target branch');
      if (source === target) throw bad('Source and target branches must be different');
      if (!title) throw bad('Give the pull request a title');
      if (title.length > 400) throw bad('Title is too long (400 characters max)');
      if (description.length > 4000) throw bad('Description is too long (Azure DevOps allows 4,000 characters)');
      const pr = await provider.createPullRequest(projectId, repoId, {
        source,
        target,
        title,
        description,
        isDraft: !!input.isDraft,
        reviewers: (Array.isArray(input.reviewers) ? input.reviewers : []).filter((r) => r?.id).map((r) => ({ id: String(r.id), isRequired: !!r.isRequired })),
        workItemIds: (Array.isArray(input.workItemIds) ? input.workItemIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
        autoComplete: !!input.autoComplete,
        completionOptions: {
          mergeStrategy: settings.autoComplete.mergeStrategy,
          deleteSourceBranch: settings.autoComplete.deleteSourceBranch,
          transitionWorkItems: settings.autoComplete.transitionWorkItems,
        },
      });
      cache.invalidate('prs:');
      cache.invalidate(`branches:${repoId}`);
      return { projectId: pr.projectId, repoId: pr.repoId, id: pr.id, webUrl: pr.webUrl, title: pr.title };
    },

    async pullRequests() {
      const [prs, repoList, team] = await Promise.all([activePRs(), repos(), people()]);
      return { prs, repos: repoList, people: team };
    },

    async pullRequest(projectId, repoId, id) {
      const [who, pr] = await Promise.all([me(), cached(`pr:${projectId}/${repoId}/${id}`, () => provider.getPullRequest(projectId, repoId, id), 30 * 1000)]);
      return enrichPR(pr, who);
    },

    /** Merge conflicts of a pull request (fresh each time: they change as people push). */
    async pullRequestConflicts(projectId, repoId, id) {
      return { conflicts: await provider.listPullRequestConflicts(projectId, repoId, id) };
    },

    async prAction(projectId, repoId, id, action) {
      const settings = await store.load();
      switch (action.type) {
        case 'vote':
          if (![10, 5, 0, -5, -10].includes(action.vote)) throw Object.assign(new Error('Invalid vote'), { status: 400 });
          await provider.votePullRequest(projectId, repoId, id, action.vote);
          break;
        case 'comment':
          if (!action.content?.trim()) throw Object.assign(new Error('Comment is empty'), { status: 400 });
          await provider.commentPullRequest(projectId, repoId, id, action.content.trim());
          break;
        case 'addReviewer':
          await provider.addReviewer(projectId, repoId, id, action.reviewerId, !!action.isRequired);
          break;
        case 'publish':
          await provider.updatePullRequest(projectId, repoId, id, { publish: true });
          break;
        case 'restartMerge':
          await provider.restartMerge(projectId, repoId, id);
          break;
        case 'abandon':
          await provider.updatePullRequest(projectId, repoId, id, { abandon: true });
          break;
        case 'complete': {
          const strategies = ['squash', 'noFastForward', 'rebase', 'rebaseMerge'];
          const mergeStrategy = strategies.includes(action.mergeStrategy) ? action.mergeStrategy : settings.autoComplete.mergeStrategy;
          const bypassReason = String(action.bypassReason || '').trim();
          if (action.bypassPolicy && !bypassReason) throw Object.assign(new Error('Give a reason for overriding branch policies'), { status: 400 });
          await provider.updatePullRequest(projectId, repoId, id, {
            complete: true,
            completionOptions: {
              mergeStrategy,
              deleteSourceBranch: !!action.deleteSourceBranch,
              transitionWorkItems: !!action.transitionWorkItems,
              ...(action.mergeCommitMessage ? { mergeCommitMessage: String(action.mergeCommitMessage).slice(0, 4000) } : {}),
              ...(action.bypassPolicy ? { bypassPolicy: true, bypassReason } : {}),
            },
          });
          cache.invalidate('prs:closed');
          break;
        }
        case 'autoComplete':
          await provider.updatePullRequest(projectId, repoId, id, {
            autoComplete: !!action.enabled,
            completionOptions: {
              mergeStrategy: settings.autoComplete.mergeStrategy,
              deleteSourceBranch: settings.autoComplete.deleteSourceBranch,
              transitionWorkItems: settings.autoComplete.transitionWorkItems,
            },
          });
          break;
        default:
          throw Object.assign(new Error(`Unknown action ${action.type}`), { status: 400 });
      }
      cache.invalidate('prs:');
      cache.invalidate(`pr:${projectId}/${repoId}/${id}`);
    },

    async workItems() {
      const [items, states, team, paths, who] = await Promise.all([openItems(), stateMaps(), people(), currentIterationPaths(), me()]);
      return { items, states, people: team, currentIterationPaths: paths, me: who };
    },

    async workItem(id) {
      const item = await provider.getWorkItem(id);
      const states = await provider.getStateMap(item.projectName).catch(() => ({}));
      return { ...item, allowedStates: states[item.type] || [] };
    },

    /** One of a work item's attachments, checked against the item: { name, length, stream }. */
    async workItemAttachment(id, attachmentId) {
      const file = (await provider.listAttachments(id)).find((a) => a.id.toLowerCase() === String(attachmentId).toLowerCase());
      if (!file) throw Object.assign(new Error('Attachment not found on this work item'), { status: 404 });
      const { length, stream } = await provider.downloadAttachment(file.id, file.name);
      return { name: file.name, length: length ?? file.size, stream };
    },

    /** Work item types in the tracked projects: [{ name, color (Azure DevOps), projects }]. */
    async workItemTypes() {
      const projects = await tracked();
      const byName = new Map();
      for (const p of projects) {
        const types = await provider.getWorkItemTypes(p.id).catch(() => []);
        for (const t of types) {
          const entry = byName.get(t.name) || { name: t.name, color: t.color, projects: [] };
          entry.color ||= t.color;
          entry.projects.push(p.name);
          byName.set(t.name, entry);
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    /** What the new work item form can offer: per tracked project, its types and teams (default area, current sprint). */
    async newWorkItemOptions() {
      const projects = await tracked();
      return Promise.all(projects.map(async (p) => {
        const [stateMap, teams] = await Promise.all([
          provider.getStateMap(p.id).catch(() => ({})),
          Promise.all(p.teams.map(async (t) => {
            const [areaPath, iteration] = await Promise.all([
              cached(`defarea:${p.id}:${t.id}`, () => provider.getTeamDefaultArea(p.id, t.id).catch(() => null), 30 * MIN),
              cached(`curiter:${p.id}:${t.id}`, () => provider.getCurrentIteration(p.id, t.id).catch(() => null), 30 * MIN),
            ]);
            return { id: t.id, name: t.name, areaPath, iteration: iteration && { name: iteration.name, path: iteration.path } };
          })),
        ]);
        return { id: p.id, name: p.name, types: creatableTypes(stateMap), teams };
      }));
    },

    /** Creates a work item from the form; returns its id. */
    async createWorkItem(body = {}) {
      const p = (await tracked()).find((x) => x.id === body.projectId);
      if (!p) throw Object.assign(new Error('Pick one of your tracked projects.'), { status: 400 });
      const types = creatableTypes(await provider.getStateMap(p.id).catch(() => ({})));
      if (!types.includes(body.type)) throw Object.assign(new Error('Pick a work item type.'), { status: 400 });
      const title = String(body.title || '').trim();
      if (!title) throw Object.assign(new Error('Give the work item a title.'), { status: 400 });
      if (title.length > 255) throw Object.assign(new Error('The title can have at most 255 characters.'), { status: 400 });
      const team = p.teams.find((t) => t.id === body.teamId) || p.teams[0] || null;
      let areaPath = null;
      let iterationPath = p.name; // the project's backlog
      if (team) {
        const opts = (await this.newWorkItemOptions()).find((x) => x.id === p.id)?.teams.find((t) => t.id === team.id);
        areaPath = opts?.areaPath || null;
        if (body.iteration === 'sprint' && opts?.iteration?.path) iterationPath = opts.iteration.path;
      }
      const priority = [1, 2, 3, 4].includes(Number(body.priority)) ? Number(body.priority) : null;
      const tags = Array.isArray(body.tags) ? body.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [];
      const parentId = Number(body.parentId) > 0 ? Number(body.parentId) : null;
      // "Related" links, e.g. a production bug to the work items the deploy shipped.
      const relatedIds = [...new Set((Array.isArray(body.relatedIds) ? body.relatedIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== parentId))].slice(0, 20);
      const created = await provider.createWorkItem(p.name, body.type, {
        title,
        description: String(body.description || '').slice(0, 20_000),
        assignedTo: body.assignedTo ? String(body.assignedTo) : null,
        areaPath,
        iterationPath,
        priority,
        tags,
        relatedIds,
      }, parentId);
      cache.invalidate('wi:');
      return created;
    },

    async workItemAction(id, action) {
      if (action.type === 'update') {
        const changes = { ...(action.changes || {}) };
        // Only a team board's own column/done/lane fields may be written directly.
        if (changes.fields) {
          changes.fields = Object.fromEntries(Object.entries(changes.fields).filter(([k]) => /^WEF_[0-9A-F]{32}_Kanban.(Column|Column.Done|Lane)$/i.test(k) || /^Mock_Kanban./.test(k)));
        }
        await provider.updateWorkItem(id, changes);
      } else if (action.type === 'comment') {
        if (!action.text?.trim()) throw Object.assign(new Error('Comment is empty'), { status: 400 });
        const item = await provider.getWorkItems([Number(id)]);
        await provider.commentWorkItem(item[0]?.projectName, id, action.text.trim());
      } else {
        throw Object.assign(new Error(`Unknown action ${action.type}`), { status: 400 });
      }
      cache.invalidate('wi:');
    },

    /**
     * One team's board. "open": all open work in the team's area paths plus
     * whatever was finished in the last `doneDays` days, regardless of sprint.
     * "sprint": just the team's current iteration.
     */
    async board({ projectId, teamId, boardId, mode = 'open', doneDays = 14 } = {}) {
      const projects = await tracked();
      const options = projects.flatMap((p) => p.teams.map((t) => ({ projectId: p.id, projectName: p.name, teamId: t.id, teamName: t.name })));
      const pick = options.find((o) => o.projectId === projectId && (!teamId || o.teamId === teamId)) || options[0];
      if (!pick) return { project: null, options };
      const p = projects.find((x) => x.id === pick.projectId);
      const team = { id: pick.teamId, name: pick.teamName };
      const [{ iteration }, areaPaths, states, cfg] = await Promise.all([
        teamScope(p, team),
        // A team's board is its area paths, whatever the "limit to team areas" setting says.
        cached(`areas:${p.id}:${team.id}`, () => provider.getTeamAreas(p.id, team.id).catch(() => null), 10 * MIN),
        stateMaps(),
        teamBoards(p.id, team.id),
      ]);

      // The team's real boards (Azure DevOps columns); without them, fall back to state categories.
      const visible = (cfg?.boards || []).filter((b) => !b.hidden);
      const board = visible.find((b) => b.id === boardId) || visible[0] || null;
      const types = board ? [...new Set([...board.types, ...(board.isRequirement ? cfg.taskTypes : [])])] : null;
      const extraFields = board ? Object.values(board.fields).filter(Boolean) : [];
      const query = (c) => provider.queryWorkItems(p.id, { ...c, areaPaths, ...(types ? { types, extraFields } : {}) });
      const tag = (w) => ({ ...w, projectId: p.id, ...(board ? { board: placeOnBoard(board, w) } : {}) });
      const scopeKey = `${p.id}:${team.id}:${board?.id || 'states'}`;

      let items = [];
      if (mode === 'sprint') {
        if (iteration) {
          items = await cached(`wi:sprint:${scopeKey}:${iteration.path}`, async () => (await query({ iterationPath: iteration.path })).map(tag));
        }
      } else {
        items = await cached(`wi:board:${scopeKey}:${doneDays}`, async () => {
          const [open, done] = await Promise.all([query({ open: true }), query({ doneWithinDays: doneDays })]);
          return [...new Map([...open, ...done].map((w) => [w.id, tag(w)])).values()];
        });
      }
      // Columns list cards in backlog order, like Azure DevOps (unranked last).
      items = [...items].sort(byBacklogOrder);
      return {
        project: { id: p.id, name: p.name, teamId: team.id, teamName: team.name },
        options,
        boards: visible.map(({ id, name, types: t }) => ({ id, name, types: t })),
        board,
        taskTypes: cfg?.taskTypes || ['Task'],
        mode: mode === 'sprint' ? 'sprint' : 'open',
        doneDays,
        iteration,
        items,
        states: states[p.id] || {},
      };
    },

    /**
     * Moves a card up or down its column: places work item `id` between
     * previousId and nextId in the team's backlog order (0 = no neighbour).
     */
    async reorderBoard(projectId, { teamId, id, previousId = 0, nextId = 0 } = {}) {
      const ids = [id, previousId, nextId].map(Number);
      if (!teamId || !Number.isInteger(ids[0]) || ids[0] <= 0 || ids.slice(1).some((n) => !Number.isInteger(n) || n < 0) || ids[0] === ids[1] || ids[0] === ids[2]) {
        throw Object.assign(new Error('Pick a spot between two other cards'), { status: 400 });
      }
      const team = (await tracked()).find((p) => p.id === projectId)?.teams.find((t) => t.id === teamId);
      if (!team) throw Object.assign(new Error('That team isn\'t tracked in Keel'), { status: 404 });
      const result = await provider.reorderWorkItems(projectId, teamId, { ids: [ids[0]], previousId: ids[1], nextId: ids[2] });
      cache.invalidate('wi:');
      return { order: result };
    },

    async epics({ includeClosed = false } = {}) {
      const [projects, settings] = await Promise.all([tracked(), store.load()]);
      const perProject = await Promise.all(projects.map(async (p) => {
        const { areaPaths } = await scope(p);
        const h = await cached(`wi:epics:${p.id}:${includeClosed}`, () => provider.getHierarchy(p.id, { includeClosed, areaPaths }), 5 * MIN);
        return { projectId: p.id, projectName: p.name, epics: buildEpicTree({ ...h, blockedTag: settings.blockedTag }) };
      }));
      return { projects: perProject };
    },

    async pipelines() {
      return pipelines();
    },

    /** What the watcher compares between polls (see domain/changes.js). */
    async snapshot() {
      const [att, prs, builds, who, items, rels] = await Promise.all([
        this.attention(), activePRs(), rawBuilds(), me(), openItems(), releases().catch(() => []),
      ]);
      const dayAgo = Date.now() - DAY;
      return {
        attention: att.items.map(({ key, kind, severity, title, reasons, target, webUrl }) => ({ key, kind, severity, title, reasons, target, webUrl })),
        myPrs: prs.filter((p) => p.isMine).map((p) => ({
          key: p.key, id: p.id, title: p.title, projectId: p.projectId, repoId: p.repoId, status: p.status,
          reviewers: p.reviewers.map(({ id, displayName, vote, isContainer }) => ({ id, displayName, vote, isContainer })),
        })),
        runs: builds
          .filter((b) => b.status !== 'completed' || Date.parse(b.finishedAt) > dayAgo)
          .map((b) => ({
            id: b.id, projectId: b.projectId, definition: { id: b.definition.id, name: b.definition.name }, status: b.status, result: b.result, buildNumber: b.buildNumber,
            sourceBranch: b.sourceBranch, webUrl: b.webUrl, mine: sameIdentity(b.requestedFor, who),
          })),
        // Anything else the pages show, so lists refresh even when nothing is notification-worthy.
        extra: [
          prs.map((p) => `${p.key}:${p.mergeStatus}:${p.isDraft}:${p.title}:${p.reviewers.map((r) => r.vote).join(',')}`).join('|'),
          items.map((w) => `${w.id}:${w.rev ?? ''}:${w.changedAt}`).join('|'),
          rels.map((d) => d.stages.map((s) => `${s.latest?.releaseId}:${s.latest?.status}:${s.active?.status}`).join(',')).join('|'),
          (monitoring ? monitoring.status() : []).map((m) => `${m.id}:${m.last?.at}:${m.ai?.at}`).join('|'),
        ].join('#'),
      };
    },

    async production() {
      return { enabled: !!monitoring, monitors: await production() };
    },

    monitors: () => {
      if (!monitoring) throw Object.assign(new Error('Production monitoring is not available on this server'), { status: 404 });
      return monitoring;
    },

    async releases() {
      const [defs, appr] = await Promise.all([releases(), approvals()]);
      return { definitions: defs, approvals: appr };
    },

    async approvals() {
      return approvals();
    },

    async decideApproval(kind, id, { status, comment } = {}) {
      if (!['approved', 'rejected'].includes(status)) throw Object.assign(new Error('Status must be approved or rejected'), { status: 400 });
      const a = (await approvals()).find((x) => x.kind === kind && String(x.id) === String(id));
      if (!a) throw Object.assign(new Error('That approval is no longer pending. It may have been handled already.'), { status: 404 });
      if (kind === 'yaml') await provider.decidePipelineApproval(a.projectName, a.id, status, comment);
      else await provider.decideReleaseApproval(a.projectName, a.id, status, comment);
      cache.invalidate('builds');
    },

    async createRelease(projectId, definitionId, description) {
      const p = (await tracked()).find((x) => x.id === projectId);
      if (!p) throw Object.assign(new Error('Unknown project'), { status: 400 });
      const r = await provider.createRelease(p.name, definitionId, description);
      cache.invalidate('builds');
      return r;
    },

    async deployReleaseStage(projectId, releaseId, environmentId, comment) {
      const p = (await tracked()).find((x) => x.id === projectId);
      if (!p) throw Object.assign(new Error('Unknown project'), { status: 400 });
      await provider.deployReleaseStage(p.name, releaseId, environmentId, comment);
      cache.invalidate('builds');
    },

    /** One pipeline: its health row and its latest runs (any branch). */
    async pipelineRuns(projectId, definitionId) {
      if (!(await tracked()).some((p) => p.id === projectId)) throw Object.assign(new Error('Unknown project'), { status: 400 });
      const id = Number(definitionId);
      const [rows, runs] = await Promise.all([
        pipelines(),
        cached(`builds:runs:${projectId}:${id}`, () => provider.listDefinitionRuns(projectId, id, { top: 25 }), MIN),
      ]);
      return { pipeline: rows.find((r) => r.projectId === projectId && r.definition.id === id) || null, runs };
    },

    /** One run: stages, jobs and steps; the failed steps' last log lines; commits; tests; approvals it waits on. */
    async runDetails(projectId, buildId) {
      if (!(await tracked()).some((p) => p.id === projectId)) throw Object.assign(new Error('Unknown project'), { status: 400 });
      const id = Number(buildId);
      // The timeline is re-read on every live poll ("builds" keys are dropped then); logs and commits don't change.
      const timeline = await cached(`builds:timeline:${id}`, () => provider.getBuildTimeline(projectId, id), 15 * 1000);
      const failed = timeline.filter((r) => r.type === 'Task' && r.result === 'failed' && r.logId != null).slice(0, 3);
      const [changes, tests, logs, waiting] = await Promise.all([
        cached(`runchanges:${id}`, () => provider.getBuildChanges(projectId, id).catch(() => []), 60 * MIN),
        cached(`runtests:${id}`, () => provider.getBuildTests(projectId, id).catch(() => null), 2 * MIN),
        Promise.all(failed.map(async (r) => [r.id, await cached(`runlog:${id}:${r.logId}`, () => provider.getBuildLogTail(projectId, id, r.logId).catch(() => null), 60 * MIN)])),
        approvals().catch(() => []),
      ]);
      return { timeline, logs: Object.fromEntries(logs), changes, tests, approvals: waiting.filter((a) => a.kind === 'yaml' && a.run?.id === id) };
    },

    /**
     * Flaky tests across tracked pipelines, from their recent runs on their own
     * branch. Only red runs' test results are read (up to 150 runs; finished
     * runs never change, so each is read once a day at most).
     */
    async flakyTests() {
      const [rows, builds] = await Promise.all([pipelines(), rawBuilds()]);
      const judged = rows.filter((r) => r.branch && r.runCount);
      const home = new Map(judged.map((r) => [`${r.projectId}:${r.definition.id}`, r.branch]));
      const red = builds
        .filter((b) => b.status === 'completed' && ['failed', 'partiallySucceeded'].includes(b.result) && b.reason !== 'pullRequest'
          && home.get(`${b.projectId}:${b.definition.id}`) === b.sourceBranch)
        .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))
        .slice(0, 150);
      const read = await Promise.all(red.map(async (b) => [b.id, await cached(`tests:failed:${b.id}`, () => provider.getBuildFailedTests(b.projectId, b.id).catch(() => null), 24 * 60 * MIN)]));
      const failedTests = new Map(read.filter(([, r]) => r));
      return {
        ...findFlakyTests({ pipelines: judged, builds, failedTests }),
        // Red runs, but no test results at all: no tests published, or no Test Management scope on the token.
        noTestData: red.length > 0 && failedTests.size === 0,
        days: (await store.load()).thresholds.buildLookbackDays,
      };
    },

    async queueBuild(projectId, definitionId, branch) {
      const result = await provider.queueBuild(projectId, Number(definitionId), branch);
      cache.invalidate('builds');
      return result;
    },

    async team() {
      const [rows, paths] = await Promise.all([workload(), currentIterationPaths()]);
      return { rows, currentIterationPaths: paths };
    },

    /** Raw inputs of insights and workload, so several organizations can be judged together (multiorg.js). */
    async insightsData(days) {
      const [closed, active, pipes] = await Promise.all([closedPRs(days), activePRs(), pipelines()]);
      return { closedPrs: closed, activePrs: active, pipelines: pipes };
    },
    async workloadData() {
      const [settings, prs, items, team, paths] = await Promise.all([store.load(), activePRs(), openItems(), people(), currentIterationPaths()]);
      return { people: team, prs, items, thresholds: settings.thresholds, blockedTag: settings.blockedTag, currentIterationPaths: paths };
    },

    async insights(days) {
      const [closed, active, pipes] = await Promise.all([closedPRs(days), activePRs(), pipelines()]);
      return buildInsights({ closedPrs: closed, activePrs: active, pipelines: pipes, days });
    },

    async changelog(body) {
      const { prs, workItemsByPr } = await this.changelogData(body);
      return buildChangelog({ prs, workItemsByPr: new Map(workItemsByPr), from: body.from, to: body.to, title: body.title });
    },

    /** Merged pull requests in a date range and the work items each delivered (for several organizations, multiorg.js). */
    async changelogData({ from, to, repoIds }) {
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to) + DAY; // inclusive end date
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
        throw Object.assign(new Error('Invalid date range'), { status: 400 });
      }
      const days = Math.ceil((Date.now() - fromMs) / DAY) + 1;
      const prs = (await closedPRs(days))
        .filter((p) => p.status === 'completed' && Date.parse(p.closedAt) >= fromMs && Date.parse(p.closedAt) < toMs)
        .filter((p) => !repoIds?.length || repoIds.includes(p.repoId))
        .slice(0, 400);
      const idLists = await Promise.all(prs.map((p) => cached(`prwi:${p.key}`, () => provider.getPullRequestWorkItemIds(p.projectId, p.repoId, p.id).catch(() => []), 60 * MIN)));
      const items = await provider.getWorkItems([...new Set(idLists.flat())]);
      const byId = new Map(items.map((w) => [w.id, w]));
      return { prs, workItemsByPr: prs.map((p, i) => [p.key, idLists[i].map((id) => byId.get(id)).filter(Boolean)]) };
    },

    async settingsView() {
      await ensureSeeded();
      const [settings, projects] = await Promise.all([store.load(), allProjects()]);
      return { settings, projects };
    },

    async projectOptions(projectId) {
      const [teams, repoList] = await Promise.all([provider.listTeams(projectId), provider.listRepos(projectId)]);
      return { teams, repos: repoList };
    },

    /** Per-account UI preferences, merged key by key (small, known keys only). */
    async savePrefs(patch) {
      const allowed = ['theme', 'notifications', 'dashboard', 'language'];
      const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => allowed.includes(k) && v && typeof v === 'object'));
      if (JSON.stringify(clean).length > 20_000) throw Object.assign(new Error('Preferences are too large'), { status: 413 });
      const current = (await store.load()).prefs || {};
      const saved = await store.save({ prefs: { ...current, ...clean } });
      return saved.prefs;
    },

    async saveSettings(patch) {
      const allowed = {};
      for (const k of ['projects', 'thresholds', 'blockedTag', 'autoComplete', 'refreshSeconds']) if (k in patch) allowed[k] = patch[k];
      if ('refreshSeconds' in allowed) allowed.refreshSeconds = Math.min(600, Math.max(15, Math.round(Number(allowed.refreshSeconds) || 60)));
      const saved = await store.save(allowed);
      cache.invalidate('');
      return saved;
    },
  };
}
