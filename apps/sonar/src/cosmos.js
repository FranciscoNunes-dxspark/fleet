// Cosmos DB accounts and what's in them, as Azure Resource Manager has it: the account's API, address,
// consistency and regions; its databases and containers (collections, for the MongoDB API) with their
// partition (shard) keys and throughput. Listing only: no documents, which need a data-plane role of
// Cosmos DB's own. Pure: the provider makes the calls (azure/arm.js cosmosAccounts, cosmosTree; demo.js).

const groupOf = (id) => /\/resourceGroups\/([^/]+)/i.exec(id ?? '')?.[1] ?? '';

/** The account's API, from its kind and capabilities: NoSQL, MongoDB, Cassandra, Table or Gremlin. */
export function apiOf(a) {
  const caps = (a.properties?.capabilities ?? []).map((c) => String(c.name ?? '').toLowerCase());
  if (/mongo/i.test(a.kind ?? '') || caps.includes('enablemongo')) return 'MongoDB';
  if (caps.includes('enablecassandra')) return 'Cassandra';
  if (caps.includes('enabletable')) return 'Table';
  if (caps.includes('enablegremlin')) return 'Gremlin';
  return 'NoSQL';
}

/** A Cosmos DB account (Microsoft.DocumentDB/databaseAccounts) as Sonar shows it. */
export function cosmosFrom(a) {
  const p = a.properties ?? {};
  const caps = (p.capabilities ?? []).map((c) => String(c.name ?? '').toLowerCase());
  const endpoint = p.documentEndpoint ?? null;
  return {
    type: 'cosmos',
    id: a.id,
    name: a.name,
    resourceGroup: groupOf(a.id),
    location: a.location,
    state: p.provisioningState === 'Succeeded' ? 'Online' : (p.provisioningState ?? 'Unknown'),
    api: apiOf(a),
    endpoint,
    host: endpoint ? endpoint.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') : null,
    consistency: p.consistencyPolicy?.defaultConsistencyLevel ?? '',
    regions: (p.locations ?? p.readLocations ?? []).map((l) => l.locationName).filter(Boolean),
    serverless: caps.includes('enableserverless'),
    freeTier: Boolean(p.enableFreeTier),
    localAuth: p.disableLocalAuth ? 'Entra only' : 'keys and Entra',
  };
}

/** A throughput setting ({database or container}/throughputSettings/default) as { manual } or { autoscale } RU/s. */
export function throughputFrom(t) {
  const r = t?.properties?.resource ?? {};
  if (r.autoscaleSettings?.maxThroughput) return { autoscale: Number(r.autoscaleSettings.maxThroughput) };
  if (r.throughput) return { manual: Number(r.throughput) };
  return null;
}

/** Throughput in words: "400 RU/s", "autoscale up to 4000 RU/s". */
export const throughputText = (t) => (!t ? '' : t.autoscale ? `autoscale up to ${t.autoscale} RU/s` : `${t.manual} RU/s`);

/** A container (or a MongoDB collection) as { name, partitionKey, ttl }. */
export function containerFrom(c) {
  const r = c.properties?.resource ?? {};
  const paths = r.partitionKey?.paths ?? Object.keys(r.shardKey ?? {});
  return { name: r.id ?? c.name, partitionKey: paths.join(', ') || '—', hierarchical: (r.partitionKey?.kind ?? '') === 'MultiHash', ttl: r.defaultTtl ?? null };
}

/** The portal's Data Explorer for the account, where its documents are. */
export const dataExplorerUrl = (account) => `https://portal.azure.com/#resource${account.id}/dataExplorer`;
