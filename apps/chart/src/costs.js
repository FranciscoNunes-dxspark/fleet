// What a plan costs a month: for each resource it creates, replaces, destroys or resizes, the price of
// what it is before and after, from the Azure Retail Prices API (pay-as-you-go, no key needed), and the
// difference. Only the resource types in the table below are priced; for every other one Chart says
// "no price" rather than guess. Pure but for `prices`, the provider's way of asking the price list.
//
//   Resource                                              What sets the price
//   azurerm_service_plan, azurerm_app_service_plan,       its sku (P1v3, B1, S1…) × workers, Linux or Windows
//     Microsoft.Web/serverfarms
//   azurerm_linux_/windows_virtual_machine,               its size (Standard_D2s_v3) × instances, Linux or Windows
//     azurerm_virtual_machine, *_virtual_machine_scale_set,
//     Microsoft.Compute/virtualMachines
//   azurerm_kubernetes_cluster (its default node pool),   vm_size × node_count (min_count when it autoscales); the
//     azurerm_kubernetes_cluster_node_pool,                 nodes only, not the cluster's own tier
//     Microsoft.ContainerService/managedClusters
//   azurerm_mssql_database, Microsoft.Sql/servers/        its sku_name: DTU (Basic, S0…, P1…) or vCore (GP_Gen5_2,
//     databases                                             BC_Gen5_4, HS_Gen5_2); compute only. Serverless is usage-priced
//   azurerm_postgresql_/mysql_flexible_server,            its sku_name (GP_Standard_D2s_v3, B_Standard_B1ms); compute
//     Microsoft.DBforPostgreSQL|MySQL/flexibleServers       only, storage is priced by the GB
//   azurerm_redis_cache, Microsoft.Cache/Redis            sku × family × capacity (Standard C1), × shards for Premium
//   storage accounts, Application Insights, Log           usage-priced: by the GB and the operation, so no figure
//     Analytics workspaces, key vaults
//   web and function apps, slots                          on their App Service plan, which is priced
//   resource groups                                       free
//
// The region is the resource's location; without one (an Azure SQL database), its parent's (the server
// its id names) or its resource group's, when the plan has them. A monthly price is 730 hours.
import { marked } from './diff.js';

export const HOURS_A_MONTH = 730;
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'DKK', 'INR', 'JPY', 'KRW', 'NOK', 'NZD', 'RUB', 'SEK', 'TWD'];

// What priced changes are: what a plan creates, replaces, destroys or updates (an update only when what sets its price changes).
const PRICED_ACTIONS = new Set(['create', 'delete', 'replace', 'update']);

/** A value at `path` (segments) of `values`, undefined when it, or something above it, is sensitive or known only after apply. */
function getter(values, { sensitive, unknown } = {}) {
  return (...path) => {
    if (marked(sensitive ?? {}, path) || marked(unknown ?? {}, path)) return undefined;
    let v = values;
    for (const s of path) {
      if (v === null || typeof v !== 'object') return undefined;
      v = v[s];
    }
    return v === null ? undefined : v;
  };
}

const lower = (s) => String(s ?? '').toLowerCase();
const present = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false);
const count = (...vs) => {
  const n = vs.map(Number).find((x) => Number.isFinite(x) && x >= 0);
  return n ?? undefined;
};

// Terraform's types and Azure's (lower-cased), each to what sets its price; `get` reads the resource's values.
const TERRAFORM = {
  azurerm_service_plan: (get) => ({ kind: 'appservice', sku: get('sku_name'), os: get('os_type') === undefined ? undefined : /windows/i.test(get('os_type')) ? 'windows' : 'linux', count: count(get('worker_count'), 1) }),
  azurerm_app_service_plan: (get) => ({ kind: 'appservice', sku: get('sku', 0, 'size'), os: get('reserved') === true || /linux/i.test(get('kind') ?? '') ? 'linux' : 'windows', count: count(get('sku', 0, 'capacity'), 1) }),
  azurerm_linux_virtual_machine: (get) => ({ kind: 'vm', pools: [{ size: get('size'), os: 'linux', count: 1 }] }),
  azurerm_windows_virtual_machine: (get) => ({ kind: 'vm', pools: [{ size: get('size'), os: 'windows', count: 1 }] }),
  azurerm_virtual_machine: (get) => ({ kind: 'vm', pools: [{ size: get('vm_size'), os: present(get('os_profile_windows_config')) ? 'windows' : present(get('os_profile_linux_config')) ? 'linux' : undefined, count: 1 }] }),
  azurerm_linux_virtual_machine_scale_set: (get) => ({ kind: 'vm', pools: [{ size: get('sku'), os: 'linux', count: count(get('instances')) }] }),
  azurerm_windows_virtual_machine_scale_set: (get) => ({ kind: 'vm', pools: [{ size: get('sku'), os: 'windows', count: count(get('instances')) }] }),
  // The default node pool is always Linux.
  azurerm_kubernetes_cluster: (get) => ({ kind: 'vm', nodes: true, pools: [{ size: get('default_node_pool', 0, 'vm_size'), os: 'linux', count: count(get('default_node_pool', 0, 'node_count'), get('default_node_pool', 0, 'min_count')) }] }),
  azurerm_kubernetes_cluster_node_pool: (get) => ({ kind: 'vm', nodes: true, pools: [{ size: get('vm_size'), os: /windows/i.test(get('os_type') ?? '') ? 'windows' : 'linux', count: count(get('node_count'), get('min_count')) }] }),
  azurerm_mssql_database: (get) => ({ kind: 'sql', sku: get('sku_name') }),
  azurerm_postgresql_flexible_server: (get) => ({ kind: 'flex', engine: 'postgresql', sku: get('sku_name') }),
  azurerm_mysql_flexible_server: (get) => ({ kind: 'flex', engine: 'mysql', sku: get('sku_name') }),
  azurerm_redis_cache: (get) => ({ kind: 'redis', tier: get('sku_name'), family: get('family'), capacity: count(get('capacity')), shards: count(get('shard_count'), 1) }),
  azurerm_storage_account: () => ({ kind: 'usage', what: 'priced by the GB stored and the operation' }),
  azurerm_application_insights: () => ({ kind: 'usage', what: 'priced by the GB of telemetry taken in' }),
  azurerm_log_analytics_workspace: () => ({ kind: 'usage', what: 'priced by the GB of logs taken in and kept' }),
  azurerm_key_vault: () => ({ kind: 'usage', what: 'priced by the operation' }),
  azurerm_resource_group: () => ({ kind: 'free' }),
};
for (const t of ['azurerm_linux_web_app', 'azurerm_windows_web_app', 'azurerm_linux_function_app', 'azurerm_windows_function_app', 'azurerm_linux_web_app_slot', 'azurerm_windows_web_app_slot', 'azurerm_app_service', 'azurerm_function_app']) TERRAFORM[t] = () => ({ kind: 'included', what: 'its App Service plan' });

const ARM_TIERS = { generalpurpose: 'GP', memoryoptimized: 'MO', burstable: 'B' };
const AZURE = {
  'microsoft.web/serverfarms': (get) => ({ kind: 'appservice', sku: get('sku', 'name'), os: get('properties', 'reserved') === true || /linux/i.test(get('kind') ?? '') ? 'linux' : 'windows', count: count(get('sku', 'capacity'), 1) }),
  'microsoft.compute/virtualmachines': (get) => {
    const osType = get('properties', 'storageProfile', 'osDisk', 'osType');
    const os = osType ? lower(osType) : present(get('properties', 'osProfile', 'windowsConfiguration')) ? 'windows' : present(get('properties', 'osProfile', 'linuxConfiguration')) ? 'linux' : undefined;
    return { kind: 'vm', pools: [{ size: get('properties', 'hardwareProfile', 'vmSize'), os, count: 1 }] };
  },
  'microsoft.containerservice/managedclusters': (get) => {
    const pools = get('properties', 'agentPools');
    return { kind: 'vm', nodes: true, pools: Array.isArray(pools) && pools.length ? pools.map((p) => ({ size: p?.vmSize, os: /windows/i.test(p?.osType ?? '') ? 'windows' : 'linux', count: count(p?.count, p?.minCount) })) : [{}] };
  },
  'microsoft.sql/servers/databases': (get) => {
    const name = get('sku', 'name');
    const capacity = get('sku', 'capacity');
    // A vCore sku is its family's name with the vCores beside it (GP_Gen5 and 2); a DTU one is whole (S0).
    return { kind: 'sql', sku: name && /_Gen\d$/i.test(name) && capacity ? `${name}_${capacity}` : name };
  },
  'microsoft.dbforpostgresql/flexibleservers': (get) => ({ kind: 'flex', engine: 'postgresql', sku: armFlexSku(get) }),
  'microsoft.dbformysql/flexibleservers': (get) => ({ kind: 'flex', engine: 'mysql', sku: armFlexSku(get) }),
  'microsoft.cache/redis': (get) => ({ kind: 'redis', tier: get('properties', 'sku', 'name'), family: get('properties', 'sku', 'family'), capacity: count(get('properties', 'sku', 'capacity')), shards: count(get('properties', 'shardCount'), 1) }),
  'microsoft.storage/storageaccounts': () => ({ kind: 'usage', what: 'priced by the GB stored and the operation' }),
  'microsoft.insights/components': () => ({ kind: 'usage', what: 'priced by the GB of telemetry taken in' }),
  'microsoft.operationalinsights/workspaces': () => ({ kind: 'usage', what: 'priced by the GB of logs taken in and kept' }),
  'microsoft.keyvault/vaults': () => ({ kind: 'usage', what: 'priced by the operation' }),
  'microsoft.web/sites': () => ({ kind: 'included', what: 'its App Service plan' }),
  'microsoft.web/sites/slots': () => ({ kind: 'included', what: 'its App Service plan' }),
  'microsoft.resources/resourcegroups': () => ({ kind: 'free' }),
};

function armFlexSku(get) {
  const name = get('sku', 'name');
  const tier = ARM_TIERS[lower(get('sku', 'tier'))];
  return name && tier ? `${tier}_${name}` : undefined;
}

/** Whether Chart has a price for resources of `type` (or knows why not). */
export const pricedType = (type) => Boolean(TERRAFORM[type] ?? AZURE[lower(type)]);

/**
 * What sets a resource's price, from its values (Terraform's before or after, or a what-if's): a small
 * object of non-secret facts ({ kind, sku…, location, resourceGroup, parents }), nothing marked
 * sensitive or unknown in it. `kind` is null for a type Chart doesn't price; null for no values at all.
 */
export function pricingSpec(type, values, marks = {}) {
  if (values === null || values === undefined || typeof values !== 'object') return null;
  const get = getter(values, marks);
  const of = TERRAFORM[type] ?? AZURE[lower(type)];
  const own = of ? of(get) : { kind: null };
  const location = get('location');
  const parents = ['server_id', 'kubernetes_cluster_id', 'service_plan_id'].map((k) => get(k)).filter((v) => typeof v === 'string');
  const name = get('name');
  return {
    ...own,
    ...(typeof location === 'string' ? { location } : {}),
    ...(typeof get('resource_group_name') === 'string' ? { resourceGroup: get('resource_group_name') } : {}),
    ...(parents.length ? { parents } : {}),
    // A resource group's name and location are what the others' regions are found from.
    ...(own.kind === 'free' && typeof name === 'string' ? { name } : {}),
  };
}

/** "West Europe" and "westeurope" as the price list names a region. */
export const regionName = (location) => lower(location).replace(/[^a-z0-9]/g, '');

const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(String(id ?? ''))?.[1];

/** Where a resource is: its own location, else its parent's (by id), else its resource group's; { region, from? } or null. */
export function regionOf(spec, change, changes) {
  if (spec?.location) return { region: regionName(spec.location) };
  const specs = changes.map((c) => ({ c, s: c.pricing?.after ?? c.pricing?.before }));
  for (const id of spec?.parents ?? []) {
    const parent = specs.find(({ c, s }) => s?.location && lower(c.id) === lower(id));
    if (parent) return { region: regionName(parent.s.location), from: `${parent.c.address}'s region` };
  }
  const group = spec?.resourceGroup ?? groupOf(change.id) ?? groupOf(spec?.parents?.[0]);
  if (group) {
    const rg = specs.find(({ s }) => s?.kind === 'free' && s.location && lower(s.name) === lower(group));
    if (rg) return { region: regionName(rg.s.location), from: `its resource group ${group}'s region` };
  }
  return null;
}

// What sets the price, compared: an update that leaves it alone costs nothing more.
const core = (spec) => {
  if (!spec) return null;
  const { parents, resourceGroup, name, ...rest } = spec;
  return JSON.stringify(rest);
};

/** An App Service sku as the price list writes it: P1v3 → "P1 v3", B1 → "B1". */
const appServiceSku = (sku) => String(sku ?? '').replace(/^([A-Za-z]+\d+)(v\d)$/i, '$1 $2');

const perMonth = (item) => {
  const unit = String(item.unitOfMeasure ?? '').replace('/', ' ').trim();
  const m = /^(\d+)?\s*(hours?|days?|months?)$/i.exec(unit);
  if (!m) return null;
  const per = Number(m[1] ?? 1) || 1;
  const factor = /^hour/i.test(m[2]) ? HOURS_A_MONTH : /^day/i.test(m[2]) ? HOURS_A_MONTH / 24 : 1;
  return (Number(item.retailPrice) / per) * factor;
};

/** The one monthly price `items` agree on: { monthly } or { error }; several different ones is no price, never a pick. */
function onePrice(items, what) {
  const prices = [...new Set(items.map(perMonth).filter((p) => p !== null && Number.isFinite(p)).map((p) => Math.round(p * 10000) / 10000))];
  if (!prices.length) return { error: `the price list has no price for ${what}` };
  if (prices.length > 1) return { error: `the price list has ${prices.length} different prices for ${what}` };
  return { monthly: prices[0] };
}

const consumption = (items) => items.filter((i) => (i.type ?? 'Consumption') === 'Consumption' && i.isPrimaryMeterRegion !== false);

const PG = { postgresql: 'Azure Database for PostgreSQL', mysql: 'Azure Database for MySQL' };
const SQL_VCORE = { GP: 'SQL Database Single/Elastic Pool General Purpose - Compute Gen5', BC: 'SQL Database Single/Elastic Pool Business Critical - Compute Gen5', HS: 'SQL Database Single Hyperscale - Compute Gen5' };
const SQL_DTU = { B: 'Basic', S: 'Standard', P: 'Premium' };
const FLEX_TIER = { GP: 'General Purpose', MO: 'Memory Optimized', B: 'Burstable' };

/**
 * How to price one part of a spec: { query, pick(items) → { monthly } | { error }, label } (`query` the
 * price list's fields to filter on: serviceName, armSkuName, skuName or productName), or { usage },
 * { included }, { free }, { none } (why there's no price).
 */
export function pricingPlan(spec) {
  if (!spec) return { none: 'nothing to price' };
  if (spec.kind === null || spec.kind === undefined) return { none: "Chart doesn't price this kind of resource" };
  if (spec.kind === 'usage') return { usage: spec.what };
  if (spec.kind === 'included') return { included: spec.what };
  if (spec.kind === 'free') return { free: true };
  if (spec.kind === 'appservice') {
    if (!spec.sku || !spec.os) return { none: 'its sku is known only after apply' };
    if (/^Y1$/i.test(spec.sku)) return { usage: 'a consumption plan, priced by the execution' };
    if (/^EP\d|^WS\d/i.test(spec.sku)) return { none: `a ${spec.sku} plan is priced by the instance-second` };
    if (/^F1$/i.test(spec.sku)) return { free: true, label: 'F1 (free)' };
    const sku = appServiceSku(spec.sku);
    const n = spec.count ?? 1;
    return {
      parts: [
        {
          query: { serviceName: 'Azure App Service', skuName: sku },
          times: n,
          what: `${spec.sku} (${spec.os === 'windows' ? 'Windows' : 'Linux'})`,
          pick: (items) => onePrice(consumption(items).filter((i) => (spec.os === 'linux' ? /linux/i.test(i.productName) : !/linux/i.test(i.productName))), `${sku} on ${spec.os}`),
        },
      ],
      label: `${spec.sku} × ${n} (${spec.os === 'windows' ? 'Windows' : 'Linux'})`,
    };
  }
  if (spec.kind === 'vm') {
    const pools = spec.pools ?? [];
    if (!pools.length || pools.some((p) => !p.size || !p.os || p.count === undefined)) return { none: 'its size, OS or count is known only after apply' };
    return {
      parts: pools.map((p) => ({
        query: { serviceName: 'Virtual Machines', armSkuName: p.size },
        times: p.count,
        what: `${p.size} (${p.os})`,
        pick: (items) => onePrice(consumption(items).filter((i) => !/spot|low priority/i.test(`${i.skuName} ${i.meterName}`) && (p.os === 'windows' ? /windows/i.test(i.productName) : !/windows/i.test(i.productName))), `${p.size} on ${p.os}`),
      })),
      label: `${pools.map((p) => `${p.size} × ${p.count}`).join(' + ')}${spec.nodes ? ' (the nodes)' : ''}`,
    };
  }
  if (spec.kind === 'sql') {
    const sku = String(spec.sku ?? '');
    if (!sku) return { none: 'its sku is known only after apply' };
    if (/^GP_S_/i.test(sku)) return { usage: 'serverless, priced by the vCore-second used' };
    const dtu = /^(Basic)$|^([SP])(\d+)$/i.exec(sku);
    if (dtu) {
      const tier = dtu[1] ? 'B' : dtu[2].toUpperCase();
      return {
        parts: [
          {
            query: { serviceName: 'SQL Database', productName: `SQL Database Single ${SQL_DTU[tier]}` },
            times: 1,
            what: sku,
            pick: (items) => onePrice(consumption(items).filter((i) => tier === 'B' || lower(i.skuName) === lower(sku) || lower(i.meterName).startsWith(`${lower(sku)} `)), `SQL Database ${sku}`),
          },
        ],
        label: `${sku} (compute)`,
      };
    }
    const vcore = /^(GP|BC|HS)_Gen5_(\d+)$/i.exec(sku);
    if (vcore) {
      const product = SQL_VCORE[vcore[1].toUpperCase()];
      return { parts: [{ query: { serviceName: 'SQL Database', productName: product, skuName: `${vcore[2]} vCore` }, times: 1, what: sku, pick: (items) => onePrice(consumption(items), `SQL Database ${sku}`) }], label: `${sku} (compute; storage by the GB)` };
    }
    return { none: `Chart doesn't price a ${sku} database` };
  }
  if (spec.kind === 'flex') {
    const m = /^(B|GP|MO)_Standard_(\w+)$/i.exec(String(spec.sku ?? ''));
    if (!m) return spec.sku ? { none: `Chart doesn't price a ${spec.sku} server` } : { none: 'its sku is known only after apply' };
    const tier = m[1].toUpperCase();
    const size = m[2];
    const flat = (s) => lower(s).replace(/[\s_]/g, '');
    // The series a size is of (D2ds_v4 → Ddsv4) and its vCores (2), as general purpose and memory optimised servers are priced by the vCore.
    const series = flat(size.replace(/^([A-Za-z])\d+/, '$1'));
    const vcores = Number(/^[A-Za-z](\d+)/.exec(size)?.[1]);
    return {
      parts: [
        {
          query: { serviceName: PG[spec.engine] },
          times: 1,
          what: spec.sku,
          pick: (items) => {
            const flexible = consumption(items).filter((i) => /flexible server/i.test(i.productName) && new RegExp(FLEX_TIER[tier], 'i').test(i.productName));
            const exact = flexible.filter((i) => flat(i.skuName) === flat(size) || flat(i.meterName) === flat(size));
            if (exact.length) return onePrice(exact, spec.sku);
            if (tier === 'B' || !vcores) return { error: `the price list has no price for ${spec.sku}` };
            const per = onePrice(flexible.filter((i) => flat(i.productName).includes(`${series}series`) && /vcore/i.test(i.meterName)), `${spec.sku}'s vCores`);
            return per.error ? per : { monthly: per.monthly * vcores };
          },
        },
      ],
      label: `${spec.sku} (compute; storage by the GB)`,
    };
  }
  if (spec.kind === 'redis') {
    if (!spec.tier || !spec.family || spec.capacity === undefined) return { none: 'its sku is known only after apply' };
    const code = `${String(spec.family).toUpperCase()}${spec.capacity}`;
    const shards = /premium/i.test(spec.tier) ? (spec.shards ?? 1) : 1;
    return {
      parts: [
        {
          query: { serviceName: 'Redis Cache' },
          times: shards,
          what: `${spec.tier} ${code}`,
          pick: (items) => onePrice(consumption(items).filter((i) => lower(i.productName).includes(lower(spec.tier)) && !/enterprise/i.test(i.productName) && [i.skuName, i.meterName].some((n) => new RegExp(`^${code.replace(/\W/g, '')}\\b`, 'i').test(n ?? ''))), `Redis ${spec.tier} ${code}`),
        },
      ],
      label: `${spec.tier} ${code}${shards > 1 ? ` × ${shards} shards` : ''}`,
    };
  }
  return { none: "Chart doesn't price this kind of resource" };
}

/** One side's monthly price: { monthly, label } | { usage } | { included } | { none } (with why). */
async function sidePrice(spec, change, changes, prices) {
  const how = pricingPlan(spec);
  if (how.none || how.usage || how.included) return how;
  if (how.free) return { monthly: 0, label: how.label ?? 'free' };
  const where = regionOf(spec, change, changes);
  if (!where) return { none: 'its region is known only after apply (no location, parent or resource group in the plan)' };
  let total = 0;
  for (const part of how.parts) {
    let items;
    try {
      items = await prices({ ...part.query, armRegionName: where.region });
    } catch (e) {
      return { none: `the price list couldn't be asked: ${String(e.message).split('\n')[0]}`, failed: true };
    }
    const p = part.pick(items ?? []);
    if (p.error) return { none: `${p.error} in ${where.region}` };
    total += p.monthly * part.times;
  }
  return { monthly: total, label: `${how.label}, ${where.region}${where.from ? `, ${where.from}` : ''}` };
}

/**
 * The cost of what `plan` does, a month: { currency, byAddress: { address → cost }, total, priced,
 * unpriced, usage, failed }. A cost is { status: priced | usage | included | none | same, delta?,
 * before?, after?, note? }: `delta` what it adds a month (negative for what's destroyed), `before`
 * and `after` the monthly price and what it is of. `prices(query)` resolves the price list's items.
 */
export async function planCosts(plan, { prices, currency = 'USD' }) {
  const byAddress = {};
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  let usage = 0;
  let failed = 0;
  for (const c of plan.changes) {
    if (!PRICED_ACTIONS.has(c.action)) continue;
    const before = c.action === 'create' ? null : (c.pricing?.before ?? null);
    const after = c.action === 'delete' ? null : (c.pricing?.after ?? null);
    if (c.action === 'update' && core(before) === core(after)) continue;
    const kind = (after ?? before)?.kind;
    if (kind === 'free') {
      byAddress[c.address] = { status: 'free' };
      continue;
    }
    if (kind === 'usage' || kind === 'included') {
      const how = pricingPlan(after ?? before);
      byAddress[c.address] = { status: kind, note: how.usage ?? `on ${how.included}` };
      if (kind === 'usage') usage++;
      continue;
    }
    const [was, will] = await Promise.all([before ? sidePrice(before, c, plan.changes, prices) : { monthly: 0 }, after ? sidePrice(after, c, plan.changes, prices) : { monthly: 0 }]);
    const missing = [was, will].find((s) => s.monthly === undefined);
    if (missing) {
      byAddress[c.address] = { status: missing.usage ? 'usage' : 'none', note: missing.none ?? missing.usage };
      if (missing.usage) usage++;
      else unpriced++;
      if (missing.failed) failed++;
      continue;
    }
    const delta = will.monthly - was.monthly;
    byAddress[c.address] = { status: 'priced', delta, ...(before ? { before: { monthly: was.monthly, label: was.label } } : {}), ...(after ? { after: { monthly: will.monthly, label: will.label } } : {}) };
    total += delta;
    priced++;
  }
  return { currency, byAddress, total, priced, unpriced, usage, failed };
}

const SYMBOLS = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', INR: '₹', KRW: '₩', BRL: 'R$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$' };

/** An amount as it reads: $340, €1,204, $12.50 (pennies only under 10), with a sign when `signed`: +$340, -$15. */
export function money(n, currency = 'USD', { signed = false } = {}) {
  const abs = Math.abs(n);
  const digits = abs >= 10 || abs === 0 ? 0 : 2;
  const text = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const symbol = SYMBOLS[currency];
  const amount = symbol ? `${symbol}${text}` : `${text} ${currency}`;
  if (!signed) return n < 0 ? `-${amount}` : amount;
  // A change that rounds to nothing has no sign.
  return Math.round(abs * 100) === 0 ? `±${amount}` : `${n < 0 ? '-' : '+'}${amount}`;
}

/** A change's cost in a few words: "+$234/month", "-$15/month", "usage-priced", "on its plan", "no price"; '' when it costs nothing more. */
export function costWords(cost, currency) {
  if (!cost) return '';
  if (cost.status === 'priced') return `${money(cost.delta, currency, { signed: true })}/month`;
  if (cost.status === 'usage') return 'usage-priced';
  if (cost.status === 'included') return 'on its plan';
  if (cost.status === 'free') return 'free';
  return 'no price';
}

/** The total in a few words: "+$219/month (2 with no price, 1 usage-priced)". */
export function totalWords(costs, { short = false } = {}) {
  if (!costs || costs.pending || costs.error) return '';
  const extra = [costs.unpriced ? `${costs.unpriced} with no price` : '', costs.usage ? `${costs.usage} usage-priced` : ''].filter(Boolean).join(', ');
  if (!costs.priced) return extra && !short ? `no figure (${extra})` : '';
  if (short) return `${money(costs.total, costs.currency, { signed: true })}/month`;
  return `${money(costs.total, costs.currency, { signed: true })}/month${extra ? ` (${extra})` : ''}`;
}

/** The lines a change's detail says about its cost. */
export function costLines(cost, currency) {
  if (!cost) return [];
  if (cost.status === 'priced') {
    const sides = [cost.before ? `was ${money(cost.before.monthly, currency)}/month: ${cost.before.label}` : '', cost.after ? `will be ${money(cost.after.monthly, currency)}/month: ${cost.after.label}` : ''].filter(Boolean);
    return [`Cost: ${money(cost.delta, currency, { signed: true })}/month (${sides.join('; ')})`, `  Azure's retail prices in ${currency}, pay-as-you-go, ${HOURS_A_MONTH} hours a month`];
  }
  if (cost.status === 'usage') return [`Cost: usage-priced (${cost.note})`];
  if (cost.status === 'included') return [`Cost: nothing of its own, it runs on ${cost.note.replace(/^on /, '')}`];
  if (cost.status === 'free') return ['Cost: free'];
  return [`Cost: no price (${cost.note})`];
}
