// /explain-slow: the statement made ready to plan (its parameters declared), the prompt Claude gets,
// and the console tab it leaves; the pure parts, then through the UI against the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { App } from '../src/ui/App.jsx';
import { decodeContext, encodeContext, takeLine } from '@fleet/kit/family.js';
import { DEFAULT_TYPE, bareName, declaredTypes, indexText, measuredText, parameterTypes, prepareStatement, slowConsoleText, slowPrompt, splitSuggestion, tablesIn, typeByName } from '../src/slow.js';

const col = (name, type, extra = {}) => ({ name, type, ...extra });
const ORDERS = { schema: 'dbo', name: 'Orders', kind: 'table', columns: [col('Id', 'int', { pk: true }), col('CustomerId', 'int'), col('Status', 'nvarchar(20)'), col('CreatedAt', 'datetime2')] };
const CUSTOMERS = { schema: 'sales', name: 'Customers', kind: 'table', columns: [col('Id', 'int', { pk: true }), col('Email', 'nvarchar(200)')] };
const schema = { objects: [ORDERS, CUSTOMERS, { schema: 'dbo', name: 'usp_x', kind: 'procedure', columns: [], params: [] }] };

test('the tables a statement names, quoted or not, found in the schema', () => {
  assert.deepEqual(tablesIn('SELECT * FROM [dbo].[Orders] o JOIN sales.Customers c ON c.Id = o.CustomerId', schema), [ORDERS, CUSTOMERS]);
  assert.deepEqual(tablesIn("UPDATE Orders SET Status = 'FROM sales.Customers' WHERE Id = 1", schema), [ORDERS]);
  assert.deepEqual(tablesIn('SELECT 1 FROM nowhere', schema), []);
});

test('a parameter\'s type: the column it is compared with, else its name, else nvarchar(4000); your DECLARE wins', () => {
  const sql = 'SELECT o.Id FROM [dbo].[Orders] AS [o] WHERE [o].[CustomerId] = @__customerId_0 AND @st <> o.Status AND o.CreatedAt > @since AND o.Id IN (@ids) AND Flag = @p0 AND @isOpen = 1';
  assert.deepEqual(parameterTypes(sql, schema), [
    { name: '@__customerId_0', type: 'int', from: 'column', column: 'dbo.Orders.CustomerId' },
    { name: '@st', type: 'nvarchar(20)', from: 'column', column: 'dbo.Orders.Status' },
    { name: '@since', type: 'datetime2', from: 'column', column: 'dbo.Orders.CreatedAt' },
    { name: '@ids', type: 'int', from: 'column', column: 'dbo.Orders.Id' },
    { name: '@p0', type: DEFAULT_TYPE, from: 'default' },
    { name: '@isOpen', type: 'bit', from: 'name' },
  ]);
  assert.deepEqual(parameterTypes('SELECT * FROM dbo.Orders WHERE Status = @s', schema, { declared: { '@s': 'varchar(5)' } }), [{ name: '@s', type: 'varchar(5)', from: 'declared' }]);
  assert.equal(bareName('@__orderId_12'), 'orderId');
  assert.equal(bareName('@p3'), '');
  assert.equal(typeByName('@customerId'), 'int');
  assert.equal(typeByName('@createdAt'), 'datetime2');
  assert.equal(typeByName('@format'), null);
  assert.equal(typeByName('@total'), 'decimal(18, 2)');
});

test('ready to plan: DECLAREd on SQL Server, NULL on Postgres and MySQL, strings left alone', () => {
  const p = prepareStatement('SELECT o.Id FROM dbo.Orders o WHERE o.CustomerId = @c AND o.Status = @p0;', { schema });
  assert.equal(p.script, 'DECLARE @c int, @p0 nvarchar(20);\nSELECT o.Id FROM dbo.Orders o WHERE o.CustomerId = @c AND o.Status = @p0;');
  assert.equal(p.note, '');
  const g = prepareStatement('SELECT * FROM dbo.Orders WHERE Id = 1 OR Status = @x + @y', { schema });
  assert.match(g.note, /^@y: the type is a guess/);
  assert.equal(prepareStatement('SELECT 1', { schema }).script, 'SELECT 1;');
  const pg = prepareStatement("SELECT * FROM t WHERE a = $1 AND b = $2 AND c = '$3' AND d = $1", { kind: 'postgres' });
  assert.equal(pg.script, "SELECT * FROM t WHERE a = NULL AND b = NULL AND c = '$3' AND d = NULL");
  assert.deepEqual(pg.params.map((x) => x.name), ['$1', '$2']);
  assert.equal(prepareStatement("SELECT * FROM t WHERE a = ? AND b = '?'", { kind: 'mysql' }).script, "SELECT * FROM t WHERE a = NULL AND b = '?'");
  assert.deepEqual(declaredTypes('DECLARE @a int, @b nvarchar(20), @t TABLE (x int);\nDECLARE @c decimal(18, 2)\nSELECT 1'), { '@a': 'int', '@b': 'nvarchar(20)', '@c': 'decimal(18, 2)' });
});

test("Claude's prompt: what was measured, the statement, its plan, the tables and their indexes, never rows", () => {
  const slow = { calls: 40, avg: 821, p95: 2400, failed: 2, span: '24h', app: 'contoso-api' };
  assert.equal(measuredText(slow), '40 calls over the last 24h (contoso-api): p95 2,400 ms, average 821 ms, 2 failed');
  assert.equal(measuredText({ calls: 1, p95: 3 }), '1 call: p95 3 ms');
  const indexes = new Map([['dbo.orders', [{ name: 'PK_Orders', columns: '[Id]', is_primary_key: true, is_unique: true, type_desc: 'CLUSTERED' }, { name: 'IX_Orders_Status', columns: '[Status]', included: '[CreatedAt]', is_unique: false, type_desc: 'NONCLUSTERED' }]]]);
  const idx = indexText([ORDERS, CUSTOMERS], indexes);
  assert.equal(idx, 'dbo.Orders: PK_Orders (Id) primary key, clustered\ndbo.Orders: IX_Orders_Status (Status) INCLUDE (CreatedAt) nonclustered\nsales.Customers: no indexes (a heap)');
  const sql = 'SELECT o.Id FROM dbo.Orders o WHERE o.CustomerId = @c';
  const prep = prepareStatement(sql, { schema });
  const prompt = slowPrompt({ sql, script: prep.script, plan: '  |--Clustered Index Scan(OBJECT:([shop].[dbo].[Orders].[PK_Orders]))', database: 'shop', slow, tables: [ORDERS], indexes: idx, params: prep.params });
  assert.match(prompt, /^Database: shop \(SQL Server\)\n\nMeasured in production by Application Insights: 40 calls over the last 24h/);
  assert.match(prompt, /Parameters \(types as declared for the plan\):\n@c int \(compared with dbo\.Orders\.CustomerId\)/);
  assert.match(prompt, /As planned:\nDECLARE @c int;/);
  assert.match(prompt, /Estimated plan \(SHOWPLAN_TEXT\):\n {2}\|--Clustered Index Scan/);
  assert.match(prompt, /Tables \(schema\.table\(column type \.\.\.\)\):\ndbo\.Orders\(Id int PK, CustomerId int, Status nvarchar\(20\), CreatedAt datetime2\)/);
  assert.match(prompt, /Their indexes:\ndbo\.Orders: PK_Orders/);
  assert.match(slowPrompt({ sql: 'SELECT 1', script: 'SELECT 1;', plan: '', database: 'x' }), /nothing \(the statement came from the console\)[\s\S]*\(none came back\)[\s\S]*\(none of its tables[\s\S]*\(not read\)/);
});

test("Claude's answer: its words as comments, its DDL as text in the console, the statement as planned under them", () => {
  const answer = 'The plan scans the clustered index for every customer.\n\n```sql\nCREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId) INCLUDE (Status)\n```\nIt costs a little on every insert.';
  const s = splitSuggestion(answer);
  assert.deepEqual(s.ddl, ['CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId) INCLUDE (Status)']);
  assert.match(s.note, /^The plan scans[\s\S]*every insert\.$/);
  const text = slowConsoleText({ where: 'shop-prod/shop', slow: { calls: 40, p95: 2400 }, note: s.note, ddl: s.ddl, script: 'DECLARE @c int;\nSELECT 1;', paramsNote: '' });
  const lines = text.split('\n');
  assert.equal(lines[0], '-- Slow in production on shop-prod/shop: 40 calls: p95 2,400 ms.');
  assert.ok(lines.includes('CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId) INCLUDE (Status);'));
  // Nothing of Claude's text is left uncommented but the DDL.
  assert.ok(lines.filter((l) => l && !l.startsWith('--')).every((l) => /^(CREATE INDEX|DECLARE|SELECT)/.test(l)));
  assert.match(text, /-- The statement, as planned\nDECLARE @c int;\nSELECT 1;\n$/);
  assert.equal(splitSuggestion('No index would help.').ddl.length, 0);
});

test("Sonar's slow query context reads back with what was measured; an old one without it still does", () => {
  const data = { sql: 'SELECT 1', server: 'srv', database: 'shop', slow: { calls: 3, avg: 10, p95: 20 } };
  assert.deepEqual(decodeContext(encodeContext('query', data)).data, data);
  assert.equal(decodeContext(encodeContext('query', { sql: 'SELECT 1' })).data.slow, undefined);
});

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-slow-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}
const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 2));
  }
};

test("a slow query taken from Sonar: on its database, planned (never run), Claude's index left in a console tab as text", async () => {
  const asked = [];
  const askClaude = async ({ prompt, system }) => {
    asked.push({ prompt, system });
    return 'It scans PK_Players for one club.\n\n```sql\nCREATE INDEX IX_Players_ClubId ON dbo.Players (ClubId) INCLUDE (Name, Goals)\n```';
  };
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo', askClaude })));
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Clubs'), 'the explorer');
    const slow = { calls: 120, avg: 640, p95: 2310, span: '24h', app: 'club-api' };
    app.stdin.write('/');
    await type(app.stdin, `take ${takeLine('query', { sql: 'SELECT p.Name, p.Goals FROM dbo.Players p WHERE p.ClubId = @__clubId_0 ORDER BY p.Goals DESC', server: 'demo', database: 'ClubB', slow })}`);
    app.stdin.write('\r');
    await until(() => frame().includes('Claude on the slow'), "Claude's answer");
    assert.equal(asked.length, 1);
    const { prompt } = asked[0];
    assert.match(prompt, /^Database: ClubB \(SQL Server\)/);
    assert.match(prompt, /120 calls over the last 24h \(club-api\): p95 2,310 ms, average 640 ms/);
    assert.match(prompt, /@__clubId_0 int \(compared with dbo\.Players\.ClubId\)/);
    assert.match(prompt, /As planned:\nDECLARE @__clubId_0 int;/);
    assert.match(prompt, /Clustered Index Scan/);
    assert.match(prompt, /dbo\.Players\(Id int PK, ClubId int/);
    assert.match(prompt, /dbo\.Players: PK_Players \(Id\) primary key/);
    assert.match(frame(), /CREATE INDEX IX_Players_ClubId/);
    app.stdin.write('\x1b');
    await until(() => /\[\d slow\]/.test(frame()), 'the console tab');
    assert.match(frame(), /demo\/ClubB/);
    assert.match(frame(), /CREATE INDEX IX_Players_ClubId ON dbo\.Players \(ClubId\) INCLUDE \(Name, Goals\);/);
    assert.match(frame(), /Its CREATE INDEX is in the console tab/);
  } finally {
    app.unmount();
  }
});
