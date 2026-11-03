// bilge-ignore-file: the demo's made-up secrets are built from pieces below, on purpose.
//
// The demo organization's settings as Azure DevOps' REST API answers them, for the security review
// (domain/devopssecurity.js): pipeline definitions with their variables, variable groups, secure
// files, service connections, pipeline permissions, repositories, branch policies, agent queues and
// agents. Some are set up well and some not, so every rule shows something. The secrets are fake,
// made of pieces so nothing here reads as a real one.
import { POLICY } from '../domain/devopssecurity.js';

const by = { displayName: 'You (Tech Lead)', id: 'u-lead', uniqueName: 'lead@contoso-demo.com' };
const at = '2026-06-01T09:00:00Z';
const FAKE_NPM = ['npm', '_', 'DEMO', 'not', 'a', 'real', 'token', '0000', '1111', '22'].join('');
const FAKE_PAYMENTS = ['pk', '-demo-', 'fake', '-7f3a', '-9c21', '-b04e'].join('');
const FAKE_SMTP = ['Demo', 'Only', '-', 'Pa55', '-', 'word'].join('');

const ref = (branch) => `refs/heads/${branch}`;
const policy = (id, type, settings) => ({
  id, revision: 1, isEnabled: true, isBlocking: true, isDeleted: false, createdBy: by, createdDate: at,
  type: { id: type, displayName: { [POLICY.minReviewers]: 'Minimum number of reviewers', [POLICY.build]: 'Build', [POLICY.requiredReviewers]: 'Required reviewers' }[type] },
  settings,
});
const reviewers = (id, repoId, branch, count, creatorVoteCounts = false) => policy(id, POLICY.minReviewers, {
  minimumApproverCount: count, creatorVoteCounts, allowDownvotes: false, resetOnSourcePush: true,
  scope: [{ refName: ref(branch), matchKind: 'Exact', repositoryId: repoId }],
});
const buildValidation = (id, repoId, branch, definitionId) => policy(id, POLICY.build, {
  buildDefinitionId: definitionId, queueOnSourceUpdateOnly: true, manualQueueOnly: false, displayName: null, validDuration: 720,
  scope: [{ refName: ref(branch), matchKind: 'Exact', repositoryId: repoId }],
});
const allowAll = (type, id) => ({ resource: { type, id: String(id) }, pipelines: [], allPipelines: { authorized: true, authorizedBy: by, authorizedOn: at } });
const someOnly = (type, id, pipelines) => ({ resource: { type, id: String(id) }, pipelines: pipelines.map((pid) => ({ id: pid, authorized: true, authorizedBy: by, authorizedOn: at })), allPipelines: null });
const agent = (id, name, version) => ({ id, name, version, enabled: true, status: 'online', provisioningState: 'Provisioned', osDescription: 'Linux 6.8.0 Ubuntu 24.04' });

function azureRm({ id, name, scheme, subscription, resourceGroup, projects, role }) {
  return {
    id, name, type: 'azurerm', url: 'https://management.azure.com/', owner: 'Library', isShared: projects.length > 1, isReady: true,
    createdBy: by,
    data: { environment: 'AzureCloud', scopeLevel: 'Subscription', subscriptionId: '00000000-0000-4000-8000-0000000000aa', subscriptionName: subscription, creationMode: 'Automatic', ...(role ? { roleName: role } : {}) },
    authorization: {
      scheme,
      parameters: {
        tenantid: '00000000-0000-4000-8000-0000000000bb',
        serviceprincipalid: '00000000-0000-4000-8000-0000000000cc',
        ...(scheme === 'ServicePrincipal' ? { authenticationType: 'spnKey', serviceprincipalkey: null } : {}),
        ...(resourceGroup ? { scope: `/subscriptions/00000000-0000-4000-8000-0000000000aa/resourcegroups/${resourceGroup}` } : {}),
      },
    },
    serviceEndpointProjectReferences: projects.map((p) => ({ projectReference: { id: p.id, name: p.name }, name })),
  };
}

const COMMERCE = { id: 'p-commerce', name: 'Commerce' };
const PLATFORM = { id: 'p-platform', name: 'Platform' };
const MOBILE = { id: 'p-mobile', name: 'Mobile' };

/** One demo project's settings, as the REST calls of azdo/provider.js readSecuritySettings answer them. */
export function demoSecuritySettings(p, org) {
  const project = { id: p.id, name: p.name, description: `${p.name} product area`, state: 'wellFormed', revision: 7, visibility: p.name === 'Mobile' ? 'public' : 'private', lastUpdateTime: at };
  const repoRaw = (r) => ({ id: r.id, name: r.name, project: { id: p.id, name: p.name }, defaultBranch: ref(r.defaultBranch), size: 48_213, isDisabled: false, webUrl: r.webUrl, remoteUrl: `${org}/${p.name}/_git/${r.name}` });
  const repos = p.repoObjs.map(repoRaw);
  const repo = (name) => p.repoObjs.find((r) => r.name === name);
  const definition = (id, name, repoName, variables = {}, variableGroups = []) => {
    const r = repo(repoName);
    return {
      id, name, path: '\\', type: 'build', queueStatus: 'enabled', revision: 4, project: { id: p.id, name: p.name },
      repository: { id: r.id, type: 'TfsGit', name: r.name, defaultBranch: ref(r.defaultBranch) },
      process: { type: 2, yamlFilename: 'azure-pipelines.yml' }, variables, variableGroups,
      _links: { web: { href: `${org}/${p.name}/_build/definition?definitionId=${id}` } },
    };
  };
  const hosted = { id: 1, projectId: p.id, name: 'Azure Pipelines', pool: { id: 9, name: 'Azure Pipelines', isHosted: true, poolType: 'automation' } };

  if (p.name === COMMERCE.name) {
    const groups = [
      { id: 11, name: 'checkout-settings', type: 'Vsts', description: 'Checkout API configuration', isShared: false, createdBy: by, modifiedOn: at,
        variables: { ApiBaseUrl: { value: 'https://api.contoso-demo.com' }, PaymentsApiKey: { value: FAKE_PAYMENTS, isSecret: false }, StripeWebhookSecret: { value: null, isSecret: true } } },
      { id: 12, name: 'commerce-keyvault', type: 'AzureKeyVault', description: 'Secrets from kv-commerce', isShared: false, createdBy: by, modifiedOn: at,
        providerData: { serviceEndpointId: 'se-commerce-staging', vault: 'kv-commerce' },
        variables: { 'sql-password': { value: null, isSecret: true, enabled: true } } },
    ];
    const files = [{ id: 'sf-signing', name: 'storefront-signing.pfx', createdBy: by, createdOn: at, modifiedOn: at, properties: {} }];
    const endpoints = [
      azureRm({ id: 'se-commerce-prod', name: 'commerce-prod', scheme: 'ServicePrincipal', subscription: 'Contoso Production', projects: [COMMERCE, PLATFORM] }),
      azureRm({ id: 'se-commerce-staging', name: 'commerce-staging', scheme: 'WorkloadIdentityFederation', subscription: 'Contoso Staging', resourceGroup: 'rg-commerce-staging', projects: [COMMERCE] }),
      { id: 'se-npm', name: 'npm-registry', type: 'npm', url: 'https://registry.npmjs.org/', owner: 'Library', isShared: false, isReady: true, createdBy: by,
        authorization: { scheme: 'Token', parameters: { apitoken: null } }, data: {}, serviceEndpointProjectReferences: [{ projectReference: COMMERCE, name: 'npm-registry' }] },
    ];
    const ids = Object.fromEntries(p.repoObjs.map((r) => [r.name, r.id]));
    return {
      org, project,
      definitions: [
        definition(101, 'storefront-web-CI', 'storefront-web', { NODE_ENV: { value: 'production' }, NPM_TOKEN: { value: FAKE_NPM, isSecret: false, allowOverride: false } }),
        definition(102, 'checkout-api-CI', 'checkout-api', { DB_PASSWORD: { value: null, isSecret: true }, TokenLifetime: { value: '3600' } }, [{ id: 11, name: 'checkout-settings' }]),
        definition(103, 'payments-service-CI', 'payments-service', { BuildConfiguration: { value: 'Release' } }, [{ id: 12, name: 'commerce-keyvault' }]),
      ],
      variableGroups: groups,
      secureFiles: files,
      endpoints,
      permissions: [
        allowAll('endpoint', 'se-commerce-prod'),
        someOnly('endpoint', 'se-commerce-staging', [102, 103]),
        someOnly('endpoint', 'se-npm', [101]),
        allowAll('variablegroup', 11),
        someOnly('variablegroup', 12, [103]),
        someOnly('securefile', 'sf-signing', [101]),
      ],
      repos,
      policies: [
        reviewers(1, ids['storefront-web'], 'main', 2), buildValidation(2, ids['storefront-web'], 'main', 101),
        reviewers(3, ids['checkout-api'], 'main', 1, true), buildValidation(4, ids['checkout-api'], 'main', 102),
        buildValidation(5, ids['payments-service'], 'main', 103),
        reviewers(6, ids['catalog-service'], 'main', 2),
      ],
      queues: [hosted, { id: 2, projectId: p.id, name: 'Commerce Build', pool: { id: 12, name: 'Commerce Build', isHosted: false, poolType: 'automation' } }],
      agents: { 12: [agent(1, 'commerce-build-01', '3.248.0'), agent(2, 'commerce-build-02', '3.212.0')] },
      gaps: [],
    };
  }

  if (p.name === PLATFORM.name) {
    const ids = Object.fromEntries(p.repoObjs.map((r) => [r.name, r.id]));
    return {
      org, project,
      definitions: [
        definition(201, 'identity-service-CI', 'identity-service', { ASPNETCORE_ENVIRONMENT: { value: 'Production' } }),
        definition(202, 'infra-terraform-plan', 'infra-terraform', { ARM_CLIENT_SECRET: { value: null, isSecret: true }, TF_STATE_KEY_NAME: { value: 'platform.tfstate' } }),
      ],
      variableGroups: [
        { id: 21, name: 'platform-shared', type: 'Vsts', isShared: false, createdBy: by, modifiedOn: at,
          variables: { Region: { value: 'westeurope' }, SmtpPassword: { value: FAKE_SMTP, isSecret: false } } },
      ],
      secureFiles: [{ id: 'sf-kubeconfig', name: 'aks-admin.kubeconfig', createdBy: by, createdOn: at, modifiedOn: at, properties: {} }],
      endpoints: [
        azureRm({ id: 'se-commerce-prod', name: 'commerce-prod', scheme: 'ServicePrincipal', subscription: 'Contoso Production', projects: [COMMERCE, PLATFORM] }),
        azureRm({ id: 'se-platform-infra', name: 'platform-infra', scheme: 'WorkloadIdentityFederation', subscription: 'Contoso Platform', projects: [PLATFORM], role: 'Owner' }),
      ],
      permissions: [
        allowAll('endpoint', 'se-commerce-prod'),
        someOnly('endpoint', 'se-platform-infra', [202]),
        someOnly('variablegroup', 21, [201]),
        allowAll('securefile', 'sf-kubeconfig'),
      ],
      repos,
      policies: [
        reviewers(11, ids['identity-service'], 'main', 2), buildValidation(12, ids['identity-service'], 'main', 201),
        reviewers(13, ids['api-gateway'], 'main', 2), buildValidation(14, ids['api-gateway'], 'main', 201),
        // One policy for every repository's default branch, as an organization often sets it.
        policy(15, POLICY.minReviewers, { minimumApproverCount: 1, creatorVoteCounts: false, scope: [{ repositoryId: null, refName: ref('main'), matchKind: 'Exact' }] }),
        buildValidation(16, ids['shared-libs'], 'main', 201),
      ],
      queues: [hosted, { id: 3, projectId: p.id, name: 'Commerce Build', pool: { id: 12, name: 'Commerce Build', isHosted: false, poolType: 'automation' } }],
      agents: { 12: [agent(1, 'commerce-build-01', '3.248.0'), agent(2, 'commerce-build-02', '3.212.0')] },
      gaps: [],
    };
  }

  // Mobile: public (an open-source app: the review says so unless settings name it as meant to be), and otherwise in good order.
  const ids = Object.fromEntries(p.repoObjs.map((r) => [r.name, r.id]));
  return {
    org, project,
    definitions: [definition(301, 'mobile-app-CI', 'mobile-app', { FASTLANE_PASSWORD: { value: null, isSecret: true } })],
    variableGroups: [{ id: 31, name: 'mobile-keyvault', type: 'AzureKeyVault', isShared: false, createdBy: by, modifiedOn: at, providerData: { vault: 'kv-mobile' }, variables: { 'apple-api-key': { value: null, isSecret: true } } }],
    secureFiles: [],
    endpoints: [azureRm({ id: 'se-mobile', name: 'mobile-backend', scheme: 'WorkloadIdentityFederation', subscription: 'Contoso Mobile', resourceGroup: 'rg-mobile', projects: [MOBILE] })],
    permissions: [someOnly('endpoint', 'se-mobile', [301]), someOnly('variablegroup', 31, [301])],
    repos,
    policies: Object.values(ids).flatMap((id, i) => [reviewers(30 + i * 2, id, 'main', 2), buildValidation(31 + i * 2, id, 'main', 301)]),
    queues: [hosted],
    agents: {},
    gaps: [],
  };
}
