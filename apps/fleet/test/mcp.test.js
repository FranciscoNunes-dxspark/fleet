// `fleet mcp`: the bounds and masks every answer goes through, the tools in-process over a temporary
// git repository, family folder, Bosun recording and Hail history (Sonar on its demo),
// and the whole server spawned as Claude Code starts it, Trawl's tools through its
// own processes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { logActivity, writeMood } from '@fleet/kit/family.js';
import { MAX_TEXT, clip, count, finish, sinceOf, tail } from '../src/mcp/bound.js';
import { createFleetServer } from '../src/mcp/server.js';

const BIN = fileURLToPath(new URL('../bin/fleet.js', import.meta.url));
const base = mkdtempSync(join(tmpdir(), 'fleet-mcp-'));
const repo = join(base, 'repo');
const homes = { FAMILY_HOME: join(base, 'family'), BOSUN_HOME: join(base, 'bosun'), HAIL_HOME: join(base, 'hail'), TRAWL_HOME: join(base, 'trawl'), SONAR_HOME: join(base, 'sonar'), WHARF_HOME: join(base, 'wharf'), DATA_DIR: join(base, 'keel') };
const saved = {};

const git = (...args) => execFileSync('git', ['-c', 'user.name=Tess', '-c', 'user.email=tess@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });

before(async () => {
  for (const [k, v] of Object.entries(homes)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'app.js'), 'const a = 1;\nconst b = 2;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First commit');
  writeFileSync(join(repo, 'app.js'), 'const a = 1;\nconst b = 3;\nconst password = "hunter2";\n');
  git('commit', '-q', '-am', 'Change b');
  writeFileSync(join(repo, 'notes.txt'), 'new\n');
  writeFileSync(join(repo, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Default: 'Server=db.example.com;Database=Shop;User Id=app;Password=s3cret!;' }, Api: { BaseUrl: 'https://api.example.com' } }));
  writeFileSync(join(repo, 'api.http'), '@host = https://api.example.com\n@token = abc123secret\n\n### Get players\n# @name players\nGET {{host}}/players\nAuthorization: Bearer {{token}}\n\n### Create\nPOST {{host}}/players\nContent-Type: application/json\n\n{"name":"x"}\n');

  // What the apps would have written: activity, a mood, a Bosun recording and a Hail response.
  logActivity('splice', { text: 'Pushed main to origin', project: repo });
  logActivity('trawl', { text: 'UPDATE dbo.Players on prod (password=letmein)', kind: 'write', project: repo });
  logActivity('bosun', { text: 'Restarted api', project: join(base, 'elsewhere') });
  writeMood('sonar', { mood: 'worried', reason: 'production has 12 new exceptions' });

  const { Recorder, sessionsDir } = await import('../../bosun/src/recorder.js');
  const now = Date.now();
  const rec = new Recorder({ dir: sessionsDir(repo), project: repo, procs: [{ name: 'api', port: 5000, spec: { run: 'node api.js', port: 5000 } }, { name: 'web', spec: { run: 'npm run dev' } }], now: now - 5000 });
  rec.line('api', { at: now - 4000, text: '── node api.js' });
  rec.state('api', { status: 'running', code: null, portOpen: true }, now - 3900);
  rec.line('api', { at: now - 3000, text: 'GET /players x-request-id=req-12345678 200' });
  rec.line('api', { at: now - 2000, text: 'Error: connect ECONNREFUSED db:5432', err: true });
  rec.state('api', { status: 'crashed', code: 1 }, now - 1900);
  rec.line('web', { at: now - 1000, text: 'ready on http://localhost:3000' });
  rec.close();

  const { appendHistory, entryFor, historyFile } = await import('../../hail/src/history.js');
  appendHistory(
    historyFile(join(repo, 'api.http')),
    entryFor({
      label: 'players',
      name: 'players',
      at: now,
      request: { method: 'GET', url: 'https://api.example.com/players', headers: [['Authorization', 'Bearer abc123secret']], body: '', secrets: ['abc123secret'] },
      response: { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json']], body: '[{"name":"Ana","token":"tok-999999"}]', ms: 42, size: 40, url: 'https://api.example.com/players' },
      checks: { tests: [{ name: 'is 200', passed: true }], log: [], error: null },
    }),
  );
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('answers are bounded at a line and masked', () => {
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
  const c = clip(long, 1000);
  assert.ok(c.length < 1100);
  assert.match(c, /\n… \(cut: \d+ more characters; ask for less\)$/);
  assert.ok(c.split('\n').at(-2).startsWith('line '));
  const t = tail(long, 1000);
  assert.match(t, /^… \(\d+ earlier characters left out\)\nline \d+/);
  assert.ok(t.endsWith('line 4999 xxxxxxxxxxxxxxxxxxxx'));
  assert.equal(finish('short'), 'short');
  assert.ok(finish(long).length <= MAX_TEXT + 100);
  const masked = finish('password=hunter2 and Authorization: Bearer eyJabc.def and postgres://me:pw@db/x');
  assert.doesNotMatch(masked, /hunter2|eyJabc|:pw@/);
  assert.equal(count('7', 3, 5), 5);
  assert.equal(count(undefined, 3, 5), 3);
  assert.equal(count(-2, 3, 5), 3);
  assert.equal(sinceOf('2h', 10 * 3_600_000), 8 * 3_600_000);
  assert.equal(sinceOf('30', 3_600_000), 1_800_000);
  assert.equal(sinceOf('2026-10-27T00:00:00Z'), Date.parse('2026-10-27T00:00:00Z'));
  assert.equal(sinceOf(''), 0);
});

const server = () => createFleetServer({ project: repo, demo: true, trawl: false });
const call = async (s, name, args = {}) => {
  const res = await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: res.result.content[0].text, error: Boolean(res.result.isError) };
};

test('initialize and tools/list: every tool read-only, with a schema', async () => {
  const s = server();
  const init = await s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'fleet');
  assert.match(init.result.instructions, /read-only/);
  const { tools } = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result;
  const names = tools.map((t) => t.name);
  for (const n of ['git_status', 'git_log', 'git_show', 'git_diff', 'git_blame', 'git_branches', 'bosun_crew', 'bosun_log', 'bosun_search', 'hail_requests', 'hail_history', 'sonar_components', 'sonar_problems', 'sonar_incident', 'sonar_query', 'family_timeline', 'family_moods', 'family_wiring'])
    assert.ok(names.includes(n), n);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(t.run, undefined);
  }
  assert.equal((await s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } })).error.code, -32602);
});

test('git: status, log, show (masked), diff, blame and branches', async () => {
  const s = server();
  const status = await call(s, 'git_status');
  assert.match(status.text, /branch: main, no upstream/);
  assert.match(status.text, /\? notes\.txt/);
  const log = await call(s, 'git_log', { n: 5 });
  assert.match(log.text, /HEAD → main.*Change b/);
  assert.match(log.text, /Tess {2}First commit/);
  assert.equal(log.text.split('\n').length, 2);
  assert.match((await call(s, 'git_log', { graph: true })).text, /\* [0-9a-f]+ .*Change b/);
  const show = await call(s, 'git_show', { commit: 'HEAD' });
  assert.match(show.text, /\+const b = 3;/);
  assert.doesNotMatch(show.text, /hunter2/);
  assert.match((await call(s, 'git_show', { commit: 'HEAD', max_chars: 50 })).text, /cut: \d+ more characters/);
  assert.match((await call(s, 'git_show', { commit: '--output=/tmp/x' })).text, /isn't a revision/);
  assert.equal((await call(s, 'git_diff')).text, 'No changes.');
  assert.match((await call(s, 'git_diff', { from: 'HEAD~1', stat: true })).text, /app\.js/);
  const blame = await call(s, 'git_blame', { path: 'app.js', start: 2, end: 2 });
  assert.match(blame.text, /^[0-9a-f]{10} {2}\d{4}-\d\d-\d\d {2}Tess +2 {2}const b = 3;$/);
  assert.match((await call(s, 'git_branches')).text, /\* main {2}[0-9a-f]+/);
  const elsewhere = await call(s, 'git_status', { folder: base });
  assert.ok(elsewhere.error);
  assert.match(elsewhere.text, /isn't inside a git repository/);
});

test('family: the timeline for this project or all, moods, and the wiring masked', async () => {
  const s = server();
  const mine = await call(s, 'family_timeline');
  assert.match(mine.text, /Splice {2}Pushed main to origin/);
  assert.match(mine.text, /Trawl {2}\[write\] UPDATE dbo\.Players/);
  assert.doesNotMatch(mine.text, /letmein|Restarted api/);
  assert.match((await call(s, 'family_timeline', { all_projects: true })).text, /Bosun {2}Restarted api/);
  assert.doesNotMatch((await call(s, 'family_timeline', { all_projects: true, app: 'trawl' })).text, /Splice/);
  assert.equal((await call(s, 'family_timeline', { since: '2h', limit: 1 })).text.split('\n').length, 1);
  assert.match((await call(s, 'family_timeline', { since: '2999-01-01T00:00:00Z' })).text, /^Nothing in the family's activity log/);
  assert.match((await call(s, 'family_moods')).text, /Sonar \(Ping\) is worried: production has 12 new exceptions/);
  const wiring = await call(s, 'family_wiring');
  assert.match(wiring.text, /ConnectionStrings:Default = Server=db\.example\.com;Database=Shop;User Id=app;Password=••••;/);
  assert.match(wiring.text, /Api:BaseUrl = https:\/\/api\.example\.com/);
  assert.match(wiring.text, /\.http files: api\.http/);
  assert.match(wiring.text, /databases: Default \(appsettings\.json\): sqlserver db\.example\.com\/Shop/);
  assert.doesNotMatch(wiring.text, /s3cret/);
});

test("bosun: the crew from the latest recording, a process's lines, and searching them", async () => {
  const s = server();
  const crew = await call(s, 'bosun_crew');
  assert.match(crew.text, /being recorded now/);
  assert.match(crew.text, /api: crashed, exit 1, port 5000 open/);
  assert.match(crew.text, /trouble: Error: connect ECONNREFUSED db:5432/);
  assert.match(crew.text, /web: stopped .*runs: npm run dev/);
  const log = await call(s, 'bosun_log', { process: 'api', lines: 2 });
  assert.equal(log.text.split('\n').length, 2);
  assert.match(log.text, /! Error: connect ECONNREFUSED/);
  assert.match((await call(s, 'bosun_log', { process: 'nope' })).text, /No process called nope\. The crew: api, web/);
  const byId = await call(s, 'bosun_search', { request_id: 'req-12345678' });
  assert.match(byId.text, /^1 match:\n[\d:]+ api {3}GET \/players/);
  assert.match((await call(s, 'bosun_search', { text: 'READY' })).text, /web {3}ready on/);
  assert.ok((await call(s, 'bosun_search', {})).error);
  const none = await call(s, 'bosun_crew', { folder: base });
  assert.match(none.text, /no recorded runs/);
});

test('hail: the requests with variables unresolved and masked, and the kept responses', async () => {
  const s = server();
  const reqs = await call(s, 'hail_requests', { headers: true });
  assert.match(reqs.text, /api\.http \(2 requests\)/);
  assert.match(reqs.text, /1\. players: GET \{\{host\}\}\/players {2}\(line 6\)/);
  assert.match(reqs.text, /token = ••••/);
  assert.match(reqs.text, /Authorization: Bearer ••••/);
  assert.doesNotMatch(reqs.text, /abc123secret/);
  const hist = await call(s, 'hail_history');
  assert.match(hist.text, /players {2}GET https:\/\/api\.example\.com\/players {2}→ 200 in 42 ms, checks 1\/1 passed/);
  const one = await call(s, 'hail_history', { request: 'players' });
  assert.match(one.text, /→ 200 OK in 42 ms/);
  assert.match(one.text, /"name":"Ana"/);
  assert.doesNotMatch(one.text, /abc123secret/);
  assert.match((await call(s, 'hail_history', { request: '1' })).text, /→ 200 OK/);
  assert.match((await call(s, 'hail_history', { request: 'Create' })).text, /No kept response for "Create"/);
});

test('sonar on its demo', async () => {
  const s = server();
  assert.match((await call(s, 'sonar_components')).text, /contoso-prod-ai/);
  const problems = await call(s, 'sonar_problems', { component: 'contoso-prod-ai' });
  assert.match(problems.text, /System\.TimeoutException/);
  const id = /problem_id: (.+?) {2}operation/.exec(problems.text)[1];
  const inc = await call(s, 'sonar_incident', { component: 'contoso-prod-ai', problem_id: id });
  assert.ok(!inc.error, inc.text);
  assert.match(inc.text, /The operation /);
  const q = await call(s, 'sonar_query', { component: 'contoso-prod-ai', kql: 'exceptions | take 3', max_rows: 2 });
  assert.ok(!q.error, q.text);
  assert.match((await call(s, 'sonar_query', { kql: '.drop table x' })).text, /Control commands are refused/);
});

test('fleet mcp from the checkout: initialize, tools/list, family, git and Trawl through its process', { timeout: 120_000 }, async () => {
  const env = { ...process.env, ...homes };
  const child = spawn(process.execPath, [BIN, 'mcp', '--project', repo, '--demo'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const waiting = new Map();
  createInterface({ input: child.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  const req = (method, params) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name, args = {}) => (await req('tools/call', { name, arguments: args })).result;
  try {
    const init = await req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'fleet', stderr);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const names = (await req('tools/list')).result.tools.map((t) => t.name);
    for (const n of ['git_log', 'family_timeline', 'trawl_list_connections', 'trawl_run_query']) assert.ok(names.includes(n), `${n} in ${names.join(' ')}\n${stderr}`);
    assert.match((await tool('git_log', { n: 1 })).content[0].text, /Change b/);
    assert.match((await tool('family_timeline')).content[0].text, /Pushed main to origin/);
    assert.match((await tool('trawl_list_connections')).content[0].text, /demo-prod: .*production/);
  } finally {
    child.stdin.end();
  }
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, stderr);
});
