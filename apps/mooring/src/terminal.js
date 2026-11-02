// A shell on the server with a terminal, as the Console shows it: `ssh -tt host <command>` (ssh forces a pty on the
// server although this side has none: its input and output are pipes), whose output goes through the kit's virtual
// terminal (vt.js) and whose input is whatever the keys were, as they came. Nothing here keeps a password: with a
// host that asks for one it is in the environment the session's `spawn` gives ssh (askpass.js), as for every ssh.
//
// Resizing: ssh sends the server a window change only when it sees one on a terminal of its own, and here it has
// none. So the shell says which tty it has (an OSC sequence it prints first, taken out of the output here), and a
// resize runs `stty` on that tty from a second, short ssh: the kernel then signals the programs on it, and they
// redraw. The screen here is fitted at once, the server told once the size has stopped changing for a moment.
import { VirtualTerminal } from '@fleet/kit/vt.js';
import { spawn as spawnProcess } from 'node:child_process';
import { shellQuote, sshArgs, terminalArgs } from './sftp.js';

export const SCROLLBACK = 2000;
const RESIZE_DELAY_MS = 250;
const TTY_START = '\x1b]5380;';
const TTY_PATH = /^\/dev\/[\w/.-]+$/;

/** What the server runs: its size, its tty reported, the folder (if it can be entered), then the user's own shell as a login shell. */
export function startCommand({ columns, rows, dir }) {
  const cd = dir ? `cd ${shellQuote(dir)} 2>/dev/null; ` : '';
  return `stty cols ${columns} rows ${rows} 2>/dev/null; printf '\\033]5380;%s\\007' "$(tty 2>/dev/null)"; ${cd}exec "\${SHELL:-/bin/sh}" -l`;
}

/** What a second ssh runs to give the tty a new size: GNU stty names it with -F, BSD's with -f. */
export function sttyCommand(tty, columns, rows) {
  const q = shellQuote(tty);
  return `stty -F ${q} cols ${columns} rows ${rows} 2>/dev/null || stty -f ${q} cols ${columns} rows ${rows}`;
}

/**
 * Opens it. `spawn` and `sshCommand` are the session's (and the tests'); `onChange` hears that the screen
 * changed (coalesced), `onExit({ code, signal, error })` hears that the shell is over. Returns { vt, write,
 * resize, close, alive } (`write` takes the bytes of the keys, as the terminal sent them).
 */
export function openTerminal({ host, sshCommand = 'ssh', password = false, spawn = spawnProcess, columns = 80, rows = 24, dir, scrollback = SCROLLBACK, onChange = () => {}, onExit = () => {} }) {
  const vt = new VirtualTerminal(columns, rows, { scrollback });
  const args = terminalArgs(host, startCommand({ columns, rows, dir }), { password });
  const child = spawn(sshCommand, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, TERM: 'xterm-256color' } });
  let alive = true;
  let timer = null;
  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 16);
  };

  // The tty the shell reports first, `ESC ] 5380 ; /dev/pts/3 BEL`: taken out of the output, and only a path under
  // /dev is believed (it is interpolated, quoted, into a command, and it comes from the server).
  let tty = null;
  let scanning = '';
  let scanned = 0;
  const takeTty = (data) => {
    if (tty || scanned > 4096) return data;
    scanning += data;
    scanned += data.length;
    const at = scanning.indexOf(TTY_START);
    if (at < 0) {
      const out = scanning;
      scanning = '';
      return out;
    }
    const end = scanning.indexOf('\x07', at);
    if (end < 0) {
      const out = scanning.slice(0, at);
      scanning = scanning.slice(at);
      return out;
    }
    const path = scanning.slice(at + TTY_START.length, end);
    if (TTY_PATH.test(path)) tty = path;
    else scanned = Infinity;
    const out = scanning.slice(0, at) + scanning.slice(end + 1);
    scanning = '';
    return out;
  };

  // A new size: this screen now, the server's tty when the size has settled; one ssh at a time, the last size wins.
  let wanted = null;
  let resizing = false;
  let resizeTimer = null;
  const tell = async () => {
    if (resizing || !wanted || !alive || !tty) return;
    resizing = true;
    const { columns: c, rows: r } = wanted;
    wanted = null;
    await new Promise((done) => {
      try {
        const helper = spawn(sshCommand, sshArgs(host, sttyCommand(tty, c, r), { password }), { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
        const stop = setTimeout(() => helper.kill(), 20_000);
        const finish = () => (clearTimeout(stop), done());
        helper.on('error', finish);
        helper.on('close', finish);
      } catch {
        done();
      }
    });
    resizing = false;
    if (wanted) tell();
  };

  // The server's terminal turns \n into \r\n itself; ssh's own messages (on stderr) come as plain lines.
  child.stdout.setEncoding('utf8').on('data', (d) => (vt.write(takeTty(d)), changed()));
  child.stderr.setEncoding('utf8').on('data', (d) => (vt.write(d.replace(/\r?\n/g, '\r\n')), changed()));
  child.stdin.on('error', () => {});
  const over = (info) => {
    if (!alive) return;
    alive = false;
    clearTimeout(timer);
    clearTimeout(resizeTimer);
    onChange();
    onExit(info);
  };
  child.on('error', (error) => over({ code: null, error }));
  child.on('close', (code, signal) => over({ code, signal }));
  return {
    vt,
    get alive() {
      return alive;
    },
    /** Whether a resize can reach the server (it has told us its tty). */
    get resizable() {
      return Boolean(tty);
    },
    write(bytes) {
      if (alive) child.stdin.write(bytes);
    },
    resize(c, r) {
      if (!alive || (c === vt.columns && r === vt.rows)) return;
      vt.fit(c, r);
      changed();
      wanted = { columns: vt.columns, rows: vt.rows };
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(tell, RESIZE_DELAY_MS);
    },
    close() {
      if (!alive) return;
      alive = false;
      clearTimeout(timer);
      clearTimeout(resizeTimer);
      try {
        child.stdin.end();
        child.kill();
      } catch {
        // already gone
      }
    },
  };
}
