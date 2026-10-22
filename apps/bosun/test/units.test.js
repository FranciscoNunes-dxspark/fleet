// The pure parts: commands and their completion, the help window's sections, the settings list,
// the pet's drawing, the updater's sums, and which project Bosun runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP, choices, remember, resolveFolder, startFolder } from '../src/projects.js';
import { COMMANDS, findCommand, suggestionsFor } from '../src/commands.js';
import { HELP } from '../src/help.js';
import { commandsSection, sectionLines } from '../src/help-layout.js';
import { FACES, PALETTE, petPixels, petRows } from '../src/pet.js';
import { settingRows } from '../src/settings.js';
import { DEFAULT_ACCENT } from '../src/theme.js';
import { assetName, compareVersions, parseChecksums } from '../src/update.js';
import { run } from '../src/run.js';

test('commands: exact names, unambiguous prefixes, and completion of their argument', () => {
  assert.equal(findCommand('restart').name, 'restart');
  assert.equal(findCommand('res').name, 'restart');
  assert.equal(findCommand('s'), null, 'stop, start and settings all start with s');
  assert.deepEqual(suggestionsFor('/se', {}).map((s) => s.label), ['/settings']);
  const data = { procs: [{ name: 'api' }, { name: 'web' }], profiles: { mock: {} } };
  assert.deepEqual(suggestionsFor('/restart w', { data }).map((s) => s.insert), ['/restart web']);
  assert.deepEqual(suggestionsFor('/restart a', { data }).map((s) => s.insert), ['/restart api', '/restart all']);
  assert.deepEqual(suggestionsFor('/profile m', { data }).map((s) => s.insert), ['/profile mock']);
  assert.deepEqual(suggestionsFor('plain text', { data }), []);
  for (const c of COMMANDS) assert.ok(c.desc && typeof c.run === 'function', `/${c.name} has a description and runs`);
});

test('projects: where Bosun starts, where /move goes, and the ones it remembers', () => {
  const root = mkdtempSync(join(tmpdir(), 'bosun-projects-'));
  try {
    const shop = join(root, 'shop');
    const blog = join(root, 'blog');
    const empty = join(root, 'empty');
    for (const d of [shop, blog, empty, join(shop, 'api')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(shop, 'bosun.json'), '{}');
    writeFileSync(join(blog, 'package.json'), '{}');

    // Given a folder, that one; in a project, that one; where there's nothing, the last project still there.
    assert.equal(startFolder('blog', root, [shop]), blog);
    assert.equal(startFolder(undefined, shop, [blog]), shop);
    assert.equal(startFolder(undefined, root, [join(root, 'gone'), empty, blog]), blog, 'the first remembered one with a crew');
    assert.equal(startFolder(undefined, root, []), root, 'nowhere better: here, to say there is nothing');

    // A project beside this one, a folder inside it, a path; nothing for one that isn't there.
    assert.equal(resolveFolder(shop, 'blog'), blog);
    assert.equal(resolveFolder(shop, 'api'), join(shop, 'api'));
    assert.equal(resolveFolder(shop, blog), blog);
    assert.equal(resolveFolder(shop, '"blog"'), blog, 'a quoted name, as a path with spaces is typed');
    assert.equal(resolveFolder(shop, 'nope'), null);
    assert.equal(resolveFolder(shop, ' '), null);

    // The recent ones first, then the rest beside it, never the one it's in; which have something to run.
    const offered = choices(shop, [blog, shop]);
    assert.deepEqual(offered.map((c) => c.name), ['blog', 'empty']);
    assert.deepEqual(offered.map((c) => [c.crew, c.recent]), [[true, true], [false, false]]);

    // Newest first, once each, as many as it keeps.
    assert.deepEqual(remember([blog, shop], shop), [shop, blog]);
    const many = Array.from({ length: KEEP + 3 }, (_, i) => join(root, `p${i}`));
    assert.equal(remember(many, shop).length, KEEP);
    assert.equal(remember(many, shop)[0], shop);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('help: every section lays out, and the commands are a section of their own', () => {
  for (const section of [...HELP, commandsSection(COMMANDS)]) assert.ok(sectionLines(section, 60).length > 0, section.title);
  assert.ok(commandsSection(COMMANDS).rows.some((r) => String(r[0]).includes('/restart')));
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
  const sums = parseChecksums(`${'a'.repeat(64)}  bosun-linux-x64\n${'b'.repeat(64)} *bosun-windows-x64.exe\n`);
  assert.equal(sums.get('bosun-windows-x64.exe'), 'b'.repeat(64));
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
