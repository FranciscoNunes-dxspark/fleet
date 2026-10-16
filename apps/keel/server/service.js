// Composes the provider (real or mock), the cache and the lead's settings into
// the views the API serves. Everything here is scoped to *tracked* projects
// and repos, so the app only ever looks at what the lead cares about.
import { config } from './config.js';
import { Cache } from './cache.js';
import { createSettingsStore, defaultSettingsFile, pruneSnoozed } from './settings.js';
import { createAzdoProvider } from './azdo/provider.js';
import { createMockProvider } from './mock/provider.js';
import { DAY, enrichPR, sameIdentity } from './domain/prs.js';
import { releaseHealth } from './domain/releases.js';
import { pipelineHealth } from './domain/pipelines.js';
import { buildWorkload } from './domain/workload.js';
import { buildAttention } from './domain/attention.js';
import { buildInsights } from './domain/insights.js';
import { buildChangelog } from './domain/changelog.js';
import { buildEpicTree } from './domain/epics.js';
import { deployMarkers, evaluateMonitor } from './domain/production.js';

const MIN = 60_000;

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
      const markers = deployMarkers(m, { releases: rels, pipelines: pipes, builds });
      return { ...m, markers, ...evaluateMonitor(m, markers) };
    });
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
      const created = await provider.createWorkItem(p.name, body.type, {
        title,
        description: String(body.description || '').slice(0, 20_000),
        assignedTo: body.assignedTo ? String(body.assignedTo) : null,
        areaPath,
        iterationPath,
        priority,
        tags,
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

    async changelog({ from, to, repoIds, title }) {
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
      const workItemsByPr = new Map(prs.map((p, i) => [p.key, idLists[i].map((id) => byId.get(id)).filter(Boolean)]));
      return buildChangelog({ prs, workItemsByPr, from, to, title });
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
