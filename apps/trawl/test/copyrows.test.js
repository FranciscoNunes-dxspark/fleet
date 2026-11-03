// /copy-rows: rows to another connection with the rows they refer to, personal data made up. The pure
// builder, then the real UI against the demo, in app.test.js's style.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { DIALECTS } from '../src/dialects.js';
import { copyRefusal, copyScript, insertOrder, insertedRows, keyTuples, maskRows, maskingRules, parentSql, parseCopyRowsArgs, parseCopyrowsArgs, parseRuleChanges, personalKind, rowsSql, ruleText, selfOrder } from '../src/copyrows.js';
import { fakeValue } from '../src/generate.js';
import { demoSession } from '../src/demo.js';
import { App } from '../src/ui/App.jsx';

const KEYS = { enter: '\r', esc: '\x1b', down: '\x1b[B' };

let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-copy-'));
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
// A dev database besides the demo's two, to copy into.
const DEV = { name: 'dev', demo: true, server: 'demo', database: 'ClubB' };
function start(connection = 'demo', props = {}) {
  const config = { connections: [...DEMO_CONNECTIONS, DEV], history: [], ran: [], limit: 500, last: null };
  lastApp = render(React.createElement(App, { config, initialConnection: connection, ...props }));
  return lastApp;
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
  app.stdin.write(KEYS.enter);
};

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const clubs = { schema: 'dbo', name: 'Clubs', kind: 'table', columns: [col('Id', 'int', { pk: true, identity: true }), col('Name', 'nvarchar(100)')] };
const people = {
  schema: 'dbo',
  name: 'People',
  kind: 'table',
  columns: [col('Id', 'int', { pk: true, identity: true }), col('ClubId', 'int'), col('ManagerId', 'int', { nullable: true }), col('Name', 'nvarchar(100)'), col('Email', 'varchar(200)'), col('IBAN', 'varchar(34)'), col('Joined', 'date'), col('Total', 'int', { computed: true })],
};
const fks = [
  { name: 'FK_People_Clubs', from: 'dbo.People', to: 'dbo.Clubs', columns: [['ClubId', 'Id']] },
  { name: 'FK_People_Manager', from: 'dbo.People', to: 'dbo.People', columns: [['ManagerId', 'Id']] },
];
const set = (obj, rows) => ({ columns: obj.columns.map((c) => ({ name: c.name, type: c.type })), rows });

test('the arguments: a target, a table, a condition to the end, and --no-mask anywhere', () => {
  assert.deepEqual(parseCopyRowsArgs('dev dbo.Players --where Id < 5 AND ClubId = 1'), { target: 'dev', table: 'dbo.Players', where: 'Id < 5 AND ClubId = 1', mask: true });
  assert.deepEqual(parseCopyRowsArgs('--no-mask dev --where "Name = \'x\'"'), { target: 'dev', table: null, where: "Name = 'x'", mask: false });
  assert.throws(() => parseCopyRowsArgs('dev t --where'), /takes a condition/);
  assert.throws(() => parseCopyRowsArgs('a b c'), /Too many/);
});

test('personal columns by name, and fakes that are the same for the same value and keep their shape', () => {
  for (const [c, k] of [['Email', 'email'], ['mobile_phone', 'phone'], ['FirstName', 'first'], ['last_name', 'last'], ['AddressLine1', 'street'], ['City', 'city'], ['PostalCode', 'zip'], ['DateOfBirth', 'birth'], ['SSN', 'scramble'], ['NIF', 'scramble'], ['IBAN', 'scramble'], ['CardNumber', 'scramble'], ['PassportNo', 'scramble'], ['IpAddress', 'ip'], ['LastLoginIp', 'ip']]) assert.equal(personalKind(c, 'Customers'), k, c);
  assert.equal(personalKind('Name', 'Players'), 'person');
  assert.equal(personalKind('Name', 'Clubs'), null);
  assert.equal(personalKind('Membership', 'Clubs'), null);
  assert.equal(personalKind('Goals', 'Players'), null);
  const a = fakeValue('email', 'ana@club.pt', col('Email', 'varchar(200)'));
  assert.equal(fakeValue('email', 'ana@club.pt', col('Email', 'varchar(200)')), a);
  assert.notEqual(fakeValue('email', 'rui@club.pt', col('Email', 'varchar(200)')), a);
  assert.match(a, /@example\.com$/);
  const iban = fakeValue('scramble', 'PT50000201231234567890154', col('IBAN', 'varchar(34)'));
  assert.match(iban, /^[A-Z]{2}\d{23}$/);
  assert.notEqual(iban, 'PT50000201231234567890154');
  assert.ok(fakeValue('birth', new Date('1990-05-03'), col('Born', 'date')) instanceof Date);
  assert.equal(fakeValue('first', null, col('FirstName', 'nvarchar(50)')), null);
  const rows = [[1, 1, null, 'Ana Silva', 'ana@club.pt', 'PT50000201231234567890154', new Date('2020-01-01'), 0], [2, 1, 1, 'Ana Silva', 'ana@club.pt', 'PT50000201231234567890154', new Date('2020-01-01'), 0]];
  const m = maskRows(people, set(people, rows));
  assert.deepEqual(m.masked, ['Name', 'Email', 'IBAN']);
  assert.notEqual(m.rows[0][3], 'Ana Silva');
  assert.deepEqual(m.rows[0].slice(3, 6), m.rows[1].slice(3, 6));
  assert.deepEqual(m.rows[0].slice(0, 3), [1, 1, null]);
});

test('the reads, the order parents first, and a table referring to itself', () => {
  const d = DIALECTS.sqlserver;
  assert.equal(rowsSql(d, people, { where: 'Id < 3', limit: 500 }), '-- trawl:copy-rows read\nSELECT TOP (500) * FROM [dbo].[People] WHERE Id < 3;');
  const s = set(people, [[3, 2, 1, 'C', 'c@x', 'X', null, 0], [1, 1, null, 'A', 'a@x', 'X', null, 0], [2, 1, 1, 'B', 'b@x', 'X', null, 0]]);
  assert.deepEqual(keyTuples(s, ['ClubId']), [[2], [1]]);
  assert.deepEqual(parentSql(d, clubs, ['Id'], [[2], [1]]), ['-- trawl:copy-rows read\nSELECT * FROM [dbo].[Clubs] WHERE [Id] IN (2, 1);']);
  assert.deepEqual(parentSql(DIALECTS.postgres, clubs, ['Id', 'Name'], [[1, "O'Neil"]]), [`-- trawl:copy-rows read\nSELECT * FROM "dbo"."Clubs" WHERE ("Id" = 1 AND "Name" = 'O''Neil');`]);
  const groups = new Map([['dbo.People', { obj: people, set: s }], ['dbo.Clubs', { obj: clubs, set: set(clubs, [[1, 'A'], [2, 'B']]) }]]);
  assert.deepEqual(insertOrder(groups, fks), { order: ['dbo.Clubs', 'dbo.People'], cycle: false });
  const ordered = selfOrder(people, s, fks).map((r) => r[0]);
  assert.ok(ordered.indexOf(1) < ordered.indexOf(3) && ordered.indexOf(1) < ordered.indexOf(2), `the manager first: ${ordered}`);
  assert.equal(copyRefusal({ ...clubs, columns: [col('Name', 'nvarchar(10)')] }), 'dbo.Clubs has no primary key, so a row already in the target can\'t be told from a new one');
  assert.equal(copyRefusal(clubs), null);
});

test('thousands of rows referring to each other are ordered in a moment, managers first', () => {
  // Read newest first, each row managed by one with half its Id.
  const n = 5000;
  const s = set(people, Array.from({ length: n }, (_, i) => [n - i, 1, n - i > 1 ? Math.floor((n - i) / 2) : null, `P${n - i}`, 'p@x', 'X', null, 0]));
  const started = performance.now();
  const ordered = selfOrder(people, s, fks);
  assert.ok(performance.now() - started < 1000, 'ordered in under a second');
  const at = new Map(ordered.map((r, i) => [r[0], i]));
  assert.equal(ordered.length, n);
  for (const r of ordered) if (r[2] != null) assert.ok(at.get(r[2]) < at.get(r[0]), `${r[2]} before ${r[0]}`);
});

test('the script skips rows already there, each kind its own way', () => {
  const tables = [{ obj: clubs, set: set(clubs, []), rows: [[1, 'Club A']] }, { obj: people, set: set(people, []), rows: [[1, 1, null, 'A', 'a@x', 'X', new Date('2020-01-02T00:00:00Z'), 5]] }];
  const ss = copyScript(tables, DIALECTS.sqlserver, { head: ['from prod'] });
  assert.equal(ss.rows, 2);
  assert.match(ss.script, /^-- trawl:copy-rows insert\n-- from prod\nSET XACT_ABORT ON;\nBEGIN TRANSACTION;/);
  assert.match(ss.script, /SET IDENTITY_INSERT \[dbo\]\.\[Clubs\] ON;\nIF NOT EXISTS \(SELECT 1 FROM \[dbo\]\.\[Clubs\] WHERE \[Id\] = 1\) INSERT INTO \[dbo\]\.\[Clubs\] \(\[Id\], \[Name\]\) VALUES \(1, N'Club A'\);\nSET IDENTITY_INSERT \[dbo\]\.\[Clubs\] OFF;/);
  // The computed column is left out.
  assert.match(ss.script, /INSERT INTO \[dbo\]\.\[People\] \(\[Id\], \[ClubId\], \[ManagerId\], \[Name\], \[Email\], \[IBAN\], \[Joined\]\) VALUES \(1, 1, NULL, N'A', 'a@x', 'X', '2020-01-02'\);/);
  assert.match(ss.script, /COMMIT TRANSACTION;\n$/);
  const pg = copyScript(tables, DIALECTS.postgres).script;
  assert.match(pg, /^-- trawl:copy-rows insert\nBEGIN;/);
  assert.match(pg, /INSERT INTO "dbo"."Clubs" \("Id", "Name"\) OVERRIDING SYSTEM VALUE VALUES \(1, 'Club A'\) ON CONFLICT DO NOTHING;/);
  const my = copyScript(tables, DIALECTS.mysql).script;
  assert.match(my, /START TRANSACTION;/);
  assert.match(my, /INSERT IGNORE INTO `dbo`.`Clubs` \(`Id`, `Name`\) VALUES \(1, 'Club A'\);/);
  assert.equal(insertedRows(['1 row affected', '2 rows affected', 'other']), 3);
});

test('/copy-rows copies the rows on screen and the clubs they refer to, masked, after showing the script', async () => {
  // What runs on dev, as it gets there.
  const ran = [];
  const open = (conn, opts) => {
    const s = demoSession(conn, opts);
    if (conn.name !== 'dev') return s;
    const run = s.run;
    s.run = (script, o) => (ran.push(script), run(script, o));
    return s;
  };
  const app = start('demo', { open });
  await until(() => frame().includes('Clubs'), 'the explorer');
  app.stdin.write(KEYS.down);
  await until(() => /❯ +T Players/.test(frame()), 'the cursor on Players');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Rui Costa'), 'the players');
  await command(app, 'copy-rows dev');
  await until(() => frame().includes('Insert up to 15 rows into dev (ClubB)?'), 'the question under the script');
  assert.match(frame(), /12 rows of dbo\.Players, and the rows they refer to in dbo\.Clubs: from demo\/ClubA to dev\/ClubB\./);
  assert.match(frame(), /Personal data made up/);
  assert.match(frame(), /SET IDENTITY_INSERT \[dbo\]\.\[Clubs\] ON;/);
  app.stdin.write('1');
  await until(() => frame().includes('15 rows went in'), 'the rows copied');
  const script = ran.find((x) => x.startsWith('-- trawl:copy-rows insert'));
  // Parents first, and the players' names made up (the clubs' aren't people's).
  assert.ok(script.indexOf('[dbo].[Clubs]') < script.indexOf('[dbo].[Players]'));
  assert.match(script, /Personal data made up \(the same value always gets the same fake, so joins still meet\): Players\.Name\./);
  assert.match(script, /N'Club A FC'/);
  assert.doesNotMatch(script, /Rui Costa|Ana Silva/);
  assert.equal((script.match(/IF NOT EXISTS/g) ?? []).length, 15);
  app.unmount();
});

test('C in the Explorer picks the target, and a production target is refused', async () => {
  const app = start();
  await until(() => frame().includes('Clubs'), 'the explorer');
  await command(app, 'copy-rows demo-prod dbo.Clubs');
  await until(() => frame().includes('demo-prod is production: /copy-rows only writes to a connection that is neither'), 'production refused');
  app.stdin.write('\x1bc');
  await until(() => frame().includes("Copy dbo.Clubs's rows to"), 'the targets');
  assert.match(frame(), /❯ dev/);
  assert.doesNotMatch(frame(), /❯ demo-prod|^│ +demo-prod/m);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Insert up to 3 rows into dev (ClubB)?'), 'the question');
  app.stdin.write('2');
  await until(() => !frame().includes('Insert up to 3 rows'), 'the question answered no');
  assert.doesNotMatch(frame(), /went in/);
  app.unmount();
});

// /copyrows: the newer form, with a preview of each column's rule, a key already there stopping it,
// and production asked about rather than refused.
test('/copyrows arguments: a table to a target, where up to limit, and --keep/--mask anywhere', () => {
  const a = parseCopyrowsArgs('dbo.Players to dev where ClubId = 1 AND Goals > 0 limit 20 --keep Name --mask Shirt,Position');
  assert.deepEqual({ ...a, overrides: [...a.overrides] }, { table: 'dbo.Players', target: 'dev', where: 'ClubId = 1 AND Goals > 0', limit: 20, overrides: [['name', 'keep'], ['shirt', 'mask'], ['position', 'mask']], mask: true });
  assert.equal(parseCopyrowsArgs('').table, null);
  assert.equal(parseCopyrowsArgs('t to staging').where, null);
  assert.throws(() => parseCopyrowsArgs('t dev'), /Which table, to where/);
  assert.throws(() => parseCopyrowsArgs('t to dev where'), /where takes a condition/);
  assert.throws(() => parseCopyrowsArgs('t to dev --keep'), /take a column/);
  assert.throws(() => parseCopyrowsArgs('t to dev limit 0'), /above 0/);
  assert.deepEqual([...parseRuleChanges('Email=keep, Players.Token = null; Name mask')], [['email', 'keep'], ['players.token', 'null'], ['name', 'mask']]);
  assert.throws(() => parseRuleChanges('Email=shuffle'), /isn't a column and a rule/);
});

test('secrets become NULL (scrambled where NOT NULL), flags and timestamps named like personal data stay, and overrides win', () => {
  for (const c of ['PasswordHash', 'password_salt', 'RefreshToken', 'ApiKey', 'SecurityStamp']) assert.equal(personalKind(c, 'Users', 'nvarchar(200)'), 'secret', c);
  for (const c of ['AccountNumber', 'BankAccount', 'SWIFT']) assert.equal(personalKind(c, 'Users', 'varchar(34)'), 'scramble', c);
  assert.equal(personalKind('EmailConfirmed', 'Users', 'bit'), null);
  assert.equal(personalKind('TokenExpiresAt', 'Users', 'datetime2'), null);
  assert.equal(personalKind('BirthDate', 'Users', 'date'), 'birth');
  assert.equal(personalKind('Origin', 'Visits', 'inet'), 'ip');
  const users = { schema: 'dbo', name: 'Users', kind: 'table', columns: [col('Id', 'int', { pk: true }), col('Email', 'varchar(200)'), col('PasswordHash', 'varbinary(64)', { nullable: true }), col('Token', 'char(32)'), col('Notes', 'nvarchar(100)', { nullable: true })] };
  const rules = maskingRules(users, users.columns, { overrides: new Map([['notes', 'mask'], ['users.email', 'keep']]) });
  assert.deepEqual(rules.map((r) => [r.name, r.rule, r.kind ?? null]), [['Id', 'keep', null], ['Email', 'keep', null], ['PasswordHash', 'null', null], ['Token', 'fake', 'scramble'], ['Notes', 'fake', 'scramble']]);
  assert.match(rules[3].why, /NOT NULL, so scrambled/);
  assert.deepEqual(rules.map(ruleText), ['kept', 'kept', 'NULL', 'made up: scrambled, letters for letters and digits for digits', 'made up: scrambled, letters for letters and digits for digits']);
  const m = maskRows(users, set(users, [[1, 'a@x.pt', Buffer.from('ff', 'hex'), 'abcdef0123456789abcdef0123456789', 'Rang 912 345 678']]), { rules });
  assert.deepEqual(m.rows[0].slice(0, 3), [1, 'a@x.pt', null]);
  assert.match(m.rows[0][3], /^[a-z]{6}\d{10}[a-z]{6}\d{10}$/);
  assert.equal(m.rows[0][4].length, 'Rang 912 345 678'.length);
});

test('a table that stops on a key already there THROWs saying which, before its plain INSERT', () => {
  const tables = [{ obj: clubs, set: set(clubs, []), rows: [[1, 'Club A']] }, { obj: people, set: set(people, []), rows: [[7, 1, null, "O'Neil", 'a@x', 'X', null, 0]], stop: true }];
  const ss = copyScript(tables, DIALECTS.sqlserver).script;
  assert.match(ss, /IF NOT EXISTS \(SELECT 1 FROM \[dbo\]\.\[Clubs\] WHERE \[Id\] = 1\) INSERT INTO \[dbo\]\.\[Clubs\]/);
  assert.match(ss, /^IF EXISTS \(SELECT 1 FROM \[dbo\]\.\[People\] WHERE \[Id\] = 7\) THROW 50000, N'dbo\.People has a row with Id = 7 already, so nothing was copied\.', 1;\nINSERT INTO \[dbo\]\.\[People\] \([^)]*\) VALUES \(7, 1, NULL, N'O''Neil'/m);
  const pg = copyScript(tables, DIALECTS.postgres).script;
  assert.match(pg, /INSERT INTO "dbo"\."People" \([^)]*\) OVERRIDING SYSTEM VALUE VALUES \(7[^\n]*\);\n/);
  assert.doesNotMatch(pg.split('"dbo"."People"')[1], /ON CONFLICT/);
  assert.match(copyScript(tables, DIALECTS.mysql).script, /^INSERT INTO `dbo`\.`People`/m);
});

test('/copyrows previews each column, takes a changed rule in the question, and copies masked rows the target lacks', async () => {
  const ran = [];
  const open = (conn, opts) => {
    const s = demoSession(conn, opts);
    if (conn.name !== 'dev') return s;
    const run = s.run;
    s.run = (script, o) => (ran.push(script), run(script, o));
    return s;
  };
  const app = start('demo', { open });
  await until(() => frame().includes('Clubs'), 'the explorer');
  // ClubA has Italian translations ClubB hasn't: nothing there stops them.
  await command(app, "copyrows i18n.Translations to dev where Culture = N'it-it' limit 2 --mask Value");
  await until(() => frame().includes('Insert 2 rows into dev (ClubB)?'), 'the question under the preview');
  assert.match(frame(), /What each column gets/);
  assert.match(frame(), /Value +made up: scrambled, letters for letters and digits for digits \(asked for\)/);
  assert.match(frame(), /Change a column's rule/);
  app.stdin.write('3');
  await until(() => frame().includes('Which column, and what does it get?'), 'the rule asked for');
  await type(app.stdin, 'Value=keep');
  app.stdin.write(KEYS.enter);
  await until(() => /Value +kept \(kept as asked\)/.test(frame()) && frame().includes('Insert 2 rows'), 'the preview again, Value kept');
  app.stdin.write('1');
  await until(() => frame().includes('2 rows went in'), 'the rows copied');
  const script = ran.find((x) => x.startsWith('-- trawl:copy-rows insert'));
  assert.match(script, /IF EXISTS \(SELECT 1 FROM \[i18n\]\.\[Translations\] WHERE \[ResourceKey\] = N'GameResult_1' AND \[Culture\] = N'it-it'\) THROW 50000/);
  assert.match(script, /N'Vittoria'/);
  app.unmount();
});

test('/copyrows stops at a key the target has, and asks before writing to production', async () => {
  const app = start('demo');
  await until(() => frame().includes('Clubs'), 'the explorer');
  // dev's ClubB has the same players' keys.
  await command(app, 'copyrows dbo.Players to dev limit 2');
  await until(() => frame().includes('Insert 4 rows into dev (ClubB)?'), 'the question: two players and their two clubs');
  assert.match(frame(), /Name +made up: a person's name \(by its name\)/);
  app.stdin.write('1');
  await until(() => frame().includes('dbo.Players has a row with Id = 1 already, so nothing was copied.'), 'the copy stopped');
  assert.doesNotMatch(frame(), /went in/);
  await command(app, 'copyrows dbo.Clubs to demo-prod');
  await until(() => frame().includes('Insert 3 rows into demo-prod'), 'production previewed, not refused');
  app.stdin.write('1');
  await until(() => frame().includes('demo-prod is production. Copy 3 rows into it?'), 'the production question');
  assert.match(frame(), /demo-prod is a production connection \(--prod\)\./);
  app.stdin.write('2');
  await until(() => !frame().includes('is production. Copy'), 'answered no');
  assert.doesNotMatch(frame(), /copy 3 rows to demo-prod/);
  app.unmount();
});
