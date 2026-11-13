// The Console (a shell on the server, $ types into it), the pet, and what Mooring tells the family.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readActivity, readMoods } from '@fleet/kit/family.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { FACES, PALETTE, moodFor, moodLine, petPixels, petRows, troubles } from '../src/pet.js';
import { demoSession } from '../src/demo.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test("$ types the command into a shell opened in the right pane's folder, and the Console shows what it answers", async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '$ ls');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Welcome to the demo shell'), 'the shell');
  await until(() => app.lastFrame().includes('ls') && app.lastFrame().includes('backups'), 'its output');
  assert.match(app.lastFrame(), /Console/);
  assert.match(app.lastFrame().replace(/\x1b\[[0-9;]*m/g, ''), /demo:\/home\/demo\$/, 'the prompt, with its colour');
  assert.deepEqual(app.host.state.calls.filter((c) => c[0] === 'terminal'), [['terminal', '/home/demo']]);
  assert.deepEqual(app.host.state.calls.filter((c) => c[0] === 'exec').map((c) => c[1]), ["cd '/home/demo' && ls"]);
  app.unmount();
});

test('in the Console every key is the shell\'s until ctrl+\\ leaves; a command with no host says so', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '$ echo first');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('first'), 'the first answer');
  // q quits and 4 is a tab elsewhere: here they are text for the shell.
  await type(app.stdin, 'echo q4');
  app.stdin.write(KEYS.enter);
  await until(() => app.host.state.calls.some((c) => c[0] === 'exec' && c[1] === "cd '/home/demo' && echo q4"), 'typed as it came');
  assert.match(app.lastFrame(), /ctrl\+\\ leaves/);
  app.stdin.write('\x1c');
  await until(shows(app, 'type in it'), 'the keys back with the view');
  assert.doesNotMatch(app.lastFrame(), /keys go to the server/);
  app.unmount();
  const none = start({ connectTo: undefined });
  await until(shows(none, 'Documents'), 'this machine');
  await type(none.stdin, '$ ls');
  none.stdin.write(KEYS.enter);
  await until(shows(none, 'Not connected: /connect <host>'), 'the refusal');
  none.unmount();
});

test('exit ends the shell, the screen stays, and ↵ starts another', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '$ exit');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'shell ended'), 'the end');
  assert.match(app.lastFrame(), /Welcome to the demo shell/);
  app.stdin.write(KEYS.enter);
  await until(() => app.host.state.calls.filter((c) => c[0] === 'terminal').length === 2, 'a new shell');
  app.unmount();
});

test('output that streams in draws the Console again by itself, and ↑ looks back over all of it', async () => {
  const host = demoSession();
  let shell;
  const open = host.terminal;
  host.terminal = function (options) {
    shell = { options, term: open.call(this, options) };
    return shell.term;
  };
  const app = start({ host });
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write('3');
  await until(() => shell && shows(app, 'Welcome to the demo shell')(), 'the shell');
  app.stdin.write('\x1c');
  await until(shows(app, 'type in it'), 'the keys back with the view');
  // Far more than the screen holds, each chunk told as the shell tells it, with no key or App state between.
  for (let i = 1; i <= 120; i++) {
    shell.term.vt.write(`streamed ${i}\r\n`);
    shell.options.onChange();
  }
  await until(shows(app, 'streamed 120'), 'the newest line');
  assert.doesNotMatch(app.lastFrame(), /streamed 1\b/);
  // How far back there is counts what came after the Console last drew whole.
  for (let i = 0; i < 6; i++) app.stdin.write('\x1b[5~');
  await until(() => /streamed 1\b/.test(app.lastFrame()), 'the oldest line, scrolled back to');
  app.unmount();
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
