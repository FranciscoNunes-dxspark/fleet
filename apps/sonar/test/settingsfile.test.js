// Settings to a JSON file and back, and copied from one app into another: the file format, and end to end over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configJson, mergeSettings, readSettingsFile, settingsFileName, stringsForDiff } from '../src/settingsfile.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const siteOf = (app, name) => app.provider.state.sites.find((s) => `${s.name}${s.slot ? `/${s.slot}` : ''}` === name);
// Its connection strings' names and types (the demo keeps a type only once one is saved, else guesses as Azure would).
const stringsOf = (app, name) => Object.fromEntries(Object.keys(siteOf(app, name).connectionStrings).map((n) => [n, { type: siteOf(app, name).connectionStringTypes?.[n] ?? 'SQLAzure' }]));
const settingsOf = (app, name) => app.provider.state.sites.find((s) => `${s.name}${s.slot ? `/${s.slot}` : ''}` === name).settings;

test("the file holds the portal's two Advanced edit lists, by name, and reads back the same", () => {
  const text = configJson({ settings: { b: '2', A: '1' }, strings: { Db: { value: 'Server=x', type: 'SQLAzure' } } });
  assert.deepEqual(JSON.parse(text), {
    appSettings: [
      { name: 'A', value: '1', slotSetting: false },
      { name: 'b', value: '2', slotSetting: false },
    ],
    connectionStrings: [{ name: 'Db', value: 'Server=x', type: 'SQLAzure', slotSetting: false }],
  });
  assert.deepEqual(readSettingsFile(text), { settings: { A: '1', b: '2' }, strings: { Db: { value: 'Server=x', type: 'SQLAzure' } } });
});

test("either portal list alone: one whose items have a type is connection strings", () => {
  assert.deepEqual(readSettingsFile('[{ "name": "A", "value": "1", "slotSetting": false }]'), { settings: { A: '1' }, strings: {} });
  assert.deepEqual(readSettingsFile('[{ "name": "Db", "value": "x", "type": "SQLServer", "slotSetting": false }]'), { settings: {}, strings: { Db: { value: 'x', type: 'SQLServer' } } });
  assert.match(readSettingsFile('{ "appSettings": [], "connectionStrings": [{ "value": "x" }] }').error, /Item 1 of connectionStrings has no name/);
});

test('reading takes a plain object and an appsettings.json: its ConnectionStrings as connection strings, its nesting as __, its comments left out', () => {
  assert.deepEqual(readSettingsFile('{ "A": "1", "N": 3, "On": true, "Off": null }').settings, { A: '1', N: '3', On: 'true', Off: '' });
  const appsettings = `{
    // .NET allows comments
    "$schema": "https://json.schemastore.org/appsettings.json",
    "ConnectionStrings": { "Default": "Server=db;Database=shop" },
    "Logging": { "LogLevel": { "Default": "Information", "Microsoft": "Warning" } }, /* and these */
    "Hosts": ["a", "b"],
    "Url": "http://x//y",
  }`;
  const read = readSettingsFile(appsettings);
  assert.deepEqual(read.settings, { Logging__LogLevel__Default: 'Information', Logging__LogLevel__Microsoft: 'Warning', Hosts__0: 'a', Hosts__1: 'b', Url: 'http://x//y' });
  assert.deepEqual(read.strings, { Default: { value: 'Server=db;Database=shop', type: 'Custom' } });
  assert.match(readSettingsFile('not json').error, /isn't JSON/);
  assert.match(readSettingsFile('[{ "value": "x" }]').error, /Item 1 has no name/);
  assert.match(readSettingsFile('"text"').error, /no settings/);
});

test('a connection string whose type changes is a change', () => {
  assert.deepEqual(stringsForDiff({ Db: { value: 'x', type: 'Custom' } }), { Db: 'Custom x' });
});

test("merging adds and changes, and keeps the app's others; a file name for a slot", () => {
  assert.deepEqual(mergeSettings({ a: '1', b: '2' }, { b: '3', c: '4' }), { a: '1', b: '3', c: '4' });
  assert.equal(settingsFileName('contoso-web/staging'), 'contoso-web-staging.settings.json');
});

test("s saves an app's settings to a file, l loads one into it, c copies them all to another slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonar-settings-'));
  const app = start({ cwd: dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write(KEYS.esc);
    await new Promise((r) => setTimeout(r, 30));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Settings of contoso-web'), 'the settings');

    // Saved to a file: the name offered, then what goes in it said.
    app.stdin.write('s');
    await until(() => frame().includes("Save contoso-web's 5 settings and 1 connection string to"), 'the file asked for');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Every value goes in it as it is'), 'the warning');
    app.stdin.write(KEYS.enter);
    const file = join(dir, 'contoso-web.settings.json');
    await until(() => existsSync(file), 'the file');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.fromEntries(saved.appSettings.map((s) => [s.name, s.value])), settingsOf(app, 'contoso-web'));
    assert.deepEqual(saved.connectionStrings.map((s) => [s.name, s.type]), [['Reporting', 'SQLAzure']]);

    // Loaded from one: new ones added, different ones changed, the rest kept; production asks for the name.
    writeFileSync(join(dir, 'more.json'), JSON.stringify({ APP_VERSION: '9.9.9', NewOne: 'x', ConnectionStrings: { Cache: 'redis:6379' } }));
    await until(() => frame().includes('Settings of contoso-web'), 'the settings again');
    app.stdin.write('l');
    await until(() => frame().includes('Load settings into contoso-web from'), 'the file asked for');
    await type(app.stdin, 'more.json');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('change APP_VERSION') && frame().includes('add connection string Cache') && frame().includes('│ >'), "what changes, and production's name asked for");
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => settingsOf(app, 'contoso-web').NewOne === 'x', 'loaded');
    assert.equal(settingsOf(app, 'contoso-web').APP_VERSION, '9.9.9');
    assert.ok(settingsOf(app, 'contoso-web').Db__ConnectionString, 'its others kept');
    assert.deepEqual(stringsOf(app, 'contoso-web'), { Reporting: { type: 'SQLAzure' }, Cache: { type: 'Custom' } }, 'a connection string added, its others kept');

    // Copied to another slot, picked from the list.
    await until(() => frame().includes('Settings of contoso-web'), 'the settings again');
    app.stdin.write('c');
    await until(() => frame().includes("Copy contoso-web's settings to"), 'the apps to copy to');
    for (let i = 0; i < 10 && !/❯ contoso-web\/staging/.test(frame()); i++) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 30));
    }
    await until(() => /❯ contoso-web\/staging/.test(frame()), 'the staging slot');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Save contoso-web/staging's settings") && frame().includes('add NewOne'), 'what changes there');
    // Production's name, asked in the question's field (its words cut short at this width).
    await until(() => frame().includes('│ >'), 'the name asked for');
    assert.match(frame(), /change ASPNETCORE_ENVIRONMENT/, 'a value the slot had of its own is said before it changes');
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => settingsOf(app, 'contoso-web/staging').NewOne === 'x', 'copied');
    assert.equal(settingsOf(app, 'contoso-web/staging').APP_VERSION, '9.9.9');
    assert.equal(settingsOf(app, 'contoso-web/staging').ASPNETCORE_ENVIRONMENT, 'Production', 'copied, as the question said');
    assert.deepEqual(stringsOf(app, 'contoso-web/staging'), { Reporting: { type: 'SQLAzure' }, Cache: { type: 'Custom' } }, 'the connection strings copied, with their types');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});
