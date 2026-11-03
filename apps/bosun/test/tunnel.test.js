// Sharing a process: the tool picked, its arguments, the address in what devtunnel, cloudflared and
// ngrok say, how to install one; the supervisor's tunnel child, kept across a restart and closed with
// the process; and alt+t, /share and /unshare in the Crew view, with a fake tool (nothing reaches the
// network or runs a real one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';
import { contextIn, readActivity } from '@fleet/kit/family.js';
import { installHint, tunnelArgs, tunnelProblem, tunnelTool, tunnelUrl } from '../src/tunnel.js';
import { Supervisor } from '../src/supervisor.js';
import { readSpec } from '../src/crew.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

// What devtunnel host writes (on stdout), as it writes it.
const DEVTUNNEL = [
  'Hosting port: 4282',
  'Connect via browser: https://k2l8mx4p-4282.euw.devtunnels.ms, https://k2l8mx4p.euw.devtunnels.ms:4282',
  'Inspect network activity: https://k2l8mx4p-4282-inspect.euw.devtunnels.ms',
  '',
  'Ready to accept connections for tunnel: quick-fish-k2l8mx4p.euw',
];
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
  assert.deepEqual(tunnelTool(null, find(['ngrok', 'cloudflared', 'devtunnel'])), { tool: 'devtunnel', path: '/usr/bin/devtunnel' });
  assert.deepEqual(tunnelTool('cloudflared', find(['cloudflared', 'devtunnel'])), { tool: 'cloudflared', path: '/usr/bin/cloudflared' });
  assert.deepEqual(tunnelTool(null, find(['ngrok', 'cloudflared'])), { tool: 'cloudflared', path: '/usr/bin/cloudflared' });
  assert.deepEqual(tunnelTool(null, find(['ngrok'])), { tool: 'ngrok', path: '/usr/bin/ngrok' });
  assert.deepEqual(tunnelTool('ngrok', find(['cloudflared'])), { missing: ['ngrok'] });
  assert.deepEqual(tunnelTool(null, find([])), { missing: ['devtunnel', 'cloudflared', 'ngrok'] });
  assert.deepEqual(tunnelArgs('devtunnel', 4282), ['host', '-p', '4282', '--allow-anonymous']);
  assert.deepEqual(DEVTUNNEL.map((l) => tunnelUrl('devtunnel', l)).filter(Boolean), ['https://k2l8mx4p-4282.euw.devtunnels.ms']);
  assert.equal(tunnelProblem('devtunnel', 'Error: Login required. Run devtunnel user login.'), 'Login required. Run devtunnel user login.');
  assert.equal(tunnelProblem('devtunnel', DEVTUNNEL[1]), null);
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
  assert.match(installHint(['devtunnel', 'cloudflared', 'ngrok'], 'win32'), /^Sharing needs devtunnel, cloudflared or ngrok on the PATH[\s\S]*winget install Microsoft.devtunnel, then devtunnel user login/);
  const read = readSpec({ tunnel: 'ngrok', procs: { api: { run: 'x', port: 1, tunnel: 'cloudflared' }, bad: { run: 'y', tunnel: 'frp' } } });
  assert.equal(read.tunnel, 'ngrok');
  assert.equal(read.procs[0].tunnel, 'cloudflared');
  assert.deepEqual(read.problems, ['"bad": "tunnel" is "devtunnel", "cloudflared" or "ngrok"']);
  assert.deepEqual(readSpec({ tunnel: 'x', procs: {} }).problems, ['"tunnel" is "devtunnel", "cloudflared" or "ngrok"']);
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

test('alt+t asks, shares it and copies its address, offers it to Hail; alt+t again stops it; without a tool it says how to install one', async () => {
  const dir = project({ procs: { api: { run: 'node -e "setInterval(() => {}, 1000)"', port: 4281 }, web: 'node -e "setInterval(() => {}, 1000)"' } });
  const tool = fakeTool(NGROK);
  const copied = [];
  let have = ['ngrok'];
  const app = start({ dir, tunnelSpawn: tool.spawnFn, findTool: (name) => (have.includes(name) ? name : null), copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api\s+running/.test(frame()) && /web\s+running/.test(frame()), 'the crew up');
    app.stdin.write('\x1bt');
    await until(() => frame().includes("Share api's port 4281 on the internet through ngrok?"), 'the question');
    assert.ok(frame().includes('The address it gets is public'), 'saying plainly it\'s public');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('api is public at https://3f2a-81-2-69-160.ngrok-free.app (copied)'), 'shared, and said');
    assert.deepEqual(copied, ['https://3f2a-81-2-69-160.ngrok-free.app']);
    await until(() => frame().includes('Copy a GET of https://3f2a-81-2-69-160.ngrok-free.app for Hail?'), 'offered to Hail');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Copied for Hail'), 'copied for Hail');
    const request = contextIn(copied[1]);
    assert.equal(request.kind, 'request');
    assert.deepEqual([request.data.method, request.data.url], ['GET', 'https://3f2a-81-2-69-160.ngrok-free.app']);
    assert.ok(frame().includes('⇄'), 'beside it');
    assert.ok(frame().includes('⇄ https://3f2a-81-2-69-160.ngrok-free.app'), 'in its log\'s title');
    assert.deepEqual(tool.started[0].args, ['http', '4281', '--log', 'stdout', '--log-format', 'json']);
    app.stdin.write('\x1bt');
    await until(() => frame().includes('Stopped sharing api'), 'stopped');
    assert.ok(!frame().includes('⇄'));

    app.stdin.write('j');
    app.stdin.write(':');
    await type(app.stdin, 'tunnel web');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('web has no port to share'), 'no port, no tunnel');
    have = [];
    app.stdin.write(':');
    await type(app.stdin, 'tunnel api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Sharing needs devtunnel, cloudflared or ngrok on the PATH'), 'how to install one');
    assert.equal(tool.started.length, 1);
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});

test('/share asks, shares through devtunnel first and logs which process, never the address; /unshare stops it', async () => {
  const dir = project({ procs: { api: { run: 'node -e "setInterval(() => {}, 1000)"', port: 4282 } } });
  const tool = fakeTool(DEVTUNNEL);
  const copied = [];
  const app = start({ dir, tunnelSpawn: tool.spawnFn, findTool: (name) => (['devtunnel', 'cloudflared'].includes(name) ? `/opt/${name}` : null), copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api\s+running/.test(frame()), 'the crew up');
    app.stdin.write(':');
    await type(app.stdin, 'share api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Share api's port 4282 on the internet through devtunnel?"), 'the question');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('through devtunnel?'), 'answered no');
    assert.equal(tool.started.length, 0, 'no means nothing runs');

    app.stdin.write(':');
    await type(app.stdin, 'share api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Share api's port 4282 on the internet through devtunnel?"), 'asked again');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('api is public at https://k2l8mx4p-4282.euw.devtunnels.ms (copied)'), 'shared');
    assert.equal(tool.started[0].path, '/opt/devtunnel');
    assert.deepEqual(tool.started[0].args, ['host', '-p', '4282', '--allow-anonymous']);
    assert.equal(copied[0], 'https://k2l8mx4p-4282.euw.devtunnels.ms');
    await until(() => frame().includes('for Hail?'), 'offered to Hail');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('for Hail?'), 'declined');

    app.stdin.write(':');
    await type(app.stdin, 'unshare api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Stopped sharing api'), 'stopped');
    assert.ok(tool.started[0].child.killed);
    const logged = readActivity({ project: dir }).map((e) => e.text);
    assert.ok(logged.includes('Shared api (port 4282) on the internet through devtunnel'), logged.join('\n'));
    assert.ok(logged.includes('Stopped sharing api'));
    assert.ok(!logged.some((t) => t.includes('devtunnels.ms')), 'never the address');

    app.stdin.write(':');
    await type(app.stdin, 'unshare api');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("api isn't shared"), 'nothing to stop');
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});
