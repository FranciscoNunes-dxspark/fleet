// The posture check: each judge over resources as Resource Graph gives them (sound and not), how an NSG
// decides for a port, VMs linked to their NSGs, Defender's assessments, the whole check over the demo,
// `sonar security` and /posture on screen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { allowsFromAnywhere, decidingRule, openRules, portRanges } from '../src/posture/nsg.js';
import { arg, defenderFindings, exposedVms, judgeCosmos, judgeKeyVault, judgeNsg, judgeRedis, judgeRegistry, judgeResource, judgeSite, judgeSqlServer, judgeStorage, judgeVm, tlsBelow12 } from '../src/posture/rules.js';
import { FAMILIES, defenderQuery, familyQuery, postureCheck } from '../src/posture/check.js';
import { parseArgs, runHeadless } from '../src/headless.js';
import { demoAzure } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const RG = '/subscriptions/s1/resourceGroups/shop';
const rules = (list) => list.map((f) => f.rule).sort();
const one = (list, rule) => list.find((f) => f.rule === rule);

// --- Storage ---

const account = (properties) => ({ id: `${RG}/providers/Microsoft.Storage/storageAccounts/shopstore`, name: 'shopstore', type: 'microsoft.storage/storageaccounts', kind: 'StorageV2', resourceGroup: 'shop', sku: { name: 'Standard_LRS' }, properties });

test('storage: a locked-down account has nothing; an open one each of its rules, with the property and its fix', () => {
  const good = account({ allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2', allowSharedKeyAccess: false, publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Deny', ipRules: [{ value: '203.0.113.0/24' }] } });
  assert.deepEqual(judgeStorage(good), []);
  // Public network access off says enough without rules.
  assert.deepEqual(judgeStorage(account({ ...good.properties, publicNetworkAccess: 'Disabled', networkAcls: { defaultAction: 'Allow' } })), []);

  const bad = account({ allowBlobPublicAccess: true, supportsHttpsTrafficOnly: false, minimumTlsVersion: 'TLS1_0', publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow', ipRules: [] } });
  const found = judgeStorage(bad, { containers: [{ name: 'images', publicAccess: 'Blob' }, { name: 'private', publicAccess: 'None' }, { name: 'dump', properties: { publicAccess: 'Container' } }] });
  assert.deepEqual(rules(found), ['storage-http-allowed', 'storage-old-tls', 'storage-open-network', 'storage-public-blob', 'storage-public-container', 'storage-public-container', 'storage-shared-key']);
  const blob = one(found, 'storage-public-blob');
  assert.equal(blob.severity, 'high');
  assert.equal(blob.where, bad.id);
  assert.equal(blob.name, 'shopstore');
  assert.equal(blob.resourceGroup, 'shop');
  assert.equal(blob.excerpt, 'allowBlobPublicAccess: true');
  assert.equal(blob.fix, 'az storage account update -n shopstore -g shop --allow-blob-public-access false');
  const containers = found.filter((f) => f.rule === 'storage-public-container');
  assert.deepEqual(containers.map((f) => f.where), [`${bad.id}/blobServices/default/containers/images`, `${bad.id}/blobServices/default/containers/dump`]);
  assert.match(containers[0].fix, /az storage container set-permission -n images --account-name shopstore --public-access off/);
  assert.equal(one(found, 'storage-old-tls').severity, 'medium');
  assert.equal(one(found, 'storage-open-network').severity, 'low');
  // A container's own setting is moot while the account forbids public access.
  assert.equal(judgeStorage(good, { containers: [{ name: 'images', publicAccess: 'Blob' }] }).length, 0);
});

test('tls: below 1.2 in each way Azure writes it', () => {
  for (const v of ['TLS1_0', 'TLS1_1', '1.0', '1.1', 'Tls11']) assert.equal(tlsBelow12(v), true, v);
  for (const v of ['TLS1_2', '1.2', '1.3', 'TLS1_3', '', null, 'whatever']) assert.equal(tlsBelow12(v), false, String(v));
});

// --- NSGs ---

const rule = (name, priority, port, { source = 'Internet', access = 'Allow', protocol = 'Tcp', direction = 'Inbound', sources } = {}) => ({ name, properties: { priority, direction, access, protocol, ...(sources ? { sourceAddressPrefixes: sources } : { sourceAddressPrefix: source }), sourcePortRange: '*', ...(Array.isArray(port) ? { destinationPortRanges: port } : { destinationPortRange: port }) } });
const nsg = (name, securityRules, extra = {}) => ({ id: `${RG}/providers/Microsoft.Network/networkSecurityGroups/${name}`, name, type: 'Microsoft.Network/networkSecurityGroups', resourceGroup: 'shop', properties: { securityRules, ...extra } });

test('nsg: ports and ranges as written', () => {
  assert.deepEqual(portRanges(rule('a', 100, '*')), [[0, 65535]]);
  assert.deepEqual(portRanges(rule('a', 100, '20-25')), [[20, 25]]);
  assert.deepEqual(portRanges(rule('a', 100, ['22', '3389', '8000-8100'])), [[22, 22], [3389, 3389], [8000, 8100]]);
});

test('nsg: the first matching rule decides, by priority; a deny above an allow shadows it', () => {
  const g = nsg('web-nsg', [rule('AllowSsh', 200, '22'), rule('DenySsh', 100, '22', { access: 'Deny', source: '*' })]);
  assert.equal(decidingRule(g, 22).name, 'DenySsh');
  assert.equal(allowsFromAnywhere(g, 22), false);
  assert.deepEqual(judgeNsg(g), []);
  // With no rule for a port, Azure's last default denies it.
  assert.equal(allowsFromAnywhere(nsg('empty', []), 3389), false);
  // A rule from a narrower source doesn't open it to everyone; UDP doesn't count for these TCP ports.
  assert.deepEqual(judgeNsg(nsg('office', [rule('Office', 100, '3389', { source: '203.0.113.0/24' }), rule('Dns', 110, '22', { protocol: 'Udp' })])), []);
  // Outbound rules are not about what comes in.
  assert.deepEqual(judgeNsg(nsg('out', [rule('Out', 100, '*', { source: '*', direction: 'Outbound' })])), []);
});

test('nsg: SSH and RDP, database ports, and every port open to the internet, each with the rule and its fix', () => {
  const g = nsg('legacy-nsg', [rule('AllowAdmin', 100, ['22', '3389'], { sources: ['10.0.0.0/8', '0.0.0.0/0'] }), rule('AllowDb', 110, '1433-1433', { source: '*' }), rule('AllowRedis', 120, '6379'), rule('AllowHttps', 130, '443')]);
  const found = judgeNsg(g);
  assert.deepEqual(rules(found), ['nsg-open-admin', 'nsg-open-database', 'nsg-open-database']);
  const admin = one(found, 'nsg-open-admin');
  assert.equal(admin.severity, 'high');
  assert.match(admin.title, /^SSH and RDP open to the internet \(AllowAdmin\)$/);
  assert.equal(admin.where, `${g.id}/securityRules/AllowAdmin`);
  assert.equal(admin.resourceId, g.id);
  assert.match(admin.fix, /^az network nsg rule update -g shop --nsg-name legacy-nsg -n AllowAdmin --source-address-prefixes/);
  assert.match(admin.excerpt, /from 10\.0\.0\.0\/8, 0\.0\.0\.0\/0 to port 22, 3389/);
  assert.deepEqual(found.filter((f) => f.rule === 'nsg-open-database').map((f) => f.title), ['SQL Server open to the internet (AllowDb)', 'Redis open to the internet (AllowRedis)']);

  const all = judgeNsg(nsg('open', [rule('AllowAny', 100, '*', { source: '*', protocol: '*' })]));
  assert.deepEqual(rules(all), ['nsg-open-all']);
  assert.equal(all[0].severity, 'critical');
  // Every port from anywhere, but only after a deny of everything: nothing gets through it.
  assert.deepEqual(judgeNsg(nsg('shadowed', [rule('DenyAll', 100, '*', { source: '*', access: 'Deny', protocol: '*' }), rule('AllowAny', 200, '*', { source: '*' })])), []);
  assert.equal(openRules(nsg('shadowed', [rule('DenyAll', 100, '*', { source: '*', access: 'Deny' }), rule('AllowAny', 200, '*', { source: '*' })])).length, 0);
});

// --- VMs ---

test('vm: a public address through NSGs that let RDP in is exposed, named with the NSG; a closed one or no address is not', () => {
  const subnet = `${RG}/providers/Microsoft.Network/virtualNetworks/vnet/subnets/default`;
  const ip = { id: `${RG}/providers/Microsoft.Network/publicIPAddresses/vm-ip`, name: 'vm-ip', type: 'microsoft.network/publicipaddresses', sku: { name: 'Standard' }, properties: { ipAddress: '20.1.2.3' } };
  const nic = (name, extra = {}) => ({ id: `${RG}/providers/Microsoft.Network/networkInterfaces/${name}`, name, type: 'microsoft.network/networkinterfaces', resourceGroup: 'shop', properties: { ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: subnet }, ...(extra.ip ? { publicIPAddress: { id: extra.ip.id } } : {}) } }], ...(extra.nsg ? { networkSecurityGroup: { id: extra.nsg.id } } : {}) } });
  const vm = (name, nicId, enc) => ({ id: `${RG}/providers/Microsoft.Compute/virtualMachines/${name}`, name, type: 'microsoft.compute/virtualmachines', resourceGroup: 'shop', properties: { networkProfile: { networkInterfaces: [{ id: nicId }] }, securityProfile: enc == null ? {} : { encryptionAtHost: enc } } });
  const subnetNsg = nsg('subnet-nsg', [rule('AllowRdp', 100, '3389')], { subnets: [{ id: subnet }] });
  const exposedNic = nic('vm1-nic', { ip });
  const found = exposedVms({ vms: [vm('vm1', exposedNic.id)], nics: [exposedNic], nsgs: [subnetNsg], publicIps: [ip] });
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'vm-exposed-admin');
  assert.equal(found[0].severity, 'high');
  assert.equal(found[0].title, 'RDP reachable from the internet at 20.1.2.3');
  assert.match(found[0].fix, /subnet-nsg/);
  // The interface's own NSG denies it: both have to let it through.
  const nicNsg = nsg('nic-nsg', []);
  const guarded = nic('vm1-nic', { ip, nsg: nicNsg });
  assert.deepEqual(exposedVms({ vms: [vm('vm1', guarded.id)], nics: [guarded], nsgs: [subnetNsg, nicNsg], publicIps: [ip] }), []);
  // No public address: nothing to reach.
  const inner = nic('vm2-nic');
  assert.deepEqual(exposedVms({ vms: [vm('vm2', inner.id)], nics: [inner], nsgs: [subnetNsg], publicIps: [] }), []);
  // A Basic address with no NSG anywhere lets everything in; a Standard one denies by default.
  const lone = { ...nic('vm3-nic', { ip }), properties: { ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: `${subnet}2` }, publicIPAddress: { id: ip.id } } }] } };
  assert.deepEqual(exposedVms({ vms: [vm('vm3', lone.id)], nics: [lone], nsgs: [], publicIps: [ip] }), []);
  assert.equal(exposedVms({ vms: [vm('vm3', lone.id)], nics: [lone], nsgs: [], publicIps: [{ ...ip, sku: { name: 'Basic' } }] })[0].rule, 'vm-public-no-nsg');
  // Encryption at host.
  assert.deepEqual(rules(judgeVm(vm('vm1', exposedNic.id))), ['vm-no-host-encryption']);
  assert.deepEqual(judgeVm(vm('vm1', exposedNic.id, true)), []);
});

// --- App Service ---

const app = ({ kind = 'app,linux', name = 'shop-web', slot = false, httpsOnly = true, identity = { type: 'SystemAssigned' }, siteConfig } = {}) => ({
  id: `${RG}/providers/Microsoft.Web/sites/${slot ? 'shop-web/slots/staging' : name}`,
  name: slot ? 'shop-web/staging' : name,
  type: slot ? 'microsoft.web/sites/slots' : 'microsoft.web/sites',
  kind,
  resourceGroup: 'shop',
  ...(identity ? { identity } : {}),
  properties: { httpsOnly, ...(siteConfig ? { siteConfig } : {}) },
});

test('app service: HTTPS only, TLS, FTP, remote debugging and identity; the site config judged only when read', () => {
  assert.deepEqual(judgeSite(app({ siteConfig: { minTlsVersion: '1.2', ftpsState: 'FtpsOnly', remoteDebuggingEnabled: false, clientCertEnabled: false } })), []);
  // Resource Graph's view alone: no site config, so nothing said of it.
  assert.deepEqual(judgeSite(app()), []);
  const found = judgeSite(app({ httpsOnly: false, identity: null, siteConfig: { minTlsVersion: '1.0', ftpsState: 'AllAllowed', remoteDebuggingEnabled: true } }));
  assert.deepEqual(rules(found), ['app-ftp-plain', 'app-http-allowed', 'app-no-identity', 'app-old-tls', 'app-remote-debugging']);
  assert.equal(one(found, 'app-http-allowed').severity, 'high');
  assert.equal(one(found, 'app-http-allowed').fix, 'az webapp update -n shop-web -g shop --https-only true');
  assert.equal(one(found, 'app-old-tls').fix, 'az webapp config set -n shop-web -g shop --min-tls-version 1.2');
  assert.equal(one(found, 'app-no-identity').severity, 'low');
  // A function app's commands are functionapp's; a slot's carry --slot.
  assert.equal(one(judgeSite(app({ kind: 'functionapp,linux', httpsOnly: false })), 'app-http-allowed').fix, 'az functionapp update -n shop-web -g shop --set httpsOnly=true');
  assert.equal(one(judgeSite(app({ slot: true, identity: null })), 'app-no-identity').fix, 'az webapp identity assign -n shop-web -g shop --slot staging');
  assert.equal(judgeResource(app({ slot: true, httpsOnly: false }))[0].rule, 'app-http-allowed');
});

// --- SQL ---

const server = (properties = {}) => ({ id: `${RG}/providers/Microsoft.Sql/servers/shop-sql`, name: 'shop-sql', type: 'microsoft.sql/servers', resourceGroup: 'shop', properties: { publicNetworkAccess: 'Enabled', privateEndpointConnections: [], administrators: { azureADOnlyAuthentication: false }, ...properties } });

test('sql: the open firewall, Azure services, public access, Entra-only and auditing', () => {
  const good = server({ publicNetworkAccess: 'Disabled', administrators: { azureADOnlyAuthentication: true } });
  assert.deepEqual(judgeSqlServer(good, { firewallRules: [{ name: 'office', start: '203.0.113.0', end: '203.0.113.255' }], auditing: { state: 'Enabled' } }), []);
  // Public, but behind a private endpoint, is fine.
  assert.deepEqual(judgeSqlServer(server({ privateEndpointConnections: [{ id: 'pe' }], administrators: { azureADOnlyAuthentication: true } })), []);
  const found = judgeSqlServer(server(), {
    firewallRules: [
      { name: 'AllowAll', properties: { startIpAddress: '0.0.0.0', endIpAddress: '255.255.255.255' } },
      { name: 'AllowAllWindowsAzureIps', start: '0.0.0.0', end: '0.0.0.0' },
    ],
    auditing: { state: 'Disabled' },
  });
  assert.deepEqual(rules(found), ['sql-auditing-off', 'sql-azure-services', 'sql-entra-only-off', 'sql-open-to-all', 'sql-public-no-private-endpoint']);
  const open = one(found, 'sql-open-to-all');
  assert.equal(open.severity, 'critical');
  assert.equal(open.where, `${server().id}/firewallRules/AllowAll`);
  assert.equal(open.fix, 'az sql server firewall-rule delete -g shop -s shop-sql -n AllowAll');
  assert.equal(one(found, 'sql-azure-services').severity, 'low');
  // Auditing not read: not judged. Entra-only from the admin when properties don't say.
  assert.equal(one(judgeSqlServer(server({ administrators: undefined }), { entraOnly: true }), 'sql-entra-only-off'), undefined);
  assert.equal(one(judgeSqlServer(server()), 'sql-auditing-off'), undefined);
});

// --- Key Vault, Redis, Cosmos DB, registries ---

const vault = (properties) => ({ id: `${RG}/providers/Microsoft.KeyVault/vaults/shop-kv`, name: 'shop-kv', type: 'Microsoft.KeyVault/vaults', resourceGroup: 'shop', properties });

test('key vault: soft delete, purge protection, network and RBAC', () => {
  assert.deepEqual(judgeKeyVault(vault({ enableSoftDelete: true, enablePurgeProtection: true, enableRbacAuthorization: true, publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Deny' } })), []);
  const found = judgeKeyVault(vault({ enableSoftDelete: false, enablePurgeProtection: null, publicNetworkAccess: 'Enabled' }));
  assert.deepEqual(rules(found), ['kv-access-policies', 'kv-no-purge-protection', 'kv-no-soft-delete', 'kv-open-network']);
  assert.equal(one(found, 'kv-no-soft-delete').severity, 'high');
  assert.equal(one(found, 'kv-no-purge-protection').severity, 'medium');
  assert.equal(one(found, 'kv-no-purge-protection').fix, 'az keyvault update -n shop-kv -g shop --enable-purge-protection true');
  // Soft delete is on unless it says otherwise (Azure no longer lets it be turned off).
  assert.equal(one(judgeKeyVault(vault({})), 'kv-no-soft-delete'), undefined);
});

test('redis, cosmos db and container registries', () => {
  const redis = (p) => ({ id: `${RG}/providers/Microsoft.Cache/Redis/shop-cache`, name: 'shop-cache', type: 'Microsoft.Cache/Redis', resourceGroup: 'shop', properties: p });
  assert.deepEqual(judgeRedis(redis({ enableNonSslPort: false, minimumTlsVersion: '1.2' })), []);
  const r = judgeRedis(redis({ enableNonSslPort: true, minimumTlsVersion: '1.0' }));
  assert.deepEqual(rules(r), ['redis-non-ssl-port', 'redis-old-tls']);
  assert.equal(one(r, 'redis-non-ssl-port').severity, 'high');
  assert.equal(one(r, 'redis-non-ssl-port').fix, 'az redis update -n shop-cache -g shop --set enableNonSslPort=false');

  const cosmos = (p) => ({ id: `${RG}/providers/Microsoft.DocumentDB/databaseAccounts/shop-db`, name: 'shop-db', type: 'microsoft.documentdb/databaseaccounts', resourceGroup: 'shop', properties: p });
  assert.deepEqual(judgeCosmos(cosmos({ publicNetworkAccess: 'Enabled', ipRules: [{ ipAddressOrRange: '203.0.113.0/24' }], disableLocalAuth: true })), []);
  assert.deepEqual(judgeCosmos(cosmos({ publicNetworkAccess: 'Enabled', isVirtualNetworkFilterEnabled: true, disableLocalAuth: true })), []);
  const c = judgeCosmos(cosmos({ publicNetworkAccess: 'Enabled', ipRules: [], disableLocalAuth: false }));
  assert.deepEqual(rules(c), ['cosmos-local-auth', 'cosmos-open-network']);
  assert.equal(one(c, 'cosmos-open-network').severity, 'medium');

  const acr = (p) => ({ id: `${RG}/providers/Microsoft.ContainerRegistry/registries/shopcr`, name: 'shopcr', type: 'microsoft.containerregistry/registries', resourceGroup: 'shop', properties: p });
  assert.deepEqual(judgeRegistry(acr({ adminUserEnabled: false, anonymousPullEnabled: false })), []);
  const a = judgeRegistry(acr({ adminUserEnabled: true, anonymousPullEnabled: true }));
  assert.deepEqual(a.map((f) => [f.rule, f.severity]), [['acr-anonymous-pull', 'high'], ['acr-admin-user', 'medium']]);
  assert.equal(one(a, 'acr-admin-user').fix, 'az acr update -n shopcr --admin-enabled false');
});

test('defender: unhealthy assessments as findings of kind defender about their resource; healthy ones left out', () => {
  const vmId = `${RG}/providers/Microsoft.Compute/virtualMachines/vm1`;
  const found = defenderFindings([
    { id: `${vmId}/providers/Microsoft.Security/assessments/abc`, name: 'abc', properties: { displayName: 'Machines should have vulnerability findings resolved', status: { code: 'Unhealthy' }, resourceDetails: { Id: vmId }, metadata: { severity: 'High', description: '<p>Fix them.</p>', remediationDescription: 'Apply the updates.' }, links: { azurePortal: 'portal.azure.com/#blade/x' } } },
    { id: `${vmId}/providers/Microsoft.Security/assessments/def`, name: 'def', properties: { displayName: 'Fine', status: { code: 'Healthy' }, metadata: { severity: 'Low' } } },
    { id: `${vmId}/providers/Microsoft.Security/assessments/ghi`, name: 'ghi', properties: { displayName: 'No details', status: { code: 'Unhealthy' } } },
  ]);
  assert.equal(found.length, 2);
  assert.deepEqual({ rule: found[0].rule, severity: found[0].severity, where: found[0].where, kind: found[0].kind, why: found[0].why, fix: found[0].fix, name: found[0].name }, { rule: 'defender-abc', severity: 'high', where: vmId, kind: 'defender', why: 'Fix them.', fix: 'Apply the updates.', name: 'vm1' });
  assert.equal(found[0].portal, 'https://portal.azure.com/#blade/x');
  // The resource from the assessment's own id when it doesn't say; no severity is unknown.
  assert.equal(found[1].where, vmId);
  assert.equal(found[1].severity, 'unknown');
});

test('names with spaces are quoted for the shell', () => {
  assert.equal(arg('shop-web'), 'shop-web');
  assert.equal(arg('My Group'), '"My Group"');
});

// --- The whole check ---

test('the queries: one per family, in a resource group when given, quotes escaped', () => {
  for (const f of FAMILIES) assert.match(familyQuery(f), new RegExp(`^resources \\| where type in~ \\(${f.types.map((t) => `'${t.replace(/[./]/g, '\\$&')}'`).join(', ')}\\)`));
  assert.match(familyQuery(FAMILIES[0], { resourceGroup: "o'brien" }), /\| where resourceGroup =~ 'o\\'brien' \|/);
  assert.match(defenderQuery(), /^securityresources \| where type == 'microsoft.security\/assessments' \| where properties.status.code =~ 'Unhealthy'/);
});

test('check: the demo subscription, its legacy group the worst, production sound where it should be', async () => {
  const provider = demoAzure();
  const result = await postureCheck(provider, 'sub-prod');
  assert.equal(result.defender, 'read');
  assert.deepEqual(result.skipped, []);
  assert.equal(result.read.network, 4);
  const by = (rule, name) => result.findings.find((f) => f.rule === rule && (!name || f.name === name));
  for (const [rule, name, severity] of [
    ['nsg-open-all', 'legacy-open-nsg', 'critical'],
    ['sql-open-to-all', 'contoso-sql-legacy', 'critical'],
    ['vm-exposed-admin', 'legacy-vm', 'high'],
    ['nsg-open-admin', 'legacy-vm-nsg', 'high'],
    ['nsg-open-database', 'legacy-vm-nsg', 'high'],
    ['kv-no-soft-delete', 'contoso-legacy-kv', 'high'],
    ['redis-non-ssl-port', 'contoso-legacy-cache', 'high'],
    ['acr-anonymous-pull', 'contosolegacycr', 'high'],
    ['app-http-allowed', 'contoso-orders', 'high'],
    ['app-remote-debugging', 'contoso-web/staging', 'medium'],
    ['sql-auditing-off', 'contoso-sql-qa', 'medium'],
    ['cosmos-open-network', 'contoso-cosmos', 'medium'],
  ]) {
    const f = by(rule, name);
    assert.ok(f, `${rule} on ${name}`);
    assert.equal(f.severity, severity, `${rule} on ${name}`);
  }
  assert.ok(result.findings.some((f) => f.kind === 'defender'), "Defender's assessments");
  // Production's vault, registry, storage account and main web app have nothing against them.
  for (const name of ['contoso-kv', 'contosocr', 'contosoprodstore', 'contoso-web']) assert.equal(result.findings.filter((f) => f.name === name && f.kind !== 'defender').length, 0, name);
  // The HTTPS-only NSG has nothing either.
  assert.equal(result.findings.filter((f) => f.name === 'contoso-app-nsg').length, 0);
  // Nothing was changed: every call was a read.
  assert.equal(provider.state.sqlServers.find((s) => s.name === 'contoso-sql-prod').rules.length, 2);

  const dev = await postureCheck(provider, 'sub-dev');
  assert.ok(dev.findings.some((f) => f.rule === 'storage-public-container' && f.name === 'contosodevstore/public-assets'));

  // One resource group only.
  const legacy = await postureCheck(provider, 'sub-prod', { resourceGroup: 'contoso-legacy' });
  assert.ok(legacy.findings.length > 5);
  assert.ok(legacy.findings.every((f) => f.resourceGroup === 'contoso-legacy'), legacy.findings.map((f) => f.resourceGroup).join(' '));
});

test("check: a family Resource Graph won't answer is skipped and said, Defender too; none answering is an error", async () => {
  const provider = demoAzure();
  const graph = provider.resourceGraph;
  provider.resourceGraph = async (sub, q, o) => {
    if (/keyvault|securityresources/.test(q)) throw new Error('you do not have access');
    return graph(sub, q, o);
  };
  const result = await postureCheck(provider, 'sub-prod');
  assert.deepEqual(result.skipped, [{ what: 'key vaults', why: 'you do not have access' }]);
  assert.equal(result.defender, 'you do not have access');
  assert.ok(!('keyvault' in result.read));
  assert.ok(result.findings.some((f) => f.rule === 'nsg-open-all'));
  provider.resourceGraph = async () => {
    throw new Error('run az login');
  };
  await assert.rejects(postureCheck(provider, 'sub-prod'), /run az login/);
});

// --- sonar security ---

test('sonar security: its arguments', () => {
  assert.deepEqual(parseArgs(['security']), { command: 'security', subscription: null, resourceGroup: null, failOn: 'high', json: false, sarif: false, ignore: [], defender: true });
  const o = parseArgs(['security', '--subscription', 'Contoso Production', '-g', 'shop', '--fail-on', 'MEDIUM', '--json', '--ignore', 'app-no-identity,kv-access-policies', '--no-defender']);
  assert.deepEqual([o.subscription, o.resourceGroup, o.failOn, o.json, o.ignore, o.defender, o.error], ['Contoso Production', 'shop', 'medium', true, ['app-no-identity', 'kv-access-policies'], false, undefined]);
  assert.match(parseArgs(['security', '--fail-on', 'bad']).error, /--fail-on/);
  assert.match(parseArgs(['security', '--resource-group']).error, /needs a value/);
  assert.match(parseArgs(['security', '--nope']).error, /Unknown option --nope/);
  assert.match(parseArgs(['security', '--json', '--sarif']).error, /not both/);
});

const headless = async (args, opts = {}) => {
  let out = '';
  const code = await runHeadless(args, { provider: demoAzure(), write: (s) => (out += s), now: new Date('2026-11-03T10:00:00Z'), ...opts });
  return { code, out };
};

test('sonar security: the JSON every app prints, its exit code by --fail-on, ignores, a resource group', async () => {
  const { code, out } = await headless(['security', '--json']);
  assert.equal(code, 1);
  const j = JSON.parse(out);
  assert.equal(j.app, 'sonar');
  assert.equal(j.check, 'posture');
  assert.equal(j.target, '/subscriptions/sub-prod');
  assert.equal(j.at, '2026-11-03T10:00:00.000Z');
  assert.deepEqual(j.subscription, { id: 'sub-prod', name: 'Contoso Production' });
  assert.equal(j.counts.critical, 2);
  assert.equal(j.defender, 'read');
  // Worst first, each with its resource and the property it saw.
  assert.equal(j.findings[0].severity, 'critical');
  assert.ok(j.findings.every((f) => f.where.startsWith('/subscriptions/sub-prod/') && f.title && f.rule));
  assert.ok(j.findings.find((f) => f.rule === 'storage-public-blob') == null);
  assert.equal(j.findings.find((f) => f.rule === 'redis-non-ssl-port').excerpt, 'enableNonSslPort: true');

  // The dev subscription, named, has nothing critical.
  assert.equal((await headless(['security', '--subscription', 'Contoso Dev', '--fail-on', 'critical'])).code, 0);
  assert.equal((await headless(['security', '--subscription', 'sub-dev', '--fail-on', 'high'])).code, 1);
  assert.equal((await headless(['security', '--fail-on', 'none'])).code, 0);

  // Ignored, from the config and the command line.
  const ignored = JSON.parse((await headless(['security', '--json', '--ignore', 'nsg-open-all'], { config: { postureIgnore: [`sql-open-to-all:/subscriptions/sub-prod/resourceGroups/contoso-legacy/providers/Microsoft.Sql/servers/contoso-sql-legacy/firewallRules/AllowAll`] } })).out);
  assert.equal(ignored.counts.critical, 0);
  assert.equal(ignored.ignored, 2);

  // A resource group.
  const prod = JSON.parse((await headless(['security', '--json', '--resource-group', 'contoso-prod'])).out);
  assert.equal(prod.target, '/subscriptions/sub-prod/resourceGroups/contoso-prod');
  assert.ok(prod.findings.every((f) => f.resourceGroup === 'contoso-prod'));
});

test('sonar security: text with each fix, SARIF, and 2 when it cannot run', async () => {
  const { code, out } = await headless(['security', '--subscription', 'sub-dev']);
  assert.equal(code, 1);
  assert.match(out, /^Contoso Dev: storage accounts 1 · web and function apps 2 · SQL servers 1\n/);
  assert.match(out, /HIGH Container public-assets is public {2}\/subscriptions\/sub-dev\/.*\/containers\/public-assets\n {5}az storage container set-permission/);
  assert.match(out, /\d+ high · \d+ medium · \d+ low · failing on high and above\n$/);

  const sarif = JSON.parse((await headless(['security', '--sarif'])).out);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].tool.driver.name, 'Sonar');
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'nsg-open-all' && r.level === 'error'));

  assert.equal((await headless(['security', '--subscription', 'nowhere'])).code, 2);
  const provider = demoAzure();
  provider.resourceGraph = async () => {
    throw new Error('Asking Resource Graph: the sign-in was refused. Try az login.');
  };
  const failed = await headless(['security'], { provider });
  assert.equal(failed.code, 2);
  assert.match(failed.out, /^sonar security: Asking Resource Graph: the sign-in was refused/);
  assert.equal((await headless(['security', '--bogus'])).code, 2);
});

// --- /posture on screen ---

test('/posture: the findings worst first, ↵ one whole with its fix, y copies it, x leaves it out', async () => {
  const copied = [];
  const app = start({ copy: (text) => copied.push(text) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders') && !frame().includes('reading…'), 'the subscription');
    await type(app.stdin, '/posture');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Security posture of Contoso Production:'), 'the posture list');
    assert.match(frame(), /2 critical · \d+ high/);
    const rows = frame().split('\n').filter((l) => /\b(CRIT|HIGH|MED|LOW)\b/.test(l));
    assert.match(rows[0], /CRIT/);
    assert.match(frame(), /legacy-open-nsg/);
    assert.match(frame(), /contoso-legacy/);
    app.stdin.write('y');
    await until(() => copied.length === 1, 'the fix copied');
    assert.match(copied[0], /^az (network nsg rule update|sql server firewall-rule delete)/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Fix (Sonar never runs it):'), 'the finding whole');
    assert.match(frame(), /seen/);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Security posture of Contoso Production:'), 'back to the list');
    app.stdin.write('x');
    await until(() => frame().includes('(1 left out)'), 'one left out');
    assert.match(frame(), /1 critical/);
  } finally {
    app.unmount();
  }
});
