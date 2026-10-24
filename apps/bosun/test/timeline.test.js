// The family's activity from Bosun's side: what it adds (a crash, giving up, restarts and stops,
// tunnels, /move), /timeline over every app's (this project's, or every project's with p; ↵ one whole),
// and /wiring, masked. FAMILY_HOME is the test's own (helpers.js's tempHome).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { basename, join } from 'node:path';
import { familyDir, logActivity, readActivity } from '../src/family.js';
import { when } from '../src/actions.js';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const IDLE = 'node -e "setInterval(() => {}, 1000)"';

test('when: the time today, the date before', () => {
  const now = new Date(2026, 9, 24, 15, 0).getTime();
  assert.doesNotMatch(when(new Date(2026, 9, 24, 9, 5).getTime(), now), /Oct|24/);
  assert.match(when(new Date(2026, 9, 20, 9, 5).getTime(), now), /20/);
});

test('crashes, giving up, restarts, stops, tunnels and /move go to the family\'s activity; /timeline shows them', async () => {
  const dir = project({ procs: { api: { run: IDLE, port: 4290 }, queue: { run: 'node -e "process.exit(4)"', restart: 'always' } } });
  const other = project({ procs: { x: IDLE } });
  logActivity('splice', { text: 'Pushed main to origin', project: dir }, { now: Date.now() - 60_000 });
  logActivity('trawl', { text: 'Ran an UPDATE on shop-dev', project: other }, { now: Date.now() - 30_000 });
  const tool = (path, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null, 'SIGTERM'));
    setTimeout(() => child.stderr.write('INF |  https://quiet-river-1.trycloudflare.com   |\n'), 20);
    return child;
  };
  const app = start({ dir, restartTimes: { first: 50, max: 100, stable: 10_000, quick: 10_000, giveUpAfter: 3 }, tunnelSpawn: tool, findTool: (n) => (n === 'cloudflared' ? n : null), copy: () => {} });
  const frame = () => app.lastFrame() ?? '';
  const mine = () => readActivity({ project: dir }).filter((e) => e.app === 'bosun').map((e) => e.text);
  try {
    await until(() => /queue\s+\S+\s+gave up/.test(frame()) || frame().includes('queue gave up'), 'the queue giving up');
    await until(() => mine().some((t) => /^queue gave up/.test(t)), 'giving up in the activity');
    assert.ok(mine().some((t) => /^queue crashed: It exited with 4\. Restarting it\.$/.test(t)), 'the crash, once');
    assert.equal(mine().filter((t) => /crashed/.test(t)).length, 1);
    assert.ok(readActivity({ project: dir }).every((e) => e.app !== 'bosun' || e.project === dir));

    app.stdin.write('r');
    await until(() => mine().includes('Restarted api'), 'a restart');
    app.stdin.write('T');
    await until(() => frame().includes('to the internet'), 'the tunnel asked for');
    app.stdin.write(KEYS.enter);
    await until(() => mine().includes('Opened a tunnel to api (port 4290): https://quiet-river-1.trycloudflare.com'), 'the tunnel opened');
    app.stdin.write('s');
    await until(() => mine().includes('Stopped api') && mine().some((t) => t.startsWith('Closed the tunnel to api')), 'stopped, and its tunnel closed');

    app.stdin.write(':');
    await type(app.stdin, 'timeline');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`The family's activity in ${basename(dir)}`) && frame().includes('Pushed main to origin'), 'this project\'s');
    assert.ok(!frame().includes('Ran an UPDATE'), 'not another project\'s');
    assert.match(frame(), /Bosun\s+· Stopped api[\s\S]*Bosun\s+· Restarted api[\s\S]*Splice\s+· Pushed main/, 'newest first');
    app.stdin.write('p');
    await until(() => frame().includes('every project') && frame().includes('Ran an UPDATE on shop-dev') && frame().includes(basename(other)), 'every project\'s');
    app.stdin.write('p');
    await until(() => !frame().includes('Ran an UPDATE'), 'this one\'s again');
    app.stdin.write('G');
    await until(() => /❯ .*Pushed main/.test(frame()), 'on the oldest');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Splice ·') && frame().includes(`project  ${dir}`), 'the whole of it');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes("The family's activity in"), 'back to the list');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes("The family's activity in"), 'closed');

    app.stdin.write(':');
    await type(app.stdin, `move ${basename(other)}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Moved to ${other}`), 'moved');
    assert.ok(mine().includes(`Moved from ${basename(dir)} to ${basename(other)}`));
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
  assert.ok(familyDir().startsWith(process.env.BOSUN_HOME), 'the test\'s own family folder');
});

test('/wiring lists what the project points at, by file, with passwords masked', async () => {
  const dir = project({ procs: { api: IDLE } });
  writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Shop: 'Server=db.local;Database=Shop;User Id=sa;Password=Hunter2!;' }, Api: { BaseUrl: 'https://payments.example.com' }, Logging: { Level: 'Debug' } }));
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://me:s3cret@localhost:5432/shop\nAPI_TOKEN=abc123\nREDIS_HOST=cache.local\n');
  mkdirSync(join(dir, 'empty'));
  const app = start({ dir, autostart: false });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api\s+stopped/.test(frame()), 'read');
    app.stdin.write(':');
    await type(app.stdin, 'wiring');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`What ${basename(dir)} points at`), 'the wiring');
    assert.match(frame(), /appsettings\.json[\s\S]*ConnectionStrings:Shop\s+Server=db\.local;Database=Shop;User Id=sa;Password=••••;[\s\S]*Api:BaseUrl\s+https:\/\/payments\.example\.com/);
    assert.match(frame(), /\.env[\s\S]*DATABASE_URL\s+postgres:\/\/me:••••@localhost:5432\/shop[\s\S]*REDIS_HOST\s+cache\.local/);
    assert.ok(!/Hunter2|s3cret|abc123|Logging/.test(frame()));
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('points at'), 'closed');
    const bare = project({ procs: { api: IDLE } });
    app.stdin.write(':');
    await type(app.stdin, `move ${basename(bare)}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Moved to ${bare}`), 'moved');
    app.stdin.write(':');
    await type(app.stdin, 'wiring');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('points anywhere'), 'nothing there');
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});
