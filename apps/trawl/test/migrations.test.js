import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECTS } from '../src/dialects.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, crc32, createPlainSql, drizzleHash, drizzleOut, fitsFolder, flywayChecksum, historySql, migrationStatus, nextRank, parseFlywayName, pickHistory, prismaChecksum, prismaMatches, probeSql, recordSql, statusText } from '../src/migrations.js';
import { migrationFiles } from '../src/actions.js';

const { sqlserver: MS, postgres: PG, mysql: MY } = DIALECTS;

test("crc32 is the standard one, and Flyway's checksum ignores line breaks and a byte order mark", () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  // Kept signed, as flyway_schema_history's int column has it.
  assert.equal(flywayChecksum('123456789'), 0xcbf43926 | 0);
  assert.ok(flywayChecksum('123456789') < 0);
  const text = 'CREATE TABLE t (\n  id int\n);\n';
  assert.equal(flywayChecksum(text), flywayChecksum(text.replace(/\n/g, '\r\n')));
  assert.equal(flywayChecksum(text), flywayChecksum(`﻿${text}`));
  // Lines are read one at a time, so the breaks between them count for nothing.
  assert.equal(flywayChecksum('ab\ncd'), crc32(Buffer.from('abcd')) | 0);
  assert.notEqual(flywayChecksum(text), flywayChecksum(text.replace('id', 'Id')));
  assert.equal(flywayChecksum('é'), crc32(Buffer.from('é', 'utf8')) | 0);
});

test('Flyway names: versions with dots or underscores, descriptions, repeatables; others are null', () => {
  assert.deepEqual(parseFlywayName('V1__Create_clubs.sql'), { prefix: 'V', version: '1', description: 'Create clubs' });
  assert.deepEqual(parseFlywayName('V1_2__x.sql'), { prefix: 'V', version: '1.2', description: 'x' });
  assert.deepEqual(parseFlywayName('v2.10.3__Add.sql'), { prefix: 'V', version: '2.10.3', description: 'Add' });
  assert.deepEqual(parseFlywayName('R__Views.sql'), { prefix: 'R', version: null, description: 'Views' });
  assert.equal(parseFlywayName('R1__x.sql'), null);
  assert.equal(parseFlywayName('V__x.sql'), null);
  assert.equal(parseFlywayName('V1_x.sql'), null);
  assert.equal(parseFlywayName('001_init.sql'), null);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('1.0', '1'), 0);
  assert.equal(compareVersions('2', '10'), -1);
});

const file = (path, text = `-- ${path}\nSELECT 1;\n`) => ({ path, text });
const row = (rank, version, script, text, extra = {}) => ({ installed_rank: rank, version, description: script, type: 'SQL', script, checksum: text == null ? null : flywayChecksum(text), installed_by: 'me', installed_on: new Date('2026-01-02T10:00:00Z'), execution_time: 5, success: true, ...extra });

test('Flyway: applied, changed (by checksum), pending in version order, missing, failed, below the baseline, repeatables', () => {
  const v1 = file('V1__One.sql');
  const v2 = file('V2__Two.sql');
  const files = [file('V10__Ten.sql'), v2, v1, file('sub/V3__Three.sql'), file('R__Views.sql', 'CREATE VIEW v AS SELECT 1;'), file('U2__Undo.sql'), file('notes.sql'), file('V0_5__Old.sql'), file('V4__Broken.sql')];
  const rows = [
    row(1, '0.9', '<< Flyway Baseline >>', null, { type: 'BASELINE' }),
    row(2, '1', 'V1__One.sql', v1.text),
    row(3, '2', 'V2__Two.sql', 'something else'),
    row(4, '1.5', 'V1_5__Gone.sql', 'x'),
    row(5, '4', 'V4__Broken.sql', 'y', { success: 0 }),
    row(6, null, 'R__Views.sql', 'CREATE VIEW v AS SELECT 0;'),
  ];
  const s = migrationStatus({ tool: 'flyway', files, rows });
  const by = Object.fromEntries(s.entries.map((e) => [e.script, e]));
  assert.equal(by['V0_5__Old.sql'].status, 'baseline');
  assert.equal(by['V1__One.sql'].status, 'applied');
  assert.equal(by['V2__Two.sql'].status, 'changed');
  assert.match(by['V2__Two.sql'].detail, /^checksum -?\d+ now, -?\d+ when applied$/);
  assert.equal(by['V1_5__Gone.sql'].status, 'missing');
  assert.equal(by['V4__Broken.sql'].status, 'failed');
  assert.equal(by['sub/V3__Three.sql'].status, 'pending');
  assert.match(by['sub/V3__Three.sql'].detail, /older than 4|^$/);
  assert.equal(by['R__Views.sql'].status, 'pending');
  assert.match(by['R__Views.sql'].detail, /changed since it last ran/);
  assert.deepEqual(s.pending.map((e) => e.script), ['sub/V3__Three.sql', 'V10__Ten.sql', 'R__Views.sql']);
  assert.deepEqual(s.entries.map((e) => e.version), ['0.5', '1', '1.5', '2', '3', '4', '10', null]);
  assert.ok(s.notes.some((n) => /Not Flyway names, so left out: notes\.sql/.test(n)));
  assert.ok(s.notes.some((n) => /Undo migrations \(U2__Undo\.sql\)/.test(n)));
  assert.ok(s.runnable);
});

test('Flyway: a pending version below the newest applied says Flyway only runs it out of order', () => {
  const v1 = file('V1__One.sql');
  const s = migrationStatus({ tool: 'flyway', files: [v1, file('V3__Three.sql'), file('V2__Two.sql')], rows: [row(1, '1', 'V1__One.sql', v1.text), row(2, '3', 'V3__Three.sql', file('V3__Three.sql').text)] });
  assert.deepEqual(s.pending.map((e) => [e.script, e.detail]), [['V2__Two.sql', 'older than 3, the newest applied (Flyway runs it only with outOfOrder)']]);
});

test('EF Core: migration ids from the .cs files and idempotent scripts, listed but never run', () => {
  const files = [
    file('Migrations/20240101120000_Initial.cs', 'class Initial {}'),
    file('Migrations/20240101120000_Initial.Designer.cs', ''),
    file('Migrations/AppModelSnapshot.cs', ''),
    file('Migrations/20240301090000_AddPlayers.cs', ''),
    file('scripts/all.sql', "IF NOT EXISTS(SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'20240501000000_AddStadiums')\nBEGIN\n  CREATE TABLE x (id int);\nEND;"),
  ];
  const rows = [{ MigrationId: '20240101120000_Initial', ProductVersion: '8.0.1' }, { MigrationId: '20231201000000_Gone', ProductVersion: '7.0.0' }];
  const s = migrationStatus({ tool: 'ef', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['20231201000000_Gone', 'missing'],
    ['20240101120000_Initial', 'applied'],
    ['20240301090000_AddPlayers', 'pending'],
    ['20240501000000_AddStadiums', 'pending'],
  ]);
  assert.equal(s.runnable, false);
  assert.match(s.notes.at(-1), /dotnet ef database update/);
});

test('DbUp: script names (an embedded resource name ends with the file), in name order, no checksums', () => {
  const files = [file('Script0002 - Players.sql'), file('Script0001 - Clubs.sql'), file('Script0003 - Matches.sql')];
  const rows = [{ SchemaVersionsId: 1, ScriptName: 'MyApp.Scripts.Script0001 - Clubs.sql', Applied: new Date('2026-01-01T00:00:00Z') }, { SchemaVersionsId: 2, ScriptName: 'Script0000 - Old.sql', Applied: new Date() }];
  const s = migrationStatus({ tool: 'dbup', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['Script0001 - Clubs.sql', 'applied'],
    ['Script0002 - Players.sql', 'pending'],
    ['Script0003 - Matches.sql', 'pending'],
    ['Script0000 - Old.sql', 'missing'],
  ]);
  assert.match(s.notes[0], /no checksums/);
});

test("Trawl's own: any .sql by its path, checksums compared", () => {
  const a = file('001_clubs.sql');
  const s = migrationStatus({ tool: 'plain', files: [file('002_players.sql'), a, file('readme.cs')], rows: [{ script: '001_clubs.sql', checksum: flywayChecksum(a.text), applied_on: new Date() }, { script: '000_gone.sql', checksum: 1 }] });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['001_clubs.sql', 'applied'],
    ['002_players.sql', 'pending'],
    ['000_gone.sql', 'missing'],
  ]);
  const changed = migrationStatus({ tool: 'plain', files: [a], rows: [{ script: '001_clubs.sql', checksum: 5 }] });
  assert.equal(changed.entries[0].status, 'changed');
});

test('the probe looks for every history table, and the first found wins (else Trawl’s own, not made yet)', () => {
  for (const kind of ['sqlserver', 'postgres', 'mysql']) {
    const sql = probeSql(kind);
    assert.match(sql, /^-- trawl:migrations-probe/);
    for (const t of ['flyway_schema_history', '__efmigrationshistory', 'schemaversions', 'trawl_migrations']) assert.ok(sql.includes(`'${t}'`), `${kind}: ${t}`);
  }
  assert.match(probeSql('sqlserver'), /IN \(N'flyway_schema_history', N'__efmigrationshistory'/);
  assert.deepEqual(pickHistory([{ schema: 'dbo', name: 'SchemaVersions' }, { schema: 'dbo', name: '__EFMigrationsHistory' }], 'dbo'), { tool: 'ef', schema: 'dbo', table: '__EFMigrationsHistory' });
  assert.deepEqual(pickHistory([], 'public'), { tool: 'plain', schema: 'public', table: 'trawl_migrations', missing: true });
  assert.equal(historySql(PG, { schema: 'public', table: 'flyway_schema_history' }), '-- trawl:migrations-history\nSELECT * FROM "public"."flyway_schema_history";');
  assert.equal(nextRank([{ installed_rank: 3 }, { INSTALLED_RANK: 7 }]), 8);
  assert.equal(nextRank([]), 1);
});

test("a run is recorded as its tool would: Flyway's row, DbUp's, Trawl's own; the table's own column spelling kept", () => {
  const entry = { script: 'V3__Add_stadiums.sql', version: '3', description: "Add stadiums' things", checksum: -123 };
  assert.equal(
    recordSql(MS, { tool: 'flyway', schema: 'dbo', table: 'flyway_schema_history' }, entry, { ms: 12.4, rank: 4 }),
    "-- trawl:migration-record\nINSERT INTO [dbo].[flyway_schema_history] ([installed_rank], [version], [description], [type], [script], [checksum], [installed_by], [execution_time], [success])\nVALUES (4, N'3', N'Add stadiums'' things', N'SQL', N'V3__Add_stadiums.sql', -123, SUSER_SNAME(), 12, 1);",
  );
  assert.match(recordSql(PG, { tool: 'flyway', schema: 'public', table: 'flyway_schema_history' }, entry, { ms: 1, rank: 1 }), /current_user, 1, TRUE\);$/);
  assert.match(recordSql(MY, { tool: 'flyway', schema: 'shop', table: 'flyway_schema_history' }, entry, { ms: 1, rank: 1 }), /`installed_rank`.*CURRENT_USER\(\), 1, 1\);$/s);
  assert.equal(
    recordSql(PG, { tool: 'dbup', schema: 'public', table: 'schemaversions' }, { script: 'Script0002.sql' }, { ms: 3, columns: ['schemaversionsid', 'scriptname', 'applied'] }),
    "-- trawl:migration-record\nINSERT INTO \"public\".\"schemaversions\" (\"scriptname\", \"applied\")\nVALUES ('Script0002.sql', now());",
  );
  assert.match(recordSql(MS, { tool: 'plain', schema: 'dbo', table: 'trawl_migrations' }, { script: '002.sql', checksum: 9 }, { ms: 40 }), /\(\[script\], \[checksum\], \[execution_ms\]\)\nVALUES \(N'002\.sql', 9, 40\);$/);
  assert.match(createPlainSql(MS, 'dbo'), /^-- trawl:migrations-create\nCREATE TABLE \[dbo\]\.\[trawl_migrations\]/);
  assert.match(createPlainSql(PG, 'public'), /"script" varchar\(1000\) NOT NULL PRIMARY KEY/);
});

test('the status text: what was compared, a line per migration, the counts and the notes', () => {
  const v1 = file('V1__One.sql');
  const s = migrationStatus({ tool: 'flyway', files: [v1, file('V2__Two.sql')], rows: [row(1, '1', 'V1__One.sql', v1.text)] });
  const text = statusText(s, { database: 'ClubA', folder: '/m', history: { schema: 'dbo', table: 'flyway_schema_history' }, files: 2 });
  assert.match(text, /^Flyway · dbo\.flyway_schema_history in ClubA · 2 files in \/m\nChecksums: Flyway's CRC-32/);
  assert.match(text, /✓ applied {2}V1 {2}V1__One\.sql {2}2026-01-02 10:00/);
  assert.match(text, /• pending {2}V2 {2}V2__Two\.sql/);
  assert.match(text, /1 applied · 1 pending$/);
  const none = statusText(migrationStatus({ tool: 'plain', files: [], rows: [] }), { database: 'ClubB', folder: '/m', history: { schema: 'dbo', table: 'trawl_migrations', missing: true }, files: 0 });
  assert.match(none, /trawl_migrations isn't in ClubB yet/);
  assert.match(none, /No migrations in the folder or the history/);
});

test('Prisma: <name>/migration.sql by folder name, SHA-256 checksums as Prisma compares them, failed and rolled back', () => {
  const sql = (name, text) => ({ path: `prisma/migrations/${name}/migration.sql`, text });
  const init = sql('20240101120000_init', 'CREATE TABLE "User" (\n  "id" SERIAL PRIMARY KEY\n);\n');
  const posts = sql('20240201120000_posts', 'CREATE TABLE "Post" (id int);\n');
  const tags = sql('20240301120000_tags', 'CREATE TABLE "Tag" (id int);\n');
  const later = sql('20240401120000_later', 'SELECT 1;\n');
  const broken = sql('20240501120000_broken', 'SELECT 2;\n');
  const files = [later, init, posts, tags, broken, { path: 'prisma/migrations/migration_lock.toml', text: '' }, { path: 'prisma/schema.prisma', text: '' }];
  const at = new Date('2026-02-01T10:00:00Z');
  const rows = [
    // Applied on Windows: CRLF line ends still match, as Prisma checks the other ending too.
    { id: 'a', checksum: prismaChecksum(init.text.replace(/\n/g, '\r\n')), migration_name: '20240101120000_init', started_at: at, finished_at: at, rolled_back_at: null, applied_steps_count: 1 },
    { id: 'b', checksum: prismaChecksum('CREATE TABLE "Post" (id bigint);\n'), migration_name: '20240201120000_posts', started_at: at, finished_at: at, rolled_back_at: null },
    { id: 'c', checksum: prismaChecksum(tags.text), migration_name: '20240301120000_tags', started_at: at, finished_at: null, rolled_back_at: at },
    { id: 'd', checksum: prismaChecksum(broken.text), migration_name: '20240501120000_broken', started_at: at, finished_at: null, rolled_back_at: null },
    { id: 'e', checksum: 'x', migration_name: '20231201000000_gone', started_at: at, finished_at: at, rolled_back_at: null },
  ];
  const s = migrationStatus({ tool: 'prisma', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['20240101120000_init', 'applied'],
    ['20240201120000_posts', 'changed'],
    ['20240301120000_tags', 'pending'],
    ['20240401120000_later', 'pending'],
    ['20240501120000_broken', 'failed'],
    ['20231201000000_gone', 'missing'],
  ]);
  assert.match(s.entries[1].detail, /^checksum [0-9a-f]{12}… now, [0-9a-f]{12}… when applied$/);
  assert.equal(s.entries[2].detail, 'rolled back before');
  assert.match(s.entries[4].detail, /prisma migrate resolve/);
  assert.deepEqual(s.pending.map((e) => e.file.path), [tags.path, later.path]);
  assert.ok(s.runnable);
  assert.equal(s.files, 5);
});

test("Prisma's checksum: SHA-256 in hex, a byte order mark counted, and the unpadded hex early versions wrote", () => {
  assert.equal(prismaChecksum('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(prismaMatches('abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'));
  // Each byte without its leading zero: 0x01 as "1", 0x03 as "3".
  assert.ok(prismaMatches('abc', 'ba7816bf8f1cfea414140de5dae2223b0361a396177a9cb410ff61f2015ad'));
  assert.ok(!prismaMatches('abd', prismaChecksum('abc')));
  assert.ok(prismaMatches('a\r\nb', prismaChecksum('a\nb')));
  assert.ok(prismaMatches('a\nb', prismaChecksum('a\r\nb')));
  // A file read with a byte order mark is hashed with it, as Prisma reads the file whole.
  const s = migrationStatus({ tool: 'prisma', files: [{ path: 'm/1_x/migration.sql', text: 'SELECT 1;', bom: true }], rows: [{ migration_name: '1_x', checksum: prismaChecksum('﻿SELECT 1;'), finished_at: new Date(), rolled_back_at: null }] });
  assert.equal(s.entries[0].status, 'applied');
});

test('Knex: file names against knex_migrations, a .ts project run compiled as .js, listed but never run', () => {
  const files = [
    { path: 'migrations/20240102_players.ts', text: '' },
    { path: 'migrations/20240101_clubs.js', text: '' },
    { path: 'migrations/20240103_matches.js', text: '' },
    { path: 'migrations/types.d.ts', text: '' },
    { path: 'src/server.js', text: '' },
  ];
  const rows = [
    { id: 1, name: '20240101_clubs.js', batch: 1, migration_time: new Date('2026-01-01T00:00:00Z') },
    { id: 2, name: '20240102_players.js', batch: 2, migration_time: new Date('2026-01-02T00:00:00Z') },
    { id: 3, name: '20231201_gone.js', batch: 1, migration_time: new Date('2025-12-01T00:00:00Z') },
  ];
  const s = migrationStatus({ tool: 'knex', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['20240101_clubs.js', 'applied'],
    ['20240102_players.ts', 'applied'],
    ['20240103_matches.js', 'pending'],
    ['20231201_gone.js', 'missing'],
  ]);
  assert.match(s.entries[0].detail, /^batch 1, 2026-01-01 00:00$/);
  assert.equal(s.runnable, false);
  assert.match(s.notes.at(-1), /npx knex migrate:latest/);
  assert.equal(s.files, 3);
});

test("Drizzle: the journal's order, hashes of each file, applied by when, changed, pending, skipped and missing", () => {
  const journal = (entries) => ({ path: 'drizzle/meta/_journal.json', text: JSON.stringify({ version: '7', dialect: 'postgresql', entries }) });
  const f0 = { path: 'drizzle/0000_init.sql', text: 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n--> statement-breakpoint\nCREATE INDEX "i" ON "users" ("id");\n' };
  const f1 = { path: 'drizzle/0001_posts.sql', text: 'CREATE TABLE "posts" ("id" serial);\n' };
  const f2 = { path: 'drizzle/0002_tags.sql', text: 'CREATE TABLE "tags" ("id" serial);\n' };
  const f3 = { path: 'drizzle/0003_late.sql', text: 'SELECT 1;\n' };
  const files = [
    journal([
      { idx: 0, version: '7', when: 1700000000000, tag: '0000_init', breakpoints: true },
      { idx: 1, version: '7', when: 1700000100000, tag: '0001_posts', breakpoints: true },
      { idx: 2, version: '7', when: 1700000200000, tag: '0002_tags', breakpoints: true },
      { idx: 3, version: '7', when: 1700000300000, tag: '0003_late', breakpoints: true },
    ]),
    f2,
    f0,
    f1,
    f3,
  ];
  const rows = [
    { id: 1, hash: drizzleHash(f0.text), created_at: '1700000000000' },
    { id: 2, hash: drizzleHash('CREATE TABLE "posts" ("id" integer);\n'), created_at: 1700000100000 },
    { id: 4, hash: 'feedfacecafe0000', created_at: 1690000000000 },
  ];
  const s = migrationStatus({ tool: 'drizzle', files, rows });
  assert.deepEqual(s.entries.map((e) => [e.script, e.status]), [
    ['drizzle/0000_init.sql', 'applied'],
    ['drizzle/0001_posts.sql', 'changed'],
    ['drizzle/0002_tags.sql', 'pending'],
    ['drizzle/0003_late.sql', 'pending'],
    ['hash feedfacecafe…', 'missing'],
  ]);
  assert.match(s.entries[1].detail, /^hash [0-9a-f]{12}… now, [0-9a-f]{12}… when applied$/);
  assert.deepEqual(s.pending.map((e) => e.when), [1700000200000, 1700000300000]);
  assert.equal(s.files, 5);
  // A migration older than the newest applied is one Drizzle's migrator never runs.
  const skipped = migrationStatus({ tool: 'drizzle', files, rows: [rows[0], { hash: drizzleHash(f3.text), created_at: 1700000300000 }] });
  assert.match(skipped.entries.find((e) => e.script === 'drizzle/0001_posts.sql').detail, /older than the newest applied/);
  // Two journals: drizzle.config's out says which.
  const other = { path: 'old/meta/_journal.json', text: JSON.stringify({ entries: [] }) };
  const config = { path: 'drizzle.config.ts', text: "export default defineConfig({\n  dialect: 'postgresql',\n  out: './drizzle',\n  schema: './src/schema.ts',\n});\n" };
  assert.equal(drizzleOut(config.text), './drizzle');
  const picked = migrationStatus({ tool: 'drizzle', files: [other, ...files, config], rows: [] });
  assert.equal(picked.pending.length, 4);
  assert.match(picked.notes[0], /2 journals here; compared with drizzle\/meta\/_journal\.json \(drizzle\.config's out\)/);
  assert.match(migrationStatus({ tool: 'drizzle', files: [f0], rows: [] }).notes[0], /No meta\/_journal\.json/);
});

test('Flyway: thousands of versions against as many rows, each matched by a lookup', () => {
  const files = Array.from({ length: 3000 }, (_, i) => ({ path: `V1_${i}__m${i}.sql`, text: `select ${i};` }));
  // Written 1.<i>.0 in the history: the same version. A file of its own for 1.5, twice.
  files.push({ path: 'V1_5_0__again.sql', text: 'select 5;' });
  const rows = files.slice(0, 2990).map((f, i) => ({ installed_rank: i + 1, version: `1.${i}.0`, type: 'SQL', script: f.path, checksum: flywayChecksum(i === 7 ? 'x' : f.text), success: true }));
  for (let i = 0; i < 5; i++) rows.push({ installed_rank: 3000 + i, version: `9.${i}`, type: 'SQL', script: `V9_${i}__gone.sql`, checksum: 1, success: true });
  const started = performance.now();
  const s = migrationStatus({ tool: 'flyway', files, rows });
  assert.ok(performance.now() - started < 1000);
  const count = (status) => s.entries.filter((e) => e.status === status).length;
  assert.deepEqual([count('applied'), count('changed'), count('pending'), count('missing')], [2990, 1, 10, 5]);
  assert.deepEqual(s.notes, ['Version 1.5 is in 2 files: V1_5__m5.sql, V1_5_0__again.sql. Flyway refuses that.', 'Version 1.5.0 is in 2 files: V1_5__m5.sql, V1_5_0__again.sql. Flyway refuses that.']);
});

test('Knex: thousands of migrations against as many rows, each matched by a lookup', () => {
  const pad = (i) => String(i).padStart(5, '0');
  const files = Array.from({ length: 5000 }, (_, i) => ({ path: `migrations/${pad(i)}_m.ts`, text: '' }));
  // Run compiled (.js names) but for the last few, and a few rows with no file.
  const rows = files.slice(0, 4990).map((f, i) => ({ name: `${pad(i)}_m.${i < 4980 ? 'js' : 'ts'}`, batch: 1 }));
  for (let i = 0; i < 5; i++) rows.push({ name: `gone${i}.js`, batch: 2 });
  const started = performance.now();
  const s = migrationStatus({ tool: 'knex', files, rows });
  assert.ok(performance.now() - started < 1000);
  const count = (status) => s.entries.filter((e) => e.status === status).length;
  assert.deepEqual([count('applied'), count('pending'), count('missing')], [4990, 10, 5]);
  assert.equal(s.entries.at(-1).script, 'gone4.js');
});

test("Prisma, Knex and Drizzle in the probe and the records; the folder's kind of files picks between several histories", () => {
  for (const kind of ['sqlserver', 'postgres', 'mysql']) for (const t of ['_prisma_migrations', 'knex_migrations', '__drizzle_migrations']) assert.ok(probeSql(kind).includes(`'${t}'`), `${kind}: ${t}`);
  // Drizzle keeps its table in a schema of its own on Postgres, outside the search path.
  assert.match(probeSql('postgres'), /OR table_schema = 'drizzle'/);
  const found = [{ schema: 'public', name: 'knex_migrations' }, { schema: 'public', name: '_prisma_migrations' }];
  assert.equal(pickHistory(found, 'public').tool, 'prisma');
  assert.equal(pickHistory(found, 'public', [{ path: 'migrations/001_x.js', text: '' }]).tool, 'knex');
  assert.deepEqual(pickHistory([{ schema: 'drizzle', name: '__drizzle_migrations' }], 'public'), { tool: 'drizzle', schema: 'drizzle', table: '__drizzle_migrations' });
  assert.equal(fitsFolder('prisma', [{ path: 'prisma/migrations/1_x/migration.sql' }]), true);
  assert.equal(fitsFolder('drizzle', [{ path: 'drizzle/0000_x.sql' }]), false);

  assert.equal(
    recordSql(PG, { tool: 'prisma', schema: 'public', table: '_prisma_migrations' }, { script: '20240301120000_tags', checksum: 'abc' }, { ms: 5, id: '00000000-0000-4000-8000-000000000001' }),
    "-- trawl:migration-record\nINSERT INTO \"public\".\"_prisma_migrations\" (\"id\", \"checksum\", \"migration_name\", \"started_at\", \"finished_at\", \"applied_steps_count\")\nVALUES ('00000000-0000-4000-8000-000000000001', 'abc', '20240301120000_tags', now(), now(), 1);",
  );
  assert.match(recordSql(MS, { tool: 'prisma', schema: 'dbo', table: '_prisma_migrations' }, { script: 'x', checksum: 'abc' }, { ms: 1 }), /VALUES \(N'[0-9a-f-]{36}', N'abc', N'x', GETDATE\(\), GETDATE\(\), 1\);$/);
  assert.equal(
    recordSql(PG, { tool: 'drizzle', schema: 'drizzle', table: '__drizzle_migrations' }, { script: 'drizzle/0002_tags.sql', checksum: 'beef', when: 1700000200000 }, { ms: 1 }),
    '-- trawl:migration-record\nINSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")\nVALUES (\'beef\', 1700000200000);',
  );
  const text = statusText(migrationStatus({ tool: 'drizzle', files: [], rows: [] }), { database: 'shop', folder: '/p', history: { schema: 'drizzle', table: '__drizzle_migrations' }, files: 0 });
  assert.match(text, /^Drizzle · drizzle\.__drizzle_migrations in shop · 0 files in \/p\nFrom meta\/_journal\.json; hashes: SHA-256/);
});

test("the folder's files: SQL and C# read, Knex's scripts only named, Drizzle's journal and config read, a byte order mark noted", () => {
  const root = mkdtempSync(join(tmpdir(), 'trawl-migrations-'));
  try {
    mkdirSync(join(root, 'prisma', 'migrations', '1_init'), { recursive: true });
    mkdirSync(join(root, 'drizzle', 'meta'), { recursive: true });
    mkdirSync(join(root, 'migrations'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'prisma', 'migrations', '1_init', 'migration.sql'), '﻿SELECT 1;');
    writeFileSync(join(root, 'drizzle', 'meta', '_journal.json'), '{"entries":[]}');
    writeFileSync(join(root, 'drizzle', 'meta', '0000_snapshot.json'), '{}');
    writeFileSync(join(root, 'drizzle.config.ts'), "export default { out: './drizzle' };");
    writeFileSync(join(root, 'migrations', '001_x.js'), 'exports.up = () => {};');
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '');
    const files = migrationFiles(root);
    assert.deepEqual(files.map((f) => f.path), ['drizzle/meta/_journal.json', 'drizzle.config.ts', 'migrations/001_x.js', 'prisma/migrations/1_init/migration.sql']);
    const prismaFile = files.find((f) => f.path.endsWith('migration.sql'));
    assert.deepEqual([prismaFile.text, prismaFile.bom], ['SELECT 1;', true]);
    assert.equal(files.find((f) => f.path.endsWith('.js')).text, '');
    assert.equal(files.find((f) => f.path === 'drizzle.config.ts').text, "export default { out: './drizzle' };");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
