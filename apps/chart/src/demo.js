// An in-memory infrastructure with the provider's interface, for `chart --demo` and the tests: a
// Terraform folder whose plan changes, replaces and deletes Azure resources (and found one changed in
// the portal), its state, and a Bicep file's what-if. Nothing is run. `calls` is the tests' handle:
// what was asked of it.
import { parseTerraformPlan, parseTerraformState, parseWhatIf } from './plan.js';
import { explain } from './iac.js';

const RG = '/subscriptions/0000/resourceGroups/shop-prod';
const rc = (address, type, name, actions, before, after, extra = {}) => ({ address, type, name, mode: 'managed', provider_name: 'registry.terraform.io/hashicorp/azurerm', change: { actions, before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {}, ...extra.change }, ...extra.rc });

const app = (name, settings, tags = { env: 'prod' }) => ({ id: `${RG}/providers/Microsoft.Web/sites/${name}`, name, resource_group_name: 'shop-prod', location: 'westeurope', https_only: true, site_config: [{ always_on: false, minimum_tls_version: '1.2' }], app_settings: settings, connection_string: [{ name: 'Db', value: 'Server=tcp:shop.database.windows.net;Password=hunter2' }], tags });

export const DEMO_PLAN = {
  format_version: '1.2',
  terraform_version: '1.9.8',
  resource_changes: [
    rc('azurerm_resource_group.main', 'azurerm_resource_group', 'main', ['no-op'], { id: RG, name: 'shop-prod', location: 'westeurope' }, { id: RG, name: 'shop-prod', location: 'westeurope' }),
    rc('azurerm_service_plan.main', 'azurerm_service_plan', 'main', ['update'], { id: `${RG}/providers/Microsoft.Web/serverFarms/shop-plan`, name: 'shop-plan', resource_group_name: 'shop-prod', os_type: 'Linux', sku_name: 'B1', worker_count: 1 }, { id: `${RG}/providers/Microsoft.Web/serverFarms/shop-plan`, name: 'shop-plan', resource_group_name: 'shop-prod', os_type: 'Linux', sku_name: 'P1v3', worker_count: 2 }),
    rc('azurerm_linux_web_app.api', 'azurerm_linux_web_app', 'api', ['update'], app('shop-api', { FEATURE_REFUNDS: 'false', LOG_LEVEL: 'info' }), { ...app('shop-api', { FEATURE_REFUNDS: 'true', LOG_LEVEL: 'info' }), site_config: [{ always_on: true, minimum_tls_version: '1.2' }] }, { change: { before_sensitive: { connection_string: [{ value: true }] }, after_sensitive: { connection_string: [{ value: true }] } } }),
    rc('azurerm_linux_web_app.admin', 'azurerm_linux_web_app', 'admin', ['delete', 'create'], app('shop-admin', {}), { ...app('shop-admin-v2', {}), id: undefined }, { change: { after_unknown: { id: true }, replace_paths: [['name']], before_sensitive: { connection_string: [{ value: true }] }, after_sensitive: { connection_string: [{ value: true }] } }, rc: { action_reason: 'replace_because_cannot_update' } }),
    rc('azurerm_mssql_database.reports', 'azurerm_mssql_database', 'reports', ['delete'], { id: `${RG}/providers/Microsoft.Sql/servers/shop/databases/reports`, name: 'reports', server_id: `${RG}/providers/Microsoft.Sql/servers/shop`, sku_name: 'S0', max_size_gb: 250 }, null, { rc: { action_reason: 'delete_because_no_resource_config' } }),
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
    { resourceId: `${RG}/providers/Microsoft.Cache/Redis/shop-cache`, changeType: 'Delete', before: { name: 'shop-cache', location: 'westeurope', properties: { sku: { name: 'Standard', family: 'C', capacity: 1 } } } },
  ],
};

// A few of the Retail Prices API's items for West Europe, shaped as it gives them (the figures are made up).
const price = (serviceName, productName, skuName, meterName, retailPrice, unitOfMeasure = '1 Hour', extra = {}) => ({ serviceName, productName, skuName, meterName, retailPrice, unitOfMeasure, armRegionName: 'westeurope', armSkuName: '', type: 'Consumption', isPrimaryMeterRegion: true, ...extra });
export const DEMO_PRICES = [
  price('Azure App Service', 'Azure App Service Basic Plan - Linux', 'B1', 'B1 App', 0.018),
  price('Azure App Service', 'Azure App Service Basic Plan', 'B1', 'B1 App', 0.075),
  price('Azure App Service', 'Azure App Service Premium v3 Plan - Linux', 'P1 v3', 'P1 v3 App', 0.169),
  price('Azure App Service', 'Azure App Service Premium v3 Plan', 'P1 v3', 'P1 v3 App', 0.3),
  price('SQL Database', 'SQL Database Single Standard', 'S0', 'S0 DTUs', 0.4839, '1/Day'),
  price('SQL Database', 'SQL Database Single Standard', 'S1', 'S1 DTUs', 0.9677, '1/Day'),
  price('Redis Cache', 'Azure Redis Cache Standard', 'C1', 'C1 Cache Instance', 0.135),
  price('Redis Cache', 'Azure Redis Cache Basic', 'C1', 'C1 Cache Instance', 0.054),
  price('Virtual Machines', 'Virtual Machines DSv3 Series', 'D2s v3', 'D2s v3', 0.096, '1 Hour', { armSkuName: 'Standard_D2s_v3' }),
  price('Virtual Machines', 'Virtual Machines DSv3 Series', 'D2s v3 Spot', 'D2s v3 Spot', 0.019, '1 Hour', { armSkuName: 'Standard_D2s_v3' }),
  price('Virtual Machines', 'Virtual Machines DSv3 Series Windows', 'D2s v3', 'D2s v3', 0.188, '1 Hour', { armSkuName: 'Standard_D2s_v3' }),
];

const LOCATIONS = { 'azurerm_linux_web_app.api': { path: 'app.tf', line: 12 }, 'azurerm_linux_web_app.admin': { path: 'app.tf', line: 40 }, 'azurerm_service_plan.main': { path: 'main.tf', line: 8 }, 'azurerm_mssql_database.reports': { path: 'db.tf', line: 20 } };

export function demoChart() {
  const calls = [];
  // The plan files it "saved", which apply takes, as the real provider's.
  const saved = new Set();
  let plans = 0;
  const demo = {
    name: 'demo',
    calls,
    failApply: null,
    async detect(dir) {
      calls.push(['detect', dir]);
      return { dir, tfDirs: ['.', 'modules/network'], bicep: ['bicep/main.bicep'], params: ['bicep/main.prod.bicepparam'], saved: [] };
    },
    async plan(dir, { bin = 'terraform', refreshOnly = false, workspace, varFile, keep = false } = {}) {
      // An environment's workspace and var file only when it gives them, so a plain plan's call stays short.
      calls.push(['plan', dir, bin, refreshOnly, ...(workspace || varFile ? [{ workspace, varFile }] : [])]);
      const plan = parseTerraformPlan(DEMO_PLAN);
      if (refreshOnly) return { ...plan, changes: [] };
      if (!keep) return plan;
      const planFile = `demo-plans/chart-${++plans}.tfplan`;
      saved.add(planFile);
      return { ...plan, planFile };
    },
    discard(planFile) {
      calls.push(['discard', planFile]);
      saved.delete(planFile);
    },
    cleanup() {
      calls.push(['cleanup']);
      saved.clear();
    },
    async workspace(dir, { workspace } = {}) {
      return workspace ?? 'default';
    },
    /** As the real one: only a plan it saved, its output line by line; `failApply` (the tests') makes it fail as Terraform would. */
    async apply(dir, { bin = 'terraform', planFile, workspace, onLine = () => {} } = {}) {
      calls.push(['apply', dir, { bin, planFile, workspace }]);
      if (!saved.has(planFile)) throw new Error('Chart applies only a plan it saved itself: /plan, then /apply.');
      saved.delete(planFile);
      if (demo.failApply) throw explain(new Error(demo.failApply), bin);
      const lines = ['azurerm_mssql_database.reports: Destroying...', 'azurerm_mssql_database.reports: Destruction complete after 12s', 'Apply complete! Resources: 2 added, 3 changed, 2 destroyed.'];
      for (const l of lines) onLine(l);
      return { stdout: lines.join('\n'), stderr: '' };
    },
    async state(dir, { bin = 'terraform', workspace } = {}) {
      calls.push(['state', dir, bin, ...(workspace ? [{ workspace }] : [])]);
      return parseTerraformState(DEMO_STATE);
    },
    async init(dir, { bin = 'terraform' } = {}) {
      calls.push(['init', dir, bin]);
      return { stdout: 'Terraform has been successfully initialized!', stderr: '' };
    },
    /** The made-up price list's items for `query`, as the Retail Prices API's (iac.js's priceFilter fields), in USD or a rough EUR. */
    async prices(query, { currency = 'USD' } = {}) {
      calls.push(['prices', query, currency]);
      const rate = currency === 'EUR' ? 0.92 : 1;
      return DEMO_PRICES.filter((i) => Object.entries(query).every(([k, v]) => i[k] === v)).map((i) => ({ ...i, currencyCode: currency, retailPrice: Math.round(i.retailPrice * rate * 10000) / 10000 }));
    },
    async whatIf(dir, opts = {}) {
      calls.push(['whatIf', dir, opts]);
      return parseWhatIf(DEMO_WHAT_IF);
    },
    async deploy(dir, opts = {}) {
      calls.push(['deploy', dir, opts]);
      return { name: 'main', state: 'Succeeded', outputs: ['cacheHost'] };
    },
    async readFile(path) {
      calls.push(['readFile', path]);
      return { kind: 'plan', ...parseTerraformPlan(DEMO_PLAN) };
    },
    async locate(dir, change) {
      return LOCATIONS[change.address] ?? null;
    },
  };
  return demo;
}
