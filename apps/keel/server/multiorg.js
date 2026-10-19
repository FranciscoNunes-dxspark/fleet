// Several Azure DevOps organizations behind one service-shaped object. Each
// organization has its own service (and provider, token and caches); this
// layer merges what they return and sends single-item calls to the right one.
//
// - Lists are concatenated, each entry tagged with `org` (the organization key).
// - Anything addressed by project (PRs, builds, releases, boards) goes to the
//   organization that owns the project; project ids are unique across them.
// - Work item ids are only unique within an organization, so calls by id take
//   an org key (the primary when absent).
// - Insights and workload are computed once over every organization's data.
// - A failing secondary organization is left out (and reported in /meta); a
//   failing primary fails the request, as with a single organization.
import { buildInsights } from './domain/insights.js';
import { buildWorkload } from './domain/workload.js';
import { buildDelivery } from './domain/delivery.js';
import { buildChangelog } from './domain/changelog.js';
import { buildSummary, weekRange } from './domain/summary.js';
import { buildFlow } from './domain/flow.js';
import { byFlakiness } from './domain/tests.js';
import { DAY } from './domain/prs.js';

const SEVERITY = { high: 0, medium: 1, low: 2 };
const HEALTH = { failing: 0, unstable: 1, healthy: 2, unknown: 3 };

export function createMultiService(entries) {
  if (entries.length === 1) return entries[0].service;
  const primary = entries[0];
  const errors = new Map(); // org key -> last error message

  // A list (a repo's branches, say) tags each entry: spread into an object it would become { 0: ..., 1: ... }.
  const tag = (org, x) => (Array.isArray(x) ? x.map((y) => tag(org, y)) : x && typeof x === 'object' ? { ...x, org: org.key } : x);
  const tagAll = (org, list) => (list || []).map((x) => tag(org, x));
  const byKey = (key) => entries.find((e) => e.org.key === key) || primary;
  // Inbox entries: the item and what it opens both carry the organization.
  const tagAttention = (org, list) => (list || []).map((i) => ({ ...i, org: org.key, target: i.target && { ...i.target, org: org.key } }));

  /** Run fn on every organization; secondaries that fail are skipped (and reported). */
  async function each(fn) {
    const results = await Promise.allSettled(entries.map((e) => fn(e.service, e.org)));
    const out = [];
    results.forEach((r, i) => {
      const { org } = entries[i];
      if (r.status === 'fulfilled') {
        errors.delete(org.key);
        out.push({ org, value: r.value });
      } else if (org.primary) {
        throw r.reason;
      } else {
        errors.set(org.key, r.reason?.message || String(r.reason));
        console.warn(`[orgs] ${org.key}: ${r.reason?.message || r.reason}`);
      }
    });
    return out;
  }

  // Which organization owns a project (tracked or not): from each one's project list.
  let owners = null;
  let ownersAt = 0;
  async function ownerOf(projectId) {
    if (!owners || Date.now() - ownersAt > 5 * 60_000 || !owners.has(projectId)) {
      const lists = await each((s) => s.allProjects());
      owners = new Map(lists.flatMap(({ org, value }) => value.map((p) => [p.id, org.key])));
      ownersAt = Date.now();
    }
    const key = owners.get(projectId);
    if (!key) throw Object.assign(new Error('Unknown project'), { status: 400 });
    return byKey(key);
  }
  const viaProject = (method) => async (projectId, ...args) => {
    const e = await ownerOf(projectId);
    return tag(e.org, await e.service[method](projectId, ...args));
  };

  const uniquePeople = (lists) => {
    const seen = new Map();
    for (const p of lists.flat()) {
      const k = (p.uniqueName || p.id || '').toLowerCase();
      if (k && !seen.has(k)) seen.set(k, p);
    }
    return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  };
  const sumObjects = (list) => {
    const out = {};
    for (const o of list) for (const [k, v] of Object.entries(o || {})) out[k] = typeof v === 'number' ? (out[k] || 0) + v : out[k] ?? v;
    return out;
  };

  return {
    org: primary.org,
    orgs: entries.map((e) => e.org),
    settingsStore: primary.service.settingsStore,
    // /api/image: the organization whose address the image URL starts with.
    provider: {
      orgUrl: primary.service.provider?.orgUrl || primary.org.url,
      fetchOrgImage(url) {
        const e = entries.find((x) => String(url).toLowerCase().startsWith(`${x.org.url.toLowerCase()}/`)) || primary;
        return e.service.provider.fetchOrgImage(url);
      },
    },

    withProjects: (projectIds) => createMultiService(entries.map((e) => ({ org: e.org, service: e.service.withProjects(projectIds) }))),

    invalidate(prefix) {
      owners = null;
      for (const e of entries) e.service.invalidate(prefix);
    },

    async meta() {
      const metas = await each((s) => s.meta());
      const base = metas[0].value;
      return {
        ...base,
        org: primary.org,
        orgs: entries.map((e) => ({ ...e.org, error: errors.get(e.org.key) || null })),
        trackedProjects: metas.flatMap(({ org, value }) => tagAll(org, value.trackedProjects)),
      };
    },
    savePrefs: (patch) => primary.service.savePrefs(patch),

    async attention() {
      const parts = await each((s) => s.attention());
      const items = parts.flatMap(({ org, value }) => tagAttention(org, value.items));
      items.sort((a, b) => (SEVERITY[a.severity] ?? 3) - (SEVERITY[b.severity] ?? 3));
      return {
        items,
        snoozedCount: parts.reduce((n, p) => n + (p.value.snoozedCount || 0), 0),
        summary: sumObjects(parts.map((p) => p.value.summary)),
      };
    },
    // Snoozes live in the shared settings; other organizations' keys carry their prefix.
    snooze: (key, days) => primary.service.snooze(key, days),
    clearSnoozes: () => primary.service.clearSnoozes(),

    async people() {
      return uniquePeople((await each((s) => s.people())).map((p) => p.value));
    },
    async repos() {
      return (await each((s) => s.repos())).flatMap(({ org, value }) => tagAll(org, value));
    },
    async pullRequests() {
      const parts = await each((s) => s.pullRequests());
      return {
        prs: parts.flatMap(({ org, value }) => tagAll(org, value.prs)),
        repos: parts.flatMap(({ org, value }) => tagAll(org, value.repos)),
        people: uniquePeople(parts.map((p) => p.value.people)),
      };
    },
    async closedPullRequests(days) {
      const parts = await each((s) => s.closedPullRequests(days));
      return {
        prs: parts.flatMap(({ org, value }) => tagAll(org, value.prs)).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)),
        repos: parts.flatMap(({ org, value }) => tagAll(org, value.repos)),
        people: uniquePeople(parts.map((p) => p.value.people)),
        days,
      };
    },
    async createPullRequest(body = {}) {
      const e = await ownerOf(body.projectId);
      return tag(e.org, await e.service.createPullRequest(body));
    },
    /** Commits of every organization's repos, or (with a projectId) of one repo in the organization that owns it. */
    async commits(opts = {}) {
      if (opts.projectId) {
        const e = await ownerOf(opts.projectId);
        const result = await e.service.commits(opts);
        return { ...result, commits: tagAll(e.org, result.commits), failed: tagAll(e.org, result.failed) };
      }
      const parts = await each((s) => s.commits(opts));
      return {
        ...parts[0].value,
        commits: parts.flatMap(({ org, value }) => tagAll(org, value.commits)).sort((a, b) => (Date.parse(b.author?.date) || 0) - (Date.parse(a.author?.date) || 0)),
        failed: parts.flatMap(({ org, value }) => tagAll(org, value.failed)),
      };
    },
    commit: viaProject('commit'),
    deployChanges: viaProject('deployChanges'),
    async undeployed() {
      return { targets: (await each((s) => s.undeployed())).flatMap(({ org, value }) => tagAll(org, value.targets)) };
    },

    /** Delivery metrics computed once over every organization's production environments. */
    async delivery(days) {
      const parts = await each((s) => s.deliveryData(days));
      return buildDelivery({ targets: parts.flatMap(({ org, value }) => tagAll(org, value)), days });
    },
    async summary(week) {
      const range = weekRange(week);
      if (range.from < Date.now() - 180 * DAY) throw Object.assign(new Error('Summaries go back 26 weeks'), { status: 400 });
      const parts = await each((s) => s.summaryData(range));
      const all = (k) => parts.flatMap(({ org, value }) => tagAll(org, value[k]));
      return buildSummary({
        ...range,
        finished: all('finished'),
        merged: all('merged'),
        deploys: all('deploys'),
        blocked: all('blocked'),
        inProgress: parts.reduce((n, { value }) => n + value.inProgress, 0),
      });
    },
    /** Work item flow computed once over every organization's items. */
    async flow(days) {
      const parts = await each((s) => s.flowData(days));
      return buildFlow({
        finished: parts.flatMap(({ org, value }) => tagAll(org, value.finished)),
        open: parts.flatMap(({ org, value }) => tagAll(org, value.open)),
        days,
      });
    },
    async sprints() {
      const parts = await each((s) => s.sprints());
      return {
        sprints: parts.flatMap(({ org, value }) => value.sprints.map((x) => ({
          ...x,
          org: org.key,
          project: tag(org, x.project),
          ...(x.added ? { added: tagAll(org, x.added), removed: tagAll(org, x.removed), carriedOver: tagAll(org, x.carriedOver) } : {}),
        }))),
      };
    },
    branches: viaProject('branches'),
    compare: viaProject('compare'),
    suggestReviewers: viaProject('suggestReviewers'),
    pullRequest: viaProject('pullRequest'),
    prAction: viaProject('prAction'),
    pullRequestConflicts: viaProject('pullRequestConflicts'),

    async workItems() {
      const parts = await each((s) => s.workItems());
      const base = parts[0].value;
      return {
        ...base,
        items: parts.flatMap(({ org, value }) => tagAll(org, value.items)),
        states: Object.assign({}, ...parts.map((p) => p.value.states)),
        people: uniquePeople(parts.map((p) => p.value.people)),
        currentIterationPaths: [...new Set(parts.flatMap((p) => p.value.currentIterationPaths))],
      };
    },
    async newWorkItemOptions() {
      return (await each((s) => s.newWorkItemOptions())).flatMap(({ org, value }) => tagAll(org, value));
    },
    async createWorkItem(body = {}) {
      const e = await ownerOf(body.projectId);
      return tag(e.org, await e.service.createWorkItem(body));
    },
    async workItem(id, orgKey) {
      const e = byKey(orgKey);
      const w = await e.service.workItem(id);
      return { ...tag(e.org, w), parent: tag(e.org, w.parent), children: tagAll(e.org, w.children) };
    },
    workItemAction: (id, action, orgKey) => byKey(orgKey).service.workItemAction(id, action),
    reorderBoard: viaProject('reorderBoard'),
    async workItemTypes() {
      const byName = new Map();
      for (const { org, value } of await each((s) => s.workItemTypes())) {
        for (const t of value) {
          const entry = byName.get(t.name) || { name: t.name, color: t.color, projects: [] };
          entry.color ||= t.color;
          entry.projects.push(...t.projects.map((p) => `${org.name} · ${p}`));
          byName.set(t.name, entry);
        }
      }
      return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    workItemAttachment: (id, attachmentId, orgKey) => byKey(orgKey).service.workItemAttachment(id, attachmentId),

    async board(opts = {}) {
      const tracked = await each((s) => s.trackedProjects());
      const options = tracked.flatMap(({ org, value }) => value.flatMap((p) => p.teams.map((t) => ({ projectId: p.id, projectName: p.name, teamId: t.id, teamName: t.name, org: org.key }))));
      const pick = options.find((o) => o.projectId === opts.projectId) || options[0];
      if (!pick) return { project: null, options };
      const e = byKey(pick.org);
      const result = await e.service.board({ ...opts, projectId: pick.projectId });
      return { ...result, options, project: tag(e.org, result.project), items: tagAll(e.org, result.items) };
    },
    async epics(opts) {
      return { projects: (await each((s) => s.epics(opts))).flatMap(({ org, value }) => tagAll(org, value.projects)) };
    },

    async pipelines() {
      const rows = (await each((s) => s.pipelines())).flatMap(({ org, value }) => tagAll(org, value));
      return rows.sort((a, b) => HEALTH[a.health] - HEALTH[b.health] || a.definition.name.localeCompare(b.definition.name));
    },
    async flakyTests() {
      const parts = await each((s) => s.flakyTests());
      const sum = (k) => parts.reduce((n, p) => n + p.value.analyzed[k], 0);
      return {
        tests: parts.flatMap(({ org, value }) => value.tests.map((x) => ({ ...x, pipeline: { ...x.pipeline, org: org.key } }))).sort(byFlakiness),
        analyzed: { pipelines: sum('pipelines'), runs: sum('runs'), unreadable: sum('unreadable') },
        noTestData: parts.every((p) => p.value.noTestData),
        days: parts[0].value.days,
      };
    },
    pipelineRuns: viaProject('pipelineRuns'),
    runDetails: viaProject('runDetails'),
    queueBuild: viaProject('queueBuild'),
    async releases() {
      const parts = await each((s) => s.releases());
      return {
        definitions: parts.flatMap(({ org, value }) => tagAll(org, value.definitions)),
        approvals: parts.flatMap(({ org, value }) => tagAll(org, value.approvals)),
      };
    },
    createRelease: viaProject('createRelease'),
    deployReleaseStage: viaProject('deployReleaseStage'),
    async decideApproval(kind, id, body, orgKey) {
      if (orgKey) return byKey(orgKey).service.decideApproval(kind, id, body);
      // Without an org: the organization where it's pending.
      let last;
      for (const e of entries) {
        try {
          return await e.service.decideApproval(kind, id, body);
        } catch (err) {
          if (err.status !== 404) throw err;
          last = err;
        }
      }
      throw last;
    },

    // Production monitors are shared by the server; the primary organization owns them.
    production: () => primary.service.production(),
    monitors: () => primary.service.monitors(),
    platformTotals: () => primary.service.platformTotals(),
    platformTotalsFor: (id) => primary.service.platformTotalsFor(id),
    fetchAllTotals: () => primary.service.fetchAllTotals(),

    async team() {
      const parts = await each((s) => s.workloadData());
      const merged = {
        ...parts[0].value,
        // One person across organizations, in all of their teams (each team knows its organization).
        people: uniquePeople(parts.map((p) => p.value.people)).map((person) => ({
          ...person,
          teams: parts.flatMap(({ org, value }) => value.people
            .filter((x) => (x.uniqueName || x.id || '').toLowerCase() === (person.uniqueName || person.id || '').toLowerCase())
            .flatMap((x) => (x.teams || []).map((tm) => ({ ...tm, org: org.key })))),
        })),
        prs: parts.flatMap((p) => p.value.prs),
        items: parts.flatMap(({ org, value }) => tagAll(org, value.items)),
        currentIterationPaths: [...new Set(parts.flatMap((p) => p.value.currentIterationPaths))],
      };
      return { rows: buildWorkload(merged), currentIterationPaths: merged.currentIterationPaths, hidden: parts[0].value.hidden || [] };
    },
    // Hidden people are kept in the one settings store; removing goes to the organization that owns the project.
    setHidden: (person, hidden) => primary.service.setHidden(person, hidden),
    removeTeamMember: viaProject('removeTeamMember'),
    async insights(days) {
      const parts = await each((s) => s.insightsData(days));
      return buildInsights({
        closedPrs: parts.flatMap((p) => p.value.closedPrs),
        activePrs: parts.flatMap((p) => p.value.activePrs),
        pipelines: parts.flatMap((p) => p.value.pipelines),
        days,
      });
    },
    /** Release notes over every organization (keys carry the organization, since PR and work item numbers repeat). */
    async changelog(body = {}) {
      const parts = await each((s) => s.changelogData(body));
      const prs = parts.flatMap(({ org, value }) => value.prs.map((p) => ({ ...p, key: `${org.key}/${p.key}`, org: org.key })));
      const workItemsByPr = new Map(parts.flatMap(({ org, value }) => value.workItemsByPr.map(([k, list]) => [`${org.key}/${k}`, tagAll(org, list)])));
      return buildChangelog({ prs, workItemsByPr, from: body.from, to: body.to, title: body.title });
    },

    async settingsView() {
      const parts = await each((s) => s.settingsView());
      return { settings: parts[0].value.settings, projects: parts.flatMap(({ org, value }) => tagAll(org, value.projects)) };
    },
    projectOptions: viaProject('projectOptions'),
    async saveSettings(patch) {
      const saved = await primary.service.saveSettings(patch); // one settings store for every organization
      for (const e of entries) e.service.invalidate('');
      owners = null;
      return saved;
    },

    // Live updates: one snapshot over every organization.
    async snapshot() {
      const parts = await each((s) => s.snapshot());
      return {
        attention: parts.flatMap(({ org, value }) => tagAttention(org, value.attention)),
        myPrs: parts.flatMap(({ org, value }) => tagAll(org, value.myPrs)),
        runs: parts.flatMap(({ org, value }) => tagAll(org, value.runs)),
        schedules: parts.flatMap(({ value }) => value.schedules || []),
        extra: parts.map((p) => p.value.extra).join('##'),
      };
    },
    approvals: async () => (await each((s) => s.approvals())).flatMap(({ org, value }) => tagAll(org, value)),
  };
}
