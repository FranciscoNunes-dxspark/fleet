// Tunnels: the tool picked, its arguments, the address in what cloudflared and ngrok say (recorded),
// how to install one; the supervisor's tunnel child, kept across a restart and closed with the
// process; and T in the Crew view, with a fake tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';
import { installHint, tunnelArgs, tunnelProblem, tunnelTool, tunnelUrl } from '../src/tunnel.js';
import { Supervisor } from '../src/supervisor.js';
import { readSpec } from '../src/crew.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

// Recorded: what cloudflared's quick tunnel writes (on stderr), and ngrok's JSON log.
const CLOUDFLARED = [
  '2026-10-24T09:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.',
  '2026-10-24T09:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-10-24T09:00:01Z INF +--------------------------------------------------------------------------------------------+',
  '2026-10-24T09:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  '2026-10-24T09:00:01Z INF |  https://seasonal-deck-organisms-sf.trycloudflare.com                                      |',
  '2026-10-24T09:00:01Z INF +--------------------------------------------------------------------------------------------+',
];
const NGROK = [
  '{"addr":"","lvl":"info","msg":"open config file","path":"/home/me/.config/ngrok/ngrok.yml","t":"2026-10-24T09:00:00Z"}',
  '{"lvl":"info","msg":"client session established","obj":"tunnels.session","t":"2026-10-24T09:00:01Z"}',
  '{"addr":"http://localhost:4280","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-10-24T09:00:01Z","url":"https://3f2a-81-2-69-160.ngrok-free.app"}',
];

test('the tool, its arguments, the address it says and how to install one', () => {
  const find = (have) => (name) => (have.includes(name) ? `/usr/bin/${name}` : null);
  assert.deepEqual(tunnelTool(null, find(['ngrok', 'cloudflared'])), { tool: 'cloudflared', path: '/usr/bin/cloudflared' });
  assert.deepEqual(tunnelTool(null, find(['ngrok'])), { tool: 'ngrok', path: '/usr/bin/ngrok' });
  assert.deepEqual(tunnelTool('ngrok', find(['cloudflared'])), { missing: ['ngrok'] });
  assert.deepEqual(tunnelTool(null, find([])), { missing: ['cloudflared', 'ngrok'] });
  assert.deepEqual(tunnelArgs('cloudflared', 4280), ['tunnel', '--no-autoupdate', '--url', 'http://localhost:4280']);
  assert.deepEqual(tunnelArgs('ngrok', 4280), ['http', '4280', '--log', 'stdout', '--log-format', 'json']);
  assert.deepEqual(CLOUDFLARED.map((l) => tunnelUrl('cloudflared', l)).filter(Boolean), ['https://seasonal-deck-organisms-sf.trycloudflare.com']);
  assert.equal(tunnelUrl('cloudflared', '2026-10-24T09:00:00Z ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp'), null);
  assert.deepEqual(NGROK.map((l) => tunnelUrl('ngrok', l)).filter(Boolean), ['https://3f2a-81-2-69-160.ngrok-free.app']);
  assert.equal(tunnelProblem('cloudflared', '2026-10-24T09:00:00Z ERR failed to request quick Tunnel'), 'failed to request quick Tunnel');
  assert.equal(tunnelProblem('cloudflared', CLOUDFLARED[1]), null);
  assert.equal(tunnelProblem('ngrok', '{"lvl":"eror","msg":"command failed","err":"authentication failed: Usage of ngrok requires a verified account"}'), 'authentication failed: Usage of ngrok requires a verified account');
  assert.equal(tunnelProblem('ngrok', NGROK[2]), null);
  assert.match(installHint(['cloudflared', 'ngrok'], 'win32'), /winget install --id Cloudflare.cloudflared[\s\S]*winget install ngrok.ngrok, then ngrok config add-authtoken/);
  assert.match(installHint(['cloudflared'], 'darwin'), /brew install cloudflared/);
  assert.match(installHint(['ngrok'], 'linux'), /ngrok.com\/download/);
  const read = readSpec({ tunnel: 'ngrok', procs: { api: { run: 'x', port: 1, tunnel: 'cloudflared' }, bad: { run: 'y', tunnel: 'frp' } } });
  assert.equal(read.tunnel, 'ngrok');
  assert.equal(read.procs[0].tunnel, 'cloudflared');
  assert.deepEqual(read.problems, ['"bad": "tunnel" is "cloudflared" or "ngrok"']);
  assert.deepEqual(readSpec({ tunnel: 'x', procs: {} }).problems, ['"tunnel" is "cloudflared" or "ngrok"']);
});

/** A tunnel tool that says `lines` (on stderr, as cloudflared does) and ends when killed. */
function fakeTool(lines) {
  const started = [];
  const spawnFn = (path, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };
    started.push({ path, args, opts, child });
    setTimeout(() => child.stderr.write(lines.map((l) => `${l}\n`).join('')), 20);
    return child;
  };
  return { spawnFn, started };
}

const waitFor = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test('the supervisor keeps the tunnel across a restart and closes it with the process and with Bosun', async () => {
  const dir = project({});
  const tool = fakeTool(CLOUDFLARED);
  const events = [];
  const sup = new Supervisor(readSpec({ procs: { api: { run: 'node -e "setInterval(() => {}, 1000)"', port: 4280 }, worker: 'node -e "setInterval(() => {}, 1000)"' } }).procs, { dir, tunnelSpawn: tool.spawnFn, onEvent: (e) => events.push(e) });
  try {
    sup.start('api');
    sup.start('worker');
    assert.equal(sup.openTunnel('worker', { tool: 'cloudflared', path: 'cloudflared' }), false, 'no port, no tunnel');
    assert.equal(sup.openTunnel('api', { tool: 'cloudflared', path: '/bin/cloudflared' }), true);
    assert.equal(sup.openTunnel('api', { tool: 'cloudflared', path: '/bin/cloudflared' }), false, 'one at a time');
    const api = sup.get('api');
    await waitFor(() => api.tunnel?.url, 'the address');
    assert.equal(api.tunnel.url, 'https://seasonal-deck-organisms-sf.trycloudflare.com');
    assert.deepEqual(tool.started[0].args, ['tunnel', '--no-autoupdate', '--url', 'http://localhost:4280']);
    assert.equal(tool.started[0].path, '/bin/cloudflared');
    assert.ok(api.lines.some((l) => l.text === '── tunnel open: https://seasonal-deck-organisms-sf.trycloudflare.com'));
    assert.equal(events.find((e) => e.type === 'tunnel').url, api.tunnel.url);

    await sup.restart('api');
    assert.ok(api.tunnel && !tool.started[0].child.killed, 'r keeps it');
    await sup.stop('api');
    await waitFor(() => !api.tunnel, 'closed with the process');
    assert.ok(tool.started[0].child.killed);
    assert.deepEqual(events.filter((e) => e.type === 'tunnel-closed').map((e) => [e.asked, e.url]), [[true, 'https://seasonal-deck-organisms-sf.trycloudflare.com']]);

    sup.start('api');
    sup.openTunnel('api', { tool: 'cloudflared', path: 'cloudflared' });
    await waitFor(() => api.tunnel?.url, 'a second one');
    sup.killAllNow();
    assert.ok(tool.started[1].child.killed, 'and with Bosun');
  } finally {
    sup.dispose();
  }
});

test('T asks, opens the tunnel and copies its address; T again closes it; without a tool it says how to install one', async () => {
  const dir = project({ procs: { api: { run: 'node -e "setInterval(() => {}, 1000)"', port: 4281 }, web: 'node -e "setInterval(() => {}, 1000)"' } });
  const tool = fakeTool(NGROK);
  const copied = [];
  let have = ['ngrok'];
  const app = start({ dir, tunnelSpawn: tool.spawnFn, findTool: (name) => (have.includes(name) ? name : null), copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api\s+running/.test(frame()) && /web\s+running/.test(frame()), 'the crew up');
    app.stdin.write('\x1bt');
    await until(() => frame().includes("Open api's port 4281 to the internet through ngrok?"), 'the question');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('api is open at https://3f2a-81-2-69-160.ngrok-free.app (copied)'), 'open, and said');
    assert.deepEqual(copied, ['https://3f2a-81-2-69-160.ngrok-free.app']);
    assert.ok(frame().includes('⇄'), 'beside it');
    assert.ok(frame().includes('⇄ https://3f2a-81-2-69-160.ngrok-free.app'), 'in its log\'s title');
    assert.deepEqual(tool.started[0].args, ['http', '4281', '--log', 'stdout', '--log-format', 'json']);
    app.stdin.write('\x1bt');
    await until(() => frame().includes("Closed api's tunnel"), 'closed');
    assert.ok(!frame().includes('⇄'));

    app.stdin.write('j');
    app.stdin.write(':');
    await type(app.stdin, 'tunnel web');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('web has no port to open'), 'no port, no tunnel');
    have = [];
    app.stdin.write(':');
    await type(app.stdin, 'tunnel api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('A tunnel needs cloudflared or ngrok on the PATH'), 'how to install one');
    assert.equal(tool.started.length, 1);
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});
