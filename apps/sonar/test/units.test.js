// The pure parts: commands and their completion, the help window's sections, the settings list,
// the pet's drawing, and the updater's sums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, findCommand, suggestionsFor } from '../src/commands.js';
import { HELP } from '../src/help.js';
import { commandsSection, sectionLines } from '../src/help-layout.js';
import { FACES, PALETTE, petPixels, petRows } from '../src/pet.js';
import { settingRows } from '../src/settings.js';
import { DARK, DEFAULT_ACCENT, LIGHT, LIGHT_ACCENT, applyTheme, backgroundFrom, theme, themeMode } from '../src/theme.js';
import { nextTheme } from '../src/settings.js';
import { assetName, compareVersions, parseChecksums } from '../src/update.js';
import { run } from '../src/run.js';
import { notification, worthNotifying } from '../src/notify.js';
import { EXPORTS, toCsv, toJson, toMarkdown } from '../src/export.js';

test('commands: exact names, unambiguous prefixes, and completion of their argument', () => {
  assert.equal(findCommand('kql').name, 'kql');
  assert.equal(findCommand('sw').name, 'swap');
  assert.equal(findCommand('s'), null);
  const data = { subscriptions: [{ name: 'Contoso Dev' }, { name: 'Contoso Production' }], components: [{ name: 'ai' }] };
  assert.deepEqual(suggestionsFor('/sub contoso p', { data }).map((s) => s.insert), ['/sub Contoso Production']);
  assert.deepEqual(suggestionsFor('/restart web/', { data, targets: { web: {}, 'web/staging': {} } }).map((s) => s.insert), ['/restart web/staging']);
  for (const c of COMMANDS) assert.ok(c.desc && typeof c.run === 'function', `/${c.name} has a description and runs`);
});

test('help: every section lays out, and the commands are a section of their own', () => {
  for (const section of [...HELP, commandsSection(COMMANDS)]) assert.ok(sectionLines(section, 60).length > 0, section.title);
  assert.ok(commandsSection(COMMANDS).rows.some((r) => String(r[0]).includes('/kql')));
});

test('settings: the rows and their values', () => {
  const by = Object.fromEntries(settingRows({ history: [] }, { file: 'x' }).map((r) => [r.id, r]));
  assert.equal(by.accent.value, `${DEFAULT_ACCENT} (default)`);
  assert.equal(by.mouse.value, 'on');
  assert.equal(by.history.action, 'none');
  const set = Object.fromEntries(settingRows({ accent: '#ff8800', mouse: false, history: ['/quit'] }).map((r) => [r.id, r]));
  assert.equal(set.accent.value, '#ff8800');
  assert.equal(set.mouse.value, 'off');
  assert.equal(set.history.action, 'clear');
  assert.equal(by.theme.value, `auto (${theme.mode} here)`);
  assert.equal(by.theme.action, 'theme');
  assert.deepEqual([nextTheme({}), nextTheme({ theme: 'dark' }), nextTheme({ theme: 'light' })], ['dark', 'light', 'auto']);
});

test('theme: dark, light, or auto from COLORFGBG, with the accent kept over it', () => {
  assert.equal(backgroundFrom('15;0'), 'dark');
  assert.equal(backgroundFrom('0;default;15'), 'light');
  assert.equal(backgroundFrom(''), null);
  assert.equal(themeMode('auto', { COLORFGBG: '0;15' }), 'light');
  assert.equal(themeMode(undefined, {}), 'dark');
  assert.equal(themeMode('dark', { COLORFGBG: '0;15' }), 'dark');
  assert.deepEqual(Object.keys(LIGHT).sort(), Object.keys(DARK).sort(), 'both palettes have every colour');
  try {
    assert.equal(applyTheme({ theme: 'light' }, {}), 'light');
    assert.equal(theme.del, LIGHT.del);
    assert.equal(theme.accent, LIGHT_ACCENT);
    applyTheme({ theme: 'light', accent: '#ff8800' }, {});
    assert.equal(theme.accent, '#ff8800');
    assert.equal(settingRows({ theme: 'light' }).find((r) => r.id === 'accent').value, `${LIGHT_ACCENT} (default)`);
  } finally {
    applyTheme({ theme: 'dark' }, {});
  }
  assert.equal(theme.accent, DEFAULT_ACCENT);
});

test('the pet: every mood is the same size, drawn only in its palette, and has a face', () => {
  for (const mood of Object.keys(FACES)) {
    const px = petPixels(mood);
    assert.equal(px.length, 10, mood);
    for (const row of px) {
      assert.equal(row.length, 16, `${mood}: ${row}`);
      for (const c of row) assert.ok(c === '.' || PALETTE[c], `${mood} uses ${c}`);
    }
    assert.equal(petRows(mood).length, 5);
  }
});

test('updates: versions compare, checksums parse, and every release file is one build.js makes', () => {
  assert.ok(compareVersions('v1.2.10', '1.2.9') > 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
  assert.equal(compareVersions('junk', '1.0.0'), 0);
  const sums = parseChecksums(`${'a'.repeat(64)}  sonar-linux-x64\n${'b'.repeat(64)} *sonar-windows-x64.exe\n`);
  assert.equal(sums.get('sonar-windows-x64.exe'), 'b'.repeat(64));
  const build = readFileSync(new URL('../scripts/build.js', import.meta.url), 'utf8');
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    assert.ok(build.includes(`'${assetName(platform, arch)}'`), `${platform} ${arch}`);
  }
});

test('run: output, a failure with the program\'s own words, and cancelling', async () => {
  assert.equal((await run('node -e "console.log(1+1)"')).stdout.trim(), '2');
  await assert.rejects(run('node -e "console.error(\'no such thing\'); process.exit(3)"'), (e) => e.code === 3 && /no such thing/.test(e.message));
  const controller = new AbortController();
  const slow = run('node -e "setTimeout(() => {}, 20000)"', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(slow, (e) => e.cancelled);
});

test('notifications: a bell, then OSC 9, or OSC 777 in VTE terminals, only past the threshold and when on', () => {
  assert.equal(notification('Sonar: Restart web', 'web is restarting', {}), '\x07\x1b]9;Sonar: Restart web: web is restarting\x07');
  assert.equal(notification('a;b', 'c\x07d', { VTE_VERSION: '7600' }), '\x07\x1b]777;notify;a,b;c d\x1b\\');
  assert.equal(worthNotifying(9_000, {}), false);
  assert.equal(worthNotifying(10_000, {}), true);
  assert.equal(worthNotifying(600, { notifyAfter: 0.5 }), true);
  assert.equal(worthNotifying(60_000, { notify: false }), false);
  const row = settingRows({ notifyAfter: 30 }).find((r) => r.id === 'notify');
  assert.deepEqual([row.value, row.action], ['on', 'toggle']);
  assert.match(row.note, /over 30 s/);
});

test('export: the grid as CSV, JSON or a Markdown table', () => {
  const table = { columns: [{ name: 'timestamp', type: 'datetime' }, { name: 'name', type: 'string' }, { name: 'n', type: 'long' }, { name: 'd', type: 'dynamic' }], rows: [['2026-10-22T08:15:00.123Z', 'GET /a, "b"', 3, { k: 1 }], [null, 'x|y', 0, null]] };
  assert.equal(toCsv(table), 'timestamp,name,n,d\r\n2026-10-22T08:15:00.123Z,"GET /a, ""b""",3,"{""k"":1}"\r\n,x|y,0,\r\n');
  assert.deepEqual(JSON.parse(toJson(table)), [{ timestamp: '2026-10-22T08:15:00.123Z', name: 'GET /a, "b"', n: 3, d: { k: 1 } }, { timestamp: null, name: 'x|y', n: 0, d: null }]);
  assert.equal(toMarkdown(table), '| timestamp | name | n | d |\n| --- | --- | ---: | --- |\n| 2026-10-22 08:15:00 | GET /a, "b" | 3 | {"k":1} |\n|  | x\\|y | 0 |  |\n');
  assert.deepEqual(Object.keys(EXPORTS), ['.csv', '.json', '.md', '.markdown']);
});
