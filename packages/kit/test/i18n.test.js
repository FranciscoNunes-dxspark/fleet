// codescan.js's translation check: keys used against a locale folder's, translations nothing uses, and
// JSX text never passed through t(). The fixture is laid out as Keel's web app is (English text as the
// key, European Portuguese in client/src/locales/pt/), with an i18next app and a .NET one beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { I18N_DEFAULTS, i18nFindings, isUserText, localeOf, scanCode, translationEntries } from '../codescan.js';

const KEEL_LIKE = {
  'client/src/locales/pt.js': "import shell from './pt/shell.js';\nexport default { ...shell };\n",
  'client/src/locales/pt/shell.js': [
    'export default {',
    "  'Save changes': 'Guardar alterações',",
    "  '{n} items': '{n} itens',",
    `  "Don't go": 'Não vás',`,
    "  'Open {days}d (stale)': 'Aberto há {days} d (parado)',",
    "  'Nobody says this any more': 'Já ninguém diz isto',",
    "  'Built at run time': '',",
    "  'Close': 'Fechar',",
    '};',
  ].join('\n'),
  'client/src/pages/Home.jsx': [
    "import { t } from '../i18n.js';",
    '// An example in a comment is no use: t(\'In a comment\')',
    'export function Home({ n, x }) {',
    '  return (',
    '    <div className="home">',
    "      <h1>{t('Save changes')}</h1>",
    "      <p>{t('{n} items', { n })} {t(\"Don't go\")}</p>",
    "      <p>{t('Not translated yet')}</p>",
    '      <p className="lead">Plain words in the page</p>',
    '      <p>',
    '        Text that wraps in the source',
    '      </p>',
    '      <div className="brand">Keel</div>',
    '      <span>Azure DevOps</span>',
    '      <code>keel login</code>',
    '      <span className="mono">npm install</span>',
    '      <span>{n}<small>ms</small></span>',
    '      <input placeholder="Search work items" />',
    "      <button title={t('Close')}>Close</button>",
    '      <span>Pull Request</span>',
    "      {x > 0 && <b>{t('Save changes')}</b>}",
    "      {t('Built at run time') && null}",
    '    </div>',
    '  );',
    '}',
  ].join('\n'),
  'client/src/pages/Home.test.jsx': "<p>Words in a test</p>\nt('Only in a test')\n",
  // Keel's terminal app: English only, beside the web app, and not its business.
  'cli/ui/App.jsx': "<Text>English only here</Text>\nt('Not the web app')\n",
  // The server sends a sentence the client translates with tx(): the key is a template there.
  'server/attention.js': 'const reason = `Open ${days}d (stale)`;\n',
};

const rules = (found) => found.map((f) => `${f.rule} ${f.path}:${f.line} ${f.excerpt}`);

test('localeOf: a locale folder\'s language, by folder or file; resx by its name; anything else is no locale', () => {
  assert.equal(localeOf('client/src/locales/pt/shell.js'), 'pt');
  assert.equal(localeOf('client/src/locales/pt.js'), 'pt');
  assert.equal(localeOf('public/locales/pt-PT/common.json'), 'pt-PT');
  assert.equal(localeOf('src/i18n/en.json'), 'en');
  assert.equal(localeOf('Resources/Strings.pt-PT.resx'), 'pt-PT');
  assert.equal(localeOf('Resources/Strings.resx'), 'en');
  assert.equal(localeOf('Resources/Strings.resx', { source: 'pt' }), 'pt');
  assert.equal(localeOf('src/pages/locales.js'), null);
  assert.equal(localeOf('src/locales/README.md'), null);
  assert.equal(localeOf('src/locales/helpers/format.js'), null);
  assert.equal(localeOf('src/strings/pt/a.js'), null);
  assert.equal(localeOf('src/strings/pt/a.js', { locales: ['strings'] }), 'pt');
  assert.deepEqual(I18N_DEFAULTS.functions, ['t', 'tj', '$t', 'i18n.t']);
});

test('translationEntries: a JS dictionary\'s lines, JSON nested with dots, .resx data', () => {
  assert.deepEqual(translationEntries('pt/a.js', KEEL_LIKE['client/src/locales/pt/shell.js']).map((e) => [e.key, e.line, e.empty]), [
    ['Save changes', 2, false],
    ['{n} items', 3, false],
    ["Don't go", 4, false],
    ['Open {days}d (stale)', 5, false],
    ['Nobody says this any more', 6, false],
    ['Built at run time', 7, true],
    ['Close', 8, false],
  ]);
  assert.deepEqual(translationEntries('pt.json', '{\n  "home": {\n    "title": "Início",\n    "empty": ""\n  }\n}').map((e) => [e.key, e.line, e.empty]), [['home.title', 3, false], ['home.empty', 4, true]]);
  const resx = '<root>\n  <data name="Hello" xml:space="preserve">\n    <value>Olá</value>\n  </data>\n  <data name="$this.Text"><value>Form1</value></data>\n  <data name="Bye"><value /></data>\n</root>';
  assert.deepEqual(translationEntries('S.pt.resx', resx).map((e) => [e.key, e.line, e.empty]), [['Hello', 2, false], ['Bye', 6, true]]);
});

test('Keel\'s layout: a key with no Portuguese, a translation nothing uses, and plain JSX text; the terminal app and tests left alone', () => {
  const found = i18nFindings(Object.entries(KEEL_LIKE).map(([path, text]) => ({ path, text })));
  assert.deepEqual(rules(found), [
    'i18n-missing client/src/pages/Home.jsx:8 Not translated yet',
    'i18n-missing client/src/pages/Home.jsx:22 Built at run time',
    'i18n-unused client/src/locales/pt/shell.js:6 Nobody says this any more',
    'i18n-plain-text client/src/pages/Home.jsx:9 Plain words in the page',
    'i18n-plain-text client/src/pages/Home.jsx:11 Text that wraps in the source',
    'i18n-plain-text client/src/pages/Home.jsx:18 Search work items',
    // A word in capitals the project translates elsewhere; Pull Request it doesn't, so it may be a name.
    'i18n-plain-text client/src/pages/Home.jsx:19 Close',
  ]);
  const [missing] = found;
  assert.equal(missing.kind, 'i18n');
  assert.equal(missing.severity, 'medium');
  assert.equal(missing.title, 'No pt translation');
  assert.match(missing.fix, /client\/src\/locales\/pt/);
  assert.equal(found.find((f) => f.rule === 'i18n-unused').severity, 'low');
  assert.equal(found.find((f) => f.rule === 'i18n-plain-text').title, 'Text not passed through t()');
  // Other function names, from the settings: nothing here calls tr(), so every key is unused.
  const other = i18nFindings(Object.entries(KEEL_LIKE).map(([path, text]) => ({ path, text })), { functions: ['tr'] });
  assert.ok(!other.some((f) => f.rule === 'i18n-missing'));
  // Without a locale folder, nothing is said.
  assert.deepEqual(i18nFindings([{ path: 'src/App.jsx', text: "<p>Hello there friend</p>\nt('Save')" }]), []);
});

test('an i18next app (ids as keys, a source-language file) and a .NET one (resx)', () => {
  const files = [
    { path: 'web/public/locales/en/common.json', text: JSON.stringify({ home: { title: 'Home', intro: 'Welcome back' }, gone: 'Old' }, null, 2) },
    { path: 'web/public/locales/pt/common.json', text: JSON.stringify({ home: { title: 'Início', intro: '' } }, null, 2) },
    { path: 'web/src/Home.vue', text: "<h1>{{ $t('home.title') }}</h1>\n<p>{{ $t('home.intro') }}</p>\n<p>{{ $t('home.missing') }}</p>\n" },
    { path: 'api/Resources/Strings.resx', text: '<root>\n<data name="Hello"><value>Hello</value></data>\n<data name="Bye"><value>Bye</value></data>\n</root>' },
    { path: 'api/Resources/Strings.pt-PT.resx', text: '<root>\n<data name="Hello"><value>Olá</value></data>\n</root>' },
    { path: 'api/Pages/Index.cshtml', text: '<h1>@Localizer["Hello"]</h1>\n<p>@Localizer["Bye"]</p>\n' },
  ];
  const found = i18nFindings(files);
  const said = found.map((f) => `${f.rule} ${f.path}:${f.line} ${f.excerpt} [${f.title}]`);
  assert.ok(said.includes('i18n-missing web/src/Home.vue:2 home.intro [No pt translation]'), said.join('\n'));
  assert.ok(said.includes('i18n-missing web/src/Home.vue:3 home.missing [No en, pt translation]'), said.join('\n'));
  assert.ok(said.includes('i18n-missing api/Pages/Index.cshtml:2 Bye [No pt-PT translation]'), said.join('\n'));
  assert.ok(said.includes('i18n-unused web/public/locales/en/common.json:6 gone [Translation no code uses]'), said.join('\n'));
  // A .resx's keys are properties in code (Strings.Hello): never said to be unused.
  assert.ok(!found.some((f) => f.rule === 'i18n-unused' && f.path.endsWith('.resx')));
});

test('isUserText: words people read, not names, units, commands or code', () => {
  for (const s of ['Save changes', 'Plain words in the page', 'Nothing needs you right now.']) assert.equal(isUserText(s), true, s);
  // A word in capitals could be a name: counted only when the project translates it (the Keel-like test's Close).
  for (const s of ['Close', 'Keel', 'Azure DevOps', 'Claude Code (CLI)', 'ms', 'kB', '—', '42', 'onClick', 'src/app.js', 'https://example.com', '&nbsp;']) assert.equal(isUserText(s), false, s);
});

test('scanCode runs the check once over the walk, and i18n: false leaves it out', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kit-i18n-'));
  try {
    for (const [path, text] of Object.entries(KEEL_LIKE)) {
      mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...path.split('/')), text);
    }
    const r = await scanCode(root);
    const i18n = r.findings.filter((f) => f.kind === 'i18n');
    assert.equal(i18n.filter((f) => f.rule === 'i18n-missing').length, 2);
    assert.equal(i18n.filter((f) => f.rule === 'i18n-unused').length, 1);
    // Worst first among the rest: the missing keys (medium) before the low ones.
    assert.equal(r.findings.findIndex((f) => f.rule === 'i18n-missing') < r.findings.findIndex((f) => f.rule === 'i18n-unused'), true);
    const off = await scanCode(root, { i18n: false });
    assert.equal(off.findings.filter((f) => f.kind === 'i18n').length, 0);
    const named = await scanCode(root, { i18n: { functions: ['tr'] } });
    assert.equal(named.findings.filter((f) => f.rule === 'i18n-missing').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
