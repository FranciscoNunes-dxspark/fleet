// The demo's answer to the posture check: its resources as Resource Graph gives them (ARM's JSON),
// made from the demo's apps, storage accounts, SQL servers and Cosmos DB account, plus a resource group
// of old, insecure ones only the check sees (contoso-legacy: a VM with RDP open, an NSG open on every
// port, a vault without soft delete, Redis on its plain port, a registry anyone can pull from, a SQL
// server open to every address), and Defender for Cloud's assessments. Production is mostly sound;
// dev and legacy are not.

const rg = (sub, group) => `/subscriptions/${sub}/resourceGroups/${group}`;

// The demo apps' security settings, by name: what ARM and config/web say of them.
const SITES = {
  'contoso-web': { httpsOnly: true, identity: 'SystemAssigned', config: { minTlsVersion: '1.2', ftpsState: 'FtpsOnly', remoteDebuggingEnabled: false } },
  'contoso-web/staging': { httpsOnly: true, identity: 'SystemAssigned', config: { minTlsVersion: '1.2', ftpsState: 'FtpsOnly', remoteDebuggingEnabled: true, remoteDebuggingVersion: 'VS2022' } },
  'contoso-api': { httpsOnly: true, identity: 'SystemAssigned', config: { minTlsVersion: '1.2', ftpsState: 'Disabled', remoteDebuggingEnabled: false } },
  'contoso-api/staging': { httpsOnly: true, identity: 'SystemAssigned', config: { minTlsVersion: '1.2', ftpsState: 'Disabled', remoteDebuggingEnabled: false } },
  'contoso-orders': { httpsOnly: false, identity: null, config: { minTlsVersion: '1.2', ftpsState: 'AllAllowed', remoteDebuggingEnabled: false } },
  'contoso-web-dev': { httpsOnly: false, identity: null, config: { minTlsVersion: '1.0', ftpsState: 'AllAllowed', remoteDebuggingEnabled: false } },
  'contoso-jobs-dev': { httpsOnly: true, identity: 'SystemAssigned', config: { minTlsVersion: '1.2', ftpsState: 'FtpsOnly', remoteDebuggingEnabled: false } },
};

// The storage accounts': production locked down, dev open with a public container.
const STORAGE = {
  contosoprodstore: { allowBlobPublicAccess: false, supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_2', allowSharedKeyAccess: false, publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Deny', ipRules: [{ value: '203.0.113.0/24', action: 'Allow' }] } },
  contosodevstore: { allowBlobPublicAccess: true, supportsHttpsTrafficOnly: true, minimumTlsVersion: 'TLS1_0', publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow', ipRules: [] } },
};
const CONTAINERS = { contosodevstore: [{ name: 'public-assets', publicAccess: 'Blob' }, { name: 'uploads', publicAccess: 'None' }] };

// SQL servers' auditing, by name (Enabled when not here).
const AUDITING = { 'contoso-sql-qa': 'Disabled', 'contoso-sql-legacy': 'Disabled' };

const rule = (name, priority, port, source = 'Internet', access = 'Allow', protocol = 'Tcp') => ({ name, properties: { priority, direction: 'Inbound', access, protocol, sourceAddressPrefix: source, sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: port } });
const DEFAULT_RULES = [
  { name: 'AllowVnetInBound', properties: { priority: 65000, direction: 'Inbound', access: 'Allow', protocol: '*', sourceAddressPrefix: 'VirtualNetwork', destinationPortRange: '*' } },
  { name: 'AllowAzureLoadBalancerInBound', properties: { priority: 65001, direction: 'Inbound', access: 'Allow', protocol: '*', sourceAddressPrefix: 'AzureLoadBalancer', destinationPortRange: '*' } },
  { name: 'DenyAllInBound', properties: { priority: 65500, direction: 'Inbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', destinationPortRange: '*' } },
];

/** contoso-legacy's resources, in production's subscription, and its SQL server (whose firewall the demo answers for too). */
function legacy() {
  const base = rg('sub-prod', 'contoso-legacy');
  const net = `${base}/providers/Microsoft.Network`;
  const subnet = `${net}/virtualNetworks/legacy-vnet/subnets/default`;
  const at = (type, name, properties, more = {}) => ({ id: `${base}/providers/${type}/${name}`, name, type: type.toLowerCase(), location: 'westeurope', resourceGroup: 'contoso-legacy', properties, ...more });
  const resources = [
    at('Microsoft.Network/networkSecurityGroups', 'legacy-vm-nsg', { securityRules: [rule('AllowRDP', 300, '3389'), rule('AllowSqlFromAnywhere', 310, '1433', '*'), rule('AllowHttpsFromOffice', 320, '443', '203.0.113.0/24')], defaultSecurityRules: DEFAULT_RULES, subnets: [{ id: subnet }] }),
    at('Microsoft.Network/networkSecurityGroups', 'legacy-open-nsg', { securityRules: [rule('AllowAnyInbound', 100, '*', '*', 'Allow', '*')], defaultSecurityRules: DEFAULT_RULES }),
    at('Microsoft.Network/networkSecurityGroups', 'contoso-app-nsg', { securityRules: [rule('AllowHttps', 100, '443'), rule('DenySsh', 110, '22', '*', 'Deny')], defaultSecurityRules: DEFAULT_RULES }),
    at('Microsoft.Network/publicIPAddresses', 'legacy-vm-ip', { ipAddress: '20.50.60.70', publicIPAllocationMethod: 'Static' }, { sku: { name: 'Standard' } }),
    at('Microsoft.Network/networkInterfaces', 'legacy-vm-nic', { ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: subnet }, publicIPAddress: { id: `${net}/publicIPAddresses/legacy-vm-ip` } } }] }),
    at('Microsoft.Compute/virtualMachines', 'legacy-vm', { hardwareProfile: { vmSize: 'Standard_B2s' }, networkProfile: { networkInterfaces: [{ id: `${net}/networkInterfaces/legacy-vm-nic` }] }, securityProfile: {} }),
    at('Microsoft.KeyVault/vaults', 'contoso-legacy-kv', { enableSoftDelete: false, enablePurgeProtection: false, enableRbacAuthorization: false, publicNetworkAccess: 'Enabled', networkAcls: { defaultAction: 'Allow' } }),
    at('Microsoft.Cache/Redis', 'contoso-legacy-cache', { enableNonSslPort: true, minimumTlsVersion: '1.0', sku: { name: 'Standard' } }),
    at('Microsoft.ContainerRegistry/registries', 'contosolegacycr', { adminUserEnabled: true, anonymousPullEnabled: true }, { sku: { name: 'Standard' } }),
    at('Microsoft.Sql/servers', 'contoso-sql-legacy', { publicNetworkAccess: 'Enabled', privateEndpointConnections: [], fullyQualifiedDomainName: 'contoso-sql-legacy.database.windows.net' }),
  ].map((r) => ({ sub: 'sub-prod', ...r }));
  const prod = rg('sub-prod', 'contoso-prod');
  // Production's own vault and registry, as they should be.
  resources.push(
    { sub: 'sub-prod', id: `${prod}/providers/Microsoft.KeyVault/vaults/contoso-kv`, name: 'contoso-kv', type: 'microsoft.keyvault/vaults', resourceGroup: 'contoso-prod', location: 'westeurope', properties: { enableSoftDelete: true, enablePurgeProtection: true, enableRbacAuthorization: true, publicNetworkAccess: 'Disabled', networkAcls: { defaultAction: 'Deny' } } },
    { sub: 'sub-prod', id: `${prod}/providers/Microsoft.ContainerRegistry/registries/contosocr`, name: 'contosocr', type: 'microsoft.containerregistry/registries', resourceGroup: 'contoso-prod', location: 'westeurope', sku: { name: 'Premium' }, properties: { adminUserEnabled: false, anonymousPullEnabled: false } },
  );
  const sqlRules = { 'contoso-sql-legacy': [{ name: 'AllowAll', start: '0.0.0.0', end: '255.255.255.255' }] };
  const assessments = [
    {
      sub: 'sub-prod',
      id: `${base}/providers/Microsoft.Compute/virtualMachines/legacy-vm/providers/Microsoft.Security/assessments/1195afff-c881-495e-9bc5-1486211ae03f`,
      name: '1195afff-c881-495e-9bc5-1486211ae03f',
      type: 'microsoft.security/assessments',
      resourceGroup: 'contoso-legacy',
      properties: { displayName: 'Machines should have vulnerability findings resolved', status: { code: 'Unhealthy', description: '3 vulnerabilities found' }, resourceDetails: { Id: `${base}/providers/Microsoft.Compute/virtualMachines/legacy-vm` }, metadata: { severity: 'High', description: 'Vulnerability findings on the machine should be fixed.', remediationDescription: 'Apply the updates the vulnerability assessment lists.' } },
    },
    {
      sub: 'sub-prod',
      id: `${prod}/providers/Microsoft.Web/sites/contoso-orders/providers/Microsoft.Security/assessments/ae7ac0a5-55a2-4e5d-9d9c-3ec6ba1fbc0d`,
      name: 'ae7ac0a5-55a2-4e5d-9d9c-3ec6ba1fbc0d',
      type: 'microsoft.security/assessments',
      resourceGroup: 'contoso-prod',
      properties: { displayName: 'Function apps should only be accessible over HTTPS', status: { code: 'Unhealthy' }, resourceDetails: { Id: `${prod}/providers/Microsoft.Web/sites/contoso-orders` }, metadata: { severity: 'Medium' } },
    },
  ];
  return { resources, sqlRules, assessments };
}

/** The demo's state for the check: { resources (ARM's JSON, each with `sub`), assessments, containers, auditing, sqlRules }. */
export function postureState(state) {
  const extra = legacy();
  const sites = state.sites.map((s) => {
    const key = s.slot ? `${s.name}/${s.slot}` : s.name;
    const sec = SITES[key] ?? { httpsOnly: true, identity: null, config: {} };
    return {
      sub: s.sub,
      id: s.id,
      name: key,
      type: s.slot ? 'microsoft.web/sites/slots' : 'microsoft.web/sites',
      kind: s.kind === 'function' ? 'functionapp,linux' : 'app,linux',
      location: s.location,
      resourceGroup: s.resourceGroup,
      ...(sec.identity ? { identity: { type: sec.identity } } : {}),
      properties: { httpsOnly: sec.httpsOnly, state: s.state, defaultHostName: s.host },
      config: sec.config,
    };
  });
  const storage = state.storage.map((a) => ({ sub: a.sub, id: a.id, name: a.name, type: 'microsoft.storage/storageaccounts', kind: a.kind, location: a.location, resourceGroup: a.resourceGroup, sku: { name: a.sku }, properties: { ...(STORAGE[a.name] ?? {}) } }));
  const sql = state.sqlServers.map((x) => ({ sub: x.sub, id: x.id, name: x.name, type: 'microsoft.sql/servers', location: x.location, resourceGroup: x.resourceGroup, properties: { publicNetworkAccess: x.publicAccess, privateEndpointConnections: [], fullyQualifiedDomainName: x.fqdn, ...(x.admin ? { administrators: { login: x.admin.login, azureADOnlyAuthentication: x.admin.only } } : {}) } }));
  const cosmos = state.cosmos.map((c) => ({ sub: c.sub, id: c.id, name: c.name, type: 'microsoft.documentdb/databaseaccounts', location: c.location, resourceGroup: c.resourceGroup, properties: { publicNetworkAccess: 'Enabled', ipRules: [], isVirtualNetworkFilterEnabled: false, disableLocalAuth: !/keys/.test(c.localAuth ?? '') } }));
  return { resources: [...sites, ...storage, ...sql, ...cosmos, ...extra.resources], assessments: extra.assessments, containers: CONTAINERS, auditing: AUDITING, sqlRules: extra.sqlRules };
}

/**
 * What Resource Graph would answer the demo for `query`: the check's own queries (`type in~ (…)`,
 * `resourceGroup =~ '…'`, and Defender's securityresources), anything else an error saying so.
 */
export function demoGraph(posture, sub, query) {
  const q = String(query).replace(/\s+/g, ' ');
  const group = /resourceGroup =~ '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
  const inGroup = (r) => !group || r.resourceGroup.toLowerCase() === group.toLowerCase();
  const strip = ({ sub: _, config: __, ...r }) => structuredClone(r);
  if (/^securityresources\b.*microsoft\.security\/assessments/.test(q)) return posture.assessments.filter((a) => a.sub === sub && inGroup(a) && a.properties.status.code === 'Unhealthy').map(strip);
  const types = /type in~ \(([^)]*)\)/.exec(q)?.[1];
  if (!/^resources\b/.test(q) || !types) throw new Error(`Asking Resource Graph: the demo answers the posture check's queries, not "${q.slice(0, 60)}"`);
  const wanted = new Set([...types.matchAll(/'([^']+)'/g)].map((m) => m[1].toLowerCase()));
  return posture.resources.filter((r) => r.sub === sub && wanted.has(r.type.toLowerCase()) && inGroup(r)).map(strip);
}
