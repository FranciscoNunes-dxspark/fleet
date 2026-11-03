// The posture check's rules: each kind of resource judged from its JSON as Azure Resource Manager gives
// it (and Resource Graph, which projects the same `properties`; and a Bicep what-if's `after`), into
// the kit's findings (findings.js): { rule, severity, title, where: the resource id, why, fix, excerpt:
// the property seen }, with the resource's `name`, `resourceGroup` and `resourceType` beside them for
// the screen. Pure: nothing here asks Azure; the fixes are az commands as text, never run.
import { ADMIN_PORTS, DATABASE_PORTS, allowsFromAnywhere, openRules, sourcesOf } from './nsg.js';

const lower = (s) => String(s ?? '').trim().toLowerCase();
const props = (r) => r?.properties ?? {};
const isTrue = (v) => v === true || lower(v) === 'true';
const isFalse = (v) => v === false || lower(v) === 'false';
const disabled = (v) => lower(v) === 'disabled';

/** The resource group in an Azure resource id. */
export const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(String(id ?? ''))?.[1] ?? '';

/** A name for a command line, quoted when it has anything a shell would split or read. */
export const arg = (s) => (/^[\w.@:/-]+$/.test(String(s)) ? String(s) : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`);

/** A TLS version (TLS1_0, 1.1, Tls12…) below 1.2; false when it says nothing that can be read. */
export function tlsBelow12(v) {
  const m = /(\d)\D?(\d)/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 10 + Number(m[2]) < 12 : false;
}

/** A finding about resource `r`. */
function finding(r, rule, severity, title, { why, fix, seen, where, name, kind } = {}) {
  return {
    rule,
    severity,
    title,
    where: where ?? r.id,
    ...(why ? { why } : {}),
    ...(fix ? { fix } : {}),
    ...(seen ? { excerpt: seen } : {}),
    ...(kind ? { kind } : {}),
    name: name ?? r.name,
    resourceId: r.id,
    resourceGroup: r.resourceGroup ?? groupOf(r.id),
    resourceType: lower(r.type),
  };
}

const rg = (r) => arg(r.resourceGroup ?? groupOf(r.id));

/** A storage account (Microsoft.Storage/storageAccounts); `containers` its blob containers, when listed. */
export function judgeStorage(r, { containers = [] } = {}) {
  const p = props(r);
  const out = [];
  const update = (flags) => `az storage account update -n ${arg(r.name)} -g ${rg(r)} ${flags}`;
  if (isTrue(p.allowBlobPublicAccess)) {
    out.push(finding(r, 'storage-public-blob', 'high', 'Blob public access allowed', { why: 'Any container in it can be made readable by anyone on the internet, without a sign-in.', fix: update('--allow-blob-public-access false'), seen: 'allowBlobPublicAccess: true' }));
    // A container's own setting counts only while the account allows it.
    for (const c of containers) {
      const access = props(c).publicAccess ?? c.publicAccess;
      if (!access || lower(access) === 'none') continue;
      out.push(
        finding(r, 'storage-public-container', 'high', `Container ${c.name} is public`, {
          where: `${r.id}/blobServices/default/containers/${c.name}`,
          name: `${r.name}/${c.name}`,
          why: access.toLowerCase() === 'container' ? 'Anyone can list and read its blobs.' : 'Anyone who knows a blob\'s address can read it.',
          fix: `az storage container set-permission -n ${arg(c.name)} --account-name ${arg(r.name)} --public-access off --auth-mode login`,
          seen: `publicAccess: ${access}`,
        }),
      );
    }
  }
  if (isFalse(p.supportsHttpsTrafficOnly)) out.push(finding(r, 'storage-http-allowed', 'high', 'Plain HTTP allowed', { why: 'Requests (and their keys or SAS tokens) can travel unencrypted.', fix: update('--https-only true'), seen: 'supportsHttpsTrafficOnly: false' }));
  if (p.minimumTlsVersion && tlsBelow12(p.minimumTlsVersion)) out.push(finding(r, 'storage-old-tls', 'medium', `TLS below 1.2 accepted (${p.minimumTlsVersion})`, { why: 'TLS 1.0 and 1.1 have known weaknesses and are being retired across Azure.', fix: update('--min-tls-version TLS1_2'), seen: `minimumTlsVersion: ${p.minimumTlsVersion}` }));
  if (!disabled(p.publicNetworkAccess) && lower(p.networkAcls?.defaultAction || 'allow') === 'allow') out.push(finding(r, 'storage-open-network', 'low', 'Reachable from any network', { why: 'Public network access is on with no firewall rules: only its keys and sign-ins stand in the way.', fix: `${update('--default-action Deny')} (then allow your networks, or add a private endpoint)`, seen: `publicNetworkAccess: ${p.publicNetworkAccess ?? 'Enabled'}, networkAcls.defaultAction: ${p.networkAcls?.defaultAction ?? 'Allow'}` }));
  if (!isFalse(p.allowSharedKeyAccess)) out.push(finding(r, 'storage-shared-key', 'low', 'Shared key access allowed', { why: 'Its account keys (and SAS tokens signed with them) work alongside Entra sign-ins, and are long-lived secrets.', fix: update('--allow-shared-key-access false'), seen: `allowSharedKeyAccess: ${p.allowSharedKeyAccess ?? 'not set (allowed)'}` }));
  return out;
}

/** A network security group (Microsoft.Network/networkSecurityGroups): its rules that let the internet in. */
export function judgeNsg(r) {
  const out = [];
  for (const { rule, admin, database, every } of openRules(r)) {
    const p = props(rule);
    const seen = `${rule.name}: Allow ${p.protocol ?? '*'} from ${sourcesOf(rule).join(', ')} to port ${[p.destinationPortRange, ...(p.destinationPortRanges ?? [])].filter(Boolean).join(', ')} (priority ${p.priority ?? '?'})`;
    const fix = `az network nsg rule update -g ${rg(r)} --nsg-name ${arg(r.name)} -n ${arg(rule.name)} --source-address-prefixes <your address range> (or --access Deny)`;
    const at = `${r.id}/securityRules/${rule.name}`;
    if (every) {
      out.push(finding(r, 'nsg-open-all', 'critical', `Every port open to the internet (${rule.name})`, { where: at, why: 'Everything behind it that listens is reachable from anywhere.', fix, seen }));
      continue;
    }
    if (admin.length) out.push(finding(r, 'nsg-open-admin', 'high', `${admin.map((n) => ADMIN_PORTS[n]).join(' and ')} open to the internet (${rule.name})`, { where: at, why: 'Remote sign-in ports open to anywhere are scanned and brute-forced within minutes; use Azure Bastion or just-in-time access.', fix, seen }));
    if (database.length) out.push(finding(r, 'nsg-open-database', 'high', `${database.map((n) => DATABASE_PORTS[n]).join(', ')} open to the internet (${rule.name})`, { where: at, why: 'A database port open to anywhere invites password guessing and exploits of the engine itself.', fix, seen }));
  }
  return out;
}

const siteCli = (r) => (/functionapp/i.test(r.kind ?? '') ? 'functionapp' : 'webapp');
// A slot's ARM name is "app/slot".
const siteArgs = (r) => {
  const [app, slot] = String(r.name).split('/');
  return `-n ${arg(app)} -g ${rg(r)}${slot ? ` --slot ${arg(slot)}` : ''}`;
};

/**
 * A web or function app, or a slot (Microsoft.Web/sites, sites/slots). Its site config (minTlsVersion,
 * ftpsState, remoteDebuggingEnabled) is judged only when it's there: Resource Graph leaves it out,
 * so the check reads it from config/web and puts it in `properties.siteConfig`.
 */
export function judgeSite(r) {
  const p = props(r);
  const c = p.siteConfig ?? {};
  const cli = siteCli(r);
  const out = [];
  if (!isTrue(p.httpsOnly)) out.push(finding(r, 'app-http-allowed', 'high', 'Plain HTTP allowed', { why: 'Without HTTPS only, requests (and the cookies and tokens in them) can be sent unencrypted.', fix: cli === 'webapp' ? `az webapp update ${siteArgs(r)} --https-only true` : `az functionapp update ${siteArgs(r)} --set httpsOnly=true`, seen: `httpsOnly: ${p.httpsOnly ?? false}` }));
  if (c.minTlsVersion && tlsBelow12(c.minTlsVersion)) out.push(finding(r, 'app-old-tls', 'medium', `TLS below 1.2 accepted (${c.minTlsVersion})`, { why: 'TLS 1.0 and 1.1 have known weaknesses.', fix: `az ${cli} config set ${siteArgs(r)} --min-tls-version 1.2`, seen: `siteConfig.minTlsVersion: ${c.minTlsVersion}` }));
  if (lower(c.ftpsState) === 'allallowed') out.push(finding(r, 'app-ftp-plain', 'medium', 'Plain FTP deployments allowed', { why: 'FTP sends the deployment credentials and the files unencrypted.', fix: `az ${cli} config set ${siteArgs(r)} --ftps-state Disabled (or FtpsOnly)`, seen: `siteConfig.ftpsState: ${c.ftpsState}` }));
  if (isTrue(c.remoteDebuggingEnabled)) out.push(finding(r, 'app-remote-debugging', 'medium', 'Remote debugging on', { why: 'It opens extra ports into the running app; turn it on only while debugging.', fix: `az ${cli} config set ${siteArgs(r)} --remote-debugging-enabled false`, seen: `siteConfig.remoteDebuggingEnabled: true${c.remoteDebuggingVersion ? ` (${c.remoteDebuggingVersion})` : ''}` }));
  if (!r.identity?.type || lower(r.identity.type) === 'none') out.push(finding(r, 'app-no-identity', 'low', 'No managed identity', { why: 'Without one it signs in to databases, storage and Key Vault with secrets kept in its settings.', fix: `az ${cli} identity assign ${siteArgs(r)}`, seen: `identity: ${r.identity?.type ?? 'none'}` }));
  return out;
}

/** A firewall rule as Sonar lists it ({ name, start, end }) or as ARM does ({ name, properties: { startIpAddress, endIpAddress } }). */
const ruleRange = (f) => ({ name: f.name, start: f.start ?? f.properties?.startIpAddress, end: f.end ?? f.properties?.endIpAddress });

/**
 * An Azure SQL server (Microsoft.Sql/servers), with what Resource Graph doesn't carry when it's been
 * read: `firewallRules`, `auditing` ({ state }: null when it couldn't be read, and then not judged)
 * and `entraOnly` (from its administrators, when properties don't say).
 */
export function judgeSqlServer(r, { firewallRules = [], auditing = null, entraOnly } = {}) {
  const p = props(r);
  const out = [];
  const server = `-g ${rg(r)} -s ${arg(r.name)}`;
  for (const f of firewallRules.map(ruleRange)) {
    if (f.start === '0.0.0.0' && f.end === '255.255.255.255') out.push(finding(r, 'sql-open-to-all', 'critical', `Firewall open to every address (${f.name})`, { where: `${r.id}/firewallRules/${f.name}`, why: 'Anyone on the internet can try to sign in to it.', fix: `az sql server firewall-rule delete ${server} -n ${arg(f.name)}`, seen: `${f.name}: ${f.start}–${f.end}` }));
    else if (f.name === 'AllowAllWindowsAzureIps' || (f.start === '0.0.0.0' && f.end === '0.0.0.0')) out.push(finding(r, 'sql-azure-services', 'low', 'Any Azure service may connect', { where: `${r.id}/firewallRules/${f.name}`, why: 'It lets in every Azure customer\'s services, not only yours.', fix: `az sql server firewall-rule delete ${server} -n ${arg(f.name)}`, seen: `${f.name}: ${f.start}–${f.end}` }));
  }
  if (!disabled(p.publicNetworkAccess) && !(p.privateEndpointConnections ?? []).length) out.push(finding(r, 'sql-public-no-private-endpoint', 'low', 'Public network access, no private endpoint', { why: 'It is reached over the internet, through its firewall only.', fix: `az sql server update -g ${rg(r)} -n ${arg(r.name)} --enable-public-network false (once a private endpoint is in place)`, seen: `publicNetworkAccess: ${p.publicNetworkAccess ?? 'Enabled'}, privateEndpointConnections: 0` }));
  const only = entraOnly ?? p.administrators?.azureADOnlyAuthentication;
  if (!isTrue(only)) out.push(finding(r, 'sql-entra-only-off', 'low', 'SQL logins allowed (Entra-only off)', { why: 'Passwords for SQL logins can be guessed, leaked or kept in settings; Entra sign-ins can\'t.', fix: `az sql server ad-only-auth enable -g ${rg(r)} -n ${arg(r.name)}`, seen: `administrators.azureADOnlyAuthentication: ${only ?? 'not set'}` }));
  if (auditing && lower(auditing.state ?? auditing.properties?.state) !== 'enabled') out.push(finding(r, 'sql-auditing-off', 'medium', 'Auditing off', { why: 'Nothing records who ran what against its databases.', fix: `az sql server audit-policy update -g ${rg(r)} -n ${arg(r.name)} --state Enabled --lats Enabled --lawri <log analytics workspace id>`, seen: `auditingSettings.state: ${auditing.state ?? auditing.properties?.state ?? 'Disabled'}` }));
  return out;
}

/** A Key Vault (Microsoft.KeyVault/vaults). */
export function judgeKeyVault(r) {
  const p = props(r);
  const out = [];
  const update = (flags) => `az keyvault update -n ${arg(r.name)} -g ${rg(r)} ${flags}`;
  if (isFalse(p.enableSoftDelete)) out.push(finding(r, 'kv-no-soft-delete', 'high', 'Soft delete off', { why: 'A deleted secret, key or certificate is gone at once, with no way back.', fix: update('--enable-soft-delete true'), seen: 'enableSoftDelete: false' }));
  if (!isTrue(p.enablePurgeProtection)) out.push(finding(r, 'kv-no-purge-protection', 'medium', 'Purge protection off', { why: 'Someone with access can purge deleted secrets before their retention ends (it can\'t be turned off once on).', fix: update('--enable-purge-protection true'), seen: `enablePurgeProtection: ${p.enablePurgeProtection ?? 'not set'}` }));
  if (!disabled(p.publicNetworkAccess) && lower(p.networkAcls?.defaultAction || 'allow') === 'allow') out.push(finding(r, 'kv-open-network', 'low', 'Reachable from any network', { why: 'Public network access is on with no firewall rules.', fix: `${update('--default-action Deny')} (then allow your networks, or add a private endpoint)`, seen: `publicNetworkAccess: ${p.publicNetworkAccess ?? 'Enabled'}, networkAcls.defaultAction: ${p.networkAcls?.defaultAction ?? 'Allow'}` }));
  if (!isTrue(p.enableRbacAuthorization)) out.push(finding(r, 'kv-access-policies', 'low', 'Access policies instead of Azure RBAC', { why: 'Access policies are all-or-nothing per kind and outside Azure\'s role assignments, PIM and their audit.', fix: update('--enable-rbac-authorization true (after granting the roles its users need)'), seen: `enableRbacAuthorization: ${p.enableRbacAuthorization ?? false}` }));
  return out;
}

/** A virtual machine (Microsoft.Compute/virtualMachines) on its own: encryption at host. Exposure is exposedVms's. */
export function judgeVm(r) {
  const enc = props(r).securityProfile?.encryptionAtHost;
  if (isTrue(enc)) return [];
  return [finding(r, 'vm-no-host-encryption', 'low', 'Encryption at host off', { why: 'Its temp disk and disk caches are kept unencrypted on the host.', fix: `az vm update -n ${arg(r.name)} -g ${rg(r)} --set securityProfile.encryptionAtHost=true (deallocate it first)`, seen: `securityProfile.encryptionAtHost: ${enc ?? 'not set'}` })];
}

const byId = (list) => new Map((list ?? []).map((x) => [lower(x.id), x]));

/**
 * The VMs reachable from the internet on SSH or RDP: a public address on one of their network
 * interfaces, and every NSG on the way (the subnet's, the interface's) letting the port in from
 * anywhere. A Basic public address with no NSG at all is open too (a Standard one denies by default).
 * Each finding names the NSG to fix, so it reads with that NSG's own finding.
 */
export function exposedVms({ vms = [], nics = [], nsgs = [], publicIps = [] }) {
  const nicById = byId(nics);
  const ipById = byId(publicIps);
  const nsgById = byId(nsgs);
  // A subnet's NSG is found from the NSG's side: its `subnets`.
  const nsgBySubnet = new Map();
  for (const n of nsgs) for (const s of props(n).subnets ?? []) nsgBySubnet.set(lower(s.id), n);
  const out = [];
  for (const vm of vms) {
    for (const ref of props(vm).networkProfile?.networkInterfaces ?? []) {
      const nic = nicById.get(lower(ref.id));
      if (!nic) continue;
      const configs = props(nic).ipConfigurations ?? [];
      const ips = configs.map((c) => ipById.get(lower(props(c).publicIPAddress?.id))).filter(Boolean);
      if (!ips.length) continue;
      const address = ips.map((ip) => props(ip).ipAddress).filter(Boolean).join(', ') || ips[0].name;
      const guards = [nsgById.get(lower(props(nic).networkSecurityGroup?.id)), ...configs.map((c) => nsgBySubnet.get(lower(props(c).subnet?.id)))].filter(Boolean);
      const unique = [...new Set(guards)];
      if (!unique.length) {
        if (ips.some((ip) => lower(ip.sku?.name) === 'basic')) out.push(finding(vm, 'vm-public-no-nsg', 'high', `Public address ${address} with no NSG`, { why: 'A Basic public address lets everything in when no network security group stands in front of it.', fix: `az network nic update -g ${rg(nic)} -n ${arg(nic.name)} --network-security-group <an NSG that denies inbound>`, seen: `${nic.name}: public ${address}, no NSG on it or its subnet` }));
        continue;
      }
      const open = Object.keys(ADMIN_PORTS).map(Number).filter((port) => unique.every((n) => allowsFromAnywhere(n, port)));
      if (!open.length) continue;
      const names = unique.map((n) => n.name).join(', ');
      out.push(finding(vm, 'vm-exposed-admin', 'high', `${open.map((p) => ADMIN_PORTS[p]).join(' and ')} reachable from the internet at ${address}`, { why: `Its public address and the NSG${unique.length > 1 ? 's' : ''} ${names} let anyone try to sign in.`, fix: `Close it in ${names} (its nsg-open-admin finding), or remove the public address: az network nic ip-config update -g ${rg(nic)} --nic-name ${arg(nic.name)} -n ${arg(configs[0]?.name ?? 'ipconfig1')} --remove publicIpAddress`, seen: `${nic.name}: public ${address}, through ${names}` }));
    }
  }
  return out;
}

/** An Azure Cache for Redis (Microsoft.Cache/redis). */
export function judgeRedis(r) {
  const p = props(r);
  const out = [];
  const update = (set) => `az redis update -n ${arg(r.name)} -g ${rg(r)} --set ${set}`;
  if (isTrue(p.enableNonSslPort)) out.push(finding(r, 'redis-non-ssl-port', 'high', 'Non-TLS port 6379 open', { why: 'Its access key and data travel unencrypted on the plain port.', fix: update('enableNonSslPort=false'), seen: 'enableNonSslPort: true' }));
  if (p.minimumTlsVersion && tlsBelow12(p.minimumTlsVersion)) out.push(finding(r, 'redis-old-tls', 'medium', `TLS below 1.2 accepted (${p.minimumTlsVersion})`, { why: 'TLS 1.0 and 1.1 have known weaknesses and are being retired.', fix: update('minimumTlsVersion=1.2'), seen: `minimumTlsVersion: ${p.minimumTlsVersion}` }));
  return out;
}

/** A Cosmos DB account (Microsoft.DocumentDB/databaseAccounts). */
export function judgeCosmos(r) {
  const p = props(r);
  const out = [];
  if (!disabled(p.publicNetworkAccess) && !(p.ipRules ?? []).length && !isTrue(p.isVirtualNetworkFilterEnabled)) out.push(finding(r, 'cosmos-open-network', 'medium', 'Reachable from any network', { why: 'Public network access with no IP or virtual network rules: its keys are all that stand in the way.', fix: `az cosmosdb update -n ${arg(r.name)} -g ${rg(r)} --ip-range-filter <your address ranges> (or --public-network-access Disabled with a private endpoint)`, seen: `publicNetworkAccess: ${p.publicNetworkAccess ?? 'Enabled'}, ipRules: 0` }));
  if (!isTrue(p.disableLocalAuth)) out.push(finding(r, 'cosmos-local-auth', 'low', 'Key (local) authentication on', { why: 'Its primary keys give full access and don\'t expire; Entra sign-ins can be scoped and revoked.', fix: `az resource update --ids ${r.id} --set properties.disableLocalAuth=true`, seen: `disableLocalAuth: ${p.disableLocalAuth ?? false}` }));
  return out;
}

/** A container registry (Microsoft.ContainerRegistry/registries). */
export function judgeRegistry(r) {
  const p = props(r);
  const out = [];
  if (isTrue(p.anonymousPullEnabled)) out.push(finding(r, 'acr-anonymous-pull', 'high', 'Anonymous pull on', { why: 'Anyone on the internet can pull its images, and whatever is baked into them.', fix: `az acr update -n ${arg(r.name)} --anonymous-pull-enabled false`, seen: 'anonymousPullEnabled: true' }));
  if (isTrue(p.adminUserEnabled)) out.push(finding(r, 'acr-admin-user', 'medium', 'Admin user on', { why: 'One shared user name and password with push and pull on every repository.', fix: `az acr update -n ${arg(r.name)} --admin-enabled false`, seen: 'adminUserEnabled: true' }));
  return out;
}

const DEFENDER_SEVERITY = { high: 'high', medium: 'medium', low: 'low', critical: 'critical' };

/**
 * Defender for Cloud's unhealthy assessments (Resource Graph's securityresources,
 * microsoft.security/assessments), as findings of kind 'defender' about the resource each is on.
 */
export function defenderFindings(assessments = []) {
  const out = [];
  for (const a of assessments) {
    const p = props(a);
    if (lower(p.status?.code) !== 'unhealthy') continue;
    const where = p.resourceDetails?.Id ?? p.resourceDetails?.id ?? p.resourceDetails?.ResourceId ?? String(a.id ?? '').replace(/\/providers\/Microsoft\.Security\/assessments\/.*$/i, '');
    const meta = p.metadata ?? {};
    out.push({
      rule: `defender-${a.name ?? 'assessment'}`,
      severity: DEFENDER_SEVERITY[lower(meta.severity ?? p.severity)] ?? 'unknown',
      title: p.displayName ?? meta.displayName ?? 'Defender for Cloud recommendation',
      where,
      ...(meta.description ? { why: String(meta.description).replace(/<[^>]+>/g, '').trim() } : {}),
      ...(meta.remediationDescription ? { fix: String(meta.remediationDescription).replace(/<[^>]+>/g, '').trim() } : {}),
      ...(p.status?.cause || p.status?.description ? { excerpt: p.status.description ?? p.status.cause } : {}),
      kind: 'defender',
      name: where.split('/').pop(),
      resourceId: where,
      resourceGroup: groupOf(where),
      resourceType: lower(/\/providers\/([^/]+\/[^/]+)\/[^/]+$/.exec(where)?.[1] ?? ''),
      ...(p.links?.azurePortal ? { portal: `https://${String(p.links.azurePortal).replace(/^https?:\/\//, '')}` } : {}),
    });
  }
  return out;
}

/** Each kind of resource's judge, by its type in lower case; `extra` is what the check read beside it. */
export const JUDGES = {
  'microsoft.storage/storageaccounts': judgeStorage,
  'microsoft.network/networksecuritygroups': judgeNsg,
  'microsoft.web/sites': judgeSite,
  'microsoft.web/sites/slots': judgeSite,
  'microsoft.sql/servers': judgeSqlServer,
  'microsoft.keyvault/vaults': judgeKeyVault,
  'microsoft.compute/virtualmachines': judgeVm,
  'microsoft.cache/redis': judgeRedis,
  'microsoft.documentdb/databaseaccounts': judgeCosmos,
  'microsoft.containerregistry/registries': judgeRegistry,
};

/** The findings about one resource, by its type; none for a type with no rules. */
export const judgeResource = (r, extra) => JUDGES[lower(r?.type)]?.(r, extra) ?? [];
