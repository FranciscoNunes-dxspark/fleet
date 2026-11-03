// bilge-ignore-file: the secrets below are fakes, built from pieces.
// Secrets in the history: the diff parser and the scan (pure), then /secrets, `splice security` and the
// check before a push against throwaway repositories.
import { removeTemp } from './temp.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { commitFindings, diffFiles, historyRange, inWorkingTree, parseHistoryLog, readHistory, secretDetail, unquote } from '../src/secrets.js';
import { parseSecurityArgs, runSecurity } from '../src/headless.js';
import { App } from '../src/ui/App.jsx';

const AWS = ['AKIA', 'Q4ZB7XWM2HNE9TLC'].join('');
const AWS2 = ['ASIA', 'R7TC2MWQ9ZLK4HXB'].join('');
const GH = ['gh', 'p_', 'Zx9Qw2'.repeat(6)].join('');
const KEY = ['-----BEGIN ', 'RSA PRIVATE', ' KEY-----'].join('');

test('a commit\'s patch as its files: added lines with their new numbers, renames, binaries, quoted paths', () => {
  const files = diffFiles(
    [
      'diff --git a/src/app.js b/src/app.js',
      'index 1111111..2222222 100644',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -3 +3 @@ start',
      '-old',
      '+new three',
      '@@ -10,0 +11,2 @@',
      '+eleven',
      '++++ twelve, not a header',
      'diff --git a/old name.txt b/docs/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to docs/new name.txt',
      'diff --git a/lib/a.js b/lib/b.js',
      'similarity index 80%',
      'rename from lib/a.js',
      'rename to lib/b.js',
      'index 3333333..4444444 100644',
      '--- a/lib/a.js',
      '+++ b/lib/b.js',
      '@@ -1,0 +2 @@',
      '+added in the rename',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'index 0000000..5555555',
      'Binary files /dev/null and b/logo.png differ',
      'diff --git "a/caf\\303\\251\\tx.js" "b/caf\\303\\251\\tx.js"',
      'new file mode 100644',
      'index 0000000..6666666',
      '--- /dev/null',
      '+++ "b/caf\\303\\251\\tx.js"',
      '@@ -0,0 +1 @@',
      '+one',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index 7777777..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    files.map((f) => [f.status, f.path, f.from, f.binary, f.added.map((a) => `${a.line}:${a.text}`)]),
    [
      ['M', 'src/app.js', null, false, ['3:new three', '11:eleven', '12:+++ twelve, not a header']],
      ['R', 'docs/new name.txt', 'old name.txt', false, []],
      ['R', 'lib/b.js', 'lib/a.js', false, ['2:added in the rename']],
      ['A', 'logo.png', null, true, []],
      ['A', 'café\tx.js', null, false, ['1:one']],
      ['D', 'gone.txt', null, false, []],
    ],
  );
  assert.equal(unquote('"a\\"b\\\\c"'), 'a"b\\c');
  assert.equal(unquote('plain'), 'plain');
});

test('the history log, and which commits /secrets reads', () => {
  const commits = parseHistoryLog(`\x1e${'a'.repeat(40)}\x1fAna\x1f2026-01-02T03:04:05+00:00\x1fAdd it\n\ndiff --git a/x b/x\n\x1e${'b'.repeat(40)}\x1fBo\x1f2026-01-01T00:00:00+00:00\x1fFirst\n`);
  assert.deepEqual(
    commits.map((c) => [c.hash[0], c.author, c.date.slice(0, 10), c.subject, c.patch.includes('diff --git')]),
    [
      ['a', 'Ana', '2026-01-02', 'Add it', true],
      ['b', 'Bo', '2026-01-01', 'First', false],
    ],
  );
  assert.deepEqual(historyRange('').range, ['HEAD']);
  assert.deepEqual(historyRange('all').range, ['--all']);
  assert.deepEqual(historyRange('main..feature').range, ['main..feature']);
  assert.ok(historyRange('--output=x').error);
});

test('the secrets a commit adds: the kit\'s rules on its added lines, redacted, with the commit; key stores and .env files', () => {
  const patch = [
    'diff --git a/config/deploy.js b/config/deploy.js',
    '--- a/config/deploy.js',
    '+++ b/config/deploy.js',
    '@@ -40,0 +41,3 @@',
    `+const key = '${AWS}';`,
    '+// and its token',
    `+const token = "${GH}";`,
    'diff --git a/certs/site.pfx b/certs/site.pfx',
    'new file mode 100644',
    'Binary files /dev/null and b/certs/site.pfx differ',
    'diff --git a/.env b/.env',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.env',
    '@@ -0,0 +1 @@',
    '+NAME=app',
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1,0 +2 @@',
    `+"x": "${AWS}"`,
    '',
  ].join('\n');
  const found = commitFindings({ hash: 'c'.repeat(40), author: 'Ana', date: '2026-01-02T03:04:05Z', subject: 'Deploy', patch });
  assert.deepEqual(
    found.map((f) => [f.rule, f.where, f.line, f.commit[0], f.author]),
    [
      ['aws-key', 'config/deploy.js', 41, 'c', 'Ana'],
      ['github-token', 'config/deploy.js', 43, 'c', 'Ana'],
      ['key-store', 'certs/site.pfx', 0, 'c', 'Ana'],
      ['env-committed', '.env', 0, 'c', 'Ana'],
    ],
  );
  assert.match(found[0].excerpt, /AKIA•+/);
  for (const f of found) assert.doesNotMatch(JSON.stringify(f), new RegExp(`${AWS}|${GH}`));
  // A file that says bilge-ignore-file in its first lines is left alone, as Bilge leaves it.
  const ignored = commitFindings({ hash: 'd'.repeat(40), patch: ['diff --git a/t.js b/t.js', 'new file mode 100644', '--- /dev/null', '+++ b/t.js', '@@ -0,0 +1,2 @@', '+// bilge-ignore-file', `+x = '${AWS}'`, ''].join('\n') });
  assert.deepEqual(ignored, []);
  // Whether it's still there: by the secret itself, which never leaves the scan.
  const tree = { 'a.js': `ok\nx = '${AWS}'\n`, 'b.js': 'nothing now\n' };
  const marked = inWorkingTree('/r', [{ finding: { where: 'a.js' }, value: AWS }, { finding: { where: 'b.js' }, value: AWS }, { finding: { where: 'c.js' }, value: AWS }, { finding: { where: 'a.js' }, value: null }], { read: (p) => tree[p.replace(/\\/g, '/').split('/').at(-1)] ?? null });
  assert.deepEqual(marked.map((f) => f.inTree), [true, false, false, true]);
  // One that moved is found in the other files.
  const moved = inWorkingTree('/r', [{ finding: { where: 'b.js' }, value: AWS }], { read: (p) => tree[p.replace(/\\/g, '/').split('/').at(-1)] ?? null, others: () => ['b.js', 'a.js'] });
  assert.equal(moved[0].inTree, true);
});

test('a finding whole: the commit, the line cut short, and how to rotate and purge it, never run', () => {
  const text = secretDetail({ rule: 'aws-key', title: 'AWS access key', where: 'a.js', line: 2, excerpt: "x = 'AKIA••••••••'", commit: 'e'.repeat(40), author: 'Ana', date: '2026-01-02T03:04:05Z', subject: 'Keys', inTree: false, why: 'Why.', fix: 'Deactivate the key in IAM.' });
  assert.match(text, /Commit {3}eeeeeeeeee {2}Keys/);
  assert.match(text, /Author {3}Ana, 2026-01-02/);
  assert.match(text, /only in the history/);
  assert.match(text, /Deactivate the key in IAM/);
  assert.match(text, /git filter-repo --replace-text/);
  assert.match(text, /never runs any of this/);
});

test('splice security\'s arguments', () => {
  assert.deepEqual(parseSecurityArgs(['repo', '--json', '--sarif', 'out.sarif', '--fail-on', 'critical', '--all']), { dir: 'repo', json: true, sarif: true, sarifFile: 'out.sarif', failOn: 'critical', all: true });
  assert.equal(parseSecurityArgs(['--sarif', '--json']).sarifFile, null);
  assert.ok(parseSecurityArgs(['--fail-on', 'loud']).error);
  assert.ok(parseSecurityArgs(['--nope']).error);
});

let base;
let lastApp = null;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'splice-secrets-'));
  process.env.SPLICE_HOME = join(base, 'home');
});

after(() => removeTemp(base));

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

// Commits without a git identity of the machine's: CI has none.
const ID = ['-c', 'user.name=Ana Tester', '-c', 'user.email=ana@example.com', '-c', 'commit.gpgsign=false'];

function makeRepo(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  const g = (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  const commit = (message, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      if (text == null) rmSync(join(dir, path));
      else writeFileSync(join(dir, path), text);
    }
    g('add', '-A');
    g('commit', '-q', '-m', message);
  };
  return { dir, g, commit };
}

// A secret added then removed (only in the history), one still there, one carried through a rename.
function historyRepo(name) {
  const r = makeRepo(name);
  r.commit('First', { 'README.md': 'hello\n' });
  r.commit('Add the deploy config', { 'config/deploy.js': `module.exports = {\n  region: 'eu-west-1',\n  key: '${AWS}',\n};\n` });
  r.commit('Read the key from the environment', { 'config/deploy.js': "module.exports = {\n  region: 'eu-west-1',\n  key: process.env.AWS_KEY,\n};\n" });
  r.commit('Add the release script', { 'scripts/release.sh': `#!/bin/sh\nGH_TOKEN=${GH} gh release create\n` });
  renameSync(join(r.dir, 'scripts/release.sh'), join(r.dir, 'scripts/ship.sh'));
  r.commit('Rename the release script', {});
  return r;
}

test('the history read for secrets: one added then removed is only in the history, one still there is in the tree, a rename isn\'t read twice', async () => {
  const { dir, g } = historyRepo('history-repo');
  const found = await readHistory({ root: dir });
  assert.equal(found.commits, 5);
  assert.equal(found.truncated, false);
  const by = Object.fromEntries(found.findings.map((f) => [f.rule, f]));
  assert.deepEqual(Object.keys(by).sort(), ['aws-key', 'github-token']);
  assert.equal(by['aws-key'].where, 'config/deploy.js');
  assert.equal(by['aws-key'].line, 3);
  assert.equal(by['aws-key'].inTree, false);
  assert.equal(by['aws-key'].author, 'Ana Tester');
  assert.equal(by['aws-key'].subject, 'Add the deploy config');
  assert.equal(by['aws-key'].commit, g('rev-parse', 'HEAD~3'));
  assert.equal(by['github-token'].where, 'scripts/release.sh');
  assert.equal(by['github-token'].line, 2);
  // Still there, under its new name.
  assert.equal(by['github-token'].inTree, true);
  assert.doesNotMatch(JSON.stringify(found), new RegExp(`${AWS}|${GH}`));
  // A range: only the commits after the first two.
  const later = await readHistory({ root: dir, range: ['HEAD~3..HEAD'] });
  assert.deepEqual(later.findings.map((f) => f.rule), ['github-token']);
  const capped = await readHistory({ root: dir, max: 2 });
  assert.equal(capped.commits, 2);
  assert.equal(capped.truncated, true);
});

test('splice security prints the kit\'s security JSON, SARIF, and fails on what --fail-on says', async () => {
  const { dir } = historyRepo('headless-repo');
  // A secret that's still in the tree at its own path.
  writeFileSync(join(dir, 'app.py'), `KEY = '${AWS2}'\n`);
  execFileSync('git', [...ID, 'add', '-A'], { cwd: dir });
  execFileSync('git', [...ID, 'commit', '-q', '-m', 'App'], { cwd: dir });
  let out = '';
  const write = (s) => {
    out += s;
  };
  const code = await runSecurity([dir, '--json'], { write, now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(code, 1);
  const json = JSON.parse(out);
  assert.equal(json.app, 'splice');
  assert.equal(json.check, 'history');
  assert.match(json.target, /headless-repo$/);
  assert.equal(json.at, '2026-11-03T00:00:00.000Z');
  assert.equal(json.commits, 6);
  assert.equal(json.counts.critical, 3);
  const app = json.findings.find((f) => f.where === 'app.py');
  assert.deepEqual(
    { rule: app.rule, line: app.line, inTree: app.inTree, author: app.author, commit: app.commit.length, date: typeof app.date },
    { rule: 'aws-key', line: 1, inTree: true, author: 'Ana Tester', commit: 40, date: 'string' },
  );
  assert.equal(json.findings.find((f) => f.where === 'config/deploy.js').inTree, false);
  assert.ok(json.findings.every((f) => !('excerpt' in f)), 'no excerpts in the JSON');
  assert.doesNotMatch(out, new RegExp(`${AWS}|${AWS2}|${GH}`));

  out = '';
  const sarifFile = join(base, 'out.sarif');
  assert.equal(await runSecurity([dir, '--fail-on', 'none', '--sarif', sarifFile], { write }), 0);
  const sarif = JSON.parse(readFileSync(sarifFile, 'utf8'));
  assert.equal(sarif.runs[0].tool.driver.name, 'Splice');
  assert.ok(sarif.runs[0].results.some((r) => r.ruleId === 'aws-key' && r.locations[0].physicalLocation.artifactLocation.uri === 'app.py'));
  assert.match(out, /CRIT AWS access key {2}config\/deploy\.js:3\n {5}in [0-9a-f]{7} Add the deploy config \(Ana Tester, \d{4}-\d\d-\d\d\), only in the history/);
  assert.match(out, /3 critical/);

  out = '';
  assert.equal(await runSecurity([join(base)], { write }), 2);
  assert.match(out, /isn't in a git repository/);
});

async function command(app, text) {
  app.stdin.write('/');
  await until(() => app.lastFrame().includes('> /'), 'the prompt');
  for (const ch of text) {
    app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  await until(() => app.lastFrame().includes(`> /${text}`), `/${text} typed`);
  app.stdin.write('\r');
}

test('/secrets lists what the history holds; ↵ shows one whole with how to purge it; d its diff', async () => {
  const { dir } = historyRepo('ui-repo');
  lastApp = render(React.createElement(App, { initialPath: dir, config: { recent: [], roots: [], history: [] } }));
  const app = lastApp;
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Rename the release script'), 'the graph');
    await command(app, 'secrets');
    await until(() => frame().includes('Secrets in the current branch: 2 critical'), 'the list');
    assert.match(frame(), /history +AWS access key {2}config\/deploy\.js:3/);
    assert.match(frame(), /GitHub token {2}scripts\/release\.sh:2/);
    assert.doesNotMatch(frame(), new RegExp(`${AWS}|${GH}`));
    app.stdin.write('\r');
    await until(() => frame().includes('git filter-repo'), 'the detail');
    assert.match(frame(), /only in the history/);
    assert.doesNotMatch(frame(), new RegExp(AWS));
    app.stdin.write('\x1b');
    await until(() => frame().includes('Secrets in the current branch') && !frame().includes('git filter-repo'), 'back to the list');
    app.stdin.write('d');
    await until(() => /Add the deploy config|Add the release script/.test(frame()) && frame().includes('diff --git'), 'the diff');
  } finally {
    app.unmount();
  }
});
