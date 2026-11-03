// What a plan would deploy, read for misconfigurations, so an insecure resource is caught in the pull
// request rather than after the apply: a storage account that lets blobs be public, SSH open to the
// internet, a database firewall open to every address, a password written into the code. Pure.
//
// Two ways in, one set of judges:
// - a plan's after state (planFindings): Terraform's resource_changes[].change.after with what it marks
//   sensitive or unknown taken out first (knownValues), and a what-if's after;
// - the source files (sourceFindings): .tf, .tfvars, .bicep and .bicepparam read line by line, each
//   `resource` block's literal values gathered into the same shape (readTerraform, readBicep), so the
//   same judge says the same thing with a path:line; and passwords written into them.
//
// The judges are keyed by resource type, an azurerm one and its Microsoft.* ARM type sharing one judge
// where they can (`dialect` says which shape it reads: 'tf' flat attributes and nested blocks as lists,
// 'arm' { properties }), and a few AWS ones, as Terraform is cloud-agnostic. A judge says which rule,
// the attribute and the value it saw; the finding (findings.js's shape) is made here. A value Terraform
// marks sensitive is never read, so it can't reach an excerpt.
//
// bilge-ignore-file: the rules below name what they look for.
import { redact, scanText } from '@fleet/kit/codescan.js';

// What a judge can't read: a sensitive value, one known only after apply, an expression in the source.
export class Unknown {
  constructor(text = '') {
    this.text = text;
  }
}
const SENSITIVE = new Unknown('(sensitive)');
const AFTER_APPLY = new Unknown('(known after apply)');
const isUnknown = (v) => v instanceof Unknown;

// The rules: what each says, how bad, and what to set. `kind` is findings.js's (iac: a misconfiguration; secret).
export const RULES = {
  'storage-public-blobs': { severity: 'high', title: 'Storage account lets blobs be public', why: 'A container set to public access can be read by anyone with its URL, no key needed.', fix: 'Set allow_nested_items_to_be_public = false (allowBlobPublicAccess: false in Bicep or ARM).' },
  'storage-http': { severity: 'high', title: 'Storage account takes plain HTTP', why: 'Keys, SAS tokens and data cross the network in clear text.', fix: 'Set https_traffic_only_enabled = true (supportsHttpsTrafficOnly: true).' },
  'storage-old-tls': { severity: 'medium', title: 'Storage account accepts TLS older than 1.2', why: 'TLS 1.0 and 1.1 have known weaknesses, and Azure is retiring them.', fix: 'Set min_tls_version = "TLS1_2" (minimumTlsVersion: \'TLS1_2\').' },
  'storage-public-network': { severity: 'low', title: 'Storage account open to every network', why: 'Any address on the internet can reach the account; only its keys stand in the way.', fix: 'Add network_rules { default_action = "Deny" } with the networks that need it (networkAcls.defaultAction: \'Deny\'), or set public_network_access_enabled = false and use a private endpoint.' },
  'nsg-open-all': { severity: 'critical', title: 'Every port open to the internet', why: 'An inbound Allow from any address to any port: whatever listens on the machines behind it is exposed.', fix: 'Set destination_port_range to the ports the service needs and source_address_prefix to who needs them (destinationPortRange, sourceAddressPrefix).' },
  'nsg-open-ssh': { severity: 'high', title: 'SSH open to the internet', why: 'Port 22 from any address is scanned and brute-forced within minutes.', fix: 'Set source_address_prefix to a VPN or office range (sourceAddressPrefix), or use Azure Bastion or just-in-time access instead.' },
  'nsg-open-rdp': { severity: 'high', title: 'RDP open to the internet', why: 'Port 3389 from any address is among the most attacked there are.', fix: 'Set source_address_prefix to a VPN or office range (sourceAddressPrefix), or use Azure Bastion or just-in-time access instead.' },
  'nsg-open-db': { severity: 'high', title: 'Database port open to the internet', why: 'A database (SQL Server, MySQL, PostgreSQL, Redis, MongoDB) reachable from any address is one weak password from a breach.', fix: 'Set source_address_prefix to the application\'s subnet (sourceAddressPrefix), or reach the database through a private endpoint.' },
  'app-http': { severity: 'high', title: 'App accepts plain HTTP', why: 'Sign-ins, cookies and data cross the network in clear text.', fix: 'Set https_only = true (httpsOnly: true).' },
  'app-old-tls': { severity: 'medium', title: 'App accepts TLS older than 1.2', why: 'TLS 1.0 and 1.1 have known weaknesses.', fix: 'Set site_config { minimum_tls_version = "1.2" } (siteConfig.minTlsVersion: \'1.2\').' },
  'app-ftp': { severity: 'medium', title: 'App allows plain FTP', why: 'FTP sends the deployment credentials, and the code, in clear text.', fix: 'Set site_config { ftps_state = "Disabled" } (or "FtpsOnly"; siteConfig.ftpsState).' },
  'app-remote-debugging': { severity: 'medium', title: 'App has remote debugging on', why: 'It opens a debugging port into the running app.', fix: 'Set site_config { remote_debugging_enabled = false } (siteConfig.remoteDebuggingEnabled: false).' },
  'sql-firewall-open': { severity: 'critical', title: 'Database firewall open to every address', why: 'A rule from 0.0.0.0 to 255.255.255.255 lets the whole internet try to sign in.', fix: 'Remove the rule; set start_ip_address and end_ip_address to the addresses that need it (startIpAddress, endIpAddress), or use a private endpoint.' },
  'sql-public-network': { severity: 'low', title: 'Database server reachable from public networks', why: 'Only its firewall rules stand between it and the internet.', fix: 'Set public_network_access_enabled = false (publicNetworkAccess: \'Disabled\') and connect through a private endpoint.' },
  'kv-no-purge-protection': { severity: 'medium', title: 'Key vault without purge protection', why: 'A deleted vault, or secret, can be purged at once: by mistake, or by whoever got in.', fix: 'Set purge_protection_enabled = true (enablePurgeProtection: true).' },
  'kv-network-open': { severity: 'low', title: 'Key vault open to every network', why: 'Any address can reach the vault; only its access policies stand in the way.', fix: 'Set network_acls { default_action = "Deny" } with the networks that need it (networkAcls.defaultAction: \'Deny\').' },
  'redis-non-ssl': { severity: 'high', title: 'Redis non-TLS port open', why: 'Port 6379 sends the access key and the data in clear text.', fix: 'Set non_ssl_port_enabled = false (enableNonSslPort: false).' },
  'redis-old-tls': { severity: 'medium', title: 'Redis accepts TLS older than 1.2', why: 'TLS 1.0 and 1.1 have known weaknesses.', fix: 'Set minimum_tls_version = "1.2" (minimumTlsVersion: \'1.2\').' },
  'acr-admin': { severity: 'medium', title: 'Container registry admin user on', why: 'One shared user name and password that can push and pull everything, often copied around.', fix: 'Set admin_enabled = false (adminUserEnabled: false) and pull with a managed identity or a scoped token.' },
  'acr-anonymous-pull': { severity: 'high', title: 'Container registry allows anonymous pull', why: 'Anyone can pull every image, and whatever is baked into them.', fix: 'Set anonymous_pull_enabled = false (anonymousPullEnabled: false).' },
  's3-public-acl': { severity: 'high', title: 'S3 bucket ACL is public', why: 'public-read lets anyone list and read the bucket; public-read-write lets them write to it too.', fix: 'Set acl = "private" and grant access with a bucket policy for the principals that need it.' },
  's3-public-access-block': { severity: 'high', title: 'S3 public access block turned off', why: 'With a flag off, an ACL or a policy can make the bucket public.', fix: 'Set block_public_acls, block_public_policy, ignore_public_acls and restrict_public_buckets = true.' },
  's3-no-public-access-block': { severity: 'high', title: 'S3 bucket without a public access block', why: 'Nothing stops an ACL or a policy from making it public later.', fix: 'Add an aws_s3_bucket_public_access_block for the bucket with all four settings true.' },
  'sg-open-all': { severity: 'critical', title: 'Security group open to the internet on every port', why: 'An ingress from 0.0.0.0/0 to every port exposes whatever listens.', fix: 'Set from_port, to_port and protocol to what the service needs, and cidr_blocks to who needs it.' },
  'sg-open-ssh': { severity: 'high', title: 'SSH open to the internet', why: 'Port 22 from 0.0.0.0/0 is scanned and brute-forced within minutes.', fix: 'Set cidr_blocks to a VPN or office range, or use SSM Session Manager instead of SSH.' },
  'sg-open-rdp': { severity: 'high', title: 'RDP open to the internet', why: 'Port 3389 from 0.0.0.0/0 is among the most attacked there are.', fix: 'Set cidr_blocks to a VPN or office range, or use SSM Fleet Manager or a bastion.' },
  'rds-public': { severity: 'high', title: 'Database instance publicly accessible', why: 'It gets a public address; only its security group stands in the way.', fix: 'Set publicly_accessible = false.' },
  'rds-unencrypted': { severity: 'medium', title: 'Database storage not encrypted', why: 'Snapshots and disks hold the data in clear.', fix: 'Set storage_encrypted = true (only when the instance is created: a new one, then move the data).' },
  'iac-plain-password': { severity: 'high', kind: 'secret', title: 'Password written into the infrastructure code', why: 'Everyone who can read the repository has it, its history keeps it, and Terraform\'s state and Azure\'s deployment history too.', fix: 'Pass it in as a sensitive variable (sensitive = true) or a @secure() parameter from a pipeline secret or Key Vault, or let the resource make one (random_password).' },
  'bicep-insecure-param': { severity: 'medium', kind: 'secret', title: 'Secret parameter without @secure()', why: 'Its value is kept in the deployment\'s history and shown in the portal and logs.', fix: 'Add @secure() above the parameter.' },
};

/**
 * Terraform's after state with what it marks sensitive or known only after apply replaced by an
 * `Unknown`, so no judge reads a secret or guesses at a value.
 */
export function knownValues(value, sensitive, unknown) {
  if (sensitive === true) return SENSITIVE;
  if (unknown === true) return AFTER_APPLY;
  if (Array.isArray(value)) return value.map((v, i) => knownValues(v, sensitive?.[i], unknown?.[i]));
  if (value && typeof value === 'object') {
    const out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, knownValues(v, sensitive?.[k], unknown?.[k])]));
    for (const [k, u] of Object.entries(unknown && typeof unknown === 'object' ? unknown : {})) if (u === true && !(k in out)) out[k] = AFTER_APPLY;
    return out;
  }
  return value;
}

// A path into the values: "site_config.minimum_tls_version" (a nested block, a list of one in Terraform, read at its first).
function get(values, path) {
  let v = values;
  for (const k of path.split('.')) {
    // What can't be read stays unknown all the way down; a value that isn't an object has no fields.
    if (isUnknown(v)) return v;
    if (v == null || typeof v !== 'object') return undefined;
    v = Array.isArray(v) && !/^\d+$/.test(k) ? v[0]?.[k] : v[k];
  }
  return v;
}

/** The first of `paths` with a value: { path, value }; the first path and undefined when none has one. */
function attr(values, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const p of list) {
    const v = get(values, p);
    if (v !== undefined && v !== null) return { path: p, value: v };
  }
  return { path: list[0], value: undefined };
}

const lc = (v) => (typeof v === 'string' ? v.toLowerCase() : v);
const isTrue = (v) => v === true || lc(v) === 'true';
const isFalse = (v) => v === false || lc(v) === 'false';
const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
// "TLS1_0", "1.0", "TLS1_1", "1.1": older than 1.2.
const oldTls = (v) => typeof v === 'string' && /^(tls)?1[._]?[01]$/i.test(v.trim());
const show = (v) => (isUnknown(v) ? v.text : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));
const hit = (rule, path, value, extra = {}) => ({ rule, attribute: path, excerpt: value === undefined ? `${path} not set` : `${path} = ${show(value)}`, ...extra });

// Each judge reads one resource's values in its dialect and returns hits: { rule, attribute, excerpt, title? }.
const pick = (d, tf, arm) => (d === 'tf' ? tf : arm);

function storage(v, d) {
  const out = [];
  const blob = attr(v, pick(d, ['allow_nested_items_to_be_public', 'allow_blob_public_access'], 'properties.allowBlobPublicAccess'));
  if (isTrue(blob.value)) out.push(hit('storage-public-blobs', blob.path, blob.value));
  const https = attr(v, pick(d, ['https_traffic_only_enabled', 'enable_https_traffic_only'], 'properties.supportsHttpsTrafficOnly'));
  if (isFalse(https.value)) out.push(hit('storage-http', https.path, https.value));
  const tls = attr(v, pick(d, 'min_tls_version', 'properties.minimumTlsVersion'));
  if (oldTls(tls.value)) out.push(hit('storage-old-tls', tls.path, tls.value));
  const pub = attr(v, pick(d, 'public_network_access_enabled', 'properties.publicNetworkAccess'));
  const action = attr(v, pick(d, 'network_rules.default_action', 'properties.networkAcls.defaultAction'));
  if ((isTrue(pub.value) || lc(pub.value) === 'enabled') && (action.value === undefined || lc(action.value) === 'allow')) out.push(hit('storage-public-network', action.value === undefined ? pub.path : action.path, action.value === undefined ? pub.value : action.value));
  return out;
}

// The addresses an NSG or security group rule lets in from anywhere.
const ANYWHERE = new Set(['*', 'internet', 'any', '0.0.0.0/0', '0.0.0.0', '::/0']);
const ADMIN_PORTS = [
  [22, 'ssh', 'SSH'],
  [3389, 'rdp', 'RDP'],
  [1433, 'db', 'SQL Server'],
  [3306, 'db', 'MySQL'],
  [5432, 'db', 'PostgreSQL'],
  [6379, 'db', 'Redis'],
  [27017, 'db', 'MongoDB'],
];

/** "22", "1000-2000", "*": [from, to]; null for what isn't a port. */
function portRange(p) {
  const s = String(p ?? '').trim();
  if (s === '*' || lc(s) === 'any') return [0, 65535];
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

/** What one rule opens to the internet: [{ what: 'all' | 'ssh' | 'rdp' | 'db', port, name }] (each kind once). */
function openTo(ranges) {
  const out = [];
  if (ranges.some(([a, b]) => a <= 1 && b >= 65535)) return [{ what: 'all' }];
  for (const [port, what, name] of ADMIN_PORTS) {
    if (out.some((o) => o.what === what)) continue;
    if (ranges.some(([a, b]) => a <= port && port <= b)) out.push({ what, port, name });
  }
  return out;
}

/** An Azure security rule, Terraform's or ARM's, as { name, direction, access, protocol, sources, ports }. */
function nsgRule(r, d) {
  const p = d === 'tf' ? r : (r?.properties ?? r);
  if (!p || typeof p !== 'object' || isUnknown(p)) return null;
  const f = (tf, arm) => p[d === 'tf' ? tf : arm];
  return {
    name: r.name ?? p.name,
    direction: f('direction', 'direction'),
    access: f('access', 'access'),
    protocol: f('protocol', 'protocol'),
    sources: [...listOf(f('source_address_prefix', 'sourceAddressPrefix')), ...listOf(f('source_address_prefixes', 'sourceAddressPrefixes'))],
    ports: [...listOf(f('destination_port_range', 'destinationPortRange')), ...listOf(f('destination_port_ranges', 'destinationPortRanges'))],
  };
}

function nsgHits(rule, path) {
  if (!rule || lc(rule.direction) !== 'inbound' || lc(rule.access) !== 'allow') return [];
  if (rule.protocol !== undefined && !isUnknown(rule.protocol) && !['tcp', '*', 'any'].includes(lc(rule.protocol))) return [];
  const source = rule.sources.find((s) => typeof s === 'string' && ANYWHERE.has(lc(s)));
  if (source === undefined) return [];
  const ranges = rule.ports.map(portRange).filter(Boolean);
  const ports = rule.ports.filter((p) => !isUnknown(p)).join(',') || '*';
  return openTo(ranges).map((o) => ({
    rule: `nsg-open-${o.what}`,
    attribute: path,
    excerpt: `${rule.name ? `${rule.name}: ` : ''}Inbound Allow from ${source} to ${o.what === 'all' ? ports : `${ports}${o.what === 'db' ? ` (${o.name})` : ''}`}`,
  }));
}

function nsgGroup(v, d) {
  const key = d === 'tf' ? 'security_rule' : 'properties.securityRules';
  return listOf(get(v, key)).flatMap((r, i) => nsgHits(nsgRule(r, d), `${key}.${i}.${d === 'tf' ? 'source_address_prefix' : 'properties.sourceAddressPrefix'}`));
}

const nsgSingle = (v, d) => nsgHits(nsgRule(v, d), d === 'tf' ? 'source_address_prefix' : 'properties.sourceAddressPrefix');

function webApp(v, d) {
  const out = [];
  const https = attr(v, pick(d, 'https_only', 'properties.httpsOnly'));
  if (isFalse(https.value)) out.push(hit('app-http', https.path, https.value));
  const tls = attr(v, pick(d, ['site_config.minimum_tls_version', 'site_config.min_tls_version'], 'properties.siteConfig.minTlsVersion'));
  if (oldTls(tls.value)) out.push(hit('app-old-tls', tls.path, tls.value));
  const ftp = attr(v, pick(d, 'site_config.ftps_state', 'properties.siteConfig.ftpsState'));
  if (lc(ftp.value) === 'allallowed') out.push(hit('app-ftp', ftp.path, ftp.value));
  const debug = attr(v, pick(d, ['site_config.remote_debugging_enabled', 'site_config.remote_debugging', 'remote_debugging_enabled'], 'properties.siteConfig.remoteDebuggingEnabled'));
  if (isTrue(debug.value)) out.push(hit('app-remote-debugging', debug.path, debug.value));
  return out;
}

function firewallRule(v, d) {
  const start = attr(v, pick(d, 'start_ip_address', 'properties.startIpAddress'));
  const end = attr(v, pick(d, 'end_ip_address', 'properties.endIpAddress'));
  return start.value === '0.0.0.0' && end.value === '255.255.255.255' ? [{ rule: 'sql-firewall-open', attribute: start.path, excerpt: `${start.path} = "0.0.0.0", ${end.path} = "255.255.255.255"` }] : [];
}

function sqlServer(v, d) {
  const pub = attr(v, pick(d, 'public_network_access_enabled', ['properties.publicNetworkAccess', 'properties.network.publicNetworkAccess']));
  return isTrue(pub.value) || lc(pub.value) === 'enabled' ? [hit('sql-public-network', pub.path, pub.value)] : [];
}

function keyVault(v, d) {
  const out = [];
  const purge = attr(v, pick(d, 'purge_protection_enabled', 'properties.enablePurgeProtection'));
  // ARM leaves it out when it's off; Terraform's plan always has it.
  if (isFalse(purge.value) || (d === 'arm' && purge.value === undefined && v.properties && !isUnknown(v.properties))) out.push(hit('kv-no-purge-protection', purge.path, purge.value));
  const acl = attr(v, pick(d, 'network_acls.default_action', 'properties.networkAcls.defaultAction'));
  const pub = attr(v, pick(d, 'public_network_access_enabled', 'properties.publicNetworkAccess'));
  if (lc(acl.value) === 'allow' && !isFalse(pub.value) && lc(pub.value) !== 'disabled') out.push(hit('kv-network-open', acl.path, acl.value));
  return out;
}

function redis(v, d) {
  const out = [];
  const port = attr(v, pick(d, ['non_ssl_port_enabled', 'enable_non_ssl_port'], 'properties.enableNonSslPort'));
  if (isTrue(port.value)) out.push(hit('redis-non-ssl', port.path, port.value));
  const tls = attr(v, pick(d, 'minimum_tls_version', 'properties.minimumTlsVersion'));
  if (oldTls(tls.value)) out.push(hit('redis-old-tls', tls.path, tls.value));
  return out;
}

function registry(v, d) {
  const out = [];
  const admin = attr(v, pick(d, 'admin_enabled', 'properties.adminUserEnabled'));
  if (isTrue(admin.value)) out.push(hit('acr-admin', admin.path, admin.value));
  const anon = attr(v, pick(d, 'anonymous_pull_enabled', 'properties.anonymousPullEnabled'));
  if (isTrue(anon.value)) out.push(hit('acr-anonymous-pull', anon.path, anon.value));
  return out;
}

function s3Acl(v) {
  const acl = attr(v, 'acl');
  return ['public-read', 'public-read-write', 'authenticated-read'].includes(lc(acl.value)) ? [hit('s3-public-acl', acl.path, acl.value)] : [];
}

const S3_FLAGS = ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'];
function s3Block(v) {
  const off = S3_FLAGS.filter((f) => isFalse(v[f]));
  return off.length ? [{ rule: 's3-public-access-block', attribute: off[0], excerpt: off.map((f) => `${f} = false`).join(', ') }] : [];
}

/** An AWS ingress rule's ports: [from, to], all of them for protocol -1. */
function awsPorts(r) {
  const protocol = lc(r.protocol ?? r.ip_protocol);
  if (protocol === '-1' || protocol === 'all') return [[0, 65535]];
  if (protocol !== undefined && !isUnknown(protocol) && !['tcp', '6'].includes(String(protocol))) return [];
  const from = Number(r.from_port);
  const to = Number(r.to_port ?? r.from_port);
  return Number.isFinite(from) && Number.isFinite(to) ? [[from, to]] : [];
}

function awsIngress(r, path) {
  const cidrs = [...listOf(r.cidr_blocks), ...listOf(r.ipv6_cidr_blocks), ...listOf(r.cidr_ipv4), ...listOf(r.cidr_ipv6)];
  const source = cidrs.find((c) => typeof c === 'string' && ANYWHERE.has(c));
  if (!source) return [];
  return openTo(awsPorts(r))
    .filter((o) => o.what !== 'db')
    .map((o) => ({ rule: `sg-open-${o.what}`, attribute: path, excerpt: `ingress from ${source} to ${o.what === 'all' ? 'every port' : `port ${o.port}`}` }));
}

const awsGroup = (v) => listOf(v.ingress).flatMap((r, i) => (r && typeof r === 'object' && !isUnknown(r) ? awsIngress(r, `ingress.${i}`) : []));
const awsRule = (v) => (lc(v.type) === 'ingress' ? awsIngress(v, 'cidr_blocks') : []);
const awsIngressRule = (v) => awsIngress(v, 'cidr_ipv4');

function rds(v) {
  const out = [];
  if (isTrue(v.publicly_accessible)) out.push(hit('rds-public', 'publicly_accessible', v.publicly_accessible));
  if (isFalse(v.storage_encrypted)) out.push(hit('rds-unencrypted', 'storage_encrypted', v.storage_encrypted));
  return out;
}

// Resource types and their judges: an azurerm type (or a pattern of them), or a Microsoft.* type, matched without case.
const JUDGES = [
  [/^azurerm_storage_account$/, 'tf', storage],
  ['microsoft.storage/storageaccounts', 'arm', storage],
  [/^azurerm_network_security_group$/, 'tf', nsgGroup],
  ['microsoft.network/networksecuritygroups', 'arm', nsgGroup],
  [/^azurerm_network_security_rule$/, 'tf', nsgSingle],
  ['microsoft.network/networksecuritygroups/securityrules', 'arm', nsgSingle],
  [/^azurerm_(linux_|windows_)?(web|function)_app(_slot)?$|^azurerm_app_service(_slot)?$|^azurerm_function_app(_slot)?$/, 'tf', webApp],
  ['microsoft.web/sites', 'arm', webApp],
  ['microsoft.web/sites/slots', 'arm', webApp],
  [/^azurerm_(mssql|sql|mysql|postgresql|mariadb|mysql_flexible_server|postgresql_flexible_server)_firewall_rule$/, 'tf', firewallRule],
  [/^microsoft\.(sql\/servers|dbforpostgresql\/(flexible)?servers|dbformysql\/(flexible)?servers|dbformariadb\/servers)\/firewallrules$/, 'arm', firewallRule],
  [/^azurerm_(mssql_server|postgresql_flexible_server|mysql_flexible_server|postgresql_server|mysql_server)$/, 'tf', sqlServer],
  [/^microsoft\.(sql\/servers|dbforpostgresql\/flexibleservers|dbformysql\/flexibleservers)$/, 'arm', sqlServer],
  [/^azurerm_key_vault$/, 'tf', keyVault],
  ['microsoft.keyvault/vaults', 'arm', keyVault],
  [/^azurerm_redis_cache$/, 'tf', redis],
  ['microsoft.cache/redis', 'arm', redis],
  [/^azurerm_container_registry$/, 'tf', registry],
  ['microsoft.containerregistry/registries', 'arm', registry],
  [/^aws_s3_bucket(_acl)?$/, 'tf', s3Acl],
  [/^aws_s3_bucket_public_access_block$/, 'tf', s3Block],
  [/^aws_security_group$/, 'tf', awsGroup],
  [/^aws_security_group_rule$/, 'tf', awsRule],
  [/^aws_vpc_security_group_ingress_rule$/, 'tf', awsIngressRule],
  [/^aws_(db_instance|rds_cluster)$/, 'tf', rds],
];

/** The judge for a resource type, and the shape it reads: { dialect, judge }, or null for a type nothing here judges. */
export function judgeFor(type) {
  const t = String(type ?? '');
  const found = JUDGES.find(([m]) => (typeof m === 'string' ? m === t.toLowerCase() : m.test(t.toLowerCase())));
  return found ? { dialect: found[1], judge: found[2] } : null;
}

/** What one resource's values say: [{ rule, attribute, excerpt }] (no finding shape yet). */
export function judgeResource(type, values) {
  const j = judgeFor(type);
  if (!j || !values || typeof values !== 'object' || isUnknown(values)) return [];
  return j.judge(values, j.dialect);
}

/** A hit as a finding: findings.js's shape, with the resource and the attribute it is about. */
const finding = (h, { where, resource, line, type }) => {
  const r = RULES[h.rule];
  return { rule: h.rule, severity: r.severity, title: r.title, where, ...(line ? { line } : {}), resource, type, ...(h.attribute ? { attribute: h.attribute } : {}), why: r.why, fix: r.fix, excerpt: h.excerpt, kind: r.kind ?? 'iac' };
};

// Whether resource `a` is pointed at by `b`: the plan's dependencies, a value equal to its name or id, or source text naming it.
function refersTo(b, a, field, dependsOn) {
  if (dependsOn?.[b.address]?.includes(a.address)) return true;
  const v = b.values?.[field];
  // The address must be in the text before a pattern is made for it: across a big folder this is asked
  // of every bucket and every block, and making a RegExp for each pair took seconds.
  if (isUnknown(v)) return v.text ? v.text.includes(a.address) && new RegExp(`\\b${a.address.replace(/[.[\]"]/g, '\\$&')}\\b`).test(v.text) : !dependsOn;
  return typeof v === 'string' && [a.values?.id, a.values?.name, a.values?.bucket, a.values?.arn].filter((x) => typeof x === 'string').includes(v);
}

/** What only shows across resources: a bucket no public access block points at; a storage account a network rules resource closes. */
function crossFindings(resources, { dependsOn, place }) {
  const out = [];
  const blocks = resources.filter((r) => r.type === 'aws_s3_bucket_public_access_block');
  for (const b of resources.filter((r) => r.type === 'aws_s3_bucket')) {
    if (blocks.some((p) => refersTo(p, b, 'bucket', dependsOn))) continue;
    out.push(finding({ rule: 's3-no-public-access-block', excerpt: `no aws_s3_bucket_public_access_block for ${b.address}` }, place(b)));
  }
  return out;
}

/** Storage accounts an azurerm_storage_account_network_rules resource closes, which the account's own values don't show. */
const closedByRules = (resources, dependsOn) => {
  const rules = resources.filter((r) => r.type === 'azurerm_storage_account_network_rules');
  return (account) => rules.some((r) => refersTo(r, account, 'storage_account_id', dependsOn) && lc(r.values?.default_action) !== 'allow');
};

/**
 * Findings for a plan's resources: [{ address, type, values, action? }] (values knownValues' for
 * Terraform), `dependsOn` the plan's (graph.js's) for what points at what. `where` is the address.
 */
export function planFindings(resources, { dependsOn = null } = {}) {
  const closed = closedByRules(resources, dependsOn);
  const place = (r) => ({ where: r.address, resource: r.address, type: r.type });
  const out = [];
  for (const r of resources) {
    for (const h of judgeResource(r.type, r.values)) {
      if (h.rule === 'storage-public-network' && closed(r)) continue;
      out.push(finding(h, place(r)));
    }
  }
  return [...out, ...crossFindings(resources, { dependsOn, place })];
}

// ---- The source files, read statically. ----

// A name that holds a secret, and the names around them that don't (its id, its name, a policy about it).
const SECRET_NAME = /(password|passwd|pwd|secret|token|api_?key|access_?key|client_?secret|private_?key|connection_?string|sas)/i;
const NOT_SECRET = /(_id|_ids|_name|_names|_uri|_url|_version|_type|_enabled|_length|_expiry|_expiration|_policy|_count|_rotation|Id|Ids|Name|Uri|Url|Version|Type|Enabled|Length|Policy|Expiry|_auth(entication)?_enabled|_profile)$/;
const PLACEHOLDER = /^(|changeme|change-me|change_me|xx+|\*+|<[^>]*>|todo|placeholder|example|none|null|redacted)$/i;
const secretName = (name) => SECRET_NAME.test(name) && !NOT_SECRET.test(name);

const ignored = (line, prev) => /(bilge|chart)-ignore/.test(line) || /(bilge|chart)-ignore(?!-file)/.test(prev ?? '');

/** A literal from the source: a string (no interpolation), a number, true or false; an `Unknown` with the text for anything else. */
function literal(text, quote) {
  const s = text.trim().replace(/,$/, '');
  const str = quote === "'" ? /^'((?:[^'\\]|\\.)*)'$/.exec(s) : /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (str) return quote === "'" ? (str[1].includes('${') ? new Unknown(s) : str[1]) : str[1].includes('${') ? new Unknown(s) : str[1];
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'null') return null;
  return new Unknown(s);
}

/** A one-line list ["a", "b"] of literals; null when it isn't one. */
function inlineList(text, quote) {
  const m = /^\[(.*)\]\s*,?$/.exec(text.trim());
  if (!m) return null;
  return m[1].trim() ? m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => literal(x, quote)) : [];
}

// How a nested block's line is kept: "site_config.ftps_state" (the first block's) and "security_rule.1.access" both.
function remember(lines, path, line) {
  if (!lines.has(path)) lines.set(path, line);
  const plain = path.replace(/\.\d+(?=\.|$)/g, '');
  if (!lines.has(plain)) lines.set(plain, line);
}

const braces = (line) => {
  const s = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '');
  return (s.match(/[{[(]/g) ?? []).length - (s.match(/[}\])]/g) ?? []).length;
};

/**
 * A .tf file's `resource` blocks, their literal values gathered as Terraform's after state would have
 * them (nested blocks as lists): [{ address, type, name, line, values, lines }] (`lines` maps an
 * attribute's path to its line); and its `variable` blocks with a default, for the secret rule.
 */
export function readTerraform(text) {
  const resources = [];
  const variables = [];
  const lines = String(text).split(/\r?\n/);
  let stack = [];
  let skip = 0;
  let comment = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    let line = raw;
    if (comment) {
      if (line.includes('*/')) comment = false;
      return;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      comment = true;
      return;
    }
    if (/^\s*(#|\/\/)/.test(line)) return;
    line = line.replace(/\s+(#|\/\/).*$/, '');
    if (skip) {
      skip += braces(line);
      if (skip < 0) skip = 0;
      return;
    }
    const top = stack.at(-1);
    if (!top) {
      const r = /^\s*resource\s+"([\w-]+)"\s+"([\w-]+)"\s*\{\s*$/.exec(line);
      if (r) {
        const res = { address: `${r[1]}.${r[2]}`, type: r[1], name: r[2], line: n, values: {}, lines: new Map() };
        resources.push(res);
        stack = [{ kind: 'block', obj: res.values, path: '', res }];
        return;
      }
      const v = /^\s*variable\s+"([\w-]+)"\s*\{\s*$/.exec(line);
      if (v) {
        const variable = { name: v[1], line: n, values: {}, lines: new Map() };
        variables.push(variable);
        stack = [{ kind: 'block', obj: variable.values, path: '', res: variable }];
        return;
      }
      skip = Math.max(0, braces(line));
      return;
    }
    const join = (k) => (top.path ? `${top.path}.${k}` : k);
    if (top.kind === 'list') {
      if (/^\s*\]/.test(line)) {
        stack.pop();
        return;
      }
      const item = line.trim().replace(/,$/, '');
      if (item) top.list.push(literal(item, '"'));
      return;
    }
    if (/^\s*\}\s*$/.test(line)) {
      stack.pop();
      return;
    }
    const dyn = /^\s*dynamic\s+"([\w-]+)"\s*\{/.exec(line);
    if (dyn) {
      // A dynamic block's content is an expression: unknown here.
      top.obj[dyn[1]] = new Unknown(`dynamic "${dyn[1]}"`);
      skip = braces(line);
      return;
    }
    const block = /^\s*([\w-]+)\s*\{\s*$/.exec(line);
    if (block) {
      const list = Array.isArray(top.obj[block[1]]) ? top.obj[block[1]] : (top.obj[block[1]] = []);
      const obj = {};
      list.push(obj);
      const path = join(`${block[1]}.${list.length - 1}`);
      remember(top.res.lines, path, n);
      stack.push({ kind: 'block', obj, path, res: top.res });
      return;
    }
    const a = /^\s*"?([\w-]+)"?\s*=\s*(.*)$/.exec(line);
    if (!a) {
      skip = Math.max(0, braces(line));
      return;
    }
    const [, key, rest] = a;
    const path = join(key);
    remember(top.res.lines, path, n);
    const value = rest.trim();
    if (value === '[') {
      const list = [];
      top.obj[key] = list;
      stack.push({ kind: 'list', list });
      return;
    }
    if (value === '{') {
      // A map (tags = {): its entries as values, so a secret in one is still seen.
      const obj = {};
      top.obj[key] = obj;
      stack.push({ kind: 'block', obj, path, res: top.res });
      return;
    }
    const list = inlineList(value, '"');
    top.obj[key] = list ?? literal(value, '"');
    const open = braces(value);
    if (!list && open > 0) {
      top.obj[key] = new Unknown(value);
      skip = open;
    }
  });
  return { resources, variables };
}

/**
 * A .bicep file's resources, their literal values in ARM's shape ({ properties: { … } }), and its
 * parameters: { resources: [{ address (the symbolic name), type, name, line, values, lines }],
 * params: [{ name, type, line, secure, value? }] }.
 */
export function readBicep(text) {
  const resources = [];
  const params = [];
  const lines = String(text).split(/\r?\n/);
  let stack = [];
  let skip = 0;
  let decorators = [];
  let comment = false;
  lines.forEach((raw, i) => {
    const n = i + 1;
    let line = raw;
    if (comment) {
      if (line.includes('*/')) comment = false;
      return;
    }
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      comment = true;
      return;
    }
    if (/^\s*\/\//.test(line)) return;
    line = line.replace(/\s+\/\/.*$/, '');
    if (skip) {
      skip += braces(line);
      if (skip < 0) skip = 0;
      return;
    }
    const top = stack.at(-1);
    if (!top) {
      const d = /^\s*@(\w+)/.exec(line);
      if (d) {
        decorators.push(d[1].toLowerCase());
        skip = Math.max(0, braces(line));
        return;
      }
      const p = /^\s*param\s+(\w+)\s+(\w+)(?:\s*=\s*(.+))?\s*$/.exec(line);
      if (p) {
        params.push({ name: p[1], type: p[2], line: n, secure: decorators.includes('secure'), ...(p[3] !== undefined ? { value: literal(p[3], "'") } : {}) });
        decorators = [];
        return;
      }
      const r = /^\s*resource\s+(\w+)\s+'([^'@]+)(?:@[^']*)?'\s*(existing\s*)?=.*\{\s*$/.exec(line);
      decorators = [];
      if (r && !r[3]) {
        const res = { address: r[1], type: r[2], name: r[1], line: n, values: {}, lines: new Map() };
        resources.push(res);
        stack = [{ kind: 'object', obj: res.values, path: '', res }];
        return;
      }
      skip = Math.max(0, braces(line));
      return;
    }
    const join = (k) => (top.path ? `${top.path}.${k}` : k);
    if (/^\s*\}\s*\]?\s*\)?\s*$/.test(line) && top.kind === 'object') {
      stack.pop();
      return;
    }
    if (top.kind === 'array') {
      if (/^\s*\]/.test(line)) {
        stack.pop();
        return;
      }
      if (/^\s*\{\s*$/.test(line)) {
        const obj = {};
        top.list.push(obj);
        const path = `${top.path}.${top.list.length - 1}`;
        remember(top.res.lines, path, n);
        stack.push({ kind: 'object', obj, path, res: top.res });
        return;
      }
      const item = line.trim();
      if (item) top.list.push(literal(item, "'"));
      return;
    }
    const a = /^\s*'?(\w+)'?\s*:\s*(.*)$/.exec(line);
    if (!a) {
      skip = Math.max(0, braces(line));
      return;
    }
    const [, key, rest] = a;
    const path = join(key);
    remember(top.res.lines, path, n);
    const value = rest.trim();
    if (value === '{') {
      const obj = {};
      top.obj[key] = obj;
      stack.push({ kind: 'object', obj, path, res: top.res });
      return;
    }
    if (value === '[') {
      const list = [];
      top.obj[key] = list;
      stack.push({ kind: 'array', list, path, res: top.res });
      return;
    }
    const list = inlineList(value, "'");
    top.obj[key] = list ?? literal(value, "'");
    const open = braces(value);
    if (!list && open > 0) {
      top.obj[key] = new Unknown(value);
      skip = open;
    }
  });
  return { resources, params };
}

/** The line a hit is on: its attribute's, the nearest block above it, or the resource's own. */
function lineOf(res, attribute) {
  let p = attribute ?? '';
  while (p) {
    if (res.lines.has(p)) return res.lines.get(p);
    p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
  }
  return res.line;
}

const plainPassword = (path, line, name, value, extra = {}) => ({ ...finding({ rule: 'iac-plain-password', attribute: name, excerpt: `${name} = "${redact(value)}"` }, { where: path, resource: extra.resource ?? name, line }), ...extra });

// A secret-named attribute with a literal string: `administrator_login_password = "…"`, `db_password = "…"`, `adminPassword: '…'`.
const ASSIGNED = /^\s*"?([\w-]+)"?\s*(=|:)\s*(["'])((?:(?!\3)[^\\]|\\.)*)\3\s*,?\s*$/;

/** The passwords written into one file, line by line: [finding]. */
function passwordLines(path, text, { resourceAt = () => null } = {}) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (ignored(line, lines[i - 1])) return;
    const m = ASSIGNED.exec(line) ?? /^\s*param\s+(\w+)\s*(=)\s*(['"])((?:(?!\3)[^\\]|\\.)*)\3\s*$/.exec(line);
    if (!m) return;
    const [, name, , , value] = m;
    if (!secretName(name) || PLACEHOLDER.test(value.trim()) || value.includes('${') || /^\{\{|^\$\(|^#\{/.test(value)) return;
    out.push(plainPassword(path, i + 1, name, value, { resource: resourceAt(i + 1) ?? name }));
  });
  return out;
}

const TF = /\.tf$/i;
const TFVARS = /\.tfvars$/i;
const BICEP = /\.bicep$/i;
const BICEPPARAM = /\.bicepparam$/i;
/** Whether Chart reads a file for its source checks: .tf, .tfvars, .bicep, .bicepparam. */
export const isSourceFile = (path) => TF.test(path) || TFVARS.test(path) || BICEP.test(path) || BICEPPARAM.test(path);

/**
 * What one source file says (`path` relative and /-separated): each resource's literal values through
 * the judges, with the line of the attribute; passwords written into it; and codescan.js's secret rules
 * (keys, tokens, connection strings) for what else is pasted in. A file saying bilge-ignore-file (or
 * chart-ignore-file) in its first lines is skipped, as a line saying bilge-ignore or chart-ignore is.
 * Returns { findings, resources } (the resources for the checks across files).
 */
export function sourceFindings(path, text) {
  const src = String(text ?? '');
  if (src.split(/\r?\n/, 15).some((l) => /(bilge|chart)-ignore-file/.test(l))) return { findings: [], resources: [] };
  const out = [];
  const lines = src.split(/\r?\n/);
  const skipLine = (n) => ignored(lines[n - 1] ?? '', lines[n - 2]);
  let resources = [];
  let resourceAt = () => null;
  if (TF.test(path) || BICEP.test(path)) {
    const read = TF.test(path) ? readTerraform(src) : readBicep(src);
    resources = read.resources.map((r) => ({ ...r, path }));
    resourceAt = (n) => [...resources].reverse().find((r) => r.line <= n)?.address ?? null;
    for (const r of resources) {
      for (const h of judgeResource(r.type, r.values)) {
        const line = lineOf(r, h.attribute);
        if (!skipLine(line)) out.push(finding(h, { where: path, resource: r.address, line, type: r.type }));
      }
    }
    for (const v of read.variables ?? []) {
      // A variable named like a secret with a literal default: every plan without the variable set uses it.
      const d = v.values.default;
      const line = lineOf(v, 'default');
      if (secretName(v.name) && typeof d === 'string' && !PLACEHOLDER.test(d) && !skipLine(line)) out.push(plainPassword(path, line, `var.${v.name}`, d, { resource: `var.${v.name}` }));
    }
    for (const p of read.params ?? []) {
      if (!secretName(p.name) || skipLine(p.line)) continue;
      if (typeof p.value === 'string' && !PLACEHOLDER.test(p.value)) out.push(plainPassword(path, p.line, p.name, p.value, { resource: `param ${p.name}` }));
      else if (!p.secure && p.type === 'string') out.push(finding({ rule: 'bicep-insecure-param', attribute: p.name, excerpt: `param ${p.name} ${p.type}` }, { where: path, resource: `param ${p.name}`, line: p.line }));
    }
  }
  if (isSourceFile(path)) {
    const seen = new Set(out.map((f) => f.line));
    for (const f of passwordLines(path, src, { resourceAt })) if (!seen.has(f.line) && !out.some((o) => o.line === f.line)) out.push(f);
    // The kit's secret rules for the rest (keys, tokens, connection strings), once a line.
    const taken = new Set(out.filter((f) => f.kind === 'secret').map((f) => f.line));
    for (const f of scanText(path, src)) {
      if (f.kind !== 'secret' || taken.has(f.line)) continue;
      taken.add(f.line);
      out.push({ rule: f.rule, severity: f.severity, title: f.title, where: path, line: f.line, resource: resourceAt(f.line) ?? path, why: f.why, fix: f.fix, excerpt: f.excerpt, kind: 'secret' });
    }
  }
  return { findings: out, resources };
}

/**
 * What a folder's source files say, `files` [{ path, text }]: each file's findings, and the checks
 * across them (a bucket in one file, its public access block in another). Sorted by file and line.
 */
export function folderFindings(files) {
  const all = [];
  const resources = [];
  for (const f of files) {
    const r = sourceFindings(f.path, f.text);
    all.push(...r.findings);
    resources.push(...r.resources.filter((x) => x.type.startsWith('aws_') || x.type.startsWith('azurerm_')));
  }
  const closed = closedByRules(resources, null);
  // Each file's resources by address (the first one, as a search would find), looked up for each finding.
  const byPlace = new Map();
  for (const r of resources) if (!byPlace.has(`${r.path}\0${r.address}`)) byPlace.set(`${r.path}\0${r.address}`, r);
  const kept = all.filter((f) => !(f.rule === 'storage-public-network' && closed(byPlace.get(`${f.where}\0${f.resource}`) ?? { address: f.resource, values: {} })));
  const place = (r) => ({ where: r.path, resource: r.address, line: r.line, type: r.type });
  return [...kept, ...crossFindings(resources, { dependsOn: null, place })].sort((a, b) => a.where.localeCompare(b.where) || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Both together, for `chart security` given a plan and its folder: a plan's finding that a source file
 * also has (the same rule on the same resource) is left out, as the source's has its line.
 */
export function mergeFindings(planned, source) {
  const inSource = new Set(source.map((f) => `${f.rule}:${f.resource}`));
  return [...source, ...planned.filter((f) => !inSource.has(`${f.rule}:${f.resource}`))];
}

/** A finding's resource and attribute, as said in a list: "azurerm_storage_account.main · min_tls_version". */
export const findingSubject = (f) => [f.resource !== f.where ? f.resource : '', f.attribute ?? ''].filter(Boolean).join(' · ');
