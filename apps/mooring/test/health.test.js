// The server's health (health.js, /health, alt+h): what the one command prints, parsed, and the panel
// and Tug's mood over the demo host.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readMoods } from '@fleet/kit/family.js';
import { HEALTH_COMMAND, healthProblems, parseHealth, uptimeText } from '../src/health.js';
import { DEMO_HEALTH } from '../src/demo.js';
import { familyMood } from '../src/moods.js';
import { troubles } from '../src/pet.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('the command asks for everything at once, and what it prints is parsed: disks, memory, load, processes, failed units', () => {
  for (const part of ['df -P', '/proc/meminfo', 'free -m', '/proc/loadavg', 'nproc', '/proc/uptime', '--sort=-pcpu', '--sort=-pmem', 'systemctl list-units --state=failed']) assert.ok(HEALTH_COMMAND.includes(part), part);
  const h = parseHealth(DEMO_HEALTH);
  assert.deepEqual(h.disks.map((d) => [d.mount, d.percent]), [['/', 47], ['/var', 93]]);
  assert.deepEqual(h.memory, { totalMb: 3928, availableMb: 1484, usedMb: 2443, swapTotalMb: 2048, swapUsedMb: 256 });
  assert.deepEqual([h.load, h.cpus, uptimeText(h.uptime)], [[0.42, 0.35, 0.3], 2, '41 days, 3h']);
  assert.deepEqual(h.topCpu[0], { pid: 1312, cpu: 23.5, mem: 6.1, command: 'node' });
  assert.equal(h.topMem[0].command, 'postgres');
  assert.deepEqual(h.failed, [{ unit: 'backup.service', description: 'Nightly backup to the bucket' }]);
  assert.deepEqual(healthProblems(h), ['/var is 93% full', 'backup.service failed']);
});

test('the fallbacks parse too: free -m, uptime, no systemd; and a server\'s escapes are cleaned', () => {
  const h = parseHealth(['@@df', 'Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/vda 1000 500 500 50% /', '@@mem', '              total        used        free      shared  buff/cache   available', 'Mem:           3900        1200         800          10        1900        2500', 'Swap:             0           0           0', '@@load', ' 10:00:00 up 3 days, load average: 1.50, 1.20, 0.90', '@@topcpu', '  7 99.0  1.0 \x1b]0;evil\x07miner', '@@units', '@@nosystemd', '@@end'].join('\n'));
  assert.deepEqual(h.memory, { totalMb: 3900, availableMb: 2500, usedMb: 1400, swapTotalMb: 0, swapUsedMb: 0 });
  assert.deepEqual(h.load, [1.5, 1.2, 0.9]);
  assert.equal(h.failed, null);
  assert.equal(h.topCpu[0].command, 'miner');
  assert.deepEqual(healthProblems(h), []);
  assert.deepEqual(parseHealth('').disks, []);
});

test("/health shows the panel with what's wrong, Tug worries, and r reads it again", async () => {
  const app = start();
  await until(shows(app, 'demo  /home/demo'), 'the host connected');
  await type(app.stdin, '/health');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Health · demo'), 'the panel');
  const frame = app.lastFrame();
  assert.match(frame, /demo: \/var is 93% full, backup\.service failed/);
  assert.match(frame, /93%/);
  assert.match(frame, /✗ backup\.service/);
  assert.match(frame, /up 41 days, 3h/);
  assert.match(frame, /postgres/);
  assert.equal(app.host.state.calls.filter((c) => c[0] === 'exec').length, 1);
  await until(() => readMoods('splice').find((m) => m.app === 'mooring')?.reason?.includes('/var is 93% full'), 'the mood');
  assert.equal(readMoods('splice').find((m) => m.app === 'mooring').mood, 'worried');
  app.stdin.write('r');
  await until(() => app.host.state.calls.filter((c) => c[0] === 'exec').length === 2, 'read again');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Health · demo'), 'the panel closed');
  // alt+h opens it from anywhere.
  app.stdin.write('\x1bh');
  await until(shows(app, 'Health · demo'), 'the panel again');
  app.unmount();
});

test("a health read counts only for the host it was read from", () => {
  const conn = { host: { name: 'web' } };
  assert.deepEqual(troubles({ conn, health: { host: 'web', problems: ['/ is 95% full'] } }).health, ['/ is 95% full']);
  assert.deepEqual(troubles({ conn, health: { host: 'db', problems: ['/ is 95% full'] } }).health, []);
  assert.deepEqual(familyMood({ mood: 'wave', trouble: { failed: [], problem: null, health: ['/ is 95% full'] }, host: 'web' }), { mood: 'worried', reason: 'web: / is 95% full' });
});
