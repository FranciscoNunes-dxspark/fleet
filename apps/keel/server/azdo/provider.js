// Real Azure DevOps provider. Every method returns the same normalized shapes
// as server/mock/provider.js, so the domain logic and UI never see raw REST
// payloads and the two providers stay interchangeable.
import { marked } from 'marked';
import { config } from '../config.js';
import { createClient, seg } from './client.js';
import { stageSummary } from '../domain/releases.js';

const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

const WI_FIELDS = [
  'System.Id', 'System.Rev', 'System.TeamProject', 'System.WorkItemType', 'System.Title', 'System.State', 'System.Reason',
  'System.AssignedTo', 'System.CreatedBy', 'System.IterationPath', 'System.AreaPath', 'System.Tags', 'System.CreatedDate',
  'System.ChangedDate', 'System.Parent', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Common.Severity',
  'Microsoft.VSTS.Common.StateChangeDate', 'Microsoft.VSTS.Common.ActivatedDate', 'Microsoft.VSTS.Common.ClosedDate',
  'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size',
  'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.CMMI.Blocked',
  // Backlog order: Stack Rank (Agile, CMMI) or Backlog Priority (Scrum).
  'Microsoft.VSTS.Common.StackRank', 'Microsoft.VSTS.Common.BacklogPriority',
];

const CATEGORY_GROUPS = {
  requirement: 'Microsoft.RequirementCategory',
  bug: 'Microsoft.BugCategory',
  task: 'Microsoft.TaskCategory',
  feature: 'Microsoft.FeatureCategory',
  epic: 'Microsoft.EpicCategory',
};

const ident = (i) => (i ? {
  id: i.id,
  displayName: i.displayName,
  uniqueName: i.uniqueName || '',
  imageUrl: i.imageUrl || i._links?.avatar?.href || null,
  isContainer: !!i.isContainer,
} : null);

/**
 * A long-text field as { text, html }: Markdown fields (and plain values with no
 * tags) come back as the Markdown itself; HTML fields keep their HTML for display
 * plus a plain-text copy for prompts.
 */
function richField(raw, field) {
  const value = raw.fields?.[field] || '';
  const formats = Object.fromEntries(Object.entries(raw.multilineFieldsFormat || {}).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  const format = formats[field.toLowerCase()];
  const markdown = format === 'markdown' || (!format && !/<[a-z][^>]*>/i.test(value));
  return markdown ? { text: value, html: null } : { text: htmlToText(value), html: value };
}

// Markdown as HTML, for organizations that don't accept Markdown fields or comments yet.
const markdownToHtml = (md) => marked.parse(String(md), { gfm: true, breaks: true, async: false });
// Azure DevOps rejects the Markdown format with a 400 where it isn't available.
const markdownRefused = (err) => err?.status === 400 && /markdown|multilineFieldsFormat|format/i.test(`${err.message} ${JSON.stringify(err.detail || '')}`);

/** Files attached to a work item, from its relations (the id is the attachment's GUID). */
const attachmentsOf = (relations = []) => relations
  .filter((r) => r.rel === 'AttachedFile')
  .map((r) => ({
    id: String(r.url || '').split('/').pop(),
    name: r.attributes?.name || 'attachment',
    size: r.attributes?.resourceSize ?? null,
    comment: r.attributes?.comment || '',
    addedAt: r.attributes?.authorizedDate || r.attributes?.resourceCreatedDate || null,
  }))
  .filter((a) => /^[0-9a-f-]{36}$/i.test(a.id));

/** Azure DevOps colors are bare hex ("CC293D"); anything else is ignored (it ends up in a style). */
const hexColor = (c) => (/^#?[0-9a-f]{6}$/i.test(String(c || '')) ? `#${String(c).replace('#', '')}` : null);

// GitConflictType: Azure DevOps sends the name (or the number in older versions).
const CONFLICT_TYPES = ['none', 'addAdd', 'addRename', 'deleteEdit', 'deleteRename', 'directoryFile', 'directoryChild', 'editDelete', 'editEdit', 'fileDirectory', 'rename1to2', 'rename2to1', 'renameAdd', 'renameDelete', 'renameRename'];
const RESOLUTION = ['unresolved', 'partiallyResolved', 'resolved'];
const enumName = (v, names) => (typeof v === 'number' ? names[v] : String(v || names[0]).replace(/^./, (c) => c.toLowerCase()));

const stripRef = (ref) => (ref || '').replace(/^refs\/heads\//, '');

/** Azure DevOps change types are comma lists like "edit, rename"; collapse to one kind. */
export function changeKind(changeType = '') {
  const t = String(changeType).toLowerCase();
  if (t.includes('delete')) return 'deleted';
  if (t.includes('add')) return 'added';
  if (t.includes('rename')) return 'renamed';
  return 'edited';
}

/**
 * A git commit. Authors are git identities (name and email), not Azure DevOps
 * accounts; lists cut long messages short (`truncated`), getCommit has them whole.
 */
export const normalizeCommit = (c) => ({
  id: c.commitId,
  message: c.comment || '',
  truncated: !!c.commentTruncated,
  author: { name: c.author?.name || '', email: c.author?.email || '', date: c.author?.date || null },
  committedAt: c.committer?.date || null,
  changes: c.changeCounts ? { added: c.changeCounts.Add || 0, edited: c.changeCounts.Edit || 0, deleted: c.changeCounts.Delete || 0 } : null,
  webUrl: c.remoteUrl || null,
});
const q = (s) =>`'${String(s).replace(/'/g, "''")}'`;

export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/** Classic Release Management lives on its own host in Azure DevOps Services. */
export function releaseHost(orgUrl) {
  const u = new URL(orgUrl);
  if (u.hostname === 'dev.azure.com') u.hostname = 'vsrm.dev.azure.com';
  else if (u.hostname.endsWith('.visualstudio.com')) u.hostname = u.hostname.replace(/\.visualstudio\.com$/, '.vsrm.visualstudio.com');
  // Azure DevOps Server serves releases from the collection URL itself.
  return u.toString().replace(/\/$/, '');
}

/** A provider acting as the owner of `pat` (one per signed-in user). */
export function createAzdoProvider({ orgUrl = config.orgUrl, pat = config.pat } = {}) {
  const org = orgUrl;
  const { api, apiText, download, listAll, listSkip, fetchOrgImage } = createClient({ orgUrl, pat });
  const toBuild = (b) => ({
    id: b.id,
    projectId: b.project?.id,
    projectName: b.project?.name,
    definition: { id: b.definition?.id, name: b.definition?.name, path: b.definition?.path },
    buildNumber: b.buildNumber,
    status: b.status,
    result: b.result || null,
    reason: b.reason,
    sourceBranch: stripRef(b.sourceBranch),
    repoId: b.repository?.type === 'TfsGit' ? b.repository.id : null,
    repoName: b.repository?.name || null,
    commit: b.sourceVersion || null,
    requestedFor: ident(b.requestedFor),
    queuedAt: b.queueTime,
    startedAt: b.startTime || null,
    finishedAt: b.finishTime || null,
    webUrl: b._links?.web?.href || `${org}/${seg(b.project?.name)}/_build/results?buildId=${b.id}`,
  });
  const rm = releaseHost(org);
  const relUrl = (project, releaseId) => `${org}/${seg(project)}/_releaseProgress?releaseId=${releaseId}&_a=release-pipeline-progress`;
  // A release's artifacts never change once it's created.
  const artifactsByRelease = new Map();
  const releaseArtifacts = (projectName, releaseId) => {
    if (!releaseId) return Promise.resolve([]);
    if (!artifactsByRelease.has(releaseId)) {
      artifactsByRelease.set(releaseId, api(`${rm}/${seg(projectName)}/_apis/release/releases/${releaseId}`)
        .then((r) => r.artifacts || [])
        .catch((err) => {
          artifactsByRelease.delete(releaseId);
          throw err;
        }));
    }
    return artifactsByRelease.get(releaseId);
  };

  // Same shape as YAML approvals (listPipelineApprovals) so the UI can list both.
  const normalizeApproval = (a, projectId, projectName) => ({
    kind: 'release',
    id: a.id,
    projectId,
    projectName,
    pipeline: a.releaseDefinition?.name || 'Release',
    stage: `${a.releaseEnvironment?.name || 'Stage'}${a.approvalType === 'postDeploy' ? ' (after deployment)' : ''}`,
    run: a.release?.id ? { name: a.release.name, webUrl: relUrl(projectName, a.release.id) } : null,
    createdOn: a.createdOn,
    instructions: a.comments || '',
    minRequired: 1,
    approvers: [ident(a.approver)].filter(Boolean),
    canDecide: null, // decided by the service: you, or a group you may belong to
  });
  let meCache;
  let fieldSetPromise;
  const stateMaps = new Map();
  // Each project's work item type colors ("Bug" → "#CC293D"), filled with the state maps.
  const typeColors = new Map();

  const prWebUrl = (projectName, repoName, id) => `${org}/${seg(projectName)}/_git/${seg(repoName)}/pullrequest/${id}`;
  const wiWebUrl = (projectName, id) => `${org}/${seg(projectName)}/_workitems/edit/${id}`;

  function normalizePR(r) {
    const projectName = r.repository?.project?.name;
    return {
      key: `${r.repository?.project?.id}/${r.repository?.id}/${r.pullRequestId}`,
      id: r.pullRequestId,
      title: r.title,
      projectId: r.repository?.project?.id,
      projectName,
      repoId: r.repository?.id,
      repoName: r.repository?.name,
      author: ident(r.createdBy),
      createdAt: r.creationDate,
      closedAt: r.closedDate || null,
      // Who completed or abandoned it.
      closedBy: r.closedBy ? ident(r.closedBy) : null,
      status: r.status,
      isDraft: !!r.isDraft,
      mergeStatus: r.mergeStatus || 'notSet',
      mergeFailureMessage: r.mergeFailureMessage || null,
      sourceBranch: stripRef(r.sourceRefName),
      targetBranch: stripRef(r.targetRefName),
      reviewers: (r.reviewers || []).map((rv) => ({
        ...ident(rv),
        vote: rv.vote || 0,
        isRequired: !!rv.isRequired,
        hasDeclined: !!rv.hasDeclined,
      })),
      labels: (r.labels || []).filter((l) => l.active !== false).map((l) => l.name),
      autoComplete: !!r.autoCompleteSetBy,
      webUrl: prWebUrl(projectName, r.repository?.name, r.pullRequestId),
    };
  }

  async function fieldSet() {
    fieldSetPromise ??= listAll('_apis/wit/fields').then((fs) => new Set(fs.map((f) => f.referenceName)));
    return fieldSetPromise;
  }

  async function getStateMap(project) {
    if (!stateMaps.has(project)) {
      stateMaps.set(project, (async () => {
        const types = await api(`${seg(project)}/_apis/wit/workitemtypes`);
        const map = {};
        typeColors.set(project, Object.fromEntries((types.value || []).map((t) => [t.name, hexColor(t.color)]).filter(([, c]) => c)));
        for (const t of types.value || []) {
          let states = t.states;
          if (!states) {
            states = (await api(`${seg(project)}/_apis/wit/workitemtypes/${seg(t.name)}/states`)).value;
          }
          map[t.name] = (states || []).map((s) => ({ name: s.name, category: s.category, color: s.color }));
        }
        return map;
      })().catch((err) => {
        stateMaps.delete(project);
        throw err;
      }));
    }
    return stateMaps.get(project);
  }

  const categoryOf = (map, type, state) => map?.[type]?.find((s) => s.name === state)?.category || 'InProgress';

  async function normalizeItems(rawItems, extraFields = []) {
    const byProject = new Map();
    for (const w of rawItems) {
      const p = w.fields['System.TeamProject'];
      if (!byProject.has(p)) byProject.set(p, await getStateMap(p).catch(() => null));
    }
    return rawItems.map((w) => {
      const f = w.fields;
      const projectName = f['System.TeamProject'];
      return {
        id: w.id,
        rev: w.rev,
        projectName,
        type: f['System.WorkItemType'],
        title: f['System.Title'],
        state: f['System.State'],
        stateCategory: categoryOf(byProject.get(projectName), f['System.WorkItemType'], f['System.State']),
        typeColor: typeColors.get(projectName)?.[f['System.WorkItemType']] || null,
        backlogOrder: f['Microsoft.VSTS.Common.StackRank'] ?? f['Microsoft.VSTS.Common.BacklogPriority'] ?? null,
        reason: f['System.Reason'] || null,
        assignedTo: ident(f['System.AssignedTo']),
        createdBy: ident(f['System.CreatedBy']),
        iterationPath: f['System.IterationPath'],
        areaPath: f['System.AreaPath'],
        tags: f['System.Tags'] ? f['System.Tags'].split(';').map((t) => t.trim()).filter(Boolean) : [],
        priority: f['Microsoft.VSTS.Common.Priority'] ?? null,
        severity: f['Microsoft.VSTS.Common.Severity'] ?? null,
        storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.Effort'] ?? f['Microsoft.VSTS.Scheduling.Size'] ?? null,
        remainingWork: f['Microsoft.VSTS.Scheduling.RemainingWork'] ?? null,
        blocked: f['Microsoft.VSTS.CMMI.Blocked'] === 'Yes',
        parentId: f['System.Parent'] ?? null,
        createdAt: f['System.CreatedDate'],
        changedAt: f['System.ChangedDate'],
        stateChangedAt: f['Microsoft.VSTS.Common.StateChangeDate'] || f['System.ChangedDate'],
        activatedAt: f['Microsoft.VSTS.Common.ActivatedDate'] || null,
        closedAt: f['Microsoft.VSTS.Common.ClosedDate'] || null,
        webUrl: wiWebUrl(projectName, w.id),
        // Board column / lane fields asked for by the caller (they're per team board).
        ...(extraFields.length ? { boardFields: Object.fromEntries(extraFields.map((x) => [x, f[x] ?? null])) } : {}),
      };
    });
  }

  /** The WHERE conditions of a work item query (see queryWorkItems for what `c` takes). */
  async function wiqlWhere(projectId, c) {
    const stateMap = await getStateMap(projectId);
    const where = ['[System.TeamProject] = @project'];

    // Explicit types (from the team's backlog configuration, custom types included),
    // else categories; children of a parent are whatever type they are.
    const categories = c.types?.length ? null : c.categories || (c.parentId ? null : ['requirement', 'bug', 'task']);
    if (c.types?.length) where.push(`[System.WorkItemType] IN (${c.types.map(q).join(', ')})`);
    if (categories) {
      const groups = categories.map((k) => CATEGORY_GROUPS[k]).filter(Boolean);
      where.push(`(${groups.map((g) => `[System.WorkItemType] IN GROUP ${q(g)}`).join(' OR ')})`);
    }
    if (c.parentId) where.push(`[System.Parent] = ${Number(c.parentId)}`);

    if (c.open) {
      const done = [...new Set(Object.values(stateMap).flat()
        .filter((s) => s.category === 'Completed' || s.category === 'Removed').map((s) => s.name))];
      if (done.length) where.push(`[System.State] NOT IN (${done.map(q).join(', ')})`);
    } else {
      const removed = [...new Set(Object.values(stateMap).flat().filter((s) => s.category === 'Removed').map((s) => s.name))];
      if (removed.length) where.push(`[System.State] NOT IN (${removed.map(q).join(', ')})`);
    }
    if (c.iterationPath) where.push(`[System.IterationPath] UNDER ${q(c.iterationPath)}`);
    if (c.areaPaths?.length) {
      where.push(`(${c.areaPaths.map((a) => `[System.AreaPath] ${a.includeChildren ? 'UNDER' : '='} ${q(a.value)}`).join(' OR ')})`);
    }
    if (c.assignedToMe) where.push('[System.AssignedTo] = @Me');
    if (c.unassigned) where.push("[System.AssignedTo] = ''");
    if (c.tag) where.push(`[System.Tags] CONTAINS ${q(c.tag)}`);
    if (c.changedWithinDays) where.push(`[System.ChangedDate] >= @Today - ${Number(c.changedWithinDays)}`);
    if (c.doneWithinDays) {
      const done = [...new Set(Object.values(stateMap).flat().filter((s) => s.category === 'Completed').map((s) => s.name))];
      if (done.length) where.push(`[System.State] IN (${done.map(q).join(', ')})`);
      where.push(`[System.ChangedDate] >= @Today - ${Number(c.doneWithinDays)}`);
    }

    return where;
  }

  async function getWorkItems(ids, extraFields = []) {
    if (!ids.length) return [];
    const available = await fieldSet();
    const fields = [...WI_FIELDS.filter((x) => available.has(x)), ...extraFields];
    const chunks = [];
    for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
    const pages = await Promise.all(chunks.map((chunk) =>
      api('_apis/wit/workitemsbatch', { method: 'POST', body: { ids: chunk, fields, errorPolicy: 'omit' } })));
    return normalizeItems(pages.flatMap((p) => (p.value || []).filter(Boolean)), extraFields);
  }

  async function me() {
    meCache ??= api('_apis/connectionData', { apiVersion: '7.1-preview' }).then((d) => {
      const u = d.authenticatedUser;
      return {
        id: u.id,
        displayName: u.providerDisplayName || u.customDisplayName,
        uniqueName: u.properties?.Account?.$value || '',
      };
    }).catch((err) => {
      meCache = undefined;
      throw err;
    });
    return meCache;
  }

  return {
    kind: 'azdo',
    orgUrl: org,
    fetchOrgImage,
    me,

    async listProjects() {
      const projects = await listAll('_apis/projects', { query: { $top: 500, stateFilter: 'wellFormed' } });
      return projects
        .map((p) => ({ id: p.id, name: p.name, description: p.description || '', webUrl: `${org}/${seg(p.name)}` }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async listTeams(projectId) {
      const teams = await listAll(`_apis/projects/${seg(projectId)}/teams`, { query: { $top: 500 } });
      return teams.map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name));
    },

    async listTeamMembers(projectId, teamId) {
      const members = await listAll(`_apis/projects/${seg(projectId)}/teams/${seg(teamId)}/members`, { query: { $top: 500 } });
      return members.map((m) => ident(m.identity)).filter((m) => m && !m.isContainer);
    },

    async getTeamAreas(projectId, teamId) {
      const d = await api(`${seg(projectId)}/${seg(teamId)}/_apis/work/teamsettings/teamfieldvalues`);
      return (d.values || []).map((v) => ({ value: v.value, includeChildren: !!v.includeChildren }));
    },

    /** The area path new work items get for this team (its "default area"). */
    async getTeamDefaultArea(projectId, teamId) {
      const d = await api(`${seg(projectId)}/${seg(teamId)}/_apis/work/teamsettings/teamfieldvalues`);
      return d.defaultValue || d.values?.[0]?.value || null;
    },

    async getCurrentIteration(projectId, teamId) {
      const d = await api(`${seg(projectId)}/${seg(teamId)}/_apis/work/teamsettings/iterations`, { query: { $timeframe: 'current' } });
      const it = d.value?.[0];
      return it ? { id: it.id, name: it.name, path: it.path, startDate: it.attributes?.startDate, finishDate: it.attributes?.finishDate } : null;
    },

    /** A team's sprints (all of them, dated or not), oldest first. */
    async listIterations(projectId, teamId) {
      const d = await api(`${seg(projectId)}/${seg(teamId)}/_apis/work/teamsettings/iterations`);
      return (d.value || [])
        .map((it) => ({ id: it.id, name: it.name, path: it.path, startDate: it.attributes?.startDate || null, finishDate: it.attributes?.finishDate || null }))
        .sort((x, y) => (Date.parse(x.startDate) || 0) - (Date.parse(y.startDate) || 0));
    },

    async listRepos(projectId) {
      const d = await api(`${seg(projectId)}/_apis/git/repositories`);
      return (d.value || [])
        .filter((r) => !r.isDisabled)
        .map((r) => ({
          id: r.id,
          name: r.name,
          projectId: r.project.id,
          projectName: r.project.name,
          defaultBranch: stripRef(r.defaultBranch) || null,
          webUrl: r.webUrl,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async listPullRequests(projectId, { status = 'active', closedAfter } = {}) {
      const query = { 'searchCriteria.status': status };
      if (closedAfter) {
        query['searchCriteria.minTime'] = new Date(closedAfter).toISOString();
        query['searchCriteria.queryTimeRangeType'] = 'closed';
      }
      const raw = await listSkip(`${seg(projectId)}/_apis/git/pullrequests`, { query, max: status === 'active' ? 2000 : 1000 });
      const prs = raw.map(normalizePR);
      // Older servers ignore the time filter; enforce it here too.
      return closedAfter ? prs.filter((p) => p.closedAt && Date.parse(p.closedAt) >= Date.parse(closedAfter)) : prs;
    },

    async getPullRequest(projectId, repoId, prId) {
      const base = `${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullrequests/${prId}`;
      const raw = await api(base);
      const pr = normalizePR(raw);
      const [threads, wiRefs, policies, files] = await Promise.all([
        api(`${base}/threads`).then((d) => d.value || []).catch(() => []),
        api(`${base}/workitems`).then((d) => d.value || []).catch(() => []),
        api(`${seg(projectId)}/_apis/policy/evaluations`, {
          apiVersion: '7.1-preview.1',
          query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${pr.projectId}/${prId}` },
        }).then((d) => d.value || []).catch(() => []),
        // Latest iteration vs. the merge base: the same diff the Files tab shows.
        api(`${base}/iterations`).then(async (d) => {
          const latest = (d.value || []).at(-1);
          if (!latest) return { total: 0, truncated: false, items: [] };
          const ch = await api(`${base}/iterations/${latest.id}/changes`, { query: { $top: 2000 } });
          // Deleted files have no current path (item.path is null), only originalPath.
          const entries = (ch.changeEntries || [])
            .filter((e) => (e.item?.path || e.originalPath) && !e.item?.isFolder && e.item?.gitObjectType !== 'tree');
          return {
            iteration: latest.id,
            total: entries.length,
            truncated: ch.nextSkip > 0,
            items: entries.map((e) => {
              const kind = changeKind(e.changeType);
              return {
                path: e.item?.path || e.originalPath,
                kind,
                originalPath: kind === 'renamed' ? e.originalPath || null : null,
              };
            }).sort((a, b) => a.path.localeCompare(b.path)),
          };
        }).catch((err) => ({ error: err.message, total: 0, truncated: false, items: [] })),
      ]);

      const discussion = threads.filter((t) => !t.isDeleted && t.comments?.[0]?.commentType !== 'system' && t.comments?.length);
      const workItems = await getWorkItems(wiRefs.map((w) => Number(w.id)));
      return {
        ...pr,
        description: raw.description || '',
        autoCompleteSetBy: ident(raw.autoCompleteSetBy),
        completionOptions: raw.completionOptions || null,
        threads: {
          total: discussion.length,
          active: discussion.filter((t) => t.status === 'active' || t.status === 'pending').length,
          recent: discussion
            .flatMap((t) => t.comments.filter((c) => !c.isDeleted).map((c) => ({
              threadId: t.id,
              status: t.status,
              filePath: t.threadContext?.filePath || null,
              author: ident(c.author),
              content: c.content || '',
              publishedAt: c.publishedDate,
            })))
            .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
            .slice(0, 15),
        },
        workItems: workItems.map(({ id, title, type, state, stateCategory, webUrl }) => ({ id, title, type, state, stateCategory, webUrl })),
        files,
        policies: policies
          .filter((p) => p.status !== 'notApplicable')
          .map((p) => ({
            name: p.configuration?.settings?.displayName || p.configuration?.type?.displayName || 'Policy',
            status: p.status,
            isBlocking: !!p.configuration?.isBlocking,
          })),
      };
    },

    async getPullRequestWorkItemIds(projectId, repoId, prId) {
      const d = await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullrequests/${prId}/workitems`);
      return (d.value || []).map((w) => Number(w.id));
    },

    /** The commits a pull request brought (its source branch commits), as ids. */
    async getPullRequestCommitIds(projectId, repoId, prId) {
      const list = await listAll(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullrequests/${prId}/commits`, { query: { $top: 500 } });
      return list.map((c) => c.commitId);
    },

    /** All branches, with when/who last pushed for the recently active ones. */
    async listBranches(projectId, repoId) {
      const base = `${seg(projectId)}/_apis/git/repositories/${seg(repoId)}`;
      const [refs, pushes] = await Promise.all([
        listAll(`${base}/refs`, { query: { filter: 'heads/', $top: 1000 } }),
        api(`${base}/pushes`, { query: { $top: 100, 'searchCriteria.includeRefUpdates': true } }).then((d) => d.value || []).catch(() => []),
      ]);
      const recent = new Map();
      for (const p of pushes) {
        for (const u of p.refUpdates || []) {
          const name = stripRef(u.name);
          if (!recent.has(name) && !/^0+$/.test(u.newObjectId || '')) recent.set(name, { pushedAt: p.date, pushedBy: ident(p.pushedBy) });
        }
      }
      return refs.map((r) => ({ name: stripRef(r.name), ...(recent.get(stripRef(r.name)) || { pushedAt: null, pushedBy: null }) }));
    },

    /** Commits on a branch (the repo's default when none is given), newest first; with `path`, only those touching it. */
    async listCommits(projectId, repoId, { branch, since, path, top = 300 } = {}) {
      const d = await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/commits`, {
        query: {
          ...(branch ? { 'searchCriteria.itemVersion.version': branch, 'searchCriteria.itemVersion.versionType': 'branch' } : {}),
          ...(path ? { 'searchCriteria.itemPath': path } : {}),
          ...(since ? { 'searchCriteria.fromDate': since } : {}),
          'searchCriteria.$top': top,
        },
      });
      return (d.value || []).map(normalizeCommit);
    },

    /** Commits reachable from `to` but not from `from` (what a deploy of `to` adds over `from`), newest first. */
    async listCommitsBetween(projectId, repoId, from, to, { top = 300 } = {}) {
      const d = await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/commits`, {
        query: {
          'searchCriteria.itemVersion.version': to,
          'searchCriteria.itemVersion.versionType': 'commit',
          'searchCriteria.compareVersion.version': from,
          'searchCriteria.compareVersion.versionType': 'commit',
          'searchCriteria.$top': top,
        },
      });
      return (d.value || []).map(normalizeCommit);
    },

    /**
     * How two commits relate: `ahead` commits only `target` has, `behind`
     * commits only `base` has. behind > 0 means target doesn't contain base.
     */
    async aheadBehind(projectId, repoId, base, target) {
      const d = await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/diffs/commits`, {
        query: { baseVersion: base, baseVersionType: 'commit', targetVersion: target, targetVersionType: 'commit', diffCommonCommit: true, $top: 1 },
      });
      return { ahead: d.aheadCount ?? null, behind: d.behindCount ?? null };
    },

    /** One commit: its whole message, parents and the files it changed. */
    async getCommit(projectId, repoId, commitId) {
      const c = await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/commits/${seg(commitId)}`, { query: { changeCount: 500 } });
      const files = (c.changes || []).filter((x) => x.item?.path && !x.item.isFolder && x.item.gitObjectType !== 'tree');
      return {
        ...normalizeCommit(c),
        parents: c.parents || [],
        files: files.map((x) => ({ path: x.item.path, kind: changeKind(x.changeType), originalPath: x.sourceServerItem || null })),
      };
    },

    /** What a PR from `source` into `target` would contain. */
    async compareBranches(projectId, repoId, source, target) {
      const base = `${seg(projectId)}/_apis/git/repositories/${seg(repoId)}`;
      const templatePaths = ['/.azuredevops/pull_request_template.md', '/.vsts/pull_request_template.md', '/docs/pull_request_template.md', '/pull_request_template.md'];
      const [diff, existing, templates] = await Promise.all([
        // Diff from the merge base, i.e. exactly what the PR would change.
        api(`${base}/diffs/commits`, {
          query: { baseVersion: target, baseVersionType: 'branch', targetVersion: source, targetVersionType: 'branch', diffCommonCommit: true, $top: 2000 },
        }),
        api(`${base}/pullrequests`, {
          query: { 'searchCriteria.sourceRefName': `refs/heads/${source}`, 'searchCriteria.targetRefName': `refs/heads/${target}`, 'searchCriteria.status': 'active' },
        }).then((d) => (d.value || []).map(normalizePR)).catch(() => []),
        Promise.all(templatePaths.map((path) => api(`${base}/items`, {
          query: { path, includeContent: true, 'versionDescriptor.version': target, 'versionDescriptor.versionType': 'branch' },
        }).then((d) => d.content || null).catch(() => null))),
      ]);
      // The newest `ahead` commits on the source branch are the ones the target lacks.
      const ahead = diff.aheadCount ?? 0;
      const commits = ahead > 0
        ? await api(`${base}/commits`, {
          query: { 'searchCriteria.itemVersion.version': source, 'searchCriteria.itemVersion.versionType': 'branch', 'searchCriteria.$top': Math.min(ahead, 100) },
        }).then((d) => d.value || []).catch(() => [])
        : [];
      const files = (diff.changes || []).filter((c) => c.item?.path && !c.item.isFolder && c.item.gitObjectType !== 'tree');
      return {
        ahead,
        behind: diff.behindCount ?? 0,
        commits: commits.map((c) => ({ id: c.commitId, message: c.comment || '', author: c.author?.name, date: c.author?.date })),
        files: { total: files.length, items: files.map((c) => ({ path: c.item.path, kind: changeKind(c.changeType), originalPath: c.sourceServerItem || null })) },
        existing: existing.map(({ id, title, webUrl, projectId: pid, repoId: rid }) => ({ id, title, webUrl, projectId: pid, repoId: rid })),
        template: templates.find(Boolean) || null,
      };
    },

    async createPullRequest(projectId, repoId, pr) {
      const base = `${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullrequests`;
      const created = await api(base, {
        method: 'POST',
        query: { supportsIterations: true },
        body: {
          sourceRefName: `refs/heads/${pr.source}`,
          targetRefName: `refs/heads/${pr.target}`,
          title: pr.title,
          description: pr.description || '',
          isDraft: !!pr.isDraft,
          reviewers: (pr.reviewers || []).map((r) => ({ id: r.id, isRequired: !!r.isRequired })),
          workItemRefs: (pr.workItemIds || []).map((id) => ({ id: String(id) })),
        },
      });
      if (pr.autoComplete && !pr.isDraft) {
        await api(`${base}/${created.pullRequestId}`, {
          method: 'PATCH',
          body: { autoCompleteSetBy: { id: (await me()).id }, completionOptions: pr.completionOptions },
        });
      }
      return normalizePR(created);
    },

    async votePullRequest(projectId, repoId, prId, vote) {
      const { id } = await me();
      await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullRequests/${prId}/reviewers/${id}`, {
        method: 'PUT',
        body: { vote },
      });
    },

    async addReviewer(projectId, repoId, prId, reviewerId, isRequired = false) {
      await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullRequests/${prId}/reviewers/${seg(reviewerId)}`, {
        method: 'PUT',
        body: { vote: 0, isRequired },
      });
    },

    async commentPullRequest(projectId, repoId, prId, content) {
      await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullRequests/${prId}/threads`, {
        method: 'POST',
        body: { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1 },
      });
    },

    /** A pull request's merge conflicts: [{ id, path, type, status }], unresolved first. */
    async listPullRequestConflicts(projectId, repoId, prId) {
      const d = await api(`${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullRequests/${prId}/conflicts`, {
        apiVersion: '7.1-preview.1',
        query: { $top: 500, includeObsolete: false },
      });
      return (d.value || [])
        .map((c) => ({
          id: c.conflictId,
          path: c.conflictPath || '',
          type: enumName(c.conflictType, CONFLICT_TYPES),
          status: enumName(c.resolutionStatus, RESOLUTION),
        }))
        .sort((a, b) => (a.status === 'resolved') - (b.status === 'resolved') || a.path.localeCompare(b.path));
    },

    /**
     * Runs the pull request merge again (Azure DevOps' "Restart merge"), e.g.
     * after conflicts were fixed by a push or the target branch moved. Queues
     * the merge; where that's refused, re-applying the merge options also
     * starts a new merge.
     */
    async restartMerge(projectId, repoId, prId) {
      const url = `${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullrequests/${prId}`;
      try {
        await api(url, { method: 'PATCH', body: { mergeStatus: 'queued' } });
      } catch (err) {
        if (err.status !== 400) throw err;
        const current = await api(url);
        await api(url, { method: 'PATCH', body: { mergeOptions: current.mergeOptions || { detectRenameFalsePositives: false } } });
      }
    },

    async updatePullRequest(projectId, repoId, prId, change) {
      const body = {};
      if (change.publish) body.isDraft = false;
      if (change.abandon) body.status = 'abandoned';
      if (change.autoComplete === true) {
        body.autoCompleteSetBy = { id: (await me()).id };
        body.completionOptions = change.completionOptions;
      }
      if (change.autoComplete === false) body.autoCompleteSetBy = { id: EMPTY_GUID };
      const url = `${seg(projectId)}/_apis/git/repositories/${seg(repoId)}/pullrequests/${prId}`;
      if (change.complete) {
        // Completing needs the source commit we're merging, so a push that
        // lands in between can't be merged unseen.
        const current = await api(url);
        if (!current.lastMergeSourceCommit?.commitId) throw Object.assign(new Error('Azure DevOps hasn\'t finished preparing the merge yet. Try again in a moment.'), { status: 409 });
        body.status = 'completed';
        body.lastMergeSourceCommit = { commitId: current.lastMergeSourceCommit.commitId };
        body.completionOptions = change.completionOptions;
      }
      await api(url, { method: 'PATCH', body });
    },

    getStateMap,
    /** A project's work item types with their Azure DevOps colors: [{ name, color }]. */
    async getWorkItemTypes(project) {
      const map = await getStateMap(project);
      const colors = typeColors.get(project) || {};
      return Object.keys(map).map((name) => ({ name, color: colors[name] || null }));
    },

    async queryWorkItems(projectId, c = {}) {
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${(await wiqlWhere(projectId, c)).join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
      const res = await api(`${seg(projectId)}/_apis/wit/wiql`, { method: 'POST', query: { $top: c.top || 1000 }, body: { query: wiql } });
      return getWorkItems((res.workItems || []).map((w) => w.id), c.extraFields || []);
    },

    /**
     * Ids of the work items that matched the same conditions at `asOf` (WIQL
     * ASOF: iteration, area and state as they were then), or now without it.
     */
    async queryWorkItemIds(projectId, c = {}) {
      const asOf = c.asOf ? ` ASOF '${new Date(c.asOf).toISOString()}'` : '';
      const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${(await wiqlWhere(projectId, c)).join(' AND ')}${asOf}`;
      const res = await api(`${seg(projectId)}/_apis/wit/wiql`, { method: 'POST', query: { $top: c.top || 1000 }, body: { query: wiql } });
      return (res.workItems || []).map((w) => w.id);
    },

    getWorkItems,

    /**
     * A team's boards as configured in Azure DevOps: one per visible backlog
     * level (custom levels included), with columns, WIP limits, split columns,
     * state mappings and swimlanes, plus the per-board column/lane fields.
     */
    async getBoards(projectId, teamId) {
      const base = `${seg(projectId)}/${seg(teamId)}/_apis/work`;
      const [cfg, list] = await Promise.all([api(`${base}/backlogconfiguration`), api(`${base}/boards`)]);
      const levels = [cfg.requirementBacklog, ...(cfg.portfolioBacklogs || [])].filter(Boolean);
      const hidden = new Set(cfg.hiddenBacklogs || []);
      const boards = await Promise.all((list.value || []).map(async (b) => {
        const full = await api(`${base}/boards/${seg(b.id)}`);
        const level = levels.find((l) => l.name === b.name);
        return {
          id: b.id,
          name: b.name,
          level: level?.id || null,
          rank: level?.rank ?? 0,
          isRequirement: level?.id === cfg.requirementBacklog?.id,
          hidden: level ? hidden.has(level.id) : false,
          types: (level?.workItemTypes || []).map((w) => w.name),
          columns: (full.columns || []).map((c) => ({
            id: c.id, name: c.name, columnType: c.columnType, isSplit: !!c.isSplit, itemLimit: c.itemLimit || 0, stateMappings: c.stateMappings || {},
          })),
          lanes: (full.rows || []).map((r) => ({ id: r.id, name: r.name || null })),
          fields: {
            column: full.fields?.columnField?.referenceName || null,
            done: full.fields?.doneField?.referenceName || null,
            lane: full.fields?.rowField?.referenceName || null,
          },
        };
      }));
      // Backlog items first, then custom levels, then features and epics.
      boards.sort((a, b) => (b.isRequirement - a.isRequirement) || a.rank - b.rank);
      return {
        boards,
        taskTypes: (cfg.taskBacklog?.workItemTypes || []).map((w) => w.name),
        workTypes: [...new Set([
          ...levels.filter((l) => !/Microsoft.(Epic|Feature)Category/.test(l.id)).flatMap((l) => l.workItemTypes.map((w) => w.name)),
          ...(cfg.taskBacklog?.workItemTypes || []).map((w) => w.name),
        ])],
      };
    },

    /**
     * Every epic (open, or all with includeClosed) with its full descendant
     * tree, in one recursive link query.
     */
    async getHierarchy(projectId, { includeClosed = false, areaPaths } = {}) {
      const stateMap = await getStateMap(projectId);
      const names = (...cats) => [...new Set(Object.values(stateMap).flat().filter((s) => cats.includes(s.category)).map((s) => s.name))];
      const hidden = includeClosed ? names('Removed') : names('Completed', 'Removed');
      const where = [
        '[Source].[System.TeamProject] = @project',
        `[Source].[System.WorkItemType] IN GROUP ${q(CATEGORY_GROUPS.epic)}`,
        "[System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'",
      ];
      if (hidden.length) where.push(`[Source].[System.State] NOT IN (${hidden.map(q).join(', ')})`);
      if (areaPaths?.length) {
        where.push(`(${areaPaths.map((a) => `[Source].[System.AreaPath] ${a.includeChildren ? 'UNDER' : '='} ${q(a.value)}`).join(' OR ')})`);
      }
      const res = await api(`${seg(projectId)}/_apis/wit/wiql`, {
        method: 'POST',
        body: { query: `SELECT [System.Id] FROM WorkItemLinks WHERE ${where.join(' AND ')} MODE (Recursive)` },
      });
      const rels = res.workItemRelations || [];
      const items = await getWorkItems([...new Set(rels.map((r) => r.target.id))]);
      return {
        roots: rels.filter((r) => !r.source).map((r) => r.target.id),
        links: rels.filter((r) => r.source && r.rel).map((r) => ({ parent: r.source.id, child: r.target.id })),
        items: items.filter((w) => w.stateCategory !== 'Removed'),
      };
    },

    async getWorkItem(id) {
      const raw = await api(`_apis/wit/workitems/${id}`, { query: { $expand: 'relations' } });
      const [item] = await normalizeItems([raw]);
      const rels = raw.relations || [];
      const relIds = (name) => rels.filter((r) => r.rel === name).map((r) => Number(r.url.split('/').pop()));
      const [related, comments] = await Promise.all([
        getWorkItems([...relIds('System.LinkTypes.Hierarchy-Reverse'), ...relIds('System.LinkTypes.Hierarchy-Forward')]),
        api(`${seg(item.projectName)}/_apis/wit/workItems/${id}/comments`, { apiVersion: '7.1-preview.4', query: { $top: 30 } })
          .then((d) => d.comments || []).catch(() => []),
      ]);
      const parentIds = new Set(relIds('System.LinkTypes.Hierarchy-Reverse'));
      const description = richField(raw, raw.fields['System.Description'] ? 'System.Description' : 'Microsoft.VSTS.TCM.ReproSteps');
      const acceptance = richField(raw, 'Microsoft.VSTS.Common.AcceptanceCriteria');
      const pick = ({ id: i, title, type, state, stateCategory, assignedTo, webUrl }) => ({ id: i, title, type, state, stateCategory, assignedTo, webUrl });
      return {
        ...item,
        description: description.text,
        descriptionHtml: description.html,
        acceptanceCriteria: acceptance.text,
        acceptanceCriteriaHtml: acceptance.html,
        parent: related.filter((w) => parentIds.has(w.id)).map(pick)[0] || null,
        children: related.filter((w) => !parentIds.has(w.id)).map(pick),
        pullRequests: rels
          .filter((r) => r.rel === 'ArtifactLink' && /PullRequestId/i.test(r.url))
          .map((r) => {
            const [projectId, repoId, prId] = decodeURIComponent(r.url.split('PullRequestId/')[1] || '').split('/');
            return { projectId, repoId, id: Number(prId) };
          }),
        attachments: attachmentsOf(rels),
        comments: comments.map((c) => {
          const markdown = String(c.format || '').toLowerCase() === 'markdown';
          return { author: ident(c.createdBy), text: markdown ? c.text || '' : htmlToText(c.text), html: markdown ? null : c.text || '', createdAt: c.createdDate };
        }),
      };
    },

    /**
     * Creates a work item. fields: { title, description (Markdown), assignedTo, areaPath,
     * iterationPath, priority, tags }; parentId links it under an existing item.
     */
    async createWorkItem(projectName, type, fields, parentId) {
      const known = await fieldSet().catch(() => new Set());
      const ops = [];
      const set = (field, value) => {
        if (value !== undefined && value !== null && value !== '') ops.push({ op: 'add', path: `/fields/${field}`, value });
      };
      set('System.Title', fields.title);
      // Bugs show "Repro Steps" in Azure DevOps rather than the description.
      const descriptionField = type === 'Bug' && known.has('Microsoft.VSTS.TCM.ReproSteps') ? 'Microsoft.VSTS.TCM.ReproSteps' : 'System.Description';
      set(descriptionField, fields.description || null);
      // The description is Markdown; Azure DevOps keeps it as Markdown when told so.
      const markdownOp = fields.description ? { op: 'add', path: `/multilineFieldsFormat/${descriptionField}`, value: 'Markdown' } : null;
      if (markdownOp) ops.push(markdownOp);
      set('System.AssignedTo', fields.assignedTo);
      set('System.AreaPath', fields.areaPath);
      set('System.IterationPath', fields.iterationPath);
      if (fields.priority) set('Microsoft.VSTS.Common.Priority', Number(fields.priority));
      if (fields.tags?.length) set('System.Tags', fields.tags.join('; '));
      if (parentId) {
        ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${org}/_apis/wit/workItems/${Number(parentId)}` } });
      }
      for (const id of fields.relatedIds || []) {
        ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Related', url: `${org}/_apis/wit/workItems/${Number(id)}` } });
      }
      const create = (body) => api(`${seg(projectName)}/_apis/wit/workitems/${encodeURIComponent(type)}`, { method: 'POST', body, contentType: 'application/json-patch+json' });
      const w = await create(ops).catch((err) => {
        if (!markdownOp || !markdownRefused(err)) throw err;
        return create(ops.filter((o) => o !== markdownOp).map((o) => (o.path === `/fields/${descriptionField}` ? { ...o, value: markdownToHtml(o.value) } : o)));
      });
      return { id: w.id, webUrl: w._links?.html?.href || `${org}/${seg(projectName)}/_workitems/edit/${w.id}` };
    },

    async listAttachments(id) {
      const raw = await api(`_apis/wit/workitems/${id}`, { query: { $expand: 'relations' } });
      return attachmentsOf(raw.relations);
    },

    /** An attachment's bytes as a stream: { type, length, stream }. */
    downloadAttachment(attachmentId, name) {
      return download(`_apis/wit/attachments/${encodeURIComponent(attachmentId)}`, { query: { fileName: name, download: true } });
    },

    /**
     * Moves work items in the team's backlog order (what its board sorts by),
     * between previousId and nextId (0 = start / end of the list).
     */
    async reorderWorkItems(projectId, teamId, { ids, previousId = 0, nextId = 0 }) {
      const d = await api(`${seg(projectId)}/${seg(teamId)}/_apis/work/workitemsorder`, {
        method: 'PATCH',
        apiVersion: '7.1',
        body: { ids, previousId, nextId, parentId: 0 },
      });
      return (d.value || []).map((r) => ({ id: r.id, order: r.order }));
    },

    async updateWorkItem(id, changes) {
      const ops = [];
      const set = (field, value) => ops.push({ op: 'add', path: `/fields/${field}`, value });
      if (changes.state !== undefined) set('System.State', changes.state);
      if (changes.assignedTo !== undefined) set('System.AssignedTo', changes.assignedTo || '');
      if (changes.priority !== undefined) set('Microsoft.VSTS.Common.Priority', Number(changes.priority));
      if (changes.iterationPath !== undefined) set('System.IterationPath', changes.iterationPath);
      if (changes.tags !== undefined) set('System.Tags', changes.tags.join('; '));
      // Board column / done / lane fields (validated by the service).
      for (const [field, value] of Object.entries(changes.fields || {})) set(field, value);
      if (!ops.length) return;
      await api(`_apis/wit/workitems/${id}`, { method: 'PATCH', body: ops, contentType: 'application/json-patch+json' });
    },

    /** Posts a Markdown comment (as HTML where the organization doesn't take Markdown). */
    async commentWorkItem(projectName, id, text) {
      const post = (body, query) => api(`${seg(projectName)}/_apis/wit/workItems/${id}/comments`, { method: 'POST', apiVersion: '7.1-preview.4', query, body });
      await post({ text }, { format: 'markdown' }).catch((err) => {
        if (!markdownRefused(err)) throw err;
        return post({ text: markdownToHtml(text) });
      });
    },

    async listBuilds(projectId, { sinceDays = 14 } = {}) {
      const minTime = new Date(Date.now() - sinceDays * 86_400_000).toISOString();
      // Queued runs are "notStarted": a run you just started waits there for an agent first.
      const [done, running, queued] = await Promise.all([
        api(`${seg(projectId)}/_apis/build/builds`, { query: { statusFilter: 'completed', queryOrder: 'finishTimeDescending', minTime, $top: 1000 } }),
        api(`${seg(projectId)}/_apis/build/builds`, { query: { statusFilter: 'inProgress', $top: 200 } }),
        api(`${seg(projectId)}/_apis/build/builds`, { query: { statusFilter: 'notStarted', $top: 200 } }),
      ]);
      return [...(running.value || []), ...(queued.value || []), ...(done.value || [])].map(toBuild);
    },

    /**
     * Build and YAML pipeline definitions (enabled ones), so pipelines without
     * recent runs, or that never ran, still show up.
     */
    async listDefinitions(projectId) {
      const list = await listAll(`${seg(projectId)}/_apis/build/definitions`, { query: { includeAllProperties: true, includeLatestBuilds: true, $top: 500 } });
      return list
        .filter((d) => d.queueStatus !== 'disabled' && d.type !== 'xaml')
        .map((d) => ({
          id: d.id,
          name: d.name,
          path: d.path,
          projectId: d.project?.id,
          projectName: d.project?.name,
          repoId: d.repository?.type === 'TfsGit' ? d.repository.id : null,
          repoName: d.repository?.name || null,
          defaultBranch: stripRef(d.repository?.defaultBranch) || null,
          paused: d.queueStatus === 'paused',
          lastRun: d.latestCompletedBuild ? toBuild({ ...d.latestCompletedBuild, project: d.project, definition: d }) : null,
          webUrl: d._links?.web?.href || null,
        }));
    },

    /** A pipeline's latest runs, any status and branch, newest first. */
    async listDefinitionRuns(projectId, definitionId, { top = 25 } = {}) {
      const d = await api(`${seg(projectId)}/_apis/build/builds`, { query: { definitions: definitionId, queryOrder: 'queueTimeDescending', $top: top } });
      return (d.value || []).map(toBuild);
    },

    /** A run's stages, jobs and steps (flat; parentId links them), with their issues. */
    async getBuildTimeline(projectId, buildId) {
      const t = await api(`${seg(projectId)}/_apis/build/builds/${buildId}/timeline`).catch((err) => (err.status === 404 ? null : Promise.reject(err)));
      return (t?.records || []).map((r) => ({
        id: r.id,
        parentId: r.parentId || null,
        type: r.type,
        name: r.name,
        order: r.order ?? 0,
        state: r.state,
        result: r.result || null,
        startedAt: r.startTime || null,
        finishedAt: r.finishTime || null,
        errorCount: r.errorCount || 0,
        warningCount: r.warningCount || 0,
        issues: (r.issues || []).slice(0, 10).map((i) => ({ type: i.type, message: String(i.message || '').slice(0, 600) })),
        logId: r.log?.id ?? null,
      }));
    },

    /** The last lines of one step's log, without timestamps or colour codes. */
    async getBuildLogTail(projectId, buildId, logId, lines = 60) {
      const meta = await api(`${seg(projectId)}/_apis/build/builds/${buildId}/logs`);
      const count = (meta.value || []).find((l) => l.id === logId)?.lineCount || 0;
      const text = await apiText(`${seg(projectId)}/_apis/build/builds/${buildId}/logs/${logId}`, {
        query: count ? { startLine: Math.max(1, count - lines + 1), endLine: count } : undefined,
      });
      return text.split(/\r?\n/).slice(-lines)
        .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\u001b\[[0-9;]*m/g, ''))
        .join('\n').trimEnd();
    },

    /** The commits a run built (first line of each message). */
    async getBuildChanges(projectId, buildId) {
      const d = await api(`${seg(projectId)}/_apis/build/builds/${buildId}/changes`, { query: { $top: 20 } });
      return (d.value || []).map((c) => ({
        id: c.id,
        message: String(c.message || '').split('\n')[0].slice(0, 200),
        author: c.author?.displayName || null,
        at: c.timestamp || null,
        webUrl: c.displayUri || null,
      }));
    },

    /** Test results the run published, summed over its test runs (null when none, or no Test scope on the token). */
    async getBuildTests(projectId, buildId) {
      const d = await api(`${seg(projectId)}/_apis/test/runs`, { query: { buildUri: `vstfs:///Build/Build/${buildId}`, includeRunDetails: true } }).catch(() => null);
      const runs = d?.value || [];
      if (!runs.length) return null;
      const sum = (k) => runs.reduce((n, r) => n + (r[k] || 0), 0);
      const total = sum('totalTests');
      const passed = sum('passedTests');
      const other = sum('notApplicableTests') + sum('incompleteTests');
      return { total, passed, failed: Math.max(0, total - passed - other), other };
    },

    /**
     * The tests that failed in a run, from the test runs it published:
     * { failed: [{ name, title, error }] }, or null when it published none
     * (or the token has no Test Management read scope).
     */
    async getBuildFailedTests(projectId, buildId) {
      const d = await api(`${seg(projectId)}/_apis/test/runs`, { query: { buildUri: `vstfs:///Build/Build/${buildId}`, includeRunDetails: true } }).catch(() => null);
      const runs = d?.value || [];
      if (!runs.length) return null;
      const failing = runs.filter((r) => (r.totalTests || 0) - (r.passedTests || 0) - (r.notApplicableTests || 0) - (r.incompleteTests || 0) > 0);
      const lists = await Promise.all(failing.slice(0, 5).map((r) => api(`${seg(projectId)}/_apis/test/Runs/${r.id}/results`, { query: { outcomes: 'Failed', $top: 200 } })
        .then((x) => x.value || []).catch(() => [])));
      return {
        failed: lists.flat().map((x) => ({
          name: x.automatedTestName || x.testCaseTitle,
          title: x.testCaseTitle || x.automatedTestName,
          error: String(x.errorMessage || '').split('\n')[0].slice(0, 300) || null,
        })).filter((x) => x.name),
      };
    },

    /**
     * Classic release pipelines with each stage's latest finished deployment
     * and anything deploying right now, from each definition's recent releases.
     */
    async listReleases(projectId, projectName, { releasesPerDefinition = 15 } = {}) {
      const base = `${rm}/${seg(projectName)}/_apis/release`;
      const defs = await api(`${base}/definitions`, { query: { $expand: 'environments,artifacts', $top: 500 } })
        .then((d) => d.value || [])
        .catch((err) => {
          // Release Management not enabled / no access: treat as "no release pipelines".
          if (err.status === 404) return [];
          throw err;
        });
      return Promise.all(defs.map(async (d) => {
        const releases = await api(`${base}/releases`, { query: { definitionId: d.id, $top: releasesPerDefinition, $expand: 'environments' } })
          .then((r) => r.value || []).catch(() => []);
        const normalized = releases.map((r) => ({
          id: r.id,
          name: r.name,
          createdOn: r.createdOn,
          webUrl: relUrl(projectName, r.id),
          envs: (r.environments || []).map((e) => {
            const step = e.deploySteps?.at(-1);
            const waiting = (e.preDeployApprovals || []).some((a) => a.status === 'pending')
              || /^(pending|deferred|evaluatinggates|gatefailed)$/i.test(step?.operationStatus || '');
            return {
              id: e.id,
              definitionEnvironmentId: e.definitionEnvironmentId,
              status: e.status,
              deploying: e.status === 'inProgress' && !waiting,
              waiting,
              startedAt: step?.queuedOn || null,
              at: step?.lastModifiedOn || step?.queuedOn || r.modifiedOn || r.createdOn,
              requestedFor: ident(step?.requestedFor || step?.requestedBy),
              reason: step?.reason || e.triggerReason || null,
            };
          }),
        }));
        const stages = stageSummary((d.environments || []).map((e) => ({ id: e.id, name: e.name, rank: e.rank })), normalized);
        return {
          id: d.id,
          name: d.name,
          path: d.path || '\\',
          projectId,
          projectName,
          webUrl: `${org}/${seg(projectName)}/_release?definitionId=${d.id}&view=mine&_a=releases`,
          artifacts: (d.artifacts || []).map((a) => ({
            type: a.type,
            alias: a.alias,
            sourceId: a.definitionReference?.definition?.id || null,
            sourceName: a.definitionReference?.definition?.name || null,
            isPrimary: !!a.isPrimary,
          })),
          stages,
          releases: releases.slice(0, 10).map((r) => ({
            id: r.id,
            name: r.name,
            createdOn: r.createdOn,
            createdBy: ident(r.createdBy),
            webUrl: relUrl(projectName, r.id),
            stages: (normalized.find((n) => n.id === r.id)?.envs || []).map((e) => ({
              id: e.id, definitionEnvironmentId: e.definitionEnvironmentId, name: (r.environments || []).find((x) => x.id === e.id)?.name, status: e.status, at: e.at, requestedFor: e.requestedFor,
              deploying: e.deploying, waiting: e.waiting, startedAt: e.startedAt,
            })),
          })),
        };
      }));
    },

    /**
     * Deployments into one environment since `since`, newest first, each with
     * the commit it shipped: a classic release stage (target.type 'release',
     * with definitionId and optional stage) or a pipeline's runs on its branch
     * (type 'pipeline'). See service.js productionTargets().
     */
    async listDeployments(target, { since }) {
      if (target.type === 'pipeline') {
        const runs = await listAll(`${seg(target.projectId)}/_apis/build/builds`, {
          query: {
            definitions: target.definitionId,
            minTime: since,
            statusFilter: 'completed',
            queryOrder: 'finishTimeDescending',
            ...(target.branch ? { branchName: `refs/heads/${target.branch}` } : {}),
            $top: 500,
          },
        });
        return runs
          .filter((b) => b.reason !== 'pullRequest' && b.result !== 'canceled')
          .map((b) => ({
            id: b.id,
            label: b.buildNumber,
            at: b.finishTime,
            startedAt: b.startTime || b.queueTime,
            status: b.result,
            by: b.requestedFor?.displayName || null,
            webUrl: b._links?.web?.href || `${org}/${seg(b.project?.name)}/_build/results?buildId=${b.id}`,
            repoId: b.repository?.type === 'TfsGit' ? b.repository.id : null,
            commit: b.sourceVersion || null,
            branch: stripRef(b.sourceBranch) || null,
          }));
      }
      const base = `${rm}/${seg(target.projectName)}/_apis/release`;
      const list = await api(`${base}/deployments`, {
        query: { definitionId: target.definitionId, minStartedTime: since, queryOrder: 'descending', $top: 200 },
      }).then((d) => d.value || []).catch((err) => (err.status === 404 ? [] : Promise.reject(err)));
      const deployments = list.filter((d) => (!target.stage || d.releaseEnvironment?.name === target.stage)
        && ['succeeded', 'partiallySucceeded', 'failed'].includes(d.deploymentStatus));
      return Promise.all(deployments.map(async (d) => {
        // The commit comes from the release's primary artifact (fetched once per release; releases don't change).
        const artifacts = d.release?.artifacts?.length ? d.release.artifacts : await releaseArtifacts(target.projectName, d.release?.id);
        const a = artifacts.find((x) => x.isPrimary) || artifacts[0];
        const ref = a?.definitionReference || {};
        const git = /git/i.test(a?.type || '');
        return {
          id: d.release?.id,
          label: d.release?.name || `Release ${d.release?.id}`,
          at: d.completedOn || d.lastModifiedOn || d.startedOn,
          startedAt: d.startedOn || d.queuedOn || null,
          status: d.deploymentStatus,
          by: (d.requestedFor || d.requestedBy)?.displayName || null,
          webUrl: relUrl(target.projectName, d.release?.id),
          repoId: (git ? ref.definition?.id : ref.repository?.id) || null,
          commit: (git ? ref.version?.id : ref.sourceVersion?.id) || null,
          branch: stripRef(ref.branch?.name || ref.branch?.id) || null,
        };
      }));
    },

    async listReleaseApprovals(projectId, projectName) {
      const d = await api(`${rm}/${seg(projectName)}/_apis/release/approvals`, { query: { statusFilter: 'pending', $top: 200 } })
        .catch((err) => (err.status === 404 ? { value: [] } : Promise.reject(err)));
      return (d.value || []).map((a) => normalizeApproval(a, projectId, projectName));
    },

    /**
     * Pending YAML approval checks (environments). The approval itself doesn't
     * say which run or stage it gates, so we find it in the timelines of the
     * project's in-progress runs, where it appears as a Checkpoint.Approval.
     */
    async listPipelineApprovals(projectId, projectName, runningBuilds = []) {
      const d = await api(`${seg(projectName)}/_apis/pipelines/approvals`, {
        apiVersion: '7.1-preview.1',
        query: { state: 'pending', $expand: 'steps,permissions', $top: 200 },
      }).catch((err) => (err.status === 404 ? { value: [] } : Promise.reject(err)));
      const pending = d.value || [];
      if (!pending.length) return [];

      const where = new Map();
      await Promise.all(runningBuilds.map(async (b) => {
        const t = await api(`${seg(projectId)}/_apis/build/builds/${b.id}/timeline`).catch(() => null);
        const records = t?.records || [];
        const byId = new Map(records.map((r) => [r.id, r]));
        for (const r of records.filter((x) => x.type === 'Checkpoint.Approval')) {
          let stage = null;
          for (let p = byId.get(r.parentId); p; p = byId.get(p.parentId)) {
            if (p.type === 'Stage') {
              stage = p.name;
              break;
            }
          }
          where.set(r.id, { build: b, stage });
        }
      }));

      const EMPTY = '00000000-0000-0000-0000-000000000000';
      return pending.map((a) => {
        const loc = where.get(a.id);
        return {
          kind: 'yaml',
          id: a.id,
          projectId,
          projectName,
          pipeline: loc?.build.definition.name || a.pipeline?.name || 'Pipeline run',
          stage: loc?.stage || null,
          run: loc ? { id: loc.build.id, name: loc.build.buildNumber, webUrl: loc.build.webUrl, branch: loc.build.sourceBranch } : null,
          createdOn: a.createdOn,
          instructions: a.instructions || '',
          minRequired: a.minRequiredApprovers || 1,
          approvers: (a.steps || []).map((s) => s.assignedApprover).filter((x) => x?.id && x.id !== EMPTY).map(ident),
          // "update" in the permission flags means you may approve or reject it.
          canDecide: /update/i.test(String(a.permissions || '')),
        };
      });
    },

    async decidePipelineApproval(projectName, approvalId, status, comment) {
      await api(`${seg(projectName)}/_apis/pipelines/approvals`, {
        method: 'PATCH',
        apiVersion: '7.1-preview.1',
        body: [{ approvalId, status, comment: comment || '' }],
      });
    },

    async decideReleaseApproval(projectName, approvalId, status, comments) {
      await api(`${rm}/${seg(projectName)}/_apis/release/approvals/${approvalId}`, { method: 'PATCH', body: { status, comments: comments || '' } });
    },

    async createRelease(projectName, definitionId, description) {
      // No artifact versions given: Azure DevOps uses each artifact's default (usually latest).
      const r = await api(`${rm}/${seg(projectName)}/_apis/release/releases`, {
        method: 'POST',
        body: { definitionId: Number(definitionId), description: description || '', isDraft: false, reason: 'manual' },
      });
      return { id: r.id, name: r.name, webUrl: relUrl(projectName, r.id) };
    },

    async deployReleaseStage(projectName, releaseId, environmentId, comment) {
      await api(`${rm}/${seg(projectName)}/_apis/release/releases/${releaseId}/environments/${environmentId}`, {
        method: 'PATCH',
        apiVersion: '7.1-preview.7',
        body: { status: 'inProgress', comment: comment || '' },
      });
    },

    async queueBuild(projectId, definitionId, branch) {
      const b = await api(`${seg(projectId)}/_apis/build/builds`, {
        method: 'POST',
        body: { definition: { id: definitionId }, sourceBranch: branch ? `refs/heads/${branch}` : undefined },
      });
      return { id: b.id, webUrl: b._links?.web?.href };
    },
  };
}
