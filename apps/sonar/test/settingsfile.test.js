// Settings to a JSON file and back, and copied from one app into another: the file format, and end to end over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSettings, readSettingsFile, settingsFileName, settingsJson } from '../src/settingsfile.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const settingsOf = (app, name) => app.provider.state.sites.find((s) => `${s.name}${s.slot ? `/${s.slot}` : ''}` === name).settings;

test("the file is the portal's Advanced edit list, by name, and reads back the same", () => {
  const text = settingsJson({ b: '2', A: '1' });
  assert.deepEqual(JSON.parse(text), [
    { name: 'A', value: '1', slotSetting: false },
    { name: 'b', value: '2', slotSetting: false },
  ]);
  assert.deepEqual(readSettingsFile(text), { settings: { A: '1', b: '2' } });
});

test('reading takes a plain object and an appsettings.json, its nesting as __ and its comments left out', () => {
  assert.deepEqual(readSettingsFile('{ "A": "1", "N": 3, "On": true, "Off": null }').settings, { A: '1', N: '3', On: 'true', Off: '' });
  const appsettings = `{
    // .NET allows comments
    "$schema": "https://json.schemastore.org/appsettings.json",
    "Logging": { "LogLevel": { "Default": "Information", "Microsoft": "Warning" } }, /* and these */
    "Hosts": ["a", "b"],
    "Url": "http://x//y",
  }`;
  assert.deepEqual(readSettingsFile(appsettings).settings, { Logging__LogLevel__Default: 'Information', Logging__LogLevel__Microsoft: 'Warning', Hosts__0: 'a', Hosts__1: 'b', Url: 'http://x//y' });
  assert.match(readSettingsFile('not json').error, /isn't JSON/);
  assert.match(readSettingsFile('[{ "value": "x" }]').error, /Item 1 has no name/);
  assert.match(readSettingsFile('"text"').error, /no settings/);
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
    await until(() => frame().includes("Save contoso-web's") && frame().includes('settings to'), 'the file asked for');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Every value goes in it as it is'), 'the warning');
    app.stdin.write(KEYS.enter);
    const file = join(dir, 'contoso-web.settings.json');
    await until(() => existsSync(file), 'the file');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.fromEntries(saved.map((s) => [s.name, s.value])), settingsOf(app, 'contoso-web'));

    // Loaded from one: new ones added, different ones changed, the rest kept; production asks for the name.
    writeFileSync(join(dir, 'more.json'), JSON.stringify({ APP_VERSION: '9.9.9', NewOne: 'x' }));
    await until(() => frame().includes('Settings of contoso-web'), 'the settings again');
    app.stdin.write('l');
    await until(() => frame().includes('Load settings into contoso-web from'), 'the file asked for');
    await type(app.stdin, 'more.json');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('add NewOne') && frame().includes('change APP_VERSION') && frame().includes('Type contoso-web'), 'what changes, and the name asked for');
    await type(app.stdin, 'contoso-web');
    app.stdin.write(KEYS.enter);
    await until(() => settingsOf(app, 'contoso-web').NewOne === 'x', 'loaded');
    assert.equal(settingsOf(app, 'contoso-web').APP_VERSION, '9.9.9');
    assert.ok(settingsOf(app, 'contoso-web').Db__ConnectionString, 'its others kept');

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
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});
