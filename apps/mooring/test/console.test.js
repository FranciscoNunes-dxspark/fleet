// The console (commands on the server with $), the pet, and what Mooring tells the family.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readActivity, readMoods } from '@fleet/kit/family.js';
import { consoleLines } from '../src/ui/ConsoleView.jsx';
import { familyMood, reactionTo } from '../src/moods.js';
import { FACES, PALETTE, moodFor, moodLine, petPixels, petRows, troubles } from '../src/pet.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('$ runs a command on the server in the right pane\'s folder, and Console shows its output', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '$ ls');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '$ ls'), 'the command listed');
  await until(shows(app, 'notes.txt'), 'its output');
  assert.match(app.lastFrame(), /Console/);
  assert.match(app.lastFrame(), /demo:\/home\/demo/);
  assert.deepEqual(app.host.state.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ["cd '/home/demo' && ls"]);
  app.unmount();
});

test('a command that fails shows its exit code and what it said', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '$ frobnicate');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'exit 127'), 'the exit code');
  assert.match(app.lastFrame(), /command not found/);
  app.unmount();
});

test('cd in the console moves the right pane, and the next command runs there', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '$ cd /var/log');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'syslog'), 'the pane moved');
  await type(app.stdin, '/ssh pwd');
  app.stdin.write(KEYS.enter);
  await until(() => app.host.state.calls.some((c) => c[0] === 'exec' && c[1] === "cd '/var/log' && pwd"), 'run there');
  app.unmount();
});

test('a command with no host open says so', async () => {
  const app = start({ connectTo: undefined });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '$ ls');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Not connected: /connect <host>'), 'the refusal');
  app.unmount();
});

test("console rows: commands, output, errors, and how each ended; long output keeps its end", () => {
  const rows = consoleLines([
    { id: 1, host: 'h', dir: '/x', command: 'ls', status: 'done', out: 'a\nb\n', err: '', code: 0 },
    { id: 2, host: 'h', dir: '/x', command: 'bad', status: 'failed', out: '', err: 'oops\n', code: 2 },
    { id: 3, host: 'h', dir: '/x', command: 'sleep 9', status: 'running', out: '', err: '' },
    { id: 4, host: 'h', dir: '/x', command: 'many', status: 'done', out: `${Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')}\n`, err: '', code: 0 },
    { id: 5, host: 'h', dir: '/x', command: 'colour', status: 'done', out: '\x1b[31mred\x1b[0m\x1b[2J\n', err: '', code: 0 },
  ]);
  assert.deepEqual(rows.slice(0, 7).map((r) => [r.kind, r.text]), [
    ['command', 'ls'], ['out', 'a'], ['out', 'b'], ['command', 'bad'], ['err', 'oops'], ['bad', 'exit 2'], ['command', 'sleep 9'],
  ]);
  assert.equal(rows.find((r) => r.kind === 'dim' && /earlier/.test(r.text)).text, '… 100 earlier lines');
  assert.equal(rows.at(-1).text, 'red');
  assert.equal(rows.some((r) => r.text?.includes('\x1b')), false);
});

test("Tug's art is whole: every row 16 wide, only palette letters, every mood", () => {
  for (const mood of ['idle', 'look', 'sleep', 'happy', 'worried', 'wave']) {
    const px = petPixels(mood);
    assert.equal(px.length, 10, mood);
    for (const row of px) {
      assert.equal(row.length, 16, `${mood}: ${row}`);
      for (const c of row) assert.ok(c === '.' || PALETTE[c], `${mood}: ${c}`);
    }
    assert.equal(petRows(mood).length, 5);
    assert.ok(FACES[mood]);
  }
});

test('the pet feels what happened: failed transfers and a refused connection worry it, a connection waves, none sleeps', () => {
  const now = 1_000_000;
  const calm = troubles({ transfers: [{ status: 'done' }], conn: { problem: null } });
  assert.equal(moodFor({ loaded: true, connected: true, trouble: calm, now }), 'wave');
  assert.equal(moodFor({ loaded: true, connected: false, trouble: calm, now }), 'sleep');
  assert.equal(moodFor({ loaded: false, trouble: calm, now }), 'idle');
  assert.equal(moodFor({ loaded: true, connected: true, running: true, trouble: calm, now }), 'look');
  const failed = troubles({ transfers: [{ status: 'failed', name: 'a.zip' }], conn: {} });
  assert.equal(moodFor({ loaded: true, connected: true, trouble: failed, now }), 'worried');
  assert.equal(moodFor({ loaded: true, connected: true, trouble: calm, lastEntry: { status: 'ok', at: now - 1000 }, now }), 'happy');
  assert.match(moodLine('worried', { loaded: true, trouble: failed }), /a\.zip didn't copy/);
  assert.match(moodLine('sleep', { loaded: true, connected: false, hosts: 0 }), /\/add/);
  assert.match(moodLine('wave', { loaded: true, connected: true, host: 'build' }), /Connected to build/);
});

test("what Mooring tells the family names transfers and hosts, nothing else; Tug answers a worried sibling", () => {
  const failed = troubles({ transfers: [{ status: 'failed', name: 'a.zip' }, { status: 'failed', name: 'b.zip' }, { status: 'failed', name: 'c.zip' }], conn: {} });
  assert.deepEqual(familyMood({ mood: 'worried', trouble: failed }), { mood: 'worried', reason: 'a.zip, b.zip and 1 more didn\'t transfer' });
  assert.deepEqual(familyMood({ mood: 'wave', trouble: troubles(), host: 'build' }), { mood: 'happy', reason: 'connected to build' });
  assert.equal(familyMood({ mood: 'sleep', trouble: troubles() }).mood, 'neutral');
  const r = reactionTo([{ app: 'trawl', mood: 'worried', reason: 'a query failed', at: 5 }]);
  assert.match(r.text, /Tug tightens the line: Trawl is worried \(a query failed\)/);
  assert.equal(reactionTo([{ app: 'trawl', mood: 'worried', at: 5 }], new Set(['trawl:5'])), null);
});

test('it writes its mood and what it changed to the family folder, and no command text', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  const mine = () => readMoods('trawl').find((m) => m.app === 'mooring');
  await until(() => mine(), 'the mood written');
  assert.equal(mine().mood, 'happy');
  app.stdin.write('m');
  await until(shows(app, 'New folder in /home/demo'), 'the question');
  await type(app.stdin, 'releases');
  app.stdin.write(KEYS.enter);
  await until(() => readActivity({ limit: 10 }).some((e) => e.app === 'mooring' && /created folder releases on demo/.test(e.text)), 'the change logged');
  await type(app.stdin, '$ echo hunter2-secret');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'hunter2-secret'), 'the command ran');
  assert.ok(!JSON.stringify(readActivity({ limit: 100 })).includes('hunter2-secret'), 'a command reached the activity log');
  assert.ok(!JSON.stringify(mine()).includes('hunter2-secret'), 'a command reached the mood');
  app.unmount();
});
