// Hosted mode: an app running inside Fleet (apps/fleet), the host that runs every app of the family in
// one terminal and switches between them. The host starts each app as a child process with
// FLEET_HOSTED=1 and pipes, not a terminal: it reads what the app draws from its stdout, and writes the
// keys meant for it into its stdin. Ink wants a terminal, so here the app's stdin and stdout are made
// to look like one (isTTY, raw mode, a size and 'resize'). A third pipe, fd 3, carries the host's
// messages as lines of JSON (size changes and repaints); the app's own messages (ready, hand-offs) go
// out in its stdout as a private OSC sequence the host takes out, since on Windows a child's writes to
// fd 3 never reached the host, while its stdout always does.
//
// Each app's cli takes its streams from appTerminal(), which outside the host are process.stdin and
// process.stdout, untouched; everything else (config, credentials, mouse reports, OSC 52, the bell)
// already goes through those streams, so the host simply passes it on.
//
// Messages, host → app:  { "resize": { "columns": 120, "rows": 39 } }   the size the app draws at; sent
//                        again unchanged on a switch, to draw the whole frame again (repaint)
// app → host:            { "ready": true }                            Ink is reading keys
//                        { "handoff": "trawl" | ["sonar", "hail"], "line": "/take …" }   copied for a sibling
//                        { "update": true }                           /update: the host updates the fleet
//                        { "move": "/abs/folder" }                    the whole fleet to that folder (asked first)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pasteOnCtrlV } from './clipboard.js';
import { plainOutput } from './glyphs.js';

/** The variable the host sets on its children, and the fd of the control pipe. */
export const HOSTED_VARIABLE = 'FLEET_HOSTED';
export const CONTROL_FD = 3;

/** Whether this process is an app the host started. */
export const isHosted = (env = process.env) => env[HOSTED_VARIABLE] === '1';

/** One message as the line that carries it. */
export const encodeMessage = (message) => `${JSON.stringify(message)}\n`;

/** The start of an app's message in its output: OSC 5379, then the JSON, ended with BEL. */
export const APP_MESSAGE = '\x1b]5379;';

/** One message from the app, as the sequence in its output that carries it. */
export const encodeAppMessage = (message) => `${APP_MESSAGE}${JSON.stringify(message)}\x07`;

/** The message an OSC sequence from the app carries, or null when it's another sequence (or not JSON). */
export function decodeAppMessage(seq) {
  if (!seq.startsWith(APP_MESSAGE)) return null;
  const body = seq.slice(APP_MESSAGE.length).replace(/(\x07|\x1b\\)$/, '');
  try {
    const message = JSON.parse(body);
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  } catch {
    return null;
  }
}

/**
 * A reader of newline-delimited JSON: call it with each chunk (text), and `onMessage` gets each whole
 * object. A line that isn't JSON, or isn't an object, is skipped; a line cut by a chunk waits for its end.
 */
export function messageReader(onMessage) {
  let held = '';
  return (chunk) => {
    held += chunk;
    const lines = held.split('\n');
    held = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message && typeof message === 'object' && !Array.isArray(message)) onMessage(message);
    }
  };
}

/** A size as the host sends it, made sane: whole numbers, at least 1×1; null when it isn't one. */
export function sizeOf(value) {
  const columns = Math.floor(Number(value?.columns));
  const rows = Math.floor(Number(value?.rows));
  return columns > 0 && rows > 0 ? { columns, rows } : null;
}

// What the app has on screen, kept from what it writes, to draw it again when it comes back on screen:
// Ink only draws what changed, and nothing has from its side. Ink's log-update writes each frame whole
// (what to erase of the last one, then every line), and a full-screen app's frames start at the top
// left corner, so a frame starts the screen again; so does clearing it (or the alternate screen, as the
// app starts). Anything else (text an app writes before Ink starts, as Keel's first-run questions,
// colours, a drag's selection) adds to it; titles, notifications and the bell are left out, so a
// repaint never says them again.
const LEAD = /^(?:\x1b\[[0-9;?]*[A-LN-Za-ln-z])+/;
const CLEARS = /\x1b\[\?1049h|\x1b\[2J/g;
const SAID = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x07/g;
const MAX_SCREEN = 4 * 1024 * 1024;

/**
 * A keeper of what's on the app's screen: write(data) with each write, `screen` what draws it again
 * from nothing (from the top left corner), `starts` how many times the screen started again.
 */
export function screenKeeper() {
  let screen = '';
  let starts = 0;
  const restart = (text) => {
    screen = `\x1b[H${text.replace(SAID, '')}`;
    starts++;
  };
  return {
    write(data) {
      const s = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '';
      if (!s) return;
      let clear = -1;
      for (const m of s.matchAll(CLEARS)) clear = m.index + m[0].length;
      const lead = LEAD.exec(s)?.[0] ?? '';
      if (clear >= 0) restart(s.slice(clear));
      // A frame of log-update's: it erased the last one's lines (from the top), and draws from there.
      else if (lead.includes('\x1b[2K')) restart(s.slice(lead.length));
      else if (screen.length + s.length > MAX_SCREEN) restart(s);
      else screen += s.replace(SAID, '');
    },
    get screen() {
      return screen;
    },
    get starts() {
      return starts;
    },
  };
}

// How long a resize waits for Ink's frame at the new size before drawing the last one again itself
// (an app whose frame doesn't change with the size draws nothing new).
const RESIZE_SETTLE = 60;

/**
 * The control pipe on fd 3, as { onData(fn), onEnd(fn), write(text) }. Node wraps it in a socket; Bun
 * (the compiled builds) can't, so there it's read as a file and written synchronously.
 */
function controlPipe(fd = CONTROL_FD) {
  if (typeof Bun === 'undefined') {
    const socket = new net.Socket({ fd, readable: true, writable: true });
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    // It mustn't keep the app running by itself; the app's own exit ends it.
    socket.unref?.();
    return { onData: (fn) => socket.on('data', fn), onEnd: (fn) => socket.on('close', fn), write: (text) => socket.write(text) };
  }
  const stream = fs.createReadStream(null, { fd, autoClose: false, encoding: 'utf8' });
  stream.on('error', () => {});
  return {
    onData: (fn) => stream.on('data', fn),
    onEnd: (fn) => stream.on('end', fn),
    write: (text) => {
      try {
        fs.writeSync(fd, text);
      } catch {
        // The host has gone; the end of the pipe says so too.
      }
    },
  };
}

/**
 * Makes `stdin` and `stdout` (the pipes from the host) look like the terminal Ink expects, and wires
 * the control pipe. Returns { stdin, stdout, hosted: true, send(message) }. `control` is the pipe as
 * { onData, onEnd, write } (fd 3 unless given); `exit` is what happens when the host goes away.
 */
export function hostedStreams({ stdin, stdout, control = controlPipe(), env = process.env, exit = () => process.exit(0) }) {
  // Straight to the pipe, past the kept screen: a message is never part of what's drawn again.
  const write = stdout.write;
  const send = (message) => {
    write.call(stdout, encodeAppMessage(message));
    return true;
  };
  const define = (stream, key, value) => Object.defineProperty(stream, key, { value, configurable: true, writable: true, enumerable: true });
  const size = sizeOf({ columns: env.FLEET_COLUMNS, rows: env.FLEET_ROWS }) ?? { columns: 80, rows: 24 };
  define(stdout, 'isTTY', true);
  define(stdout, 'columns', size.columns);
  define(stdout, 'rows', size.rows);
  define(stdout, 'getWindowSize', () => [stdout.columns, stdout.rows]);
  define(stdin, 'isTTY', true);
  define(stdin, 'isRaw', false);
  let ready = false;
  // Raw mode is the host's business (its own terminal is raw already); the first switch to it is Ink
  // starting to read keys, which is when a hand-off can be typed in.
  define(stdin, 'setRawMode', (on) => {
    stdin.isRaw = Boolean(on);
    if (on && !ready) {
      ready = true;
      send({ ready: true });
    }
    return stdin;
  });
  if (typeof stdin.ref !== 'function') define(stdin, 'ref', () => stdin);
  if (typeof stdin.unref !== 'function') define(stdin, 'unref', () => stdin);
  const kept = screenKeeper();
  define(stdout, 'write', function (data, ...rest) {
    kept.write(data);
    return write.call(this, data, ...rest);
  });
  // The host's repaint: everything on the app's screen, drawn again in one synchronized update.
  const repaint = () => {
    if (kept.screen) write.call(stdout, `\x1b[?2026h${kept.screen}\x1b[?2026l`);
  };
  control.onData(
    messageReader((message) => {
      const next = message.resize && sizeOf(message.resize);
      if (!next) return;
      if (next.columns === stdout.columns && next.rows === stdout.rows) return repaint();
      stdout.columns = next.columns;
      stdout.rows = next.rows;
      const before = kept.starts;
      stdout.emit('resize');
      setTimeout(() => kept.starts === before && repaint(), RESIZE_SETTLE).unref?.();
    }),
  );
  // The host is gone (it quit, or crashed): nobody can see this app or type into it any more.
  control.onEnd(exit);
  return { stdin, stdout, hosted: true, send };
}

let current = null;

/**
 * The terminal this app draws on: { stdin, stdout, hosted, send(message) }. Outside the host,
 * process.stdin and process.stdout as they are, and `send` does nothing (false). Inside it, those same
 * streams made to look like a terminal (hostedStreams). Either way ctrl+v pastes the clipboard where
 * the terminal hands it on as a key (clipboard.js `pasteOnCtrlV`), and in Windows' own console what's
 * written has the characters its font lacks swapped (glyphs.js). The same object every time it's asked.
 */
export function appTerminal({ env = process.env } = {}) {
  if (current) return current;
  current = isHosted(env)
    ? hostedStreams({ stdin: process.stdin, stdout: process.stdout, env })
    : { stdin: process.stdin, stdout: process.stdout, hosted: false, send: () => false };
  pasteOnCtrlV(current.stdin);
  // Hosted, the host writes to the terminal and swaps the characters itself.
  if (!current.hosted) plainOutput(current.stdout);
  return current;
}

/**
 * Tells the host that `line` was copied for `apps` (one app or a list), so it can switch to that app
 * and type the line into its prompt. Does nothing outside the host, or before the app asked for its
 * terminal. Returns whether the host was told.
 */
export function handOff(apps, line) {
  if (!current?.hosted) return false;
  const list = [].concat(apps).filter(Boolean);
  if (!list.length || !line) return false;
  return current.send({ handoff: list.length === 1 ? list[0] : list, line: String(line) });
}

/**
 * Asks the host to look for a new version of the whole fleet now (an app's /update: inside the host the
 * apps don't update themselves, Fleet does as one) and install it. Does nothing outside the host, or
 * before the app asked for its terminal. Returns whether the host was told, so the app falls back to its
 * own update when not.
 */
export function askHostToUpdate() {
  if (!current?.hosted) return false;
  return current.send({ update: true });
}

/**
 * Asks the host to move the whole fleet to folder `dir` (made absolute from this app's folder): the host
 * asks in its bar, with the folder filled in, and on ↵ starts every running app again there. Does
 * nothing outside the host, or before the app asked for its terminal. Returns whether the host was told.
 */
export function askHostToMove(dir) {
  if (!current?.hosted || !dir) return false;
  return current.send({ move: path.resolve(String(dir)) });
}
