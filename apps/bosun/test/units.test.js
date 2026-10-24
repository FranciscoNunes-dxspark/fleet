// The pure parts: commands and their completion, the help window's sections, the settings list,
// the pet's drawing, the updater's sums, and which project Bosun runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP, choices, pathArg, remember, resolveFolder, startFolder } from '../src/projects.js';
import { quoteArg } from '@fleet/kit/family.js';
import { COMMANDS, findCommand, suggestionsFor } from '../src/commands.js';
import { HELP } from '../src/help.js';
import { commandsSection, sectionLines } from '@fleet/kit/help-layout.js';
import { FACES, PALETTE, petPixels, petRows } from '../src/pet.js';
import { settingRows } from '../src/settings.js';
import { DARK, DEFAULT_ACCENT, LIGHT, LIGHT_ACCENT, applyTheme, backgroundFrom, theme, themeMode } from '../src/theme.js';
import { nextTheme } from '../src/settings.js';
import { exitNews, notification, worthNotifying } from '../src/notify.js';
import { run } from '@fleet/kit/run.js';
import { expand, parseDotenv } from '../src/dotenv.js';
import { markRanges, matcher } from '../src/search.js';
import { parseYaml, scalar } from '../src/yaml.js';
import { globRegex, skipsFolder, watchMatcher, watchRoots } from '../src/watch.js';

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
    assert.equal(resolveFolder(shop, quoteArg(blog)), blog, 'a path as a sibling\'s /move line quotes it');
    assert.equal(pathArg(quoteArg('C:\\work\\my shop')), 'C:\\work\\my shop', 'a Windows path, its backslashes escaped');
    assert.equal(pathArg('"C:\\work\\shop"'), 'C:\\work\\shop', 'one typed in quotes keeps them');
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

test('run: output, a failure with the program\'s own words, and cancelling', async () => {
  assert.equal((await run('node -e "console.log(1+1)"')).stdout.trim(), '2');
  await assert.rejects(run('node -e "console.error(\'no such thing\'); process.exit(3)"'), (e) => e.code === 3 && /no such thing/.test(e.message));
  const controller = new AbortController();
  const slow = run('node -e "setTimeout(() => {}, 20000)"', { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(slow, (e) => e.cancelled);
});

test('.env files: comments, export, quotes, escapes, lines over several lines and ${VAR}', () => {
  const text = [
    '# a comment',
    '',
    'PLAIN=hello world  # said after',
    'export EXPORTED=yes',
    "SINGLE='keeps $PLAIN and \\n'",
    'DOUBLE="line one\\nline two \\"quoted\\" ${PLAIN}"',
    'MULTI="first',
    'second"',
    'URL=http://${HOST}:${PORT:-3000}/x',
    'COST=\\$5',
    'HASH=a#b',
    'EMPTY=',
    'KEEP=$PLAIN-$MISSING.',
    'not a line',
    'OPEN="never closed',
  ].join('\n');
  const { values, problems } = parseDotenv(text, { HOST: 'localhost', PLAIN: 'from the environment' });
  assert.equal(values.PLAIN, 'hello world');
  assert.equal(values.EXPORTED, 'yes');
  assert.equal(values.SINGLE, 'keeps $PLAIN and \\n');
  assert.equal(values.DOUBLE, 'line one\nline two "quoted" hello world', 'earlier lines win over the environment');
  assert.equal(values.MULTI, 'first\nsecond');
  assert.equal(values.URL, 'http://localhost:3000/x');
  assert.equal(values.COST, '$5');
  assert.equal(values.HASH, 'a#b', 'a # without a space before it is part of the value');
  assert.equal(values.EMPTY, '');
  assert.equal(values.KEEP, 'hello world-.');
  assert.equal(problems.length, 2);
  assert.match(problems[0], /line 14: not a line isn't NAME=value/);
  assert.match(problems[1], /OPEN's " is never closed/);
  assert.equal(expand('${A-x}${B:-y}${C-z}', (n) => ({ A: '', B: '' })[n]), 'y' + 'z');
});

test('watch: globs, the folders to watch, and which changes restart', () => {
  assert.ok(globRegex('src/**/*.js').test('src/a.js'));
  assert.ok(globRegex('src/**/*.js').test('src/a/b/c.js'));
  assert.ok(!globRegex('src/*.js').test('src/a/b.js'));
  assert.ok(globRegex('*.{json,yml}').test('a.yml'));
  assert.ok(globRegex('a?.txt').test('ab.txt'));
  assert.deepEqual(watchRoots(['src', 'lib/**/*.js', '*.json', 'src/deep']), [{ root: 'src', deep: true }, { root: 'lib', deep: true }, { root: '.', deep: false }]);
  assert.deepEqual(watchRoots(['./**/*.js', 'src']), [{ root: '.', deep: true }]);
  const wanted = watchMatcher(['src', 'lib/**/*.js', '*.json'], ['*.test.js', 'src/generated']);
  const yes = ['src/a.js', 'src/b/c.ts', 'lib/x/y.js', 'package.json', 'src\\win.js'];
  const no = ['lib/a.ts', 'src/a.test.js', 'src/generated/x.js', 'src/node_modules/x.js', '.git/HEAD', 'other/x.js', 'sub/package.json'];
  for (const f of yes) assert.ok(wanted(f), f);
  for (const f of no) assert.ok(!wanted(f), f);
  // The folders left unwatched: only ones where nothing inside could restart it.
  const ignore = ['*.test.js', 'src/generated', 'cache', 'src/*.gen'];
  const skip = skipsFolder(ignore);
  const skipped = ['node_modules', 'a/node_modules/b', '.git', 'src/generated', 'src/generated/x', 'cache', 'lib/cache/deep', 'x.test.js'];
  const kept = ['src', 'src/gen', 'src/a.gen', 'src/generated2', 'lib', 'caches'];
  for (const f of skipped) assert.ok(skip(f), f);
  for (const f of kept) assert.ok(!skip(f), f);
  const any = watchMatcher(['**/*'], ignore);
  for (const f of skipped) assert.ok(!any(`${f}/x.js`) && !any(`${f}/y/z.js`), f);
});

test('search: smart case, and the matches picked out of the segments', () => {
  assert.deepEqual(matcher('ab')('xAbyab'), [[1, 3], [4, 6]]);
  assert.deepEqual(matcher('Ab')('xAbyab'), [[1, 3]]);
  assert.equal(matcher(''), null);
  assert.deepEqual(markRanges([{ text: 'hello ' }, { text: 'world', color: 'x' }], [[4, 8]], { bg: 'm' }), [
    { text: 'hell' },
    { text: 'o ', bg: 'm' },
    { text: 'wo', color: 'x', bg: 'm' },
    { text: 'rld', color: 'x' },
  ]);
});

test('yaml: the subset a compose file needs', () => {
  const doc = parseYaml([
    '# a compose file',
    'services:',
    '  db:',
    '    image: "postgres:16"   # its image',
    '    ports:',
    '      - "5432:5432"',
    '  api:',
    '    ports:',
    '    - 127.0.0.1:4000:4000/tcp',
    '    - 9229',
    '    depends_on: [db]',
    '    command: >',
    '      node server.js',
    '      --verbose',
    '  web:',
    '    ports:',
    '      - target: 80',
    '        published: 8080',
    '    depends_on:',
    '      api:',
    '        condition: service_started',
    "      db: {condition: 'service_healthy'}",
    'volumes:',
    '  data: {}',
    '---',
    'other: document',
  ].join('\n'));
  assert.deepEqual(doc.services.db, { image: 'postgres:16', ports: ['5432:5432'] });
  assert.deepEqual(doc.services.api.ports, ['127.0.0.1:4000:4000/tcp', 9229]);
  assert.deepEqual(doc.services.api.depends_on, ['db']);
  assert.equal(doc.services.api.command, 'node server.js --verbose\n');
  assert.deepEqual(doc.services.web.ports, [{ target: 80, published: 8080 }]);
  assert.deepEqual(doc.services.web.depends_on, { api: { condition: 'service_started' }, db: { condition: 'service_healthy' } });
  assert.deepEqual(doc.volumes, { data: {} });
  assert.equal(doc.other, undefined, 'only the first document');
  assert.deepEqual([scalar('~'), scalar('true'), scalar("'it''s'"), scalar('[a, "b, c"]')], [null, true, "it's", ['a', 'b, c']]);
  assert.equal(parseYaml(''), null);
});

test('theme: dark, light, auto from COLORFGBG, and the accent over it', () => {
  assert.deepEqual(Object.keys(LIGHT).sort(), Object.keys(DARK).sort(), 'every colour in both');
  assert.equal(backgroundFrom('15;0'), 'dark');
  assert.equal(backgroundFrom('0;default;15'), 'light');
  assert.equal(backgroundFrom(''), null);
  assert.equal(themeMode('auto', { COLORFGBG: '0;7' }), 'light');
  assert.equal(themeMode(undefined, {}), 'dark');
  assert.equal(themeMode('dark', { COLORFGBG: '0;15' }), 'dark');
  try {
    assert.equal(applyTheme({ theme: 'light' }, {}), 'light');
    assert.equal(theme.accent, LIGHT_ACCENT);
    applyTheme({ theme: 'light', accent: '#123456' }, {});
    assert.equal(theme.accent, '#123456', 'yours, as it is');
    assert.equal(theme.del, LIGHT.del);
    assert.deepEqual([{}, { theme: 'dark' }, { theme: 'light' }].map(nextTheme), ['dark', 'light', 'auto']);
    assert.match(settingRows({ theme: 'light' }).find((r) => r.id === 'theme').value, /light/);
  } finally {
    applyTheme({}, {});
  }
  assert.equal(theme.accent, DEFAULT_ACCENT);
});

test('notify: the bytes for each kind of terminal, when a run is worth it, and what an exit says', () => {
  assert.equal(notification('Bosun: api crashed', 'It exited with 1.', {}), '\x07\x1b]9;Bosun: api crashed: It exited with 1.\x07');
  assert.equal(notification('a;b', 'c\x1bd', { VTE_VERSION: '7000' }), '\x07\x1b]777;notify;a,b;c d\x1b\\');
  assert.ok(worthNotifying(10_000, {}));
  assert.ok(!worthNotifying(9_000, {}));
  assert.ok(worthNotifying(0, { notifyAfter: 0 }));
  assert.ok(!worthNotifying(60_000, { notify: false }));

  const p = { name: 'api', code: 1, trouble: 'Error: no database' };
  assert.deepEqual(exitNews(p, { restart: false }), { title: 'Bosun: api crashed', body: 'Error: no database' });
  assert.equal(exitNews(p, { restart: true, attempt: 1 }).body, 'Error: no database Restarting it.');
  assert.equal(exitNews(p, { restart: true, attempt: 2 }), null, 'once, not each time it\'s restarted');
  assert.equal(exitNews({ ...p, code: 0 }, { restart: true, attempt: 1 }), null, 'a clean exit');
  assert.deepEqual(exitNews(p, { gaveUp: true, quick: 5 }), { title: 'Bosun: api gave up', body: 'It ended 5 times in a row just after starting.' });
  assert.equal(settingRows({ notify: false }).find((r) => r.id === 'notify').value, 'off');
});
