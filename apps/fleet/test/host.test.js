// The host end to end, with small fake apps (fixtures/fake-app.js, in hosted mode as the real ones
// are) as real processes, driven through its input and read from the screen it draws.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alive, PREFIX, quietEnv, startHost, stopAll, until } from './helpers.js';

after(stopAll);

const SPACES = [
  { id: 'one', title: 'One', letter: 'o', accent: '#5fd787' },
  { id: 'two', title: 'Two', letter: 'w', accent: '#5fafff' },
];

test('switching starts an app the first time, sends it the keys, repaints it on the way back, and quits', async () => {
  const { host, term, keys, done } = startHost({ spaces: SPACES, columns: 70, rows: 14 });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the first app at the size above the bar', { term });
  assert.match(screen.row(-1), /^ 1 One ● {2}2 Two ○ +ctrl\+\] \? help$/);
  keys('ab');
  await until(() => screen.row(1) === 'keys: "ab"', 'keys reaching the app', { term });

  keys(`${PREFIX}2`);
  await until(() => screen.row(0) === 'two 70x13', 'the second app, started', { term });
  assert.match(screen.row(-1), /1 One ● {2}2 Two ●/);
  const two = host.space('two').child.pid;
  // ctrl+] twice is a ctrl+] for the app, and keys go to the one on screen only.
  keys(`x${PREFIX}${PREFIX}y`);
  await until(() => screen.row(1) === 'keys: "x\\u001dy"', 'the literal prefix', { term });

  // Back to the first: drawn again whole, as it was, though it drew nothing new.
  keys(`${PREFIX}o`);
  await until(() => screen.row(0) === 'one 70x13' && screen.row(1) === 'keys: "ab"', 'the first app repainted', { term });
  assert.equal(screen.text().includes('two'), false);
  // ] goes to the next space, p to the one before.
  keys(`${PREFIX}]`);
  await until(() => screen.row(0) === 'two 70x13', 'the next space', { term });
  keys(`${PREFIX}p`);
  await until(() => screen.row(0) === 'one 70x13', 'the previous space', { term });

  // A resize reaches every app, the one on screen redraws at once, the other when it comes back.
  term.resize(60, 10);
  await until(() => screen.row(0) === 'one 60x9', 'the new size', { term });
  assert.match(screen.row(-1), /^ 1 One ● {2}2 Two ●/);
  keys(`${PREFIX}w`);
  await until(() => screen.row(0) === 'two 60x9', 'the other app at the new size', { term });

  // Help, closed by any key, which goes no further.
  keys(`${PREFIX}?`);
  await until(() => term.text().includes('ctrl+] ctrl+]') && term.text().includes('send ctrl+] to the app'), 'the help', { term });
  keys('z');
  await until(() => screen.row(0) === 'two 60x9' && !term.text().includes('this help'), 'the help closed', { term });
  assert.equal(screen.row(1), 'keys: "x\\u001dy"');

  // q asks while apps run; anything but y stays.
  keys(`${PREFIX}q`);
  await until(() => screen.row(-1).includes('Quit Fleet? One, Two are running'), 'the question', { term });
  keys('n');
  await until(() => screen.row(-1).includes('2 Two ●'), 'staying', { term });
  keys(`${PREFIX}q`);
  await until(() => screen.row(-1).includes('Quit Fleet?'), 'the question again', { term });
  const one = host.space('one').child.pid;
  keys('y');
  await done;
  assert.ok(term.written.endsWith('\x1b[?1049l\x1b[23;0t'), 'the terminal given back');
  await until(() => !alive(one) && !alive(two), 'both apps gone');
});

test('an app that exits says so in its tab and on its screen, and ↵ starts it again', async () => {
  const { host, term, keys, done } = startHost({ spaces: SPACES });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the app', { term });
  keys('X');
  await until(() => term.text().includes('One exited with 3 — ↵ to start again'), 'the exit', { term });
  assert.match(screen.row(-1), /1 One ✕3/);
  // Keys other than ↵ go nowhere while it's down.
  keys('abc');
  keys('\r');
  await until(() => screen.row(0) === 'one 70x13' && screen.row(1) === 'keys: ""', 'started again', { term });
  assert.match(screen.row(-1), /1 One ●/);
  keys(`${PREFIX}q`);
  keys('y');
  await done;
  assert.equal(host.spaces.some((s) => s.child), false);
});

test('a line copied for a sibling switches to it, starting it, and is typed into it', async () => {
  const { term, keys, done } = startHost({ spaces: SPACES, env: quietEnv({ FAKE_HANDOFF: 'two' }) });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the app', { term });
  keys('H');
  await until(() => screen.row(0) === 'two 70x13' && screen.row(1) === 'keys: "/take family:v1:commit:eyJoYXNoIjoiYWJjIn0"', 'the line in the other app', { term });
  assert.match(screen.row(-1), /Handed to Two/);
  // Already running, it gets the next one straight away.
  keys(`${PREFIX}1`);
  await until(() => screen.row(0) === 'one 70x13', 'back', { term });
  keys('H');
  const twice = 'keys: "/take family:v1:commit:eyJoYXNoIjoiYWJjIn0/take family:v1:commit:eyJoYXNoIjoiYWJjIn0"';
  await until(() => screen.row(0) === 'two 70x13' && `${screen.row(1)}${screen.row(2)}` === twice, 'the second line', { term });
  keys(`${PREFIX}q`);
  keys('y');
  await done;
});

test("the active app's mouse comes back with it, and a click on a tab switches", async () => {
  const { term, keys, done } = startHost({ spaces: SPACES, columns: 70, rows: 14 });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the app', { term });
  keys('M');
  await until(() => screen.modes.get(1002) === true && screen.modes.get(1006) === true, 'the mouse on', { term });
  // A click on Two's tab (the bar is row 14) switches; the other app has no mouse.
  keys('\x1b[<0;15;14M\x1b[<0;15;14m');
  await until(() => screen.row(0) === 'two 70x13', 'the click', { term });
  assert.equal(screen.modes.get(1002), false);
  // Two never asked for the mouse: the host keeps clicks on for the bar, and Two gets none.
  assert.equal(screen.modes.get(1000), true);
  keys('\x1b[<0;3;2M');
  keys('k');
  await until(() => screen.row(1) === 'keys: "k"', 'only the key', { term });
  keys('\x1b[<0;3;14M');
  await until(() => screen.row(0) === 'one 70x13', 'back by a click', { term });
  assert.equal(screen.modes.get(1002), true);
  // Clicks elsewhere are the app's, when it asked for them.
  keys('\x1b[<0;3;2M');
  await until(() => screen.row(1) === 'keys: "M\\u001b[<0;3;2M"', 'the click passed on', { term });
  keys(`${PREFIX}q`);
  keys('y');
  await done;
});

/** A folder for a test's panels: the start folder, Fleet's home and the family's. */
function toolsIn(files = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'fleet-host-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(tmp, path, '..'), { recursive: true });
    writeFileSync(join(tmp, path), text);
  }
  return { cwd: join(tmp, 'project'), env: { FLEET_HOME: join(tmp, 'home') }, familyDir: join(tmp, 'family') };
}

test("a runbook's step is handed to its app as a hand-off, and ctrl+] r comes back to the runbook", async () => {
  const tools = toolsIn({ 'project/.fleet/runbooks/check.md': '# Check two\n\nSay hello first.\n\n```two\n/hello two\n/bye\n```\n' });
  const { host, term, keys, done } = startHost({ spaces: SPACES, tools, columns: 70, rows: 14 });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the app', { term });
  keys(`${PREFIX}r`);
  await until(() => term.text().includes('Runbooks') && term.text().includes('› Check two  2 steps'), 'the picker', { term });
  keys('\r');
  await until(() => term.text().includes('Say hello first.') && /› +1 {2}Two {2}\/hello two/.test(term.text()), 'the runbook', { term });
  // While it's open, the app's drawing waits and keys stay with the panel.
  keys('j');
  await until(() => /› +2 {2}Two {2}\/bye/.test(term.text()), 'the cursor moved', { term });
  keys('k\r');
  await until(() => screen.row(0) === 'two 70x13' && screen.row(1) === 'keys: "/hello two"', 'the step typed into the other app', { term });
  assert.match(screen.row(-1), /Handed to Two/);
  keys(`${PREFIX}r`);
  await until(() => /✓ +1 {2}Two {2}\/hello two/.test(term.text()) && /› +2 {2}Two {2}\/bye/.test(term.text()), 'back in the runbook, the step done', { term });
  assert.ok(term.text().includes('1 of 2 steps handed over'));
  keys('\x1b');
  await until(() => screen.row(0) === 'two 70x13' && !term.text().includes('Check two'), 'closed, the app repainted', { term });
  // l goes back to the list, n drafts one there.
  keys(`${PREFIX}r`);
  await until(() => term.text().includes('1 of 2 steps'), 'the runbook again', { term });
  keys('ln');
  await until(() => /^Drafted \.fleet.runbooks.\d{4}-\d\d-\d\d-draft\.md/.test(host.noticeText) && term.text().includes('› Draft of'), 'the draft, listed', { term });
  keys('\x1b');
  keys(`${PREFIX}q`);
  keys('y');
  await done;
});
