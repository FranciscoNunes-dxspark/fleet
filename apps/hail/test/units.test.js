// The pure parts: commands and their completion, the help window's sections, the settings list,
// the pet's drawing, and the updater's sums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand, suggestionsFor } from '../src/commands.js';
import { HELP } from '../src/help.js';
import { commandsSection, sectionLines } from '@fleet/kit/help-layout.js';
import { FACES, PALETTE, petPixels, petRows } from '../src/pet.js';
import { settingRows } from '../src/settings.js';
import { DEFAULT_ACCENT, LIGHT_ACCENT, applyTheme, backgroundFrom, theme, themeMode } from '../src/theme.js';
import { methodColour } from '../src/ui/response.js';
import { run } from '@fleet/kit/run.js';

test('commands: exact names, unambiguous prefixes, and completion of their argument', () => {
  assert.equal(findCommand('send').name, 'send');
  assert.equal(findCommand('cu').name, 'curl');
  assert.equal(findCommand('se'), null, 'send and settings both start with se');
  assert.deepEqual(suggestionsFor('/sett', {}).map((s) => s.label), ['/settings']);
  const data = { requests: [{ name: 'login', label: 'login' }, { name: null, label: 'GET https://x/users' }], environments: { names: ['dev', 'prod'] } };
  assert.deepEqual(suggestionsFor('/send lo', { data }).map((s) => s.insert), ['/send login']);
  assert.deepEqual(suggestionsFor('/env p', { data }).map((s) => s.insert), ['/env prod']);
  assert.deepEqual(suggestionsFor('/open a', { files: ['api.http', 'b/other.http'] }).map((s) => s.insert), ['/open api.http']);
  assert.deepEqual(suggestionsFor('plain text', { data }), []);
  for (const c of COMMANDS) assert.ok(c.desc && typeof c.run === 'function', `/${c.name} has a description and runs`);
});

test('help: every section lays out, and the commands are a section of their own', () => {
  for (const section of [...HELP, commandsSection(COMMANDS)]) assert.ok(sectionLines(section, 60).length > 0, section.title);
  assert.ok(commandsSection(COMMANDS).rows.some((r) => String(r[0]).includes('/send')));
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
});

test('the theme: dark, light, or auto from COLORFGBG, with the accent over it, read as it draws', () => {
  try {
    assert.equal(backgroundFrom('15;0'), 'dark');
    assert.equal(backgroundFrom('0;default;15'), 'light');
    assert.equal(backgroundFrom(undefined), null);
    assert.equal(themeMode('auto', { COLORFGBG: '0;7' }), 'light');
    assert.equal(themeMode(undefined, {}), 'dark');
    assert.equal(themeMode('dark', { COLORFGBG: '0;15' }), 'dark');
    const dark = methodColour('GET');
    assert.equal(applyTheme({ theme: 'light' }, {}), 'light');
    assert.equal(theme.accent, LIGHT_ACCENT);
    assert.notEqual(methodColour('GET'), dark, 'the methods follow the theme');
    const row = settingRows({ theme: 'light' }).find((r) => r.id === 'theme');
    assert.deepEqual([row.value, row.note, row.action], ['light', 'auto next: from the terminal, else dark', 'theme']);
    assert.equal(settingRows({}).find((r) => r.id === 'accent').value, `${LIGHT_ACCENT} (default)`);
    applyTheme({ theme: 'auto', accent: '#123456' }, { COLORFGBG: '15;0' });
    assert.deepEqual([theme.mode, theme.accent], ['dark', '#123456']);
    assert.equal(settingRows({}).find((r) => r.id === 'theme').value, 'auto (dark here)');
  } finally {
    applyTheme({}, {});
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

test('run: output, a failure with the program\'s own words, and cancelling', async () => {
  assert.equal((await run('node -e "console.log(1+1)"')).stdout.trim(), '2');
  await assert.rejects(run('node -e "console.error(\'no such thing\'); process.exit(3)"'), (e) => e.code === 3 && /no such thing/.test(e.message));
  const controller = new AbortController();
  const slow = run('node -e "setTimeout(() => {}, 20000)"', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(slow, (e) => e.cancelled);
});
