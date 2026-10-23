// What Sonar asks Application Insights, and the rules round it. Pure, so it's tested without Azure.
// Queries use the classic schema (requests, exceptions, traces…), which the App Insights query API
// answers for workspace-based components too.

/** The time ranges `t` steps through, as the query API's ISO 8601 durations. */
export const TIMESPANS = [
  { label: '1h', iso: 'PT1H', hours: 1 },
  { label: '24h', iso: 'P1D', hours: 24 },
  { label: '7d', iso: 'P7D', hours: 24 * 7 },
  { label: '30d', iso: 'P30D', hours: 24 * 30 },
];

/** The tables and columns completion offers (the common ones; a query may use any). */
export const SCHEMA = {
  requests: ['timestamp', 'name', 'url', 'resultCode', 'success', 'duration', 'operation_Id', 'operation_Name', 'cloud_RoleName', 'cloud_RoleInstance', 'client_IP', 'user_Id', 'customDimensions'],
  dependencies: ['timestamp', 'name', 'target', 'type', 'data', 'resultCode', 'success', 'duration', 'operation_Id', 'cloud_RoleName', 'customDimensions'],
  exceptions: ['timestamp', 'problemId', 'type', 'outerMessage', 'innermostMessage', 'method', 'assembly', 'severityLevel', 'details', 'operation_Id', 'operation_Name', 'cloud_RoleName', 'user_Id', 'customDimensions'],
  traces: ['timestamp', 'message', 'severityLevel', 'operation_Id', 'operation_Name', 'cloud_RoleName', 'customDimensions'],
  customEvents: ['timestamp', 'name', 'operation_Id', 'cloud_RoleName', 'user_Id', 'customDimensions', 'customMeasurements'],
  pageViews: ['timestamp', 'name', 'url', 'duration', 'operation_Id', 'client_Browser', 'client_City', 'user_Id'],
  availabilityResults: ['timestamp', 'name', 'location', 'success', 'duration', 'message'],
  performanceCounters: ['timestamp', 'category', 'counter', 'instance', 'value', 'cloud_RoleName'],
  customMetrics: ['timestamp', 'name', 'value', 'valueCount', 'valueSum', 'cloud_RoleName'],
};

export const OPERATORS = ['where', 'project', 'extend', 'summarize', 'order by', 'sort by', 'take', 'top', 'count', 'distinct', 'join', 'union', 'render', 'parse', 'mv-expand', 'make-series', 'ago(', 'bin(', 'count()', 'dcount(', 'avg(', 'percentile(', 'contains', 'has', 'startswith', '=='];

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** `| where cloud_RoleName == '<role>'`, or nothing for every app the component watches. */
export const roleFilter = (role) => (role ? ` | where cloud_RoleName == ${quote(role)}` : '');

/** The problems: exceptions grouped as Application Insights groups them (problemId), most frequent first. */
export function problemsQuery(role) {
  // arg_max brings the latest occurrence's timestamp and operation along, under their own names.
  return `exceptions${roleFilter(role)} | summarize count = count(), users = dcount(user_Id), first = min(timestamp), message = take_any(outerMessage), role = take_any(cloud_RoleName), arg_max(timestamp, operation_Id) by problemId, type | project problemId, type, count, users, first, last = timestamp, message, role, operation = operation_Id | order by count desc | take 100`;
}

/** How often each problem happened, hour by hour (or day by day over a long span), for the sparklines. */
export function trendQuery(role, timespan) {
  const bin = timespan.hours > 24 * 2 ? '1d' : timespan.hours > 1 ? '1h' : '5m';
  return `exceptions${roleFilter(role)} | summarize n = count() by problemId, bucket = bin(timestamp, ${bin}) | order by bucket asc`;
}

/** Everything that happened in one operation, in order: the end-to-end transaction. */
export function operationQuery(operationId) {
  return `union requests, dependencies, exceptions, traces | where operation_Id == ${quote(operationId)} | project timestamp, itemType, name = coalesce(name, type, message), detail = coalesce(tostring(resultCode), outerMessage, message, target), duration, success, cloud_RoleName | order by timestamp asc`;
}

/** The availability tests' results over the span, by test: how many ran, how many failed, when they last did. */
export const availabilityQuery = () =>
  'availabilityResults | summarize total = count(), failed = countif(success == false), last = max(timestamp), lastFailure = maxif(timestamp, success == false), locations = dcount(location), message = take_anyif(message, success == false) by name | order by failed desc, name asc';

/** The query Logs starts with for an app: its latest requests. */
export const starterQuery = (role) => `requests${roleFilter(role)} | order by timestamp desc | take 50`;

/** A table's rows as objects by column name. */
export const records = (table) => table.rows.map((r) => Object.fromEntries(table.columns.map((c, i) => [c.name, r[i]])));

/**
 * Sparkline characters for counts in `buckets` (each { problemId, bucket, n }), one per bucket from
 * the oldest to now, for every problem: { problemId: '▁▂▇' }.
 */
export function sparklines(trend, { width = 12 } = {}) {
  const stamps = [...new Set(trend.map((t) => String(t.bucket)))].sort();
  const keep = stamps.slice(-width);
  const by = {};
  for (const t of trend) (by[t.problemId] ??= {})[String(t.bucket)] = Number(t.n);
  const bars = '▁▂▃▄▅▆▇█';
  const out = {};
  for (const [id, counts] of Object.entries(by)) {
    const values = keep.map((s) => counts[s] ?? 0);
    const max = Math.max(1, ...values);
    out[id] = values.map((v) => (v ? bars[Math.min(7, Math.ceil((v / max) * 7))] : ' ')).join('');
  }
  return out;
}

/** The Application Insights component an app reports to, from its settings, among `components`. */
export function componentFor(settings, components) {
  const conn = settings?.APPLICATIONINSIGHTS_CONNECTION_STRING ?? '';
  const key = /InstrumentationKey=([^;\s]+)/i.exec(conn)?.[1] ?? settings?.APPINSIGHTS_INSTRUMENTATIONKEY;
  if (!key) return null;
  return components.find((c) => c.key?.toLowerCase() === key.toLowerCase()) ?? null;
}

const PROD = /prod|production|prd|live/i;

/**
 * Whether a target is production, so changing it asks you to type its name: by the app's name or its
 * resource group (every app's main slot is called "production", so slot names don't say).
 */
export const isProduction = (target) => PROD.test(target.name) || PROD.test(target.resourceGroup ?? '');

/** Settings that tell a secret from a plain value: hidden unless asked for. */
export const looksSecret = (name, value) => /key|secret|password|pwd|token|connection|conn_?str|sas/i.test(name) || /AccountKey=|SharedAccessSignature|Password=/i.test(String(value));

/**
 * How two sets of settings differ, by name: [{ name, a, b, change: 'only-a' | 'only-b' | 'differs' }],
 * the same ones left out. For comparing a slot with production, or a setting before and after an edit.
 */
export function settingsDiff(a, b) {
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => x.localeCompare(y));
  const out = [];
  for (const name of names) {
    if (!(name in b)) out.push({ name, a: a[name], change: 'only-a' });
    else if (!(name in a)) out.push({ name, b: b[name], change: 'only-b' });
    else if (a[name] !== b[name]) out.push({ name, a: a[name], b: b[name], change: 'differs' });
  }
  return out;
}

/**
 * A request row (from requests, with its url) as a request in a .http file, for Hail: its name as
 * the title, the method from the name ("GET /api/cart"), else GET. Null for a row without a url.
 */
export function hailRequest(row) {
  if (!row?.url) return null;
  const method = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.exec(row.name ?? '')?.[1]?.toUpperCase() ?? 'GET';
  return `### ${row.name ?? row.url}${row.resultCode ? ` (answered ${row.resultCode})` : ''}\n${method} ${row.url}\n`;
}

/** A value as one line for a grid cell: objects as JSON, times shortened, nothing as empty. */
export function cellText(value, type) {
  if (value == null) return '';
  if (type === 'datetime' && typeof value === 'string') return value.replace('T', ' ').replace(/\.\d+Z$|Z$/, '');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).replace(/\s*\n\s*/g, ' ⏎ ');
}

/** The word being typed at `cursor` in a query, and what completes it: tables, then the first table's columns, then operators. */
export function completeQuery(query, cursor) {
  const before = query.slice(0, cursor);
  const word = /[\w(.-]*$/.exec(before)[0];
  if (!word) return { word, items: [] };
  const table = /^\s*(\w+)/.exec(query)?.[1];
  const afterPipe = /\|[^|]*$/.test(before);
  const pool = !afterPipe && !/\s/.test(before.trim()) ? Object.keys(SCHEMA) : [...(SCHEMA[table] ?? []), ...OPERATORS, ...Object.keys(SCHEMA)];
  const w = word.toLowerCase();
  const items = [...new Set(pool)].filter((p) => p.toLowerCase().startsWith(w) && p.toLowerCase() !== w).slice(0, 6);
  return { word, items };
}
