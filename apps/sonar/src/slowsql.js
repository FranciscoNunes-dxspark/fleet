// /slow-sql (alt+q in Problems): the app's slowest SQL calls, from Application Insights' dependencies,
// for Trawl to explain. Pure: actions.js sends the query and shows the list.
import { roleFilter } from './insights.js';
import { sqlTarget } from './incident.js';

/**
 * The SQL calls of the app in scope over the span, by server, database and command: how many, their
 * average and 95th percentile duration (ms), how many failed. The slowest (by p95) first.
 */
export const slowSqlQuery = (role) =>
  `dependencies${roleFilter(role)} | where type in~ ('SQL', 'Azure SQL') | summarize calls = count(), avg = avg(duration), p95 = percentile(duration, 95), failed = countif(success == false), last = max(timestamp) by target, data | order by p95 desc | take 50`;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * The rows slowSqlQuery answered, as the list to pick from: { list, withoutText }. Only the calls whose
 * command text Application Insights kept can be explained (the SDK leaves it out unless told to keep
 * it), so the others are only counted. Slowest p95 first, then the most called; at most `limit`.
 */
export function slowestSql(rows, { limit = 20 } = {}) {
  const withText = [];
  let withoutText = 0;
  for (const r of rows ?? []) {
    const sql = String(r.data ?? '').trim();
    const p95 = num(r.p95);
    if (p95 == null) continue;
    if (!sql) {
      withoutText++;
      continue;
    }
    const { server, database } = sqlTarget(r.target);
    withText.push({ sql, target: r.target ?? '', server, database, calls: num(r.calls) ?? 0, avg: num(r.avg), p95, failed: num(r.failed) ?? 0, last: r.last ?? null });
  }
  withText.sort((a, b) => b.p95 - a.p95 || b.calls - a.calls);
  return { list: withText.slice(0, limit), withoutText };
}

/**
 * One slow call as Trawl's `query` context: the SQL, its server and database, and what was measured
 * (`slow`: calls, avg and p95 in ms, over `span`, in `app`). A Trawl that knows `slow` explains it
 * (/explain-slow); an older one opens it in a console tab as any query.
 */
export function slowSqlContext(s, { span = null, app = null } = {}) {
  const round = (n) => (n == null ? null : Math.round(n));
  return {
    sql: s.sql,
    ...(s.server ? { server: s.server } : {}),
    ...(s.database ? { database: s.database } : {}),
    slow: { calls: s.calls, avg: round(s.avg), p95: round(s.p95), ...(s.failed ? { failed: s.failed } : {}), ...(span ? { span } : {}), ...(app ? { app } : {}) },
  };
}
