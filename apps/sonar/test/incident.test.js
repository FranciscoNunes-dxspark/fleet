// The incident view over the demo: a problem told whole, what it copies for the siblings, Claude's
// write-up and saving it; and the pure parts it's made of.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextIn } from '@fleet/kit/family.js';
import { deploymentsBefore, framesInCheckout, framesOf, gitLogCommand, incidentMarkdown, parseGitLog, requestContext, sqlTarget } from '../src/incident.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const DAY = 24 * 3600_000;

/** A checkout holding the file the deadlock's stack goes through, changed two days ago, and another file. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'sonar-repo-'));
  const git = (args, date) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Rui Costa', GIT_AUTHOR_EMAIL: 'rui@contoso.com', GIT_COMMITTER_NAME: 'Rui Costa', GIT_COMMITTER_EMAIL: 'rui@contoso.com' } });
  git(['init', '-q'], new Date().toISOString());
  mkdirSync(join(dir, 'src', 'Contoso.Api', 'Orders'), { recursive: true });
  writeFileSync(join(dir, 'src', 'Contoso.Api', 'Orders', 'OrderRepository.cs'), 'class OrderRepository {}\n');
  writeFileSync(join(dir, 'README.md'), '# contoso\n');
  git(['add', '.'], new Date(Date.now() - 40 * DAY).toISOString());
  git(['commit', '-qm', 'The first of it'], new Date(Date.now() - 40 * DAY).toISOString());
  writeFileSync(join(dir, 'src', 'Contoso.Api', 'Orders', 'OrderRepository.cs'), 'class OrderRepository { /* one transaction */ }\n');
  git(['commit', '-qam', 'Save the order and its lines in one transaction'], new Date(Date.now() - 2 * DAY).toISOString());
  writeFileSync(join(dir, 'README.md'), '# contoso, again\n');
  git(['commit', '-qam', 'Say more in the README'], new Date(Date.now() - 2 * DAY).toISOString());
  return dir;
}

test('the incident: a problem whole, with its deployments, SQL, stack and commits; the shares, the write-up, saving', async () => {
  const repo = checkout();
  const copied = [];
  const asked = [];
  const askClaude = async (prompt, opts) => {
    asked.push({ prompt, ...opts });
    return '# Deadlocks saving orders\n\n## Summary\nOrders deadlock.';
  };
  const app = start({ cwd: repo, askClaude, copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('j');
    app.stdin.write('j');
    await until(() => /❯ ● contoso-api/.test(frame()), 'contoso-api');
    app.stdin.write('p');
    await until(() => frame().includes('SqlException') && /\d+ problems/.test(frame()), 'its problems');
    app.stdin.write('/');
    await type(app.stdin, 'incident SqlException');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Incident: Microsoft.Data.SqlClient.SqlException') && frame().includes('Y exception'), 'the incident');
    assert.match(frame(), /deadlocked on lock resources/);
    assert.match(frame(), /app\s+contoso-api/);
    assert.match(frame(), /Y exception → Splice/);
    // The whole of it, as s would save it before a write-up.
    app.stdin.write('y');
    await until(() => copied.length === 1, 'the incident copied');
    const md = copied[0];
    assert.match(md, /^# Microsoft\.Data\.SqlClient\.SqlException/);
    assert.match(md, /## Deployments in the 24 h before first seen\n\n(None\.|- )/);
    assert.match(md, /Contoso\.Api\.Orders\.OrderRepository\.SaveAsync` \/home\/runner\/work\/contoso\/contoso\/src\/Contoso\.Api\/Orders\/OrderRepository\.cs:42/);
    assert.match(md, /\d+× on contoso-sql-prod\.database\.windows\.net \| contoso \(error 1205\): `UPDATE Orders SET Status/);
    assert.match(md, /Save the order and its lines in one transaction/);
    assert.doesNotMatch(md, /Say more in the README/);

    app.stdin.write('Y');
    await until(() => frame().includes("Copied for Splice: paste it into Splice's prompt"), 'the exception for Splice');
    const exception = contextIn(copied.at(-1));
    assert.equal(exception.kind, 'exception');
    assert.equal(exception.data.app, 'contoso-api');
    assert.equal(exception.data.frames[0].line, 42);
    assert.match(exception.data.request.url, /^https:\/\/contoso-api\.azurewebsites\.net\//);

    app.stdin.write('H');
    await until(() => frame().includes("Copied for Hail: paste it into Hail's prompt"), 'the request for Hail');
    assert.equal(contextIn(copied.at(-1)).kind, 'request');

    app.stdin.write('T');
    await until(() => frame().includes('The SQL that failed with'), 'the failing SQL');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Copied for Trawl: paste it into Trawl's prompt"), 'a query for Trawl');
    assert.deepEqual(contextIn(copied.at(-1)), { kind: 'query', data: { sql: 'UPDATE Orders SET Status = @status, UpdatedAt = SYSUTCDATETIME() WHERE Id = @id', server: 'contoso-sql-prod.database.windows.net', database: 'contoso' } });
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Incident: Microsoft') && !frame().includes('The SQL that failed'), 'back to the incident');

    app.stdin.write('w');
    await until(() => frame().includes('Write-up: Microsoft.Data.SqlClient.SqlException') && frame().includes('Orders deadlock.'), 'the write-up');
    assert.deepEqual(asked[0].tools, ['Read', 'Grep', 'Glob']);
    assert.equal(asked[0].cwd, repo);
    assert.match(asked[0].prompt, /Summary, Impact, Timeline, Likely cause, Next steps/);
    assert.match(asked[0].input, /## Failing SQL/);
    app.stdin.write('s');
    await until(() => frame().includes("Save Claude's write-up as"), 'the file asked for');
    for (let i = 0; i < 60; i++) app.stdin.write(KEYS.backspace);
    await type(app.stdin, 'deadlock.md');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Wrote Claude's write-up to"), 'saved');
    assert.match(readFileSync(join(repo, 'deadlock.md'), 'utf8'), /^# Deadlocks saving orders/);
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Incident: Microsoft'), 'back to the incident from the write-up');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Incident: Microsoft'), 'the incident closed');
    app.stdin.write('/');
    await type(app.stdin, 'incident save again.md');
    app.stdin.write(KEYS.enter);
    await until(() => /Wrote Claude's write-up to \S*again\.md/.test(frame()), '/incident save');
    assert.match(readFileSync(join(repo, 'again.md'), 'utf8'), /Orders deadlock\./);
  } finally {
    app.unmount();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('outside a checkout, I says nothing of commits and fails nowhere', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sonar-nogit-'));
  const app = start({ cwd: dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('3');
    await until(() => /\d+ problems/.test(frame()), 'the problems');
    app.stdin.write('I');
    await until(() => frame().includes('Incident: ') && frame().includes('Y exception'), 'the incident');
    app.stdin.write('G');
    await until(() => frame().includes('Failing SQL'), 'the end of it');
    assert.doesNotMatch(frame(), /Commits to its files/);
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident parts: frames from details or text, deployments before, files in the checkout, git log, SQL targets, requests', () => {
  const details = [{ parsedStack: [{ method: 'A.B', fileName: 'D:\\a\\1\\s\\src\\Api\\Orders.cs', line: 7 }, { method: 'X', fileName: '', line: 0 }] }];
  assert.deepEqual(framesOf(details), [{ file: 'D:\\a\\1\\s\\src\\Api\\Orders.cs', line: 7, method: 'A.B' }]);
  assert.deepEqual(framesOf(JSON.stringify(details)).length, 1);
  assert.deepEqual(framesOf([{ rawStack: '    at run (/app/src/job.js:3:1)' }]), [{ method: 'run', file: '/app/src/job.js', line: 3 }]);
  assert.deepEqual(framesOf(null), []);

  const now = Date.parse('2026-10-20T12:00:00Z');
  const d = (h, message) => ({ start: new Date(now - h * 3600_000).toISOString(), message, status: 'succeeded' });
  const r = deploymentsBefore([d(30, 'old'), d(5, 'recent'), d(-2, 'after')], new Date(now).toISOString());
  assert.deepEqual(r.within.map((x) => x.message), ['recent']);
  assert.equal(r.latest.message, 'recent');
  assert.deepEqual(deploymentsBefore([d(30, 'old')], new Date(now).toISOString()).within, []);

  const files = ['src/Api/Orders.cs', 'test/Api/Orders.cs', 'src/util.js', 'lib/util.js', 'README.md'];
  assert.deepEqual(framesInCheckout([{ file: 'D:\\s\\src\\Api\\Orders.cs', line: 7 }, { file: '/x/y/util.js', line: 1 }, { file: '/x/README.md', line: 2 }], files).map((f) => f.path), ['src/Api/Orders.cs', 'README.md']);

  const cmd = gitLogCommand(['src/a b.cs', 'x.js'], '2026-10-20T12:00:00Z');
  assert.match(cmd, /--since=2026-10-06T12:00:00\.000Z --until=2026-10-20T12:00:00\.000Z/);
  assert.match(cmd, / -- "src\/a b\.cs" x\.js$/);
  assert.deepEqual(parseGitLog('abc\tAna\t2026-10-19T10:00:00+01:00\tFix\tit\n'), [{ hash: 'abc', author: 'Ana', at: '2026-10-19T10:00:00+01:00', subject: 'Fix\tit' }]);
  assert.deepEqual(sqlTarget('srv.database.windows.net | shop'), { server: 'srv.database.windows.net', database: 'shop' });
  assert.deepEqual(sqlTarget('srv'), { server: 'srv', database: null });
  assert.deepEqual(requestContext({ name: 'POST /api/orders', url: 'https://x/api/orders' }), { method: 'POST', url: 'https://x/api/orders', headers: {}, body: '', name: 'POST /api/orders' });
  assert.equal(requestContext({ name: 'a trace' }), null);

  const md = incidentMarkdown({ problem: { type: 'T', message: 'm', role: 'app', first: '2026-10-20T10:00:00Z', last: '2026-10-20T11:00:00Z', count: 3, users: 1, problemId: 'T at x' }, span: { label: '24h' }, deploys: { within: [], latest: null }, rows: [], frames: [], sql: [], repo: null }, now);
  assert.match(md, /- \*\*Count:\*\* 3 in the last 24h, 1 user/);
  assert.match(md, /## Deployments in the 24 h before first seen\n\nNone\./);
  assert.doesNotMatch(md, /Commits/);
});
