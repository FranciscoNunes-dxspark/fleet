// bilge-ignore-file: these tests write insecure infrastructure, and passwords, on purpose.
// security.js: each rule on Terraform's after state and ARM's shape, good and bad; the source files
// read statically with path:line; a whole run over the demo; chart security headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeFor, judgeResource, knownValues, planFindings, folderFindings, sourceFindings, readTerraform, readBicep, mergeFindings } from '../src/security.js';
import { parseTerraformPlan, parseWhatIf } from '../src/plan.js';
import { DEMO_PLAN, DEMO_WHAT_IF, demoChart } from '../src/demo.js';
import { parseSecurityArgs, runSecurity, runHeadless } from '../src/headless.js';
import { markdownReport } from '../src/share.js';
import { KEYS, start, tempHome, until, type } from './helpers.js';

// A password for the tests, put together so this file doesn't hold one whole.
const PW = ['Tr0ub4', 'dor&', '3xyz'].join('');
const rules = (type, values) => judgeResource(type, values).map((h) => h.rule).sort();

test('every rule has a judge for both shapes where Azure has both; unknown types judge nothing', () => {
  assert.equal(judgeFor('azurerm_storage_account').dialect, 'tf');
  assert.equal(judgeFor('Microsoft.Storage/storageAccounts').dialect, 'arm');
  assert.equal(judgeFor('microsoft.web/sites').judge, judgeFor('azurerm_linux_web_app').judge, 'an azurerm type and its ARM type share one judge');
  assert.equal(judgeFor('azurerm_resource_group'), null);
  assert.deepEqual(judgeResource('azurerm_resource_group', { name: 'x' }), []);
  assert.deepEqual(judgeResource('azurerm_storage_account', null), []);
});

test('storage accounts: public blobs, plain HTTP, old TLS, every network', () => {
  assert.deepEqual(rules('azurerm_storage_account', { allow_nested_items_to_be_public: true, https_traffic_only_enabled: false, min_tls_version: 'TLS1_0', public_network_access_enabled: true, network_rules: [] }), ['storage-http', 'storage-old-tls', 'storage-public-blobs', 'storage-public-network']);
  assert.deepEqual(rules('azurerm_storage_account', { allow_nested_items_to_be_public: false, https_traffic_only_enabled: true, min_tls_version: 'TLS1_2', public_network_access_enabled: true, network_rules: [{ default_action: 'Deny' }] }), []);
  assert.deepEqual(rules('azurerm_storage_account', { public_network_access_enabled: false }), []);
  // Older provider versions' names.
  assert.deepEqual(rules('azurerm_storage_account', { allow_blob_public_access: true, enable_https_traffic_only: false }), ['storage-http', 'storage-public-blobs']);
  assert.deepEqual(rules('Microsoft.Storage/storageAccounts', { properties: { allowBlobPublicAccess: true, supportsHttpsTrafficOnly: false, minimumTlsVersion: 'TLS1_1', publicNetworkAccess: 'Enabled' } }), ['storage-http', 'storage-old-tls', 'storage-public-blobs', 'storage-public-network']);
  assert.deepEqual(rules('Microsoft.Storage/storageAccounts', { properties: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2', publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Deny' } } }), []);
  const [h] = judgeResource('azurerm_storage_account', { min_tls_version: 'TLS1_1' });
  assert.deepEqual(h, { rule: 'storage-old-tls', attribute: 'min_tls_version', excerpt: 'min_tls_version = "TLS1_1"' });
});

test('NSG rules: inbound Allow from anywhere to SSH, RDP and database ports is high, to every port critical; inline, standalone and ARM', () => {
  const rule = (extra) => ({ name: 'r', direction: 'Inbound', access: 'Allow', protocol: 'Tcp', source_address_prefix: '*', destination_port_range: '22', ...extra });
  assert.deepEqual(rules('azurerm_network_security_rule', rule()), ['nsg-open-ssh']);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ destination_port_range: '3389', source_address_prefix: 'Internet' })), ['nsg-open-rdp']);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ destination_port_range: '5432', source_address_prefix: '0.0.0.0/0' })), ['nsg-open-db']);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ destination_port_range: '*' })), ['nsg-open-all']);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ destination_port_range: null, destination_port_ranges: ['80', '1400-1500'] })), ['nsg-open-db']);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ destination_port_range: '20-25' })), ['nsg-open-ssh']);
  // Not from anywhere, not inbound, not allowed, not TCP, not an admin port: nothing.
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ source_address_prefix: '10.0.0.0/8' })), []);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ source_address_prefix: null, source_address_prefixes: ['10.1.0.0/16', '192.168.0.0/24'] })), []);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ direction: 'Outbound' })), []);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ access: 'Deny' })), []);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ protocol: 'Udp' })), []);
  assert.deepEqual(rules('azurerm_network_security_rule', rule({ destination_port_range: '443' })), []);
  // Inline, each rule on its own.
  const group = judgeResource('azurerm_network_security_group', { security_rule: [rule({ name: 'https', destination_port_range: '443' }), rule({ name: 'ssh' })] });
  assert.deepEqual(group, [{ rule: 'nsg-open-ssh', attribute: 'security_rule.1.source_address_prefix', excerpt: 'ssh: Inbound Allow from * to 22' }]);
  const arm = (p) => ({ name: 'r', properties: { direction: 'Inbound', access: 'Allow', protocol: '*', sourceAddressPrefix: 'Internet', destinationPortRange: '3389', ...p } });
  assert.deepEqual(rules('Microsoft.Network/networkSecurityGroups', { properties: { securityRules: [arm(), arm({ destinationPortRange: '443' })] } }), ['nsg-open-rdp']);
  assert.deepEqual(rules('Microsoft.Network/networkSecurityGroups/securityRules', arm({ destinationPortRange: '*' })), ['nsg-open-all']);
  assert.deepEqual(rules('Microsoft.Network/networkSecurityGroups/securityRules', arm({ sourceAddressPrefix: 'VirtualNetwork' })), []);
});

test('App Service and Function apps: plain HTTP, old TLS, FTP, remote debugging', () => {
  const bad = { https_only: false, site_config: [{ minimum_tls_version: '1.0', ftps_state: 'AllAllowed', remote_debugging_enabled: true }] };
  const all = ['app-ftp', 'app-http', 'app-old-tls', 'app-remote-debugging'];
  for (const type of ['azurerm_linux_web_app', 'azurerm_windows_web_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app', 'azurerm_linux_web_app_slot']) assert.deepEqual(rules(type, bad), all, type);
  assert.deepEqual(rules('azurerm_linux_web_app', { https_only: true, site_config: [{ minimum_tls_version: '1.2', ftps_state: 'FtpsOnly', remote_debugging_enabled: false }] }), []);
  assert.deepEqual(rules('Microsoft.Web/sites', { properties: { httpsOnly: false, siteConfig: { minTlsVersion: '1.1', ftpsState: 'AllAllowed', remoteDebuggingEnabled: true } } }), all);
  assert.deepEqual(rules('Microsoft.Web/sites/slots', { properties: { httpsOnly: true, siteConfig: { minTlsVersion: '1.2', ftpsState: 'Disabled' } } }), []);
});

test('SQL: a firewall rule open to every address is critical, public network access low', () => {
  assert.deepEqual(rules('azurerm_mssql_firewall_rule', { start_ip_address: '0.0.0.0', end_ip_address: '255.255.255.255' }), ['sql-firewall-open']);
  assert.deepEqual(rules('azurerm_postgresql_flexible_server_firewall_rule', { start_ip_address: '0.0.0.0', end_ip_address: '255.255.255.255' }), ['sql-firewall-open']);
  // 0.0.0.0–0.0.0.0 is Azure's "allow Azure services", not the internet.
  assert.deepEqual(rules('azurerm_mssql_firewall_rule', { start_ip_address: '0.0.0.0', end_ip_address: '0.0.0.0' }), []);
  assert.deepEqual(rules('Microsoft.Sql/servers/firewallRules', { properties: { startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' } }), ['sql-firewall-open']);
  assert.deepEqual(rules('Microsoft.Sql/servers/firewallRules', { properties: { startIpAddress: '10.0.0.1', endIpAddress: '10.0.0.9' } }), []);
  assert.deepEqual(rules('azurerm_mssql_server', { public_network_access_enabled: true }), ['sql-public-network']);
  assert.deepEqual(rules('azurerm_mssql_server', { public_network_access_enabled: false }), []);
  assert.deepEqual(rules('Microsoft.Sql/servers', { properties: { publicNetworkAccess: 'Enabled' } }), ['sql-public-network']);
  assert.deepEqual(rules('Microsoft.Sql/servers', { properties: { publicNetworkAccess: 'Disabled' } }), []);
});

test('Key Vault, Redis and container registries', () => {
  assert.deepEqual(rules('azurerm_key_vault', { purge_protection_enabled: false, network_acls: [{ default_action: 'Allow' }] }), ['kv-network-open', 'kv-no-purge-protection']);
  assert.deepEqual(rules('azurerm_key_vault', { purge_protection_enabled: true, network_acls: [{ default_action: 'Deny' }] }), []);
  assert.deepEqual(rules('azurerm_key_vault', { purge_protection_enabled: true, network_acls: [{ default_action: 'Allow' }], public_network_access_enabled: false }), []);
  // ARM leaves purge protection out when it's off.
  assert.deepEqual(rules('Microsoft.KeyVault/vaults', { properties: { networkAcls: { defaultAction: 'Allow' } } }), ['kv-network-open', 'kv-no-purge-protection']);
  assert.deepEqual(rules('Microsoft.KeyVault/vaults', { properties: { enablePurgeProtection: true } }), []);
  assert.deepEqual(rules('azurerm_redis_cache', { non_ssl_port_enabled: true, minimum_tls_version: '1.0' }), ['redis-non-ssl', 'redis-old-tls']);
  assert.deepEqual(rules('azurerm_redis_cache', { enable_non_ssl_port: false, minimum_tls_version: '1.2' }), []);
  assert.deepEqual(rules('Microsoft.Cache/Redis', { properties: { enableNonSslPort: true } }), ['redis-non-ssl']);
  assert.deepEqual(rules('azurerm_container_registry', { admin_enabled: true, anonymous_pull_enabled: true }), ['acr-admin', 'acr-anonymous-pull']);
  assert.deepEqual(rules('azurerm_container_registry', { admin_enabled: false, anonymous_pull_enabled: false }), []);
  assert.deepEqual(rules('Microsoft.ContainerRegistry/registries', { properties: { adminUserEnabled: true, anonymousPullEnabled: false } }), ['acr-admin']);
});

test('AWS: public S3 ACLs and access blocks, security groups open to the internet, public and unencrypted databases', () => {
  assert.deepEqual(rules('aws_s3_bucket_acl', { acl: 'public-read' }), ['s3-public-acl']);
  assert.deepEqual(rules('aws_s3_bucket', { acl: 'private' }), []);
  assert.deepEqual(rules('aws_s3_bucket_public_access_block', { block_public_acls: true, block_public_policy: false, ignore_public_acls: true, restrict_public_buckets: true }), ['s3-public-access-block']);
  assert.deepEqual(rules('aws_s3_bucket_public_access_block', { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }), []);
  const ingress = (p) => ({ from_port: 22, to_port: 22, protocol: 'tcp', cidr_blocks: ['0.0.0.0/0'], ...p });
  assert.deepEqual(rules('aws_security_group', { ingress: [ingress(), ingress({ from_port: 443, to_port: 443 })] }), ['sg-open-ssh']);
  assert.deepEqual(rules('aws_security_group', { ingress: [ingress({ from_port: 3389, to_port: 3389, cidr_blocks: [], ipv6_cidr_blocks: ['::/0'] })] }), ['sg-open-rdp']);
  assert.deepEqual(rules('aws_security_group', { ingress: [ingress({ protocol: '-1', from_port: 0, to_port: 0 })] }), ['sg-open-all']);
  assert.deepEqual(rules('aws_security_group', { ingress: [ingress({ cidr_blocks: ['10.0.0.0/8'] })] }), []);
  assert.deepEqual(rules('aws_security_group_rule', { type: 'ingress', ...ingress() }), ['sg-open-ssh']);
  assert.deepEqual(rules('aws_security_group_rule', { type: 'egress', ...ingress() }), []);
  assert.deepEqual(rules('aws_vpc_security_group_ingress_rule', { cidr_ipv4: '0.0.0.0/0', from_port: 3389, to_port: 3389, ip_protocol: 'tcp' }), ['sg-open-rdp']);
  assert.deepEqual(rules('aws_db_instance', { publicly_accessible: true, storage_encrypted: false }), ['rds-public', 'rds-unencrypted']);
  assert.deepEqual(rules('aws_db_instance', { publicly_accessible: false, storage_encrypted: true }), []);
  // A bucket with no access block pointing at it, by the plan's dependencies or by its name.
  const bucket = { address: 'aws_s3_bucket.logs', type: 'aws_s3_bucket', values: { bucket: 'logs' } };
  const block = { address: 'aws_s3_bucket_public_access_block.logs', type: 'aws_s3_bucket_public_access_block', values: { bucket: 'logs', block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true } };
  assert.deepEqual(planFindings([bucket]).map((f) => [f.rule, f.where]), [['s3-no-public-access-block', 'aws_s3_bucket.logs']]);
  assert.deepEqual(planFindings([bucket, block]), []);
  assert.deepEqual(planFindings([bucket, { ...block, values: { ...block.values, bucket: knownValues(null, null, true) } }], { dependsOn: { [block.address]: [bucket.address] } }), []);
});

test("what Terraform marks sensitive or known only after apply is never read, so no judge guesses and no excerpt holds it", () => {
  const values = knownValues({ https_only: false, site_config: [{ ftps_state: 'AllAllowed' }], app_settings: { KEY: 'x' } }, { https_only: true, app_settings: { KEY: true } }, { site_config: [{ ftps_state: true }] });
  assert.deepEqual(judgeResource('azurerm_linux_web_app', values), []);
  const plan = parseTerraformPlan(DEMO_PLAN);
  assert.ok(!JSON.stringify(plan.security).includes('correct horse'), 'a sensitive value never reaches a finding');
});

test("a plan's findings: Terraform's after state and a what-if's, by the resource's address; what's destroyed isn't judged", () => {
  const plan = parseTerraformPlan(DEMO_PLAN);
  assert.deepEqual(plan.security.map((f) => [f.severity, f.rule, f.where]).sort(), [
    ['critical', 'sql-firewall-open', 'azurerm_mssql_firewall_rule.everyone'],
    ['high', 'nsg-open-ssh', 'azurerm_network_security_group.web'],
    ['high', 'storage-public-blobs', 'azurerm_storage_account.uploads'],
    ['low', 'storage-public-network', 'azurerm_storage_account.uploads'],
    ['medium', 'storage-old-tls', 'azurerm_storage_account.uploads'],
  ]);
  const ssh = plan.security.find((f) => f.rule === 'nsg-open-ssh');
  assert.equal(ssh.excerpt, 'allow-ssh: Inbound Allow from * to 22');
  assert.match(ssh.fix, /source_address_prefix/);
  const whatIf = parseWhatIf(DEMO_WHAT_IF);
  assert.deepEqual(whatIf.security.map((f) => [f.rule, f.where]).sort(), [['storage-http', 'Microsoft.Storage/storageAccounts/shopfiles'], ['storage-public-blobs', 'Microsoft.Storage/storageAccounts/shopfiles']]);
  // A destroyed resource is no longer deployed.
  const gone = parseWhatIf({ changes: [{ resourceId: '/subscriptions/1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/old', changeType: 'Delete', before: { properties: { allowBlobPublicAccess: true } } }] });
  assert.deepEqual(gone.security, []);
});

test('Terraform source read statically: each resource\'s literal values, nested blocks as lists, expressions unknown; findings with path:line', () => {
  const tf = [
    '# a comment = "ignored"',
    'resource "azurerm_linux_web_app" "api" {',
    '  name       = "api"',
    '  https_only = false',
    '  app_settings = {',
    '    LOG = "info"',
    '  }',
    '  site_config {',
    '    ftps_state          = "AllAllowed"',
    '    minimum_tls_version = var.tls',
    '  }',
    '}',
    '',
    'resource "azurerm_storage_account" "ok" {',
    '  min_tls_version = "TLS1_2"',
    '  tags            = { env = "prod" }',
    '}',
  ].join('\n');
  const { resources } = readTerraform(tf);
  assert.deepEqual(resources.map((r) => [r.address, r.line]), [['azurerm_linux_web_app.api', 2], ['azurerm_storage_account.ok', 14]]);
  assert.equal(resources[0].values.site_config[0].ftps_state, 'AllAllowed');
  assert.equal(resources[0].values.app_settings.LOG, 'info');
  assert.equal(resources[0].values.site_config[0].minimum_tls_version.constructor.name, 'Unknown');
  const { findings } = sourceFindings('infra/app.tf', tf);
  assert.deepEqual(findings.map((f) => [f.rule, `${f.where}:${f.line}`, f.resource]), [
    ['app-http', 'infra/app.tf:4', 'azurerm_linux_web_app.api'],
    ['app-ftp', 'infra/app.tf:9', 'azurerm_linux_web_app.api'],
  ]);
  assert.equal(findings[0].excerpt, 'https_only = false');
  // A line saying chart-ignore (or the one above it) is left alone, as is a file saying so at the top.
  assert.equal(sourceFindings('a.tf', tf.replace('https_only = false', 'https_only = false # chart-ignore')).findings.length, 1);
  assert.equal(sourceFindings('a.tf', `# bilge-ignore-file\n${tf}`).findings.length, 0);
});

test('Bicep source: ARM-shaped values from properties, arrays of objects, @secure() parameters', () => {
  const bicep = [
    'param location string = resourceGroup().location',
    '@secure()',
    'param sqlPassword string',
    'param adminPassword string',
    `param apiKey string = '${PW}'`,
    '',
    "resource nsg 'Microsoft.Network/networkSecurityGroups@2023-04-01' = {",
    "  name: 'web'",
    '  location: location',
    '  properties: {',
    '    securityRules: [',
    '      {',
    "        name: 'rdp'",
    '        properties: {',
    "          direction: 'Inbound'",
    "          access: 'Allow'",
    "          protocol: 'Tcp'",
    "          sourceAddressPrefix: '*'",
    "          destinationPortRange: '3389'",
    '        }',
    '      }',
    '    ]',
    '  }',
    '}',
    "resource existingKv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {",
    "  name: 'kv'",
    '}',
    "resource sql 'Microsoft.Sql/servers@2023-05-01-preview' = {",
    "  name: 'sql'",
    '  properties: {',
    `    administratorLoginPassword: '${PW}'`,
    "    publicNetworkAccess: 'Enabled'",
    '  }',
    '}',
  ].join('\n');
  const read = readBicep(bicep);
  assert.deepEqual(read.resources.map((r) => [r.address, r.type, r.line]), [['nsg', 'Microsoft.Network/networkSecurityGroups', 7], ['sql', 'Microsoft.Sql/servers', 28]]);
  assert.deepEqual(read.params.map((p) => [p.name, p.secure]), [['location', false], ['sqlPassword', true], ['adminPassword', false], ['apiKey', false]]);
  const { findings } = sourceFindings('main.bicep', bicep);
  assert.deepEqual(findings.map((f) => [f.rule, f.severity, f.line, f.resource]), [
    ['nsg-open-rdp', 'high', 18, 'nsg'],
    ['sql-public-network', 'low', 32, 'sql'],
    ['bicep-insecure-param', 'medium', 4, 'param adminPassword'],
    ['iac-plain-password', 'high', 5, 'param apiKey'],
    ['iac-plain-password', 'high', 31, 'sql'],
  ]);
  for (const f of findings) assert.ok(!String(f.excerpt).includes(PW), 'a password never whole in an excerpt');
});

test('passwords in .tf, .tfvars and .bicepparam files, and the kit\'s secret rules; what only names a secret is left alone', () => {
  const tfvars = [`db_password = "${PW}"`, 'db_password_secret_name = "db-password"', 'admin_user = "shop"', 'api_token = ""', `storage_conn = "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${'A'.repeat(20)}${'b'.repeat(20)}=="`].join('\n');
  const { findings } = sourceFindings('env/prod.tfvars', tfvars);
  assert.deepEqual(findings.map((f) => [f.rule, f.line]), [['iac-plain-password', 1], ['azure-storage-key', 5]]);
  assert.equal(findings[0].excerpt, `db_password = "${PW.slice(0, 4)}••••••••"`);
  const tf = ['variable "admin_password" {', '  type    = string', `  default = "${PW}"`, '}', 'variable "admin_password_2" {', '  type      = string', '  sensitive = true', '}', 'resource "azurerm_mssql_server" "s" {', `  administrator_login_password = "${PW}"`, '  administrator_login_password_wo = var.admin_password', '}'].join('\n');
  assert.deepEqual(sourceFindings('db.tf', tf).findings.map((f) => [f.rule, f.line, f.resource]), [['iac-plain-password', 3, 'var.admin_password'], ['iac-plain-password', 10, 'azurerm_mssql_server.s']]);
  assert.deepEqual(sourceFindings('main.prod.bicepparam', `using './main.bicep'\nparam adminPassword = '${PW}'\nparam location = 'westeurope'`).findings.map((f) => [f.rule, f.line]), [['iac-plain-password', 2]]);
  // Only infrastructure files are read.
  assert.deepEqual(sourceFindings('README.md', `db_password = "${PW}"`).findings, []);
});

test('a folder: checks across files (an S3 bucket and its access block), sorted by file and line; merged with a plan\'s, the source\'s line kept', () => {
  const files = [
    { path: 'b.tf', text: 'resource "aws_s3_bucket" "logs" {\n  bucket = "logs"\n}\nresource "aws_s3_bucket" "site" {\n  bucket = "site"\n}\n' },
    { path: 'a.tf', text: 'resource "aws_s3_bucket_public_access_block" "logs" {\n  bucket                  = aws_s3_bucket.logs.id\n  block_public_acls       = true\n  block_public_policy     = true\n  ignore_public_acls      = true\n  restrict_public_buckets = false\n}\n' },
  ];
  const found = folderFindings(files);
  assert.deepEqual(found.map((f) => [f.rule, `${f.where}:${f.line}`, f.resource]), [
    ['s3-public-access-block', 'a.tf:6', 'aws_s3_bucket_public_access_block.logs'],
    ['s3-no-public-access-block', 'b.tf:4', 'aws_s3_bucket.site'],
  ]);
  const planned = [{ rule: 's3-no-public-access-block', resource: 'aws_s3_bucket.site', where: 'aws_s3_bucket.site' }, { rule: 'rds-public', resource: 'aws_db_instance.x', where: 'aws_db_instance.x' }];
  assert.deepEqual(mergeFindings(planned, found).map((f) => `${f.rule}:${f.where}`), ['s3-public-access-block:a.tf', 's3-no-public-access-block:b.tf', 'rds-public:aws_db_instance.x']);
});

test('chart security: a folder read without running anything, a plan file, --plan, --fail-on, --json, --sarif, ignores', async () => {
  const out = [];
  const write = (s) => out.push(s);
  const provider = demoChart();
  // The folder: its source files only; nothing is planned.
  assert.equal(await runSecurity(['security', '.'], { provider, write }), 1);
  assert.ok(!provider.calls.some((c) => c[0] === 'plan'), 'nothing is run');
  const text = out.join('');
  assert.match(text, /^Read 5 source files\nCRIT Database firewall open to every address {2}db\.tf:4\n/);
  assert.match(text, /HIGH Password written into the infrastructure code {2}env\/prod\.tfvars:2/);
  assert.match(text, /MED {2}Secret parameter without @secure\(\) {2}bicep\/main\.bicep:2/);
  assert.match(text, /1 critical · 5 high · 2 medium · failing on high and above\n$/);
  assert.ok(!text.includes('Adm1n2026'), 'the password is never printed whole');

  // --json: findings.js's shape, which Fleet adds up; no excerpts.
  out.length = 0;
  assert.equal(await runSecurity(['security', '--json', '--fail-on', 'none'], { provider, write }), 0);
  const json = JSON.parse(out.join(''));
  assert.equal(json.app, 'chart');
  assert.equal(json.check, 'iac');
  assert.deepEqual(json.counts, { critical: 1, high: 5, medium: 2, low: 0, unknown: 0 });
  assert.equal(json.files, 5);
  assert.deepEqual(Object.keys(json.findings[0]).sort(), ['attribute', 'fix', 'kind', 'line', 'resource', 'rule', 'severity', 'title', 'type', 'where', 'why']);

  // --plan: planned too, the plan's findings that a file already has left out.
  out.length = 0;
  assert.equal(await runSecurity(['security', '--plan', '--json', '--fail-on', 'critical'], { provider, write }), 1);
  const planned = JSON.parse(out.join(''));
  assert.ok(provider.calls.some((c) => c[0] === 'plan'));
  assert.equal(planned.resources, 10);
  assert.deepEqual(planned.findings.filter((f) => !f.line).map((f) => [f.rule, f.where]), [['storage-public-network', 'azurerm_storage_account.uploads']]);

  // A plan file (here this test file: the demo reads its own plan for any file) and --sarif to a file.
  out.length = 0;
  const files = {};
  const code = await runSecurity(['security', new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--sarif', 'out.sarif', '--fail-on', 'medium'], { provider, write, writeFile: (p, t) => (files[p] = t) });
  assert.equal(code, 1);
  const [path, sarifText] = Object.entries(files)[0];
  assert.match(path, /out\.sarif$/);
  const sarif = JSON.parse(sarifText);
  assert.equal(sarif.runs[0].tool.driver.name, 'Chart');
  assert.equal(sarif.runs[0].results.length, 5);
  assert.match(sarif.runs[0].results[0].message.text, /Database firewall open to every address \(azurerm_mssql_firewall_rule\.everyone\)/);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri, '.');
  assert.match(out.join(''), /^Read 10 resources the plan deploys; SARIF in .+out\.sarif\n/);

  // The settings' securityIgnore.
  out.length = 0;
  assert.equal(await runSecurity(['security', '--json'], { provider, write, config: { securityIgnore: ['sql-firewall-open', 'storage-public-blobs:storage.tf'] } }), 1);
  assert.deepEqual(JSON.parse(out.join('')).counts, { critical: 0, high: 4, medium: 2, low: 0, unknown: 0 });

  assert.equal(parseSecurityArgs(['security', '--fail-on', 'bad']).error, '--fail-on is one of critical, high, medium, low, none');
  assert.match(parseSecurityArgs(['security', '--json', '--sarif']).error, /both print/);
  assert.equal(parseSecurityArgs(['security', '--sarif', 'infra']).target, 'infra', '--sarif takes only a .sarif file');
  out.length = 0;
  assert.equal(await runSecurity(['security', '--nope'], { provider, write }), 2);
});

test('chart check and the report say what the plan would deploy insecurely', async () => {
  const out = [];
  await runHeadless(['check', '--no-costs'], { provider: demoChart(), write: (s) => out.push(s) });
  assert.match(out.join(''), /Security: 1 critical · 2 high · 1 medium · 1 low in what it deploys \(chart security lists them\)/);
  out.length = 0;
  await runHeadless(['check', '--json', '--no-costs'], { provider: demoChart(), write: (s) => out.push(s) });
  assert.deepEqual(JSON.parse(out.join('')).security, { critical: 1, high: 2, medium: 1, low: 1, unknown: 0 });
  const md = markdownReport(parseTerraformPlan(DEMO_PLAN), { label: 'infra', when: new Date(0) });
  assert.match(md, /## Security\n\n1 critical · 2 high · 1 medium · 1 low in what the plan would deploy\.\n\n\| Severity \| Resource \| Finding \| Fix \|/);
  assert.match(md, /\| critical \| `azurerm_mssql_firewall_rule\.everyone` \| Database firewall open to every address \(`start_ip_address = "0\.0\.0\.0", end_ip_address = "255\.255\.255\.255"`\) \|/);
});

test('the app: a ! column on what the plan would deploy insecurely, the Security view with the plan\'s and the files\' findings, ↵ detail', async (t) => {
  t.after(tempHome());
  const app = start();
  await until(() => app.lastFrame().includes('/plan asks terraform'), 'the hint');
  await type(app.stdin, '/plan');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('azurerm_storage_account.uploads'), 'the changes');
  let frame = app.lastFrame();
  assert.match(frame, /\+ azurerm_mssql_firewall_rule\.everyone +create .+! crit/);
  assert.match(frame, /\+ azurerm_storage_account\.uploads +create .+! high\+2/);
  assert.match(frame, /6 Security 5/);
  // The Security view reads the source files the first time it's shown.
  app.stdin.write('6');
  await until(() => app.lastFrame().includes('In the source files'), 'the source files read');
  frame = app.lastFrame();
  assert.ok(app.provider.calls.some((c) => c[0] === 'sources'));
  assert.match(frame, /What the plan would deploy {2}5/);
  assert.match(frame, /CRIT Database firewall open to every address +azurerm_mssql_firewall_rule/);
  assert.match(frame, /6 Security 13/);
  assert.ok(frame.indexOf('What the plan would deploy') < frame.indexOf('In the source files'));
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('Fix: Remove the rule'), 'the detail');
  frame = app.lastFrame();
  assert.match(frame, /Planned: +create/);
  assert.match(frame, /Declared: +db\.tf:1 \(t copies it for Splice\)/);
  assert.match(frame, /Seen: +start_ip_address = "0\.0\.0\.0", end_ip_address = "255\.255\.255\.255"/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Fix: Remove the rule'), 'the detail closed');
  app.stdin.write('y');
  await until(() => app.copied.length === 1, 'the copy');
  assert.equal(app.copied[0], 'azurerm_mssql_firewall_rule.everyone');
  app.unmount();
});
