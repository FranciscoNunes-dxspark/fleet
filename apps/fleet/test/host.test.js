// The host end to end, with small fake apps (fixtures/fake-app.js, in hosted mode as the real ones
// are) as real processes, driven through its input and read from the screen it draws.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive, familyHome, PREFIX, quietEnv, startHost, stopAll, until } from './helpers.js';

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

test('a worried app off screen gets a badge and rings the bell once; looking at it clears it', async () => {
  const family = familyHome();
  const { term, keys, done } = startHost({ spaces: SPACES, family });
  const { screen } = term;
  await until(() => screen.row(0) === 'one 70x13', 'the app', { term });
  // A mood from before Fleet started is old news: no badge for it.
  writeFileSync(join(family, 'two.mood.json'), JSON.stringify({ app: 'two', mood: 'worried', reason: 'stale', at: Date.now() - 60_000 }));
  await new Promise((r) => setTimeout(r, 300));
  assert.match(screen.row(-1), /2 Two ○ {2}/);
  writeFileSync(join(family, 'two.mood.json'), JSON.stringify({ app: 'two', mood: 'worried', reason: 'api crashed', at: Date.now() }));
  await until(() => / 2 Two ○ ! /.test(screen.row(-1)) && screen.row(-1).includes('Two: api crashed'), 'the badge and its reason', { term });
  assert.equal(term.written.split('\x07').length - 1, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(term.written.split('\x07').length - 1, 1, 'one bell only');
  keys(`${PREFIX}w`);
  await until(() => screen.row(0) === 'two 70x13' && !screen.row(-1).includes('!'), 'the badge gone', { term });
  // An alert the app on screen logs never badges; one from the app off screen counts.
  const log = (app, kind) => appendFileSync(join(family, 'activity.jsonl'), `${JSON.stringify({ at: Date.now(), app, kind, text: `${app} ${kind}` })}\n`);
  log('two', 'alert');
  log('one', 'info');
  log('one', 'error');
  log('one', 'alert');
  await until(() => / 1 One ● 2 /.test(screen.row(-1)), 'the count', { term });
  assert.match(screen.row(-1), /2 Two ● {2}/);
  keys(`${PREFIX}o`);
  await until(() => screen.row(0) === 'one 70x13' && / 1 One ● {2}/.test(screen.row(-1)), 'cleared by looking', { term });
  keys(`${PREFIX}q`);
  keys('y');
  await done;
});

test('split, two apps are drawn side by side at half the width each, keys going to the focused one', async () => {
  const spaces = [...SPACES, { id: 'three', title: 'Three', letter: 'e', accent: '#e8445a' }];
  const { host, term, keys, done } = startHost({ spaces, env: quietEnv({ FAKE_HANDOFF: 'one' }) });
  const { screen } = term;
  // 70 columns: 34 for the left pane, the divider, 35 for the right.
  const left = (y) => screen.row(y).slice(0, 34).trimEnd();
  const right = (y) => screen.row(y).slice(35);
  await until(() => screen.row(0) === 'one 70x13', 'the first app', { term });
  keys(`${PREFIX}w`);
  await until(() => screen.row(0) === 'two 70x13', 'the second app', { term });
  // The previous app goes beside the one on screen, which keeps the keys.
  keys(`${PREFIX}|`);
  await until(() => left(0) === 'two 34x13' && right(0) === 'one 35x13' && screen.row(0)[34] === '│', 'both apps at half the width', { term });
  assert.equal(screen.row(12)[34], '│');
  assert.match(screen.row(-1), /1 One ● {2}2 Two ●/);
  keys('ab');
  await until(() => left(1) === 'keys: "ab"', 'keys in the left pane', { term });
  assert.equal(right(1), 'keys: ""');

  // The other pane takes the keys; another app put in it takes the place of the one there.
  keys(`${PREFIX}\t`);
  keys('c');
  await until(() => right(1) === 'keys: "c"', 'keys in the right pane', { term });
  assert.equal(left(1), 'keys: "ab"');
  keys(`${PREFIX}e`);
  await until(() => right(0) === 'three 35x13' && left(0) === 'two 34x13', 'the third app in the right pane', { term });

  // The help over both, then both drawn again from what the host keeps.
  keys(`${PREFIX}?`);
  await until(() => term.text().includes('this help'), 'the help', { term });
  keys('z');
  await until(() => !term.text().includes('this help') && left(1) === 'keys: "ab"' && right(0) === 'three 35x13', 'the panes back', { term });

  // A click in the left pane focuses it; its app has no mouse, so the click goes no further.
  keys('\x1b[<0;3;3M\x1b[<0;3;3m');
  keys('d');
  await until(() => left(1) === 'keys: "abd"', 'the left pane focused by a click', { term });
  assert.equal(right(1), 'keys: ""');
  // Its app turns the mouse on: a click there reaches it, in its own columns; one in the other pane is translated too.
  keys('M');
  await until(() => left(1) === 'keys: "abdM"', 'the mouse on', { term });
  keys('\x1b[<0;5;3M');
  await until(() => left(1) === 'keys: "abdM\\u001b[<0;5;3M"', 'the click in the pane\'s columns', { term });

  // A hand-off to an app in neither pane puts it in the other one, and focuses it.
  keys('H');
  await until(() => right(0) === 'one 35x13' && right(1).startsWith('keys: "c/take family'), 'the line in the other pane', { term });
  assert.equal(left(0), 'two 34x13');
  assert.equal(host.active, 'one');

  // An exit says so in its pane, and ↵ starts it again there.
  keys('X');
  await until(() => term.text().includes('One exited with 3'), 'the exit in the pane', { term });
  assert.equal(left(0), 'two 34x13');
  keys('\r');
  await until(() => right(0) === 'one 35x13' && right(1) === 'keys: ""', 'started again in its pane', { term });

  // Too narrow, the screen goes back whole.
  term.resize(38, 10);
  // (The bar has no room for the notice at this width.)
  await until(() => screen.row(0) === 'one 38x9' && host.noticeText.startsWith('Too narrow to stay split'), 'unsplit when too narrow', { term });
  keys(`${PREFIX}|`);
  await until(() => host.noticeText.startsWith('Too narrow to split') && !host.split, 'refused', { term });
  term.resize(70, 14);
  await until(() => screen.row(0) === 'one 70x13', 'whole again', { term });
  keys(`${PREFIX}|`);
  await until(() => left(0) === 'one 34x13' && right(0).endsWith('35x13'), 'split again', { term });
  keys(`${PREFIX}x`);
  await until(() => screen.row(0) === 'one 70x13' && screen.row(1) === 'keys: ""', 'unsplit', { term });
  keys(`${PREFIX}q`);
  keys('y');
  await done;
});
