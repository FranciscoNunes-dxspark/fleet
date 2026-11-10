// keel mcp (cli/mcp.js) on the demo organization: the protocol, every tool's answer, the errors
// Claude can act on, and `keel mcp --demo` itself over stdio, whose stdout carries only messages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-mcp-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const { openKeel } = await import('../cli/service.js');
const { createServer } = await import('../cli/mcp.js');

let keel;
let server;
before(() => {
  keel = openKeel();
  server = createServer({ service: keel.service });
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

const call = async (name, args = {}) => {
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: res.result.content[0].text, error: Boolean(res.result.isError) };
};

const TOOL_NAMES = ['line', 'inbox', 'pull_requests', 'pull_request', 'pipelines', 'pipeline_run', 'waiting_to_ship', 'production', 'dora', 'work_item'];

test('initialize, tools/list, ping and unknown tools', async () => {
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'keel');
  assert.match(init.result.instructions, /only reads/);
  const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOL_NAMES);
  for (const t of list.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.ok(t.description.length > 40, t.name);
  }
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  const unknown = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'deploy', arguments: {} } });
  assert.equal(unknown.error.code, -32602);
});

test('line: every stage with its counts, or one stage with more of its cards', async () => {
  const all = await call('line');
  assert.equal(all.error, false);
  for (const name of ['Planned:', 'Building:', 'In review:', 'Merged:', 'Deploying:', 'Live:']) assert.ok(all.text.includes(name), name);
  assert.match(all.text, /cards?/);
  const review = await call('line', { stage: 'review', cards: 3 });
  assert.match(review.text, /^In review: \d+ cards/);
  assert.ok(!review.text.includes('Planned:'));
  assert.ok(review.text.split('\n').filter((l) => l.startsWith('  ') && !l.startsWith('  …')).length <= 3);
  assert.match(review.text, /PR: /);
  assert.equal((await call('line', { stage: 'shipped' })).error, true);
});

test('inbox: ranked items with their reasons, by kind', async () => {
  const all = await call('inbox', { limit: 5 });
  assert.match(all.text, /^\d+ items/);
  assert.match(all.text, /\[act now\] PR: /);
  assert.match(all.text, /\n {2}- /);
  assert.match(all.text, /… \d+ more/);
  const pipelines = await call('inbox', { kind: 'pipeline' });
  assert.ok(!/\] PR: /.test(pipelines.text));
});

test('pull_requests: riskiest first, filtered, and one in full with its risk reasons', async () => {
  const list = await call('pull_requests');
  assert.match(list.text, /^\d+ active pull requests, riskiest first/);
  const scores = [...list.text.matchAll(/risk (\d+) \(/g)].map((m) => Number(m[1]));
  assert.ok(scores.length > 3);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  const one = await call('pull_requests', { filter: 'storefront-web' });
  assert.ok(one.text.split('\n').filter((l) => l.startsWith('  ')).every((l) => l.includes('storefront-web')));
  const none = await call('pull_requests', { filter: 'no such repository anywhere' });
  assert.equal(none.text, 'No active pull requests match.');

  const { prs } = await keel.service.pullRequests();
  const pr = prs.find((p) => p.status === 'active');
  const full = await call('pull_request', { id: pr.id });
  assert.equal(full.error, false);
  assert.ok(full.text.startsWith(pr.title));
  assert.match(full.text, /Risk \d+ of 100/);
  assert.match(full.text, /Reviewers/);
  const missing = await call('pull_request', { id: 999999 });
  assert.equal(missing.error, true);
  assert.match(missing.text, /name its repo/);
});

test('pipelines and pipeline_run: failing first, and a failed run with its log lines', async () => {
  const list = await call('pipelines', { failing: true });
  assert.ok(list.text.split('\n').filter((l) => !l.startsWith('  ')).every((l) => /: (failing|unstable)/.test(l)));
  const rows = await keel.service.pipelines();
  const red = rows.find((r) => r.health === 'failing');
  const run = await call('pipeline_run', { pipeline: red.definition.name, failed: true });
  assert.equal(run.error, false);
  assert.ok(run.text.startsWith(`${red.definition.name} `));
  assert.match(run.text, /failed/);
  assert.match(run.text, /✗ /);
  const vague = await call('pipeline_run', { pipeline: 'CI' });
  assert.equal(vague.error, true);
  assert.match(vague.text, /Several pipelines match "CI"/);
  const nothing = await call('pipeline_run', { pipeline: 'no such pipeline' });
  assert.match(nothing.text, /No pipeline matches/);
});

test('waiting_to_ship, production and dora', async () => {
  const ship = await call('waiting_to_ship');
  assert.equal(ship.error, false);
  assert.match(ship.text, /waiting|all deployed|can't tell/);

  const prod = await call('production');
  const { monitors } = await keel.service.production();
  for (const m of monitors) assert.ok(prod.text.includes(`${m.name}: `), m.name);
  // Monitors that need someone come first.
  const first = prod.text.split('\n')[0];
  if (monitors.some((m) => m.state === 'down')) assert.match(first, /: down/);
  const one = await call('production', { monitor: monitors[0].name });
  assert.ok(one.text.startsWith(monitors[0].name));

  const dora = await call('dora', { days: 30 });
  assert.match(dora.text, /^DORA, the last 30 days/);
  assert.match(dora.text, /How: /);
  assert.equal((await call('dora', { scope: 'no such team' })).error, true);
});

test('work_item: one in full, and a sentence for one that is not there', async () => {
  const { items } = await keel.service.workItems();
  const w = await call('work_item', { id: items[0].id });
  assert.ok(w.text.startsWith(items[0].title));
  assert.match(w.text, new RegExp(`${items[0].type} ${items[0].id}`));
  assert.equal((await call('work_item', { id: 'x' })).error, true);
});

test('keel mcp --demo answers over stdio, with nothing but protocol messages on stdout', async () => {
  const child = spawn(process.execPath, ['--import', '@fleet/kit/register.js', 'bin/keel.js', 'mcp', '--demo'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const replies = new Map();
  const lines = [];
  const rl = createInterface({ input: child.stdout });
  const done = new Promise((resolve) => rl.on('line', (line) => {
    lines.push(line);
    const msg = JSON.parse(line);
    replies.set(msg.id, msg);
    if (replies.has(1) && replies.has(2)) resolve();
  }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pipelines', arguments: { failing: true } } })}\n`);
  await done;
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.equal(replies.get(1).result.serverInfo.name, 'keel');
  assert.match(replies.get(2).result.content[0].text, /: failing/);
  assert.ok(lines.every((l) => JSON.parse(l).jsonrpc === '2.0'));
  assert.match(stderr, /MCP server ready \(the demo organization\)/);
});
