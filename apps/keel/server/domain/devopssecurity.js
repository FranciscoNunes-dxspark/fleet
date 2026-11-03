// A security review of an Azure DevOps project: what its own settings leave open, judged from the
// REST answers the provider reads (azdo/provider.js readSecuritySettings): pipeline variables and
// variable groups holding secrets in the clear, resources every pipeline may use, Azure service
// connections with more reach than a pipeline needs, default branches without policies, self-hosted
// agents left far behind, and a project open to anyone. Pure: each judge takes the raw answers and
// gives findings in the kit's shape (@fleet/kit/findings.js), so the terminal app, the web app and
// `keel security` all read the same list.
//
// A finding's `where` is the place as a person would look for it ("Commerce/pipeline web-CI (NPM_TOKEN)",
// "Commerce/repo api (main)", "service connection prod-sub"); `webUrl` (Keel's own field) opens it.
// A value is never kept: a variable that holds a secret in the clear shows its name, and its value
// only cut down by the kit's `redact`.
import { redact } from '@fleet/kit/codescan.js';
import { countFindings, sortFindings } from '@fleet/kit/findings.js';

// Branch policy types (the same ids in every organization).
export const POLICY = {
  minReviewers: 'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd',
  requiredReviewers: 'fd2167ab-b0be-447a-8ec8-39368250530e',
  build: '0609b952-1397-4640-95ec-e00a01b2c241',
};

// A self-hosted agent this many minor versions behind the newest one seen (or on an older major) is far behind:
// the agent ships a minor version every few weeks, so 15 is about a year.
export const AGENT_MINOR_LAG = 15;

const enc = (s) => encodeURIComponent(String(s ?? ''));
const stripRef = (ref) => String(ref ?? '').replace(/^refs\/heads\//, '');

// Names that say "secret". KEY only as its own word (API_KEY, storageKey, KEY), not KeyVaultName.
const SECRET_NAME = /password|passwd|passphrase|pwd|secret|token|api[-_. ]?key|access[-_. ]?key|account[-_. ]?key|private[-_. ]?key|client[-_. ]?secret|connection[-_. ]?string|conn[-_. ]?str|credential|(^|[-_. ])sas($|[-_. ])|(^|[-_. ])key$|^key[-_. ]/i;
// What a secret-looking name means when it ends in one of these: its name, address or lifetime, not the secret.
const NOT_SECRET = /(name|names|url|uri|endpoint|host|expiry|expires|expiration|lifetime|timeout|ttl|id|path|file|header|type|length|enabled|issuer|audience|version|vault|scope|kind|count|policy)$/i;

/** Whether a variable's name says it holds a secret (DB_PASSWORD, ApiKey, StorageConnectionString). */
export function secretName(name) {
  const n = String(name ?? '');
  // camelCase as words, so "TokenTimeout" ends in "Timeout" and "storageKey" in "Key".
  const words = n.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SECRET_NAME.test(words) && !NOT_SECRET.test(n);
}

/** Whether a plain variable's value looks like the thing itself: set, and not a reference, a flag or a number. */
export function plainValue(value) {
  const v = String(value ?? '').trim();
  if (v.length < 4) return false;
  if (/^\$[([{]|^\$\{\{|^#\{|^__\w+__$/.test(v)) return false; // $(other), $[expr], ${{ }}, #{token}#, __TOKEN__
  if (/^(true|false|yes|no|none|null|\d+(\.\d+)?)$/i.test(v)) return false;
  return true;
}

const variablesOf = (vars) => Object.entries(vars && typeof vars === 'object' ? vars : {}).map(([name, v]) => ({ name, value: v?.value, isSecret: !!v?.isSecret }));

const libraryUrl = (org, project, kind, id) => `${org}/${enc(project)}/_library?itemType=${kind === 'group' ? 'VariableGroups&view=VariableGroupView&variableGroupId' : 'SecureFiles&view=SecureFileView&secureFileId'}=${enc(id)}`;
const pipelineUrl = (org, project, id) => `${org}/${enc(project)}/_build?definitionId=${enc(id)}`;
const connectionUrl = (org, project, id) => `${org}/${enc(project)}/_settings/adminservices?resourceId=${enc(id)}`;

function plainSecret({ variable, where, webUrl, kind }) {
  return {
    rule: kind === 'group' ? 'group-plain-secret' : 'pipeline-plain-secret',
    severity: 'high',
    title: 'Secret in a variable not marked secret',
    where,
    variable: variable.name,
    why: 'Its value shows to anyone who can read the pipeline or the library, and in run logs, as it is not masked.',
    fix: kind === 'group'
      ? 'In Pipelines → Library, open the variable group, lock the variable (make it secret), then rotate the value: it has been readable.'
      : "In the pipeline's Edit → Variables, tick \"Keep this value secret\" (or move it to a Key Vault variable group), then rotate the value: it has been readable.",
    excerpt: `${variable.name} = ${redact(String(variable.value).trim())}`,
    webUrl,
  };
}

/** Pipeline definitions' own variables (definitions?includeAllProperties=true): secret-named, with a value, not secret. */
export function pipelineVariableFindings({ org = '', project, definitions = [] }) {
  const out = [];
  for (const d of definitions) {
    for (const variable of variablesOf(d.variables)) {
      if (variable.isSecret || !secretName(variable.name) || !plainValue(variable.value)) continue;
      out.push(plainSecret({ variable, where: `${project.name}/pipeline ${d.name} (${variable.name})`, webUrl: d._links?.web?.href || pipelineUrl(org, project.name, d.id), kind: 'pipeline' }));
    }
  }
  return out;
}

/**
 * Variable groups (distributedtask/variablegroups): secret-named values in the clear (high), and a
 * group that keeps secrets in the library rather than linked to a Key Vault (low).
 */
export function variableGroupFindings({ org = '', project, variableGroups = [] }) {
  const out = [];
  for (const g of variableGroups) {
    const where = `${project.name}/variable group ${g.name}`;
    const webUrl = libraryUrl(org, project.name, 'group', g.id);
    // A Key Vault group's variables are the vault's secrets, read at run time: nothing is kept here.
    if (/keyvault/i.test(g.type ?? '')) continue;
    const vars = variablesOf(g.variables);
    for (const variable of vars) {
      if (variable.isSecret || !secretName(variable.name) || !plainValue(variable.value)) continue;
      out.push(plainSecret({ variable, where: `${where} (${variable.name})`, webUrl, kind: 'group' }));
    }
    const secrets = vars.filter((v) => v.isSecret).length;
    if (secrets) {
      out.push({
        rule: 'group-not-keyvault',
        severity: 'low',
        title: 'Secrets kept in the library, not in Key Vault',
        where,
        why: `${secrets === 1 ? 'Its secret is' : `Its ${secrets} secrets are`} kept only in Azure DevOps, with no rotation, expiry or access log, and a change means editing every group that holds a copy.`,
        fix: 'Keep the secrets in an Azure Key Vault and link this group to it (Pipelines → Library → the group → "Link secrets from an Azure key vault as variables").',
        webUrl,
      });
    }
  }
  return out;
}

/**
 * Resources every pipeline may use (pipelines/pipelinepermissions/<type>/<id> with allPipelines.authorized):
 * service connections, variable groups and secure files. Any pipeline in the project, including one a
 * pull request just added, can then use them without anyone approving it.
 */
export function openToAllFindings({ org = '', project, permissions = [], endpoints = [], variableGroups = [], secureFiles = [] }) {
  const out = [];
  const named = {
    endpoint: new Map(endpoints.map((e) => [String(e.id), e])),
    variablegroup: new Map(variableGroups.map((g) => [String(g.id), g])),
    securefile: new Map(secureFiles.map((f) => [String(f.id), f])),
  };
  for (const p of permissions) {
    if (!p?.allPipelines?.authorized) continue;
    const type = String(p.resource?.type ?? '').toLowerCase();
    const id = String(p.resource?.id ?? '');
    const thing = named[type]?.get(id);
    if (!thing) continue;
    const [where, webUrl, fix] = type === 'endpoint'
      ? [`service connection ${thing.name}`, connectionUrl(org, project.name, id), 'In Project settings → Service connections → the connection → ⋮ → Security, turn off "Grant access permission to all pipelines" (Open access) and allow only the pipelines that need it.']
      : type === 'variablegroup'
        ? [`${project.name}/variable group ${thing.name}`, libraryUrl(org, project.name, 'group', id), 'In Pipelines → Library → the group → Pipeline permissions, turn off Open access and allow only the pipelines that need it.']
        : [`${project.name}/secure file ${thing.name}`, libraryUrl(org, project.name, 'file', id), 'In Pipelines → Library → Secure files → the file → Pipeline permissions, turn off Open access and allow only the pipelines that need it.'];
    out.push({
      rule: 'open-to-all-pipelines',
      severity: 'medium',
      title: 'Open to every pipeline',
      where,
      why: 'Any pipeline in the project can use it without approval, including a new one added in a branch.',
      fix,
      webUrl,
    });
  }
  return out;
}

// Roles that can hand out access as well as use it.
const OWNER_LIKE = /\bowner\b|user access administrator|role based access control administrator/i;

/**
 * Service connections (serviceendpoint/endpoints): an Azure Resource Manager connection scoped to a
 * whole subscription or management group, or holding an Owner-like role where Azure DevOps says so
 * (medium); signing in with a client secret rather than workload identity federation (low); and any
 * connection shared with other projects (low).
 */
export function serviceConnectionFindings({ org = '', project, endpoints = [] }) {
  const out = [];
  for (const e of endpoints) {
    const where = `service connection ${e.name}`;
    const webUrl = connectionUrl(org, project.name, e.id);
    const azure = String(e.type ?? '').toLowerCase() === 'azurerm';
    const params = e.authorization?.parameters ?? {};
    const data = e.data ?? {};
    if (azure) {
      const level = String(data.scopeLevel ?? '');
      const scope = String(params.scope ?? '');
      if (/managementgroup/i.test(level)) {
        out.push({ rule: 'connection-wide-scope', severity: 'medium', title: 'Azure connection scoped to a management group', where, why: 'Every pipeline that can use it reaches every subscription under the management group.', fix: 'Make a connection scoped to the resource group (or subscription) a pipeline deploys to, and retire this one.', excerpt: data.managementGroupName || data.managementGroupId || undefined, webUrl });
      } else if (/subscription/i.test(level) && !/\/resourcegroups\//i.test(scope)) {
        out.push({ rule: 'connection-wide-scope', severity: 'medium', title: 'Azure connection scoped to a whole subscription', where, why: 'Every pipeline that can use it can change anything in the subscription, not only what it deploys.', fix: 'Scope it to the resource group it deploys to (a new connection with a resource group, or narrow its identity\'s role assignment in Azure).', excerpt: data.subscriptionName || undefined, webUrl });
      }
      const role = data.roleName ?? data.azureSpnRoleName ?? params.roleName ?? params.role;
      if (role && OWNER_LIKE.test(String(role))) {
        out.push({ rule: 'connection-owner-role', severity: 'medium', title: 'Azure connection with an Owner-like role', where, why: 'With Owner or User Access Administrator, a pipeline can grant itself or anyone else access in Azure.', fix: 'In Azure, give its identity Contributor (or narrower) on what it deploys, and remove the Owner-like assignment.', excerpt: String(role), webUrl });
      }
      const scheme = String(e.authorization?.scheme ?? '');
      const how = String(params.authenticationType ?? '');
      if (/^serviceprincipal$/i.test(scheme) && !/certificate/i.test(how)) {
        out.push({ rule: 'connection-client-secret', severity: 'low', title: 'Azure connection signs in with a client secret', where, why: 'A client secret is a long-lived password: it expires and has to be rotated, and anyone who gets it signs in as the pipeline.', fix: 'Convert it to workload identity federation (Project settings → Service connections → the connection → Convert), which keeps no secret.', webUrl });
      }
    }
    const projects = (e.serviceEndpointProjectReferences ?? []).map((r) => r.projectReference?.name).filter(Boolean);
    if (projects.length > 1) {
      out.push({ rule: 'connection-shared', severity: 'low', title: 'Service connection shared with other projects', where, why: 'Pipelines in every project it is shared with can use what it reaches, under their own people\'s permissions.', fix: 'Share it only with the projects that deploy through it (Project settings → Service connections → the connection → ⋮ → Security → Project permissions).', excerpt: projects.join(', '), webUrl });
    }
  }
  return out;
}

/** Whether a policy's scope entry covers `ref` of `repoId` (Exact, Prefix, DefaultBranch, or every branch when it names none). */
export function scopeCovers(scope, repoId, ref, defaultRef = ref) {
  if (scope?.repositoryId && String(scope.repositoryId).toLowerCase() !== String(repoId).toLowerCase()) return false;
  const kind = String(scope?.matchKind ?? 'Exact').toLowerCase();
  if (kind === 'defaultbranch') return ref.toLowerCase() === String(defaultRef).toLowerCase();
  if (!scope?.refName) return true;
  const name = String(scope.refName).toLowerCase();
  return kind === 'prefix' ? ref.toLowerCase().startsWith(name) : ref.toLowerCase() === name;
}

/** The enabled, blocking policies of `type` that cover a repository's branch. */
export function policiesFor(policies, type, repoId, ref) {
  return policies.filter((p) => p?.isEnabled !== false && !p?.isDeleted && p?.isBlocking !== false && p?.type?.id === type
    && (p.settings?.scope ?? [{}]).some((s) => scopeCovers(s, repoId, ref)));
}

/**
 * Each repository's default branch (git/repositories) against the branch policies
 * (policy/configurations): no required reviewers (high), no build validation (medium), and one
 * reviewer where the author's own vote counts (low).
 */
export function branchPolicyFindings({ org = '', project, repos = [], policies = [] }) {
  const out = [];
  for (const r of repos) {
    if (r.isDisabled || !r.defaultBranch) continue;
    const ref = r.defaultBranch.startsWith('refs/') ? r.defaultBranch : `refs/heads/${r.defaultBranch}`;
    const branch = stripRef(ref);
    const where = `${project.name}/repo ${r.name} (${branch})`;
    const webUrl = `${org}/${enc(project.name)}/_settings/repositories?repo=${enc(r.id)}&_a=policiesMid&refs=${enc(ref)}`;
    const reviewers = policiesFor(policies, POLICY.minReviewers, r.id, ref).filter((p) => Number(p.settings?.minimumApproverCount ?? 0) >= 1);
    const required = policiesFor(policies, POLICY.requiredReviewers, r.id, ref);
    const builds = policiesFor(policies, POLICY.build, r.id, ref);
    if (!reviewers.length && !required.length) {
      out.push({ rule: 'branch-no-reviewers', severity: 'high', title: 'Default branch needs no reviewer', where, why: 'Anyone who can push can change it with no one else looking: a mistake, or a planted change, goes straight to what is built and deployed.', fix: `In Project settings → Repositories → ${r.name} → Policies → ${branch}, turn on "Require a minimum number of reviewers".`, webUrl });
    } else if (reviewers.length && !required.length) {
      const strictest = reviewers.reduce((a, p) => {
        const count = Number(p.settings?.minimumApproverCount ?? 0);
        const own = !!p.settings?.creatorVoteCounts;
        return count > a.count || (count === a.count && a.own && !own) ? { count, own } : a;
      }, { count: 0, own: true });
      if (strictest.count === 1 && strictest.own) {
        out.push({ rule: 'branch-creator-vote', severity: 'low', title: "One reviewer, and the author's own vote counts", where, why: 'The author can approve their own pull request, so the policy asks no one else to look.', fix: `In its branch policy (Policies → ${branch} → Require a minimum number of reviewers), untick "Allow requestors to approve their own changes", or ask for two.`, webUrl });
      }
    }
    if (!builds.length) {
      out.push({ rule: 'branch-no-build-validation', severity: 'medium', title: 'Default branch has no build validation', where, why: 'A pull request can complete without a pipeline building and testing it.', fix: `In Project settings → Repositories → ${r.name} → Policies → ${branch}, add a Build validation with the repository's CI pipeline, required.`, webUrl });
    }
  }
  return out;
}

/** "3.248.1" as [3, 248, 1]; null when it isn't a version. */
export function parseVersion(v) {
  const m = String(v ?? '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
const newer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

/**
 * Self-hosted agents (distributedtask/queues for the project's pools, then pools/<id>/agents) far behind
 * the newest agent seen, or `latestAgent` when given: an old agent misses the fixes the hosted ones have.
 * One finding per pool.
 */
export function agentFindings({ org = '', queues = [], agents = {}, latestAgent }) {
  const pools = new Map();
  for (const q of queues) if (q?.pool && !q.pool.isHosted && q.pool.id != null) pools.set(String(q.pool.id), q.pool.name ?? q.name);
  const all = [...pools.keys()].flatMap((id) => (agents[id] ?? []).map((a) => ({ ...a, poolId: id, v: parseVersion(a.version) }))).filter((a) => a.v);
  if (!all.length) return [];
  const latest = parseVersion(latestAgent) ?? all.map((a) => a.v).sort(newer).at(-1);
  const behind = (v) => v[0] < latest[0] || (v[0] === latest[0] && latest[1] - v[1] >= AGENT_MINOR_LAG);
  const out = [];
  for (const [id, name] of pools) {
    const old = all.filter((a) => a.poolId === id && behind(a.v));
    if (!old.length) continue;
    out.push({
      rule: 'agent-outdated',
      severity: 'low',
      title: old.length === 1 ? 'Self-hosted agent far behind' : `${old.length} self-hosted agents far behind`,
      where: `agent pool ${name}`,
      why: `The newest agent is ${latest.join('.')}; an agent this old misses its security and platform fixes, and may stop being supported.`,
      fix: 'In Organization settings → Agent pools → the pool → Agents, choose "Update all agents" (or turn on automatic updates in its Settings).',
      excerpt: old.map((a) => `${a.name} ${a.version}`).join(', '),
      webUrl: `${org}/_settings/agentpools?poolId=${enc(id)}&view=agents`,
    });
  }
  return out;
}

/**
 * The project itself (projects/<id>): public means anyone on the internet can read its code, work and
 * pipelines. Medium, unless the project is one `publicProjects` names, then low (a note: it's meant).
 */
export function projectFindings({ org = '', project, publicProjects = [] }) {
  if (String(project?.visibility ?? '').toLowerCase() !== 'public') return [];
  const expected = publicProjects.some((n) => String(n).toLowerCase() === project.name.toLowerCase() || String(n) === project.id);
  return [{
    rule: 'project-public',
    severity: expected ? 'low' : 'medium',
    title: expected ? 'Public project (expected)' : 'Public project',
    where: `project ${project.name}`,
    why: 'Anyone, signed in or not, can read its repositories, work items, pipelines and their logs.',
    fix: expected ? 'Nothing to do while it is meant to be public; keep secrets out of its logs and variables.' : 'If it is not meant to be, make it private in Project settings → Overview → Visibility.',
    webUrl: `${org}/${enc(project.name)}/_settings/`,
  }];
}

/**
 * Every judge over one project's answers (readSecuritySettings), worst first. `publicProjects`: projects
 * meant to be public; `latestAgent`: the agent version to compare self-hosted agents with.
 */
export function reviewProject(input, { publicProjects = [], latestAgent } = {}) {
  const project = { id: input.project?.id, name: input.project?.name ?? input.projectName ?? '?', visibility: input.project?.visibility };
  const x = { ...input, org: String(input.org ?? '').replace(/\/$/, ''), project, publicProjects, latestAgent };
  return sortFindings([
    ...projectFindings(x),
    ...pipelineVariableFindings(x),
    ...variableGroupFindings(x),
    ...openToAllFindings(x),
    ...serviceConnectionFindings(x),
    ...branchPolicyFindings(x),
    ...agentFindings(x),
  ]);
}

/**
 * Several projects' reviews as one: their findings together (a service connection or agent pool two
 * projects share counted once), worst first, with the counts and what couldn't be read.
 */
export function combineReviews(projects = []) {
  const seen = new Set();
  const findings = [];
  for (const p of projects) {
    for (const f of p.findings ?? []) {
      const key = `${p.org ?? ''}|${f.rule}|${f.where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(p.org ? { ...f, org: p.org } : f);
    }
  }
  const gaps = projects.flatMap((p) => (p.gaps ?? []).map((g) => ({ ...g, projectName: p.projectName })));
  return { findings: sortFindings(findings), counts: countFindings(findings), gaps };
}
