// /leaks: what looks like a secret in a line, git log -p read as added lines, and a real temp checkout
// scanned end to end (the working tree and its history), with the values masked everywhere. Git runs with
// an empty global config and its identity given per commit, as CI has none.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextIn, readActivity } from '@fleet/kit/family.js';
import { addedLines, findSecrets, isExampleFile, masked, maskedLine, parseSince, scanRepo, secretKeys } from '../src/leaks.js';
import { normKey } from '../src/keys.js';
import { demoLocal } from '../src/demo.js';
import { KEYS, shows, start, tempHome, until } from './helpers.js';

// Made-up secrets, in the shapes the scan knows; none of them may reach a finding or the screen.
const GH = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
const AKIA = 'AKIAABCDEFGHIJKLMNOP';
const STORAGE = 'c3RvcmFnZS1rZXktZGVtby1vbmx5LW5vdC1yZWFs==';
const SQLPW = 'Sql#Passw0rd-demo';
const DBPW = 'Sup3r-S3cret-db';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vLXVzZXIifQ.c2lnbmF0dXJlLWRlbW8tb25seQ';
const SECRETS = [GH, AKIA, STORAGE, SQLPW, DBPW, JWT];
const clean = (text) => {
  for (const v of SECRETS) assert.ok(!String(text).includes(v), `${v} shown`);
};

let globalConfig;
let savedEnv;
before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'locker-gitconfig-'));
  globalConfig = join(dir, 'config');
  writeFileSync(globalConfig, '');
  savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
  // For the scan's own git too (run.js passes the environment on).
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
after(() => {
  for (const [k, v] of [['GIT_CONFIG_GLOBAL', savedEnv.global], ['GIT_CONFIG_NOSYSTEM', savedEnv.system]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Test Person', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' } });

/** A checkout: a connection string's password and a storage key in one commit, a GitHub token in the next, an AWS key not committed yet, .env ignored. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'locker-leaks-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Default: `Server=sql;Database=shop;User Id=sa;Password=${SQLPW}` }, Storage: `DefaultEndpointsProtocol=https;AccountName=shop;AccountKey=${STORAGE}` }, null, 2) + '\n');
  writeFileSync(join(dir, '.env.example'), 'Db__Password=please-set-me\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Add the settings');
  writeFileSync(join(dir, 'deploy.sh'), `#!/bin/sh\nexport GITHUB_TOKEN=${GH}\nexport Db__Password=${DBPW}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Add the deploy script');
  writeFileSync(join(dir, 'notes.txt'), `aws key ${AKIA}\n`);
  writeFileSync(join(dir, '.env'), `Db__Password=${DBPW}\n`);
  return dir;
}

test('what in a line looks like a secret: known keys given a value, and the shapes secrets have', () => {
  const known = new Set([normKey('Db:Password')]);
  const what = (line, opts) => findSecrets(line, known, opts).map((f) => f.what);
  assert.deepEqual(what(`Db__Password=${DBPW}`), ['Db__Password']);
  assert.deepEqual(what(`  "Password": "${DBPW}",`), ['Password']);
  assert.deepEqual(what('Db__Password='), []);
  assert.deepEqual(what('Db__Password=${DB_PASSWORD}'), []);
  assert.deepEqual(what('Db__Password=@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db/)'), []);
  assert.deepEqual(what(`Db__Password=${DBPW}`, { example: true }), []);
  assert.deepEqual(what(`x = "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${STORAGE}"`), ['storage account key']);
  assert.deepEqual(what(`Server=s;Pwd=${SQLPW};`), ['connection string password']);
  assert.deepEqual(what('-----BEGIN RSA PRIVATE KEY-----'), ['private key']);
  assert.deepEqual(what(`Authorization: ${JWT}`), ['JWT']);
  assert.deepEqual(what(`token: ${GH}`), ['GitHub token']);
  assert.deepEqual(what(`key ${AKIA}`), ['AWS access key']);
  assert.deepEqual(what('https://a.blob.core.windows.net/c?sv=2022-11-02&sig=AbCdEfGhIjKlMnOpQrSt%3D'), ['SAS signature']);
  assert.deepEqual(what(`ado pat ${'abcdefghijklmnopqrstuvwxyz234567'.padEnd(52, 'a')}`), ['Azure DevOps token']);
  assert.deepEqual(what(`hash ${'abcdefghijklmnopqrstuvwxyz234567'.padEnd(52, 'a')}`), []);
  assert.equal(isExampleFile('.env.example'), true);
  assert.equal(isExampleFile('src/appsettings.sample.json'), true);
  assert.equal(isExampleFile('src/config.js'), false);
});

test('a finding shows its line and value masked, never the value', () => {
  const line = `export GITHUB_TOKEN=${GH} Db__Password=${DBPW}`;
  const found = findSecrets(line, new Set([normKey('Db__Password')]));
  const shown = maskedLine(line, found);
  clean(shown);
  assert.match(shown, /GITHUB_TOKEN=••••/);
  assert.equal(masked('Db__Password', DBPW), '••••');
  assert.equal(masked(null, `Server=s;Password=${SQLPW}`), 'Server=s;Password=••••');
  assert.equal(masked(null, JWT), '••••');
});

test('the keys Locker knows to be secrets: named so in the folder, references in the app, the vault', () => {
  const keys = secretKeys({
    local: [{ entries: [{ key: 'Db__Password', value: 'x' }, { key: 'Api__BaseUrl', value: 'x' }] }],
    columns: [{ kind: 'app', entries: [{ key: 'Smtp__Key', value: '@Microsoft.KeyVault(VaultName=kv;SecretName=smtp)' }, { key: 'Plain', value: '1' }] }],
    vaultSecrets: [{ name: 'Stripe--ApiKey' }],
  });
  assert.deepEqual([...keys].sort(), ['db:password', 'smtp:key', 'stripe:apikey']);
});

test("git log -p's text as the lines each commit added, by file and line", () => {
  const log = [
    'commit 1111111111111111111111111111111111111111',
    'Author:     Ana Lima <ana@example.com>',
    'AuthorDate: 2026-10-01T10:00:00+01:00',
    'Commit:     Ana Lima <ana@example.com>',
    'CommitDate: 2026-10-01T10:00:00+01:00',
    '',
    '    Add the script',
    '',
    '    With more.',
    '',
    'diff --git a/deploy.sh b/deploy.sh',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/deploy.sh',
    '@@ -0,0 +1,2 @@',
    '+#!/bin/sh',
    '++++ not a header',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -5 +7,1 @@',
    '-old',
    '+new',
  ].join('\n');
  assert.deepEqual(
    addedLines(log).map((l) => [l.commit.slice(0, 4), l.author, l.date.slice(0, 10), l.subject, l.file, l.line, l.text]),
    [
      ['1111', 'Ana Lima', '2026-10-01', 'Add the script', 'deploy.sh', 1, '#!/bin/sh'],
      ['1111', 'Ana Lima', '2026-10-01', 'Add the script', 'deploy.sh', 2, '+++ not a header'],
      ['1111', 'Ana Lima', '2026-10-01', 'Add the script', 'a.txt', 7, 'new'],
    ],
  );
});

test('/leaks takes a number of commits or a date', () => {
  assert.deepEqual(parseSince(''), { count: 200 });
  assert.deepEqual(parseSince('50'), { count: 50 });
  assert.deepEqual(parseSince('2026-01-31'), { since: '2026-01-31' });
  assert.deepEqual(parseSince('2 weeks ago'), { since: '2 weeks ago' });
  assert.equal(parseSince('0'), null);
  assert.equal(parseSince('x; rm -rf /'), null);
});

test('a checkout scanned: the files git would commit, then the history a batch at a time, the values masked', async () => {
  const dir = makeRepo();
  try {
    const batches = [];
    const res = await scanRepo(dir, { known: new Set([normKey('Db:Password')]), range: { count: 10 }, onBatch: (b) => batches.push(b.done) });
    const by = res.findings.map((f) => [f.commit ? 'commit' : 'tree', f.file, f.line, f.key ?? f.what, f.author]);
    // The working tree (as git would commit it: .env is ignored, the example's value is only an example) …
    assert.deepEqual(by.filter(([w]) => w === 'tree').map(([, file, line, what]) => [file, line, what]).sort(), [
      ['appsettings.json', 3, 'connection string password'],
      ['appsettings.json', 5, 'storage account key'],
      ['deploy.sh', 2, 'GitHub token'],
      ['deploy.sh', 3, 'Db__Password'],
      ['notes.txt', 1, 'AWS access key'],
    ]);
    // … then each commit's added lines, newest first, with who and when.
    assert.deepEqual(by.filter(([w]) => w === 'commit').map(([, file, line, what, author]) => [file, line, what, author]), [
      ['deploy.sh', 2, 'GitHub token', 'Test Person'],
      ['deploy.sh', 3, 'Db__Password', 'Test Person'],
      ['appsettings.json', 3, 'connection string password', 'Test Person'],
      ['appsettings.json', 5, 'storage account key', 'Test Person'],
    ]);
    assert.equal(res.commits, 2);
    assert.equal(batches.at(-1), true);
    assert.match(res.findings.find((f) => f.commit).subject, /Add the deploy script/);
    clean(JSON.stringify(res.findings));
    // The last commit only.
    const one = await scanRepo(dir, { range: { count: 1 } });
    assert.ok(one.findings.filter((f) => f.commit).every((f) => f.file === 'deploy.sh'));
    // Stopped: the scan says it was cancelled.
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(scanRepo(dir, { signal: stop.signal }), (e) => e.cancelled);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('/leaks lists what it finds, masked; t hands Splice the commit, r rotates a vault secret', async () => {
  const dir = makeRepo();
  try {
    // The temp folder isn't named as the app is, so the app is the one saved.
    const app = start({ local: demoLocal({ dir }), cwd: dir, config: { history: [], target: { label: 'shop-api' } } });
    await until(shows(app, 'shop-api · kv-shop'), 'loaded');
    await until(() => app.lastFrame().includes('✗ broken'), 'the vault read');
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    for (const ch of 'leaks') app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(shows(app, 'values that look like secrets in 5 files and 2 commits'), 'the history read');
    await until(() => !app.lastFrame().includes('read…'), 'the scan done');
    const frame = app.lastFrame();
    clean(frame);
    assert.match(frame, /worktree/);
    assert.match(frame, /GitHub token/);
    assert.match(frame, /Db__Password/);
    assert.match(frame, /Test Person/);
    // The first commit row: the newest commit's GitHub token.
    for (let i = 0; i < 12 && !app.lastFrame().split('\n').some((l) => l.includes('❯') && /[0-9a-f]{8}\s+deploy\.sh:2/.test(l)); i++) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 150));
    app.stdin.write(KEYS.enter);
    await until(shows(app, 'needs a rewrite'), 'the details');
    clean(app.lastFrame());
    app.stdin.write('t');
    await until(() => app.copied.length === 1, 'the line for Splice');
    const ctx = contextIn(app.copied[0]);
    assert.equal(ctx.kind, 'commit');
    assert.equal(ctx.data.hash, git(dir, 'rev-parse', 'HEAD').trim());
    assert.equal(ctx.data.subject, 'Add the deploy script');
    app.stdin.write(KEYS.esc);
    await until(shows(app, 'Secrets in'), 'back to the list');
    // The Db__Password row: the vault's db-password.
    for (let i = 0; i < 12 && !app.lastFrame().split('\n').some((l) => l.includes('❯') && /[0-9a-f]{8}\s+deploy\.sh:3/.test(l)); i++) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 30));
    }
    // As until() does: once the cursor shows there, let the view's key handler catch up before r.
    await new Promise((r) => setTimeout(r, 150));
    app.stdin.write('r');
    await until(shows(app, 'A new value for db-password in kv-shop'), 'the rotation');
    app.stdin.write('3');
    await until(shows(app, 'stopped, nothing was changed'), 'stopped');
    clean(JSON.stringify(readActivity({ limit: 1000 })));
    app.unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
