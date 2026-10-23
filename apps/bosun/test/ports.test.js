// The port map: lsof, ss, netstat and tasklist read, the crew's marked, and /ports in the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { listeningPorts, markCrew, parseLsof, parseNetstat, parseSs, parseTasklist, tidyPorts } from '../src/ports.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const LSOF = `COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node      41234 me     23u  IPv4 0x5c3a3b7a3f1b2a1d      0t0  TCP 127.0.0.1:3000 (LISTEN)
node      41234 me     24u  IPv6 0x5c3a3b7a3f1b2a1e      0t0  TCP [::1]:3000 (LISTEN)
Google\\x20  999 me     30u  IPv4 0x1                     0t0  TCP *:9222 (LISTEN)`;

const SS = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511          0.0.0.0:5173       0.0.0.0:*     users:(("node",pid=777,fd=20))
LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*
LISTEN 0      511             [::]:8080          [::]:*     users:(("python3",pid=12,fd=3),("python3",pid=13,fd=3))`;

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1044
  TCP    127.0.0.1:4280         0.0.0.0:0              LISTENING       5120
  TCP    127.0.0.1:4280         127.0.0.1:50000        ESTABLISHED     5120
  TCP    [::]:4280              [::]:0                 LISTENING       5120
  UDP    0.0.0.0:500            *:*                                    4200`;

const TASKLIST = `"svchost.exe","1044","Services","0","12,000 K"
"node.exe","5120","Console","1","45,000 K"`;

test('lsof, ss and netstat read into one list, a line per port and process', () => {
  assert.deepEqual(tidyPorts(parseLsof(LSOF)).map((e) => [e.port, e.pid, e.name, e.hosts.join(' ')]), [[3000, 41234, 'node', '127.0.0.1 ::1'], [9222, 999, 'Google ', '*']]);
  assert.deepEqual(parseSs(SS).map((e) => [e.port, e.pid, e.name, e.host]), [[5173, 777, 'node', '0.0.0.0'], [53, null, null, '127.0.0.53'], [8080, 12, 'python3', '::']]);
  assert.deepEqual(parseNetstat(NETSTAT).map((e) => [e.port, e.pid]), [[135, 1044], [4280, 5120], [4280, 5120]]);
  assert.equal(parseTasklist(TASKLIST).get(5120), 'node.exe');
  const runs = { netstat: NETSTAT, tasklist: TASKLIST, ss: SS, lsof: LSOF };
  const run = (cmd) => ({ status: 0, stdout: runs[cmd] });
  assert.deepEqual(listeningPorts({ run, platform: 'win32' }).map((e) => [e.port, e.name]), [[135, 'svchost.exe'], [4280, 'node.exe']]);
  assert.deepEqual(listeningPorts({ run, platform: 'linux' }).map((e) => e.port), [53, 5173, 8080]);
  assert.deepEqual(listeningPorts({ run: (cmd) => (cmd === 'ss' ? { status: null, error: new Error('ENOENT') } : run(cmd)), platform: 'linux' }).map((e) => e.port), [3000, 9222]);
  assert.deepEqual(listeningPorts({ run, platform: 'darwin' }).map((e) => e.port), [3000, 9222]);
  assert.deepEqual(listeningPorts({ run: () => { throw new Error('no'); }, platform: 'darwin' }), []);
  const marked = markCrew(tidyPorts(parseLsof(LSOF)), [{ name: 'api', port: 3000 }, { name: 'web', port: 5173, pid: 999 }]);
  assert.deepEqual(marked.map((e) => e.proc), ['api', 'web']);
});

test('/ports lists them, the crew\'s marked; f frees one after asking, o opens it', async () => {
  const opened = [];
  const killed = [];
  const app = start({
    listPorts: () => [{ port: 4999, pid: 4321, name: 'node', hosts: ['127.0.0.1'] }, { port: 8080, pid: 55, name: 'nginx', hosts: ['*'] }],
    pidsOnPort: (port) => (port === 8080 ? [55] : [4321]),
    killPids: (pids) => killed.push(...pids),
    openUrl: (u) => opened.push(u),
  });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /❯ ● api/.test(frame()), 'the crew');
    app.stdin.write('/');
    await type(app.stdin, 'ports');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Ports listening') && /:4999\s+pid 4321\s+node\s+api \(this crew\)/.test(frame()) && /:8080\s+pid\s+55\s+nginx/.test(frame()), 'the list');
    app.stdin.write('j');
    await until(() => /❯ :8080/.test(frame()), 'on 8080');
    app.stdin.write('o');
    await until(() => opened.length === 1, 'opened');
    assert.deepEqual(opened, ['http://localhost:8080']);
    app.stdin.write('f');
    await until(() => frame().includes('Stop process 55, which holds port 8080?'), 'the question');
    app.stdin.write(KEYS.enter);
    await until(() => killed.length === 1 && frame().includes('Ports listening'), 'stopped, and the list again');
    assert.deepEqual(killed, [55]);
  } finally {
    app.unmount();
  }
});
