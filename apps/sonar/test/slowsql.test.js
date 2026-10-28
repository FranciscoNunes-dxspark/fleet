// /slow-sql: the app's slowest SQL calls, for Trawl's /explain-slow; the pure parts and through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { contextIn, decodeContext, encodeContext } from '@fleet/kit/family.js';
import { slowSqlContext, slowSqlQuery, slowestSql } from '../src/slowsql.js';
import { KEYS, start, tempHome, until } from './helpers.js';

test('the query: SQL dependencies of the app in scope, by target and command, slowest p95 first', () => {
  assert.equal(
    slowSqlQuery('contoso-api'),
    "dependencies | where cloud_RoleName == 'contoso-api' | where type in~ ('SQL', 'Azure SQL') | summarize calls = count(), avg = avg(duration), p95 = percentile(duration, 95), failed = countif(success == false), last = max(timestamp) by target, data | order by p95 desc | take 50",
  );
  assert.match(slowSqlQuery(null), /^dependencies \| where type in~/);
});

test('the slowest, with their command text; those without it only counted', () => {
  const rows = [
    { target: 'srv.database.windows.net | shop', data: 'SELECT 1', calls: 900, avg: 2.4, p95: 5, failed: 0 },
    { target: 'srv.database.windows.net | shop', data: 'SELECT * FROM dbo.Orders WHERE CustomerId = @c', calls: 40, avg: 820.6, p95: 2400.4, failed: 2, last: '2026-10-27T10:00:00Z' },
    { target: 'srv.database.windows.net | shop', data: '', calls: 10, avg: 5000, p95: 9000 },
    { target: 'other', data: 'SELECT 2', calls: 70, avg: 2, p95: 5 },
    { target: 'srv', data: 'SELECT 3', calls: 1, p95: null },
  ];
  const { list, withoutText } = slowestSql(rows);
  assert.equal(withoutText, 1);
  assert.deepEqual(list.map((s) => s.sql), ['SELECT * FROM dbo.Orders WHERE CustomerId = @c', 'SELECT 1', 'SELECT 2']);
  assert.deepEqual(list[0], { sql: 'SELECT * FROM dbo.Orders WHERE CustomerId = @c', target: 'srv.database.windows.net | shop', server: 'srv.database.windows.net', database: 'shop', calls: 40, avg: 820.6, p95: 2400.4, failed: 2, last: '2026-10-27T10:00:00Z' });
  assert.equal(list[2].database, null);
  assert.equal(slowestSql(rows, { limit: 1 }).list.length, 1);
  assert.deepEqual(slowestSql(undefined), { list: [], withoutText: 0 });
});

test("one as Trawl's query context, with what was measured; it reads back whole", () => {
  const [s] = slowestSql([{ target: 'srv.database.windows.net | shop', data: 'SELECT 1', calls: 40, avg: 820.6, p95: 2400.4, failed: 2 }]).list;
  const data = slowSqlContext(s, { span: '24h', app: 'contoso-api' });
  assert.deepEqual(data, { sql: 'SELECT 1', server: 'srv.database.windows.net', database: 'shop', slow: { calls: 40, avg: 821, p95: 2400, failed: 2, span: '24h', app: 'contoso-api' } });
  assert.deepEqual(decodeContext(encodeContext('query', data)), { kind: 'query', data });
  assert.deepEqual(slowSqlContext({ sql: 'x', server: null, database: null, calls: 1, avg: null, p95: 3, failed: 0 }), { sql: 'x', slow: { calls: 1, avg: null, p95: 3 } });
});

let cleanup;
before(() => {
  cleanup = tempHome();
});
after(() => cleanup());

test('alt+q in Problems lists the slowest SQL; ↵ copies one for Trawl with its durations', async () => {
  const copied = [];
  const app = start({ copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('j');
    app.stdin.write('j');
    await until(() => /❯ ● contoso-api/.test(frame()), 'contoso-api');
    app.stdin.write('p');
    await until(() => /\d+ problems/.test(frame()), 'its problems');
    app.stdin.write('\x1bq');
    await until(() => frame().includes('The slowest SQL of contoso-api'), 'the list');
    // The deadlocking update waited longest; the order lookup is the slow read under it.
    assert.match(frame(), /❯ p95 4,200 ms.*UPDATE Ord/);
    app.stdin.write('j');
    await until(() => /❯ p95 [\d,]+ ms.*contoso-sql-prod\.database\.windows\.net \| contoso {2}SELECT o\.I/.test(frame()), 'the order lookup');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Copied for Trawl: paste it into Trawl's prompt"), 'copied for Trawl');
    const c = contextIn(copied.at(-1));
    assert.equal(c.kind, 'query');
    assert.match(c.data.sql, /^SELECT o\.Id, o\.Status/);
    assert.equal(c.data.server, 'contoso-sql-prod.database.windows.net');
    assert.equal(c.data.database, 'contoso');
    assert.equal(c.data.slow.app, 'contoso-api');
    assert.ok(c.data.slow.p95 >= c.data.slow.avg && c.data.slow.calls > 0);
  } finally {
    app.unmount();
  }
});
