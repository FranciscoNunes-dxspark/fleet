// /compare <connection|environment>: the schema here against another's, grouped as only here, only
// there and different, and the script that brings the other in line. The pure parts, then the UI
// against the demo, whose ClubB has drifted from ClubA.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { DIFF_SQL, alterRisk, buildExtras, compareText, definitionHash, schemaDiff, syncScript, typeRisk } from '../src/diff.js';
import { demoSession } from '../src/demo.js';
import { SCHEMA_SQL, buildSchema } from '../src/schema.js';
import { App } from '../src/ui/App.jsx';

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-compare-'));
  process.env.TRAWL_HOME = join(base, 'home');
  process.env.FAMILY_HOME = join(base, 'family');
});
after(() => rmSync(base, { recursive: true, force: true }));

async function read(database) {
  const s = demoSession({ name: 'demo', demo: true }, { database });
  return { schema: buildSchema((await s.run(SCHEMA_SQL)).sets), ...buildExtras((await s.run(DIFF_SQL)).sets) };
}

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const table = (name, columns) => ({ schema: 'dbo', name, kind: 'table', rows: 0, columns });
const side = (objects, { foreignKeys = [], indexes = [], defaults = new Map(), definitions = new Map() } = {}) => ({ schema: { objects, foreignKeys }, indexes, defaults, definitions });

test('the demo compared: grouped as only here, only there and different, with the definitions by hash', async () => {
  const [a, b] = [await read('ClubA'), await read('ClubB')];
  const text = compareText(schemaDiff(a, b), { here: 'demo/ClubA', there: 'dev/ClubB' });
  assert.match(text, /^Only in demo\/ClubA \(0\)\n  nothing$/m);
  assert.match(text, /^Only in dev\/ClubB \(2\)\n  table +dbo\.Stadiums: 4 columns\n  index +dbo\.Matches\.IX_Matches_PlayedOn: nonclustered \(\[PlayedOn\] DESC\)$/m);
  assert.match(text, /^Different \(2\)\n  column +dbo\.Players\.Shirt: type tinyint → smallint\n  view +dbo\.vTopScorers: definition [0-9a-f]{12} → [0-9a-f]{12}\n[\s\S]*- WHERE Goals > 0;/m);
  assert.match(text, /0 only in demo\/ClubA · 2 only in dev\/ClubB · 2 different$/);
  assert.match(compareText([], { here: 'a', there: 'b' }), /The schemas are the same/);
});

test('a definition hashes the same however it is indented, but not when a string in it changes', () => {
  const one = 'CREATE VIEW v AS\r\n  SELECT  a,\tb\r\n  FROM t WHERE x = \'a  b\';';
  assert.equal(definitionHash(one), definitionHash("CREATE OR ALTER VIEW v AS SELECT a, b FROM t WHERE x = 'a  b';"));
  assert.notEqual(definitionHash(one), definitionHash("CREATE VIEW v AS SELECT a, b FROM t WHERE x = 'a b';"));
  assert.equal(definitionHash(null), null);
});

test('which column changes keep every value, and which could lose some', () => {
  for (const [from, to] of [['nvarchar(50)', 'nvarchar(100)'], ['varchar(20)', 'nvarchar(20)'], ['nvarchar(50)', 'nvarchar(max)'], ['tinyint', 'int'], ['int', 'bigint'], ['int', 'decimal(12,2)'], ['decimal(10,2)', 'decimal(12,3)'], ['date', 'datetime2'], ['datetime2(3)', 'datetime2'], ['real', 'float'], ['char', 'varchar(10)']]) assert.equal(typeRisk(from, to), null, `${from} → ${to}`);
  assert.match(typeRisk('nvarchar(100)', 'nvarchar(50)'), /shorter/);
  assert.match(typeRisk('nvarchar(20)', 'varchar(20)'), /code page/);
  assert.match(typeRisk('int', 'smallint'), /smaller/);
  assert.match(typeRisk('decimal(12,2)', 'decimal(10,2)'), /fewer digits/);
  assert.match(typeRisk('bigint', 'decimal(10,0)'), /fewer whole digits/);
  assert.match(typeRisk('nvarchar(10)', 'int'), /may not convert/);
  assert.match(typeRisk('datetime2', 'datetime2(0)'), /fractions/);
  assert.match(alterRisk(col('A', 'int', { nullable: true }), col('A', 'int')), /NOT NULL fails while any row holds NULL/);
  assert.match(alterRisk(col('Id', 'int', { pk: true }), col('Id', 'bigint', { pk: true })), /primary key/);
  assert.equal(alterRisk(col('A', 'int'), col('A', 'bigint', { nullable: true })), null);
});

test('the script brings the other in line: keys on a changing column dropped first and made again after, a risky change commented out', () => {
  // There (the left, to change): Orders.ClubId is smallint, with a key and an index on it; Name is longer; Code has no default.
  const there = side(
    [table('Clubs', [col('Id', 'smallint', { pk: true })]), table('Orders', [col('Id', 'int', { pk: true }), col('ClubId', 'smallint'), col('Name', 'nvarchar(200)'), col('Code', 'int', { nullable: true })])],
    { foreignKeys: [{ name: 'FK_Orders_Clubs', from: 'dbo.Orders', to: 'dbo.Clubs', columns: [['ClubId', 'Id']] }], indexes: [{ table: 'dbo.Orders', name: 'IX_Orders_ClubId', unique: false, type: 'NONCLUSTERED', columns: '[ClubId]', included: '', filter: '' }] },
  );
  // Here (the right, to match): ClubId int, Name shorter, Code NOT NULL with a default, and a new table that refers to Orders.
  const here = side(
    [
      table('Clubs', [col('Id', 'smallint', { pk: true })]),
      table('Orders', [col('Id', 'int', { pk: true }), col('ClubId', 'int'), col('Name', 'nvarchar(100)'), col('Code', 'int')]),
      table('Lines', [col('Id', 'int', { pk: true, identity: true }), col('OrderId', 'int'), col('Qty', 'int')]),
    ],
    {
      foreignKeys: [{ name: 'FK_Orders_Clubs', from: 'dbo.Orders', to: 'dbo.Clubs', columns: [['ClubId', 'Id']] }, { name: 'FK_Lines_Orders', from: 'dbo.Lines', to: 'dbo.Orders', columns: [['OrderId', 'Id']] }],
      indexes: [{ table: 'dbo.Orders', name: 'IX_Orders_ClubId', unique: false, type: 'NONCLUSTERED', columns: '[ClubId]', included: '', filter: '' }, { table: 'dbo.Lines', name: 'IX_Lines_OrderId', unique: false, type: 'NONCLUSTERED', columns: '[OrderId]', included: '', filter: '' }],
      defaults: new Map([['dbo.orders.code', { name: 'DF_Orders_Code', definition: '((0))' }], ['dbo.lines.qty', { name: 'DF_Lines_Qty', definition: '((1))' }]]),
    },
  );
  there.defaults = new Map();
  const changes = schemaDiff(there, here);
  const script = syncScript(changes, { left: 'dev/Shop', right: 'prod/Shop', rightSchema: here.schema, rightDefinitions: here.definitions, rightIndexes: here.indexes, rightDefaults: here.defaults, leftSchema: there.schema, leftIndexes: there.indexes });
  const at = (re) => {
    const m = re.exec(script);
    assert.ok(m, `${re} in:\n${script}`);
    return m.index;
  };
  const dropFk = at(/^ALTER TABLE \[dbo\]\.\[Orders\] DROP CONSTRAINT \[FK_Orders_Clubs\]; -- stands on a column that changes/m);
  const dropIx = at(/^DROP INDEX \[IX_Orders_ClubId\] ON \[dbo\]\.\[Orders\]; -- stands on a column that changes/m);
  const create = at(/^CREATE TABLE \[dbo\]\.\[Lines\] \(\n  \[Id\] int IDENTITY\(1,1\) NOT NULL,\n  \[OrderId\] int NOT NULL,\n  \[Qty\] int NOT NULL CONSTRAINT \[DF_Lines_Qty\] DEFAULT \(\(1\)\)/m);
  const alter = at(/^ALTER TABLE \[dbo\]\.\[Orders\] ALTER COLUMN \[ClubId\] int NOT NULL;$/m);
  const remakeIx = at(/^CREATE NONCLUSTERED INDEX \[IX_Orders_ClubId\] ON \[dbo\]\.\[Orders\] \(\[ClubId\]\);$/m);
  const remakeFk = at(/^ALTER TABLE \[dbo\]\.\[Orders\] ADD CONSTRAINT \[FK_Orders_Clubs\] FOREIGN KEY \(\[ClubId\]\) REFERENCES \[dbo\]\.\[Clubs\] \(\[Id\]\);$/m);
  assert.ok(dropFk < dropIx && dropIx < create && create < alter && alter < remakeIx && remakeIx < remakeFk, 'drops first, then tables, columns, indexes, keys');
  at(/^CREATE NONCLUSTERED INDEX \[IX_Lines_OrderId\] ON \[dbo\]\.\[Lines\] \(\[OrderId\]\);$/m);
  // Made shorter: commented out with why. Made NOT NULL: the same, and its new default comes all the same.
  at(/^-- \[dbo\]\.\[Orders\]\.\[Name\]: nvarchar\(100\) is shorter than nvarchar\(200\): longer values don't fit\.\n-- ALTER TABLE \[dbo\]\.\[Orders\] ALTER COLUMN \[Name\] nvarchar\(100\) NOT NULL;$/m);
  at(/^-- \[dbo\]\.\[Orders\]\.\[Code\]: NOT NULL fails while any row holds NULL there: fill those in first\.\n-- ALTER TABLE \[dbo\]\.\[Orders\] ALTER COLUMN \[Code\] int NOT NULL;$/m);
  at(/^ALTER TABLE \[dbo\]\.\[Orders\] ADD CONSTRAINT \[DF_Orders_Code\] DEFAULT \(\(0\)\) FOR \[Code\];$/m);
  assert.equal((script.match(/FK_Orders_Clubs/g) ?? []).length, 2, 'dropped once, made once');
});

// A dev database besides the demo's two, to compare with; the project names it as staging.
const DEV = { name: 'dev', demo: true, server: 'demo', database: 'ClubB' };
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
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame();
const command = async (app, text) => {
  app.stdin.write('/');
  await type(app.stdin, text);
  app.stdin.write('\r');
};

test('/compare staging compares with the connection the environment names, s shows the script, y copies it and o opens it there', async () => {
  const project = join(base, 'shop');
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(join(project, '.fleet', 'project.json'), JSON.stringify({ default: 'local', environments: { local: { trawl: { connection: 'demo' } }, staging: { trawl: { connection: 'dev' } } } }));
  const copied = [];
  const config = { connections: [...DEMO_CONNECTIONS, DEV], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo', projectDir: project, clipboard: (t) => (copied.push(t), 'tool') })));
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, 'compare nowhere');
  await until(() => frame().includes('No connection or environment called nowhere.'), 'an unknown name');
  await command(app, 'compare staging');
  await until(() => frame().includes('Compare: demo/ClubA → dev/ClubB (staging)'), 'the comparison');
  assert.match(frame(), /Only in dev\/ClubB \(2\)/);
  assert.match(frame(), /s script/);
  app.stdin.write('s');
  await until(() => frame().includes('Script for dev/ClubB: brings it in line with demo/ClubA'), 'the script');
  // The other database loses what this one hasn't: the table only as a comment, and its index.
  assert.match(frame(), /-- DROP TABLE \[dbo\]\.\[Stadiums\];/);
  app.stdin.write('y');
  await until(() => copied.length === 1 && frame().includes('Script for dev/ClubB'), 'copied, and the script back on screen');
  assert.match(copied[0], /^DROP INDEX \[IX_Matches_PlayedOn\] ON \[dbo\]\.\[Matches\];$/m);
  assert.match(copied[0], /^-- \[dbo\]\.\[Players\]\.\[Shirt\]: tinyint is smaller than smallint: larger values don't fit\.$/m);
  assert.match(copied[0], /CREATE OR ALTER VIEW dbo\.vTopScorers AS[\s\S]*WHERE Goals > 0;/);
  app.stdin.write('o');
  await until(() => frame().includes('The script is in the console tab compare, on dev'), 'the script open on dev');
  assert.match(frame(), /dev +demo\/ClubB|│  dev/);
  app.unmount();
});

test('/compare alone still compares the pinned result', async () => {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo' })));
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, 'compare');
  await until(() => /pin/i.test(frame().split('\n').slice(-8).join('\n')), 'the pinned comparison asks for a pin');
  app.unmount();
});
