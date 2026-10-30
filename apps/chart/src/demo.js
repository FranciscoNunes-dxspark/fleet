// An in-memory infrastructure with the provider's interface, for `chart --demo` and the tests: a
// Terraform folder whose plan changes, replaces and deletes Azure resources (and found one changed in
// the portal), its state, and a Bicep file's what-if. Nothing is run. `calls` is the tests' handle:
// what was asked of it.
import { parseTerraformPlan, parseTerraformState, parseWhatIf } from './plan.js';

const RG = '/subscriptions/0000/resourceGroups/shop-prod';
const rc = (address, type, name, actions, before, after, extra = {}) => ({ address, type, name, mode: 'managed', provider_name: 'registry.terraform.io/hashicorp/azurerm', change: { actions, before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {}, ...extra.change }, ...extra.rc });

const app = (name, settings, tags = { env: 'prod' }) => ({ id: `${RG}/providers/Microsoft.Web/sites/${name}`, name, resource_group_name: 'shop-prod', location: 'westeurope', https_only: true, site_config: [{ always_on: false, minimum_tls_version: '1.2' }], app_settings: settings, connection_string: [{ name: 'Db', value: 'Server=tcp:shop.database.windows.net;Password=hunter2' }], tags });

export const DEMO_PLAN = {
  format_version: '1.2',
  terraform_version: '1.9.8',
  resource_changes: [
    rc('azurerm_resource_group.main', 'azurerm_resource_group', 'main', ['no-op'], { id: RG, name: 'shop-prod', location: 'westeurope' }, { id: RG, name: 'shop-prod', location: 'westeurope' }),
    rc('azurerm_service_plan.main', 'azurerm_service_plan', 'main', ['update'], { id: `${RG}/providers/Microsoft.Web/serverFarms/shop-plan`, name: 'shop-plan', resource_group_name: 'shop-prod', sku_name: 'B1', worker_count: 1 }, { id: `${RG}/providers/Microsoft.Web/serverFarms/shop-plan`, name: 'shop-plan', resource_group_name: 'shop-prod', sku_name: 'P1v3', worker_count: 2 }),
    rc('azurerm_linux_web_app.api', 'azurerm_linux_web_app', 'api', ['update'], app('shop-api', { FEATURE_REFUNDS: 'false', LOG_LEVEL: 'info' }), { ...app('shop-api', { FEATURE_REFUNDS: 'true', LOG_LEVEL: 'info' }), site_config: [{ always_on: true, minimum_tls_version: '1.2' }] }, { change: { before_sensitive: { connection_string: [{ value: true }] }, after_sensitive: { connection_string: [{ value: true }] } } }),
    rc('azurerm_linux_web_app.admin', 'azurerm_linux_web_app', 'admin', ['delete', 'create'], app('shop-admin', {}), { ...app('shop-admin-v2', {}), id: undefined }, { change: { after_unknown: { id: true }, replace_paths: [['name']], before_sensitive: { connection_string: [{ value: true }] }, after_sensitive: { connection_string: [{ value: true }] } }, rc: { action_reason: 'replace_because_cannot_update' } }),
    rc('azurerm_mssql_database.reports', 'azurerm_mssql_database', 'reports', ['delete'], { id: `${RG}/providers/Microsoft.Sql/servers/shop/databases/reports`, name: 'reports', sku_name: 'S0', max_size_gb: 250 }, null, { rc: { action_reason: 'delete_because_no_resource_config' } }),
    rc('azurerm_key_vault_secret.db', 'azurerm_key_vault_secret', 'db', ['create'], null, { name: 'db-password', value: 'correct horse battery staple', key_vault_id: `${RG}/providers/Microsoft.KeyVault/vaults/shop-kv` }, { change: { after_unknown: { id: true, version: true }, after_sensitive: { value: true } } }),
    rc('azurerm_application_insights.main', 'azurerm_application_insights', 'main', ['create'], null, { name: 'shop-insights', resource_group_name: 'shop-prod', application_type: 'web', retention_in_days: 90 }, { change: { after_unknown: { id: true, connection_string: true, instrumentation_key: true } } }),
    rc('random_password.db', 'random_password', 'db', ['no-op'], { length: 24 }, { length: 24 }),
  ],
  resource_drift: [
    rc('azurerm_linux_web_app.api', 'azurerm_linux_web_app', 'api', ['update'], app('shop-api', { FEATURE_REFUNDS: 'false', LOG_LEVEL: 'info' }), app('shop-api', { FEATURE_REFUNDS: 'false', LOG_LEVEL: 'debug' }, { env: 'prod', owner: 'ana' }), { change: { before_sensitive: { connection_string: [{ value: true }] }, after_sensitive: { connection_string: [{ value: true }] } } }),
  ],
  output_changes: {
    api_url: { actions: ['no-op'], before: 'https://shop-api.azurewebsites.net', after: 'https://shop-api.azurewebsites.net' },
    insights_connection: { actions: ['create'], before: null, after: null, after_unknown: true, sensitive: true },
  },
};

export const DEMO_STATE = {
  format_version: '1.0',
  terraform_version: '1.9.8',
  values: {
    root_module: {
      resources: [
        { address: 'azurerm_resource_group.main', mode: 'managed', type: 'azurerm_resource_group', name: 'main', provider_name: 'registry.terraform.io/hashicorp/azurerm', values: { id: RG, name: 'shop-prod', location: 'westeurope' }, sensitive_values: {} },
        { address: 'azurerm_linux_web_app.api', mode: 'managed', type: 'azurerm_linux_web_app', name: 'api', provider_name: 'registry.terraform.io/hashicorp/azurerm', values: app('shop-api', { FEATURE_REFUNDS: 'false', LOG_LEVEL: 'info' }), sensitive_values: { connection_string: [{ value: true }] } },
        { address: 'random_password.db', mode: 'managed', type: 'random_password', name: 'db', provider_name: 'registry.terraform.io/hashicorp/random', values: { length: 24, result: 'x' }, sensitive_values: { result: true } },
      ],
      child_modules: [
        { address: 'module.network', resources: [{ address: 'module.network.azurerm_virtual_network.main', mode: 'managed', type: 'azurerm_virtual_network', name: 'main', provider_name: 'registry.terraform.io/hashicorp/azurerm', values: { name: 'shop-vnet', address_space: ['10.0.0.0/16'] }, sensitive_values: {} }] },
      ],
    },
  },
};

const site = (name) => `${RG}/providers/Microsoft.Web/sites/${name}`;
export const DEMO_WHAT_IF = {
  status: 'Succeeded',
  changes: [
    { resourceId: site('shop-api'), changeType: 'Modify', delta: [{ path: 'properties.siteConfig', propertyChangeType: 'Modify', children: [{ path: 'alwaysOn', propertyChangeType: 'Modify', before: false, after: true }] }, { path: 'properties.httpsOnly', propertyChangeType: 'NoEffect', before: true, after: true }] },
    { resourceId: `${RG}/providers/Microsoft.Storage/storageAccounts/shopfiles`, changeType: 'Create', after: { name: 'shopfiles', kind: 'StorageV2', sku: { name: 'Standard_LRS' } } },
    { resourceId: `${RG}/providers/Microsoft.Insights/components/shop-insights`, changeType: 'NoChange' },
    { resourceId: `${RG}/providers/Microsoft.Cache/Redis/shop-cache`, changeType: 'Delete', before: { name: 'shop-cache', sku: { name: 'Basic' } } },
  ],
};

const LOCATIONS = { 'azurerm_linux_web_app.api': { path: 'app.tf', line: 12 }, 'azurerm_linux_web_app.admin': { path: 'app.tf', line: 40 }, 'azurerm_service_plan.main': { path: 'main.tf', line: 8 }, 'azurerm_mssql_database.reports': { path: 'db.tf', line: 20 } };

export function demoChart() {
  const calls = [];
  return {
    name: 'demo',
    calls,
    async detect(dir) {
      calls.push(['detect', dir]);
      return { dir, tfDirs: ['.', 'modules/network'], bicep: ['bicep/main.bicep'], params: ['bicep/main.prod.bicepparam'], saved: [] };
    },
    async plan(dir, { bin = 'terraform', refreshOnly = false } = {}) {
      calls.push(['plan', dir, bin, refreshOnly]);
      const plan = parseTerraformPlan(DEMO_PLAN);
      return refreshOnly ? { ...plan, changes: [] } : plan;
    },
    async state(dir, { bin = 'terraform' } = {}) {
      calls.push(['state', dir, bin]);
      return parseTerraformState(DEMO_STATE);
    },
    async init(dir, { bin = 'terraform' } = {}) {
      calls.push(['init', dir, bin]);
      return { stdout: 'Terraform has been successfully initialized!', stderr: '' };
    },
    async whatIf(dir, opts = {}) {
      calls.push(['whatIf', dir, opts]);
      return parseWhatIf(DEMO_WHAT_IF);
    },
    async readFile(path) {
      calls.push(['readFile', path]);
      return { kind: 'plan', ...parseTerraformPlan(DEMO_PLAN) };
    },
    async locate(dir, change) {
      return LOCATIONS[change.address] ?? null;
    },
  };
}
