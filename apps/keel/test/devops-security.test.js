// bilge-ignore-file: the fake secrets below are built from pieces, on purpose.
//
// The Azure DevOps security review's judges (server/domain/devopssecurity.js), each over REST answers
// shaped as Azure DevOps sends them: one set up well, one not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY, agentFindings, branchPolicyFindings, combineReviews, openToAllFindings, parseVersion, pipelineVariableFindings,
  plainValue, projectFindings, reviewProject, scopeCovers, secretName, serviceConnectionFindings, variableGroupFindings,
} from '../server/domain/devopssecurity.js';

const ORG = 'https://dev.azure.com/contoso';
const project = { id: 'p1', name: 'Shop', visibility: 'private' };
const FAKE_TOKEN = ['ghp', '_', 'fake', 'Fake', 'FAKE', '0123456789', 'abcdefghij', 'KLMNOP'].join('');
const FAKE_PASSWORD = ['Hunter', '2', '-not-', 'real', '!'].join('');
const rules = (list) => list.map((f) => `${f.severity} ${f.rule} ${f.where}`).sort();

test('a secret-looking name: passwords, tokens, keys and connection strings, not their names, addresses or lifetimes', () => {
  for (const n of ['DB_PASSWORD', 'dbPassword', 'NPM_TOKEN', 'ApiKey', 'API_KEY', 'storageKey', 'KEY', 'ClientSecret', 'StorageConnectionString', 'SqlConnStr', 'SAS', 'sas_token', 'AzureCredentials', 'pwd']) assert.ok(secretName(n), n);
  for (const n of ['KeyVaultName', 'TokenLifetime', 'TOKEN_ENDPOINT', 'SecretName', 'BuildConfiguration', 'monkey', 'NODE_ENV', 'TF_STATE_KEY_NAME', 'Passthrough', 'ApiBaseUrl', 'keyboard']) assert.ok(!secretName(n), n);
});

test('a plain value: set, and not a reference, a flag or a number', () => {
  for (const v of [FAKE_TOKEN, FAKE_PASSWORD, 'abcd']) assert.ok(plainValue(v), v);
  for (const v of [null, undefined, '', '  ', 'abc', '$(OtherVar)', '$[variables.x]', '${{ parameters.token }}', '#{Token}#', '__TOKEN__', 'true', 'false', '3600', '1.5']) assert.ok(!plainValue(v), String(v));
});

test("pipeline variables: a secret-named one with a value that isn't secret is high, its value redacted", () => {
  const definitions = [
    {
      id: 7, name: 'web-CI', _links: { web: { href: `${ORG}/Shop/_build/definition?definitionId=7` } },
      variables: {
        NPM_TOKEN: { value: FAKE_TOKEN, allowOverride: false },
        DB_PASSWORD: { value: null, isSecret: true },
        API_KEY: { value: '$(KeyFromGroup)' },
        TokenLifetime: { value: '3600' },
        NODE_ENV: { value: 'production' },
      },
    },
    { id: 8, name: 'api-CI', variables: { ClientSecret: { value: FAKE_PASSWORD, isSecret: false } } },
    { id: 9, name: 'no-variables' },
  ];
  const found = pipelineVariableFindings({ org: ORG, project, definitions });
  assert.deepEqual(rules(found), ['high pipeline-plain-secret Shop/pipeline api-CI (ClientSecret)', 'high pipeline-plain-secret Shop/pipeline web-CI (NPM_TOKEN)']);
  const npm = found.find((f) => f.variable === 'NPM_TOKEN');
  assert.equal(npm.webUrl, `${ORG}/Shop/_build/definition?definitionId=7`);
  assert.equal(found.find((f) => f.variable === 'ClientSecret').webUrl, `${ORG}/Shop/_build?definitionId=8`);
  assert.match(npm.excerpt, /^NPM_TOKEN = ghp_•+$/);
  assert.ok(!JSON.stringify(found).includes(FAKE_TOKEN) && !JSON.stringify(found).includes(FAKE_PASSWORD), 'no value kept');
  assert.match(npm.fix, /Keep this value secret/);
});

test('variable groups: plain secrets (high), secrets kept in the library rather than Key Vault (low); a Key Vault group is fine', () => {
  const variableGroups = [
    { id: 3, name: 'checkout', type: 'Vsts', variables: { ApiBaseUrl: { value: 'https://api.example.com' }, PaymentsApiKey: { value: FAKE_PASSWORD }, Webhook_Secret: { value: null, isSecret: true } } },
    { id: 4, name: 'vault', type: 'AzureKeyVault', providerData: { vault: 'kv-shop' }, variables: { 'sql-password': { value: null, isSecret: true } } },
    { id: 5, name: 'plain', type: 'Vsts', variables: { Region: { value: 'westeurope' } } },
  ];
  const found = variableGroupFindings({ org: ORG, project, variableGroups });
  assert.deepEqual(rules(found), ['high group-plain-secret Shop/variable group checkout (PaymentsApiKey)', 'low group-not-keyvault Shop/variable group checkout']);
  assert.equal(found[0].webUrl, `${ORG}/Shop/_library?itemType=VariableGroups&view=VariableGroupView&variableGroupId=3`);
  assert.match(found.find((f) => f.rule === 'group-not-keyvault').why, /^Its secret is kept only in Azure DevOps/);
  assert.ok(!JSON.stringify(found).includes(FAKE_PASSWORD));
});

test('open to every pipeline: service connections, variable groups and secure files authorized for all pipelines', () => {
  const input = {
    org: ORG, project,
    endpoints: [{ id: 'e1', name: 'prod' }, { id: 'e2', name: 'staging' }],
    variableGroups: [{ id: 3, name: 'checkout' }],
    secureFiles: [{ id: 'f1', name: 'signing.pfx' }, { id: 'f2', name: 'other.pfx' }],
    permissions: [
      { resource: { type: 'endpoint', id: 'e1' }, pipelines: [], allPipelines: { authorized: true, authorizedOn: '2026-01-01T00:00:00Z' } },
      { resource: { type: 'endpoint', id: 'e2' }, pipelines: [{ id: 7, authorized: true }], allPipelines: null },
      { resource: { type: 'variablegroup', id: '3' }, pipelines: [], allPipelines: { authorized: true } },
      { resource: { type: 'securefile', id: 'f1' }, pipelines: [], allPipelines: { authorized: true } },
      { resource: { type: 'securefile', id: 'f2' }, pipelines: [], allPipelines: { authorized: false } },
      // One the review didn't read (a resource since deleted): nothing to name, so nothing said.
      { resource: { type: 'endpoint', id: 'gone' }, allPipelines: { authorized: true } },
    ],
  };
  const found = openToAllFindings(input);
  assert.deepEqual(rules(found), [
    'medium open-to-all-pipelines Shop/secure file signing.pfx',
    'medium open-to-all-pipelines Shop/variable group checkout',
    'medium open-to-all-pipelines service connection prod',
  ]);
  assert.match(found.find((f) => f.where === 'service connection prod').fix, /Service connections/);
  assert.equal(found.find((f) => f.where === 'service connection prod').webUrl, `${ORG}/Shop/_settings/adminservices?resourceId=e1`);
});

const azureRm = ({ id = 'e1', name = 'prod', scheme = 'ServicePrincipal', authenticationType = 'spnKey', scopeLevel = 'Subscription', scope, role, projects = ['Shop'] } = {}) => ({
  id, name, type: 'azurerm',
  data: { scopeLevel, subscriptionName: 'Contoso Production', ...(role ? { roleName: role } : {}) },
  authorization: { scheme, parameters: { tenantid: 't', serviceprincipalid: 's', ...(scheme === 'ServicePrincipal' ? { authenticationType, serviceprincipalkey: null } : {}), ...(scope ? { scope } : {}) } },
  serviceEndpointProjectReferences: projects.map((n) => ({ projectReference: { id: n, name: n }, name })),
});

test('service connections: a whole subscription or management group, an Owner-like role, a client secret, shared with other projects', () => {
  const endpoints = [
    azureRm({ name: 'wide' }),
    azureRm({ id: 'e2', name: 'narrow', scheme: 'WorkloadIdentityFederation', scope: '/subscriptions/x/resourceGroups/rg-shop' }),
    azureRm({ id: 'e3', name: 'mg', scheme: 'WorkloadIdentityFederation', scopeLevel: 'ManagementGroup' }),
    azureRm({ id: 'e4', name: 'owner', scheme: 'WorkloadIdentityFederation', scope: '/subscriptions/x/resourcegroups/rg', role: 'Owner' }),
    azureRm({ id: 'e5', name: 'cert', authenticationType: 'spnCertificate', scope: '/subscriptions/x/resourcegroups/rg' }),
    azureRm({ id: 'e6', name: 'msi', scheme: 'ManagedServiceIdentity', scope: '/subscriptions/x/resourcegroups/rg', projects: ['Shop', 'Ops'] }),
    { id: 'e7', name: 'npm', type: 'npm', authorization: { scheme: 'Token', parameters: {} }, serviceEndpointProjectReferences: [{ projectReference: { name: 'Shop' } }] },
  ];
  assert.deepEqual(rules(serviceConnectionFindings({ org: ORG, project, endpoints })), [
    'low connection-client-secret service connection wide',
    'low connection-shared service connection msi',
    'medium connection-owner-role service connection owner',
    'medium connection-wide-scope service connection mg',
    'medium connection-wide-scope service connection wide',
  ]);
  const shared = serviceConnectionFindings({ org: ORG, project, endpoints: [endpoints[5]] })[0];
  assert.equal(shared.excerpt, 'Shop, Ops');
});

const policy = (type, settings, extra = {}) => ({ isEnabled: true, isBlocking: true, isDeleted: false, type: { id: type }, settings, ...extra });
const exact = (repositoryId, branch = 'main') => [{ refName: `refs/heads/${branch}`, matchKind: 'Exact', repositoryId }];

test('policy scopes: one repository or all of them, exact, prefix, the default branch, or every branch', () => {
  assert.ok(scopeCovers({ repositoryId: 'r1', refName: 'refs/heads/main', matchKind: 'Exact' }, 'R1', 'refs/heads/main'));
  assert.ok(!scopeCovers({ repositoryId: 'r2', refName: 'refs/heads/main', matchKind: 'Exact' }, 'r1', 'refs/heads/main'));
  assert.ok(scopeCovers({ repositoryId: null, refName: 'refs/heads/', matchKind: 'Prefix' }, 'r1', 'refs/heads/main'));
  assert.ok(!scopeCovers({ refName: 'refs/heads/release/', matchKind: 'Prefix' }, 'r1', 'refs/heads/main'));
  assert.ok(scopeCovers({ matchKind: 'DefaultBranch' }, 'r1', 'refs/heads/main'));
  assert.ok(scopeCovers({ repositoryId: 'r1' }, 'r1', 'refs/heads/anything'));
});

test("default branches: no required reviewers (high), no build validation (medium), one reviewer whose own vote counts (low)", () => {
  const repos = [
    { id: 'r-good', name: 'good', defaultBranch: 'refs/heads/main' },
    { id: 'r-bare', name: 'bare', defaultBranch: 'refs/heads/master' },
    { id: 'r-self', name: 'self', defaultBranch: 'refs/heads/main' },
    { id: 'r-req', name: 'required', defaultBranch: 'refs/heads/main' },
    { id: 'r-off', name: 'off', defaultBranch: 'refs/heads/main' },
    { id: 'r-empty', name: 'empty' },
    { id: 'r-disabled', name: 'disabled', defaultBranch: 'refs/heads/main', isDisabled: true },
  ];
  const policies = [
    policy(POLICY.minReviewers, { minimumApproverCount: 2, creatorVoteCounts: true, scope: exact('r-good') }),
    policy(POLICY.build, { buildDefinitionId: 7, scope: exact('r-good') }),
    policy(POLICY.minReviewers, { minimumApproverCount: 1, creatorVoteCounts: true, scope: exact('r-self') }),
    policy(POLICY.build, { buildDefinitionId: 7, scope: [{ repositoryId: null, refName: 'refs/heads/main', matchKind: 'Exact' }] }),
    policy(POLICY.requiredReviewers, { requiredReviewerIds: ['g1'], scope: exact('r-req') }),
    // Switched off, not blocking, or deleted: none of these count.
    policy(POLICY.minReviewers, { minimumApproverCount: 2, scope: exact('r-off') }, { isEnabled: false }),
    policy(POLICY.minReviewers, { minimumApproverCount: 2, scope: exact('r-off') }, { isBlocking: false }),
    policy(POLICY.minReviewers, { minimumApproverCount: 2, scope: exact('r-off') }, { isDeleted: true }),
  ];
  const found = branchPolicyFindings({ org: ORG, project, repos, policies });
  assert.deepEqual(rules(found), [
    'high branch-no-reviewers Shop/repo bare (master)',
    'high branch-no-reviewers Shop/repo off (main)',
    'low branch-creator-vote Shop/repo self (main)',
    'medium branch-no-build-validation Shop/repo bare (master)',
  ]);
  const bare = found.find((f) => f.rule === 'branch-no-reviewers' && f.where.includes('bare'));
  assert.match(bare.fix, /Repositories → bare → Policies → master/);
  assert.equal(bare.webUrl, `${ORG}/Shop/_settings/repositories?repo=r-bare&_a=policiesMid&refs=refs%2Fheads%2Fmaster`);
  // A stricter policy beside a weak one leaves nothing to say.
  const both = [...policies, policy(POLICY.minReviewers, { minimumApproverCount: 1, creatorVoteCounts: false, scope: exact('r-self') })];
  assert.ok(!branchPolicyFindings({ org: ORG, project, repos, policies: both }).some((f) => f.rule === 'branch-creator-vote'));
});

test('self-hosted agents far behind the newest seen (or the version given), one finding per pool; hosted pools are left alone', () => {
  assert.deepEqual(parseVersion('3.248.1'), [3, 248, 1]);
  assert.equal(parseVersion('n/a'), null);
  const queues = [
    { id: 1, name: 'Azure Pipelines', pool: { id: 9, name: 'Azure Pipelines', isHosted: true } },
    { id: 2, name: 'Build', pool: { id: 12, name: 'Build', isHosted: false } },
    { id: 3, name: 'Fresh', pool: { id: 13, name: 'Fresh', isHosted: false } },
  ];
  const agents = {
    9: [{ name: 'hosted', version: '2.100.0' }],
    12: [{ name: 'b1', version: '3.248.0' }, { name: 'b2', version: '3.220.0' }, { name: 'b3', version: '2.217.2' }, { name: 'b4', version: '3.240.0' }],
    13: [{ name: 'f1', version: '3.246.0' }],
  };
  const found = agentFindings({ org: ORG, queues, agents });
  assert.deepEqual(rules(found), ['low agent-outdated agent pool Build']);
  assert.equal(found[0].title, '2 self-hosted agents far behind');
  assert.equal(found[0].excerpt, 'b2 3.220.0, b3 2.217.2');
  assert.equal(found[0].webUrl, `${ORG}/_settings/agentpools?poolId=12&view=agents`);
  assert.deepEqual(rules(agentFindings({ org: ORG, queues, agents, latestAgent: '3.262.0' })), ['low agent-outdated agent pool Build', 'low agent-outdated agent pool Fresh']);
  assert.deepEqual(agentFindings({ org: ORG, queues: queues.slice(0, 1), agents }), []);
});

test('a public project is medium, or low when it is meant to be; a private one says nothing', () => {
  assert.deepEqual(projectFindings({ org: ORG, project }), []);
  const pub = { ...project, visibility: 'public' };
  assert.deepEqual(rules(projectFindings({ org: ORG, project: pub })), ['medium project-public project Shop']);
  const meant = projectFindings({ org: ORG, project: pub, publicProjects: ['shop'] });
  assert.deepEqual(rules(meant), ['low project-public project Shop']);
  assert.equal(meant[0].title, 'Public project (expected)');
});

test('a whole project: every judge, worst first; a project in good order has nothing; projects combine with shared things counted once', () => {
  const bad = {
    org: `${ORG}/`,
    project: { ...project, visibility: 'public' },
    definitions: [{ id: 1, name: 'ci', variables: { DB_PASSWORD: { value: FAKE_PASSWORD } } }],
    variableGroups: [],
    secureFiles: [],
    endpoints: [azureRm()],
    permissions: [{ resource: { type: 'endpoint', id: 'e1' }, allPipelines: { authorized: true } }],
    repos: [{ id: 'r1', name: 'api', defaultBranch: 'refs/heads/main' }],
    policies: [],
    queues: [],
    agents: {},
  };
  const found = reviewProject(bad);
  assert.deepEqual(found.map((f) => f.severity), ['high', 'high', 'medium', 'medium', 'medium', 'medium', 'low']);
  assert.ok(found.every((f) => f.rule && f.title && f.where && f.why && f.fix), 'each has the kit\'s fields');
  assert.ok(found.every((f) => !f.webUrl || f.webUrl.startsWith(`${ORG}/`) && !f.webUrl.startsWith(`${ORG}//`)));
  const good = {
    org: ORG, project,
    definitions: [{ id: 1, name: 'ci', variables: { DB_PASSWORD: { value: null, isSecret: true } } }],
    endpoints: [azureRm({ scheme: 'WorkloadIdentityFederation', scope: '/subscriptions/x/resourcegroups/rg' })],
    permissions: [{ resource: { type: 'endpoint', id: 'e1' }, pipelines: [{ id: 1 }], allPipelines: null }],
    repos: [{ id: 'r1', name: 'api', defaultBranch: 'refs/heads/main' }],
    policies: [policy(POLICY.minReviewers, { minimumApproverCount: 2, scope: exact('r1') }), policy(POLICY.build, { scope: exact('r1') })],
  };
  assert.deepEqual(reviewProject(good), []);
  const shop = { projectName: 'Shop', findings: found, gaps: [] };
  const ops = { projectName: 'Ops', findings: found.filter((f) => f.where.startsWith('service connection')), gaps: [{ what: 'service connections', error: 'Azure DevOps GET failed (403): denied' }] };
  const all = combineReviews([shop, ops]);
  assert.equal(all.findings.length, found.length);
  assert.equal(all.counts.high, 2);
  assert.deepEqual(all.gaps, [{ what: 'service connections', error: 'Azure DevOps GET failed (403): denied', projectName: 'Ops' }]);
});
