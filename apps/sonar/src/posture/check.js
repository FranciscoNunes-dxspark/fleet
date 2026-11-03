// The posture check (/posture and `sonar security`): a subscription's (or one resource group's)
// resources read through Azure Resource Graph, one query per family of resource, and judged by
// rules.js; with what Resource Graph doesn't carry read from ARM for the few resources that need it
// (a site's config, a SQL server's firewall and auditing, the containers of an account that allows
// public blobs), and Defender for Cloud's unhealthy assessments when it's there. Read-only.
import { mapLimited } from '../tree.js';
import { defenderFindings, exposedVms, judgeResource } from './rules.js';

const lower = (s) => String(s ?? '').toLowerCase();

/** The families of resource the check reads, each one Resource Graph query. */
export const FAMILIES = [
  { key: 'storage', label: 'storage accounts', types: ['microsoft.storage/storageaccounts'] },
  { key: 'network', label: 'NSGs and VMs', types: ['microsoft.network/networksecuritygroups', 'microsoft.compute/virtualmachines', 'microsoft.network/networkinterfaces', 'microsoft.network/publicipaddresses'] },
  { key: 'web', label: 'web and function apps', types: ['microsoft.web/sites', 'microsoft.web/sites/slots'] },
  { key: 'sql', label: 'SQL servers', types: ['microsoft.sql/servers'] },
  { key: 'keyvault', label: 'key vaults', types: ['microsoft.keyvault/vaults'] },
  { key: 'data', label: 'Redis and Cosmos DB', types: ['microsoft.cache/redis', 'microsoft.documentdb/databaseaccounts'] },
  { key: 'registry', label: 'container registries', types: ['microsoft.containerregistry/registries'] },
];

const quoted = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const inGroup = (resourceGroup) => (resourceGroup ? ` | where resourceGroup =~ ${quoted(resourceGroup)}` : '');

/** The Resource Graph query for one family's types, in one resource group when given. */
export const familyQuery = (family, { resourceGroup } = {}) =>
  `resources | where type in~ (${family.types.map(quoted).join(', ')})${inGroup(resourceGroup)} | project id, name, type, kind, location, resourceGroup, sku, identity, properties`;

/** Defender for Cloud's unhealthy assessments (the securityresources table). */
export const defenderQuery = ({ resourceGroup } = {}) =>
  `securityresources | where type == 'microsoft.security/assessments' | where properties.status.code =~ 'Unhealthy'${inGroup(resourceGroup)} | project id, name, type, resourceGroup, properties`;

const cancelled = (e, signal) => e?.cancelled || signal?.aborted;

/**
 * The whole check: { findings, read: { family: n resources }, skipped: [{ what, why }], defender:
 * 'read' | why it wasn't }. A family Resource Graph won't answer for (no access, say) is skipped and
 * said, not fatal; when none answers, it throws the first family's error. `provider` is arm.js's or
 * the demo's.
 */
export async function postureCheck(provider, sub, { resourceGroup, signal, defender = true } = {}) {
  const skipped = [];
  const results = await Promise.all(
    FAMILIES.map(async (family) => {
      try {
        return { family, rows: await provider.resourceGraph(sub, familyQuery(family, { resourceGroup }), { signal }) };
      } catch (e) {
        if (cancelled(e, signal)) throw e;
        return { family, error: e };
      }
    }),
  );
  const failed = results.filter((r) => r.error);
  if (failed.length === results.length) throw failed[0].error;
  for (const r of failed) skipped.push({ what: r.family.label, why: r.error.message });
  const rows = Object.fromEntries(results.map((r) => [r.family.key, r.rows ?? []]));
  const read = Object.fromEntries(results.filter((r) => !r.error).map((r) => [r.family.key, r.rows.length]));
  const ofType = (key, type) => rows[key].filter((r) => lower(r.type) === type);
  // What Resource Graph doesn't carry, from ARM, a few at a time; one that can't be read is said and
  // its resource judged on what there is.
  const extra = new Map();
  const jobs = [];
  const unreadable = (what) => (e) => {
    if (cancelled(e, signal)) throw e;
    skipped.push({ what, why: e.message });
  };
  for (const site of rows.web) {
    jobs.push(() =>
      provider.siteConfig(site, { signal }).then((config) => {
        if (config) site.properties = { ...site.properties, siteConfig: { ...(site.properties?.siteConfig ?? {}), ...config } };
      }, unreadable(`${site.name}'s configuration`)),
    );
  }
  for (const server of rows.sql) {
    const e = { firewallRules: [], auditing: null };
    extra.set(server, e);
    jobs.push(() => provider.firewallRules(server, { signal }).then((list) => (e.firewallRules = list), unreadable(`${server.name}'s firewall`)));
    // Auditing is judged only when it could be read.
    if (provider.sqlAuditing) jobs.push(() => provider.sqlAuditing(server, { signal }).then((a) => (e.auditing = a), (err) => (cancelled(err, signal) ? Promise.reject(err) : null)));
  }
  // Only an account that allows public blobs can have a public container: its containers are listed.
  for (const account of rows.storage.filter((a) => a.properties?.allowBlobPublicAccess === true).slice(0, 50)) {
    const e = { containers: [] };
    extra.set(account, e);
    jobs.push(() => provider.storageContainers(account, { signal }).then((list) => (e.containers = list), unreadable(`${account.name}'s containers`)));
  }
  await mapLimited(jobs, 6, (job) => job());

  const findings = [];
  for (const key of ['storage', 'web', 'sql', 'keyvault', 'data', 'registry']) for (const r of rows[key]) findings.push(...judgeResource(r, extra.get(r)));
  const nsgs = ofType('network', 'microsoft.network/networksecuritygroups');
  const vms = ofType('network', 'microsoft.compute/virtualmachines');
  // Their network interfaces and addresses are read to link them, not counted.
  if ('network' in read) read.network = nsgs.length + vms.length;
  for (const r of [...nsgs, ...vms]) findings.push(...judgeResource(r));
  findings.push(...exposedVms({ vms, nsgs, nics: ofType('network', 'microsoft.network/networkinterfaces'), publicIps: ofType('network', 'microsoft.network/publicipaddresses') }));

  let defended = 'not asked';
  if (defender) {
    try {
      findings.push(...defenderFindings(await provider.resourceGraph(sub, defenderQuery({ resourceGroup }), { signal })));
      defended = 'read';
    } catch (e) {
      if (cancelled(e, signal)) throw e;
      defended = e.message;
    }
  }
  return { findings, read, skipped, defender: defended };
}

/** "storage accounts 12 · NSGs and VMs 4 …": what was read (the families that had some), for the check's summary. */
export const readLine = (read) => {
  const line = FAMILIES.filter((f) => read[f.key])
    .map((f) => `${f.label} ${read[f.key]}`)
    .join(' · ');
  return line || (Object.keys(read).length ? 'no resources it checks' : '');
};
