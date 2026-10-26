import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { decodeAppMessage, encodeAppMessage, encodeMessage, askHostToUpdate, handOff, hostedStreams, isHosted, messageReader, screenKeeper, sizeOf } from '../hosted.js';
import { copiedNote } from '../family.js';

test('messages are lines of JSON objects, cut anywhere; anything else is skipped', () => {
  const got = [];
  const read = messageReader((m) => got.push(m));
  read('{"resize":{"columns":80,');
  read('"rows":23}}\nnot json\n[1]\n\n{"ready":true}');
  assert.deepEqual(got, [{ resize: { columns: 80, rows: 23 } }]);
  read('\n');
  assert.deepEqual(got.at(-1), { ready: true });
  assert.equal(encodeMessage({ handoff: 'trawl', line: 'x' }), '{"handoff":"trawl","line":"x"}\n');
  assert.deepEqual(sizeOf({ columns: '120.7', rows: 40 }), { columns: 120, rows: 40 });
  assert.equal(sizeOf({ columns: 0, rows: 3 }), null);
  assert.equal(isHosted({ FLEET_HOSTED: '1' }), true);
  assert.equal(isHosted({}), false);
});

test("the screen kept is the last frame from the top, with what's drawn on it since, never the bell", () => {
  const kept = screenKeeper();
  kept.write('\x1b[?1049h\x1b[H');
  kept.write('Question?\n');
  kept.write('\x1b]9;done\x07\x07> ');
  assert.equal(kept.screen, '\x1b[H\x1b[HQuestion?\n> ');
  // A frame of Ink's log-update erases the last one's lines and starts the screen again.
  kept.write('\x1b[2K\x1b[1A\x1b[2K\x1b[Gline 1\nline 2\n');
  assert.equal(kept.screen, '\x1b[Hline 1\nline 2\n');
  kept.write('\x1b7\x1b[2;1H\x1b[7mline\x1b[27m\x1b8');
  assert.ok(kept.screen.endsWith('\x1b8'));
  // Ink's full-screen frames clear the terminal first.
  kept.write('\x1b[2J\x1b[3J\x1b[Hall of it');
  assert.equal(kept.screen, '\x1b[H\x1b[3J\x1b[Hall of it');
  assert.equal(kept.starts, 3);
  kept.write(Buffer.from('!'));
  assert.ok(kept.screen.endsWith('all of it!'));
});

function fakeControl() {
  const sent = [];
  let onData = () => {};
  let onEnd = () => {};
  return {
    sent,
    control: { onData: (fn) => (onData = fn), onEnd: (fn) => (onEnd = fn), write: (t) => sent.push(t) },
    hostSays: (m) => onData(encodeMessage(m)),
    hostGoes: () => onEnd(),
  };
}

function fakeStdout() {
  const out = new Writable({
    write(chunk, _enc, done) {
      out.data += chunk.toString();
      done();
    },
  });
  out.data = '';
  return out;
}

test('hosted streams look like a terminal of the size the host says, and repaint when asked', async () => {
  const stdin = new PassThrough();
  const stdout = fakeStdout();
  const { sent, control, hostSays, hostGoes } = fakeControl();
  let exited = false;
  const term = hostedStreams({ stdin, stdout, control, env: { FLEET_COLUMNS: '90', FLEET_ROWS: '29' }, exit: () => (exited = true) });
  assert.equal(term.hosted, true);
  assert.deepEqual([stdout.isTTY, stdout.columns, stdout.rows, stdin.isTTY], [true, 90, 29, true]);
  // Ink's first switch to raw mode says it reads keys, once.
  stdin.setRawMode(true);
  stdin.setRawMode(false);
  stdin.setRawMode(true);
  // Messages to the host go out in the app's output (fd 3 only carries the host's).
  assert.equal(stdout.data, encodeAppMessage({ ready: true }));
  assert.deepEqual(sent, []);
  stdout.data = '';
  assert.equal(stdin.isRaw, true);

  let resized = 0;
  stdout.on('resize', () => resized++);
  stdout.write('\x1b[?1049h\x1b[Hframe\n');
  hostSays({ resize: { columns: 100, rows: 30 } });
  assert.deepEqual([stdout.columns, stdout.rows, resized], [100, 30, 1]);
  // Nothing new was drawn at that size, so a moment later the last screen is drawn again.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stdout.data.endsWith('\x1b[?2026h\x1b[H\x1b[Hframe\n\x1b[?2026l'), true);
  // The same size again is the host's repaint: what's on the app's screen, written again.
  stdout.data = '';
  hostSays({ resize: { columns: 100, rows: 30 } });
  assert.equal(resized, 1);
  assert.equal(stdout.data, '\x1b[?2026h\x1b[H\x1b[Hframe\n\x1b[?2026l');
  // A new size the app draws a frame for: that frame is all.
  stdout.on('resize', () => stdout.write('\x1b[2K\x1b[Gnarrow\n'));
  stdout.data = '';
  hostSays({ resize: { columns: 80, rows: 30 } });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stdout.data, '\x1b[2K\x1b[Gnarrow\n');

  stdout.data = '';
  term.send({ handoff: 'trawl', line: '/x' });
  assert.equal(stdout.data, '\x1b]5379;{"handoff":"trawl","line":"/x"}\x07');
  assert.deepEqual(decodeAppMessage(stdout.data), { handoff: 'trawl', line: '/x' });
  assert.equal(decodeAppMessage('\x1b]0;title\x07'), null);
  hostGoes();
  assert.equal(exited, true);
});

test('outside the host, a hand-off does nothing and the note reads as it always has', () => {
  assert.equal(handOff('trawl', '/azure-sql srv db'), false);
  assert.equal(copiedNote('trawl', '/azure-sql srv db'), "Copied for Trawl: paste it into Trawl's prompt. /azure-sql srv db");
});

test('outside the host, asking it to update does nothing, so the app updates itself', () => {
  assert.equal(askHostToUpdate(), false);
});
