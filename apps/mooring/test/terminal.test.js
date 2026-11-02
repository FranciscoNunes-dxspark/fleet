// The Console's shell: ssh with a forced terminal, its output through the virtual terminal, the keys sent as they came.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openTerminal, startCommand } from '../src/terminal.js';
import { terminalArgs } from '../src/sftp.js';
import { until } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-tty-ssh.js', import.meta.url));
const spawn = (_command, args, options) => spawnProcess(process.execPath, [FAKE, ...args], options);
const screen = (t) => Array.from({ length: t.vt.rows }, (_, y) => t.vt.rowText(y)).join('\n');
const host = { user: 'me', host: 'build.example.com', port: 2222, key: '/k/id' };

test('the shell starts at its size, in the folder, as the login shell; ssh is told to force a terminal', () => {
  const command = startCommand({ columns: 100, rows: 30, dir: "/srv/it's" });
  assert.equal(command, `stty cols 100 rows 30 2>/dev/null; printf '\\033]5380;%s\\007' "$(tty 2>/dev/null)"; cd '/srv/it'\\''s' 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`);
  const args = terminalArgs(host, command);
  assert.equal(args[0], '-tt');
  assert.ok(args.includes('BatchMode=yes') && args.includes('2222') && args.at(-2) === 'me@build.example.com' && args.at(-1) === command);
  assert.ok(!terminalArgs(host, command, { password: true }).includes('BatchMode=yes'));
});

test('what is typed reaches the shell as it came, its output is a screen, and it ends when the shell does', async () => {
  let exited = null;
  const t = openTerminal({ host, spawn, columns: 80, rows: 14, dir: '/srv', onExit: (e) => (exited = e) });
  try {
    await until(() => screen(t).includes('fake$'), 'the prompt');
    assert.match(screen(t), /TERM=xterm-256color/);
    assert.match(screen(t), /"-tt"/);
    t.write('hi');
    t.write('\r');
    await until(() => screen(t).includes('got: hi'), 'the answer');
    const kept = t.vt.history.length;
    t.write('vim\r');
    await until(() => screen(t).includes('full screen'), 'a full screen program');
    assert.equal(t.vt.history.length, kept, 'a full screen program adds no scrollback');
    t.write('exit\r');
    await until(() => exited, 'the end');
    assert.equal(exited.code, 0);
    assert.equal(t.alive, false);
  } finally {
    t.close();
  }
});

test('lines that scroll off the top are kept for scrolling back; closing ends the shell', async () => {
  const t = openTerminal({ host, spawn, columns: 40, rows: 4 });
  try {
    await until(() => screen(t).includes('fake$'), 'the prompt');
    for (const word of ['one', 'two', 'three']) {
      t.write(`${word}\r`);
      await until(() => screen(t).includes(`got: ${word}`), word);
    }
    assert.ok(t.vt.history.length > 0, 'the first lines scrolled away');
  } finally {
    t.close();
  }
  assert.equal(t.alive, false);
  t.write('ignored after close');
});

test('the tty the shell reports is taken out of the output, and a resize fits the screen at once and runs stty on that tty once the size settles', async () => {
  const calls = [];
  const recording = (command, args, options) => (calls.push(args), spawn(command, args, options));
  const t = openTerminal({ host, spawn: recording, columns: 60, rows: 8, dir: '/srv' });
  try {
    await until(() => screen(t).includes('fake$'), 'the prompt');
    assert.ok(t.resizable, 'it told us its tty');
    assert.doesNotMatch(screen(t), /\/dev\/pts/, 'the report is not drawn');
    t.resize(50, 6);
    t.resize(40, 5);
    assert.equal(t.vt.columns, 40, 'the screen is fitted at once');
    assert.equal(t.vt.rows, 5);
    assert.match(screen(t), /fake\$/, 'and keeps what was on it');
    await until(() => calls.some((a) => a.includes('-T')), 'the stty');
    const helpers = calls.filter((a) => a.includes('-T'));
    assert.equal(helpers.length, 1, 'a size that is still changing is told once, at the end');
    assert.equal(helpers[0].at(-1), "stty -F '/dev/pts/9' cols 40 rows 5 2>/dev/null || stty -f '/dev/pts/9' cols 40 rows 5");
    assert.ok(helpers[0].includes('BatchMode=yes') && helpers[0].includes('2222') && helpers[0].includes('/k/id'), 'signed in as the shell was');
    t.resize(40, 5);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.filter((a) => a.includes('-T')).length, 1, 'the same size is not told again');
  } finally {
    t.close();
  }
});

test('a tty that is not a path under /dev is not believed: nothing is run with it', async () => {
  const calls = [];
  const lying = (command, args, options) => (calls.push(args), spawn(command, args, { ...options, env: { ...options.env, FAKE_TTY: "x; rm -rf ~" } }));
  const t = openTerminal({ host, spawn: lying, columns: 60, rows: 8 });
  try {
    await until(() => screen(t).includes('fake$'), 'the prompt');
    assert.equal(t.resizable, false);
    assert.doesNotMatch(screen(t), /rm -rf/);
    t.resize(30, 4);
    assert.equal(t.vt.columns, 30, 'the screen still fits');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(calls.filter((a) => a.includes('-T')).length, 0);
  } finally {
    t.close();
  }
});
