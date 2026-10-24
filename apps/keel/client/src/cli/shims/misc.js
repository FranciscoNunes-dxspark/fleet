// The rest of Node the terminal app touches, and Ink's helpers for a real terminal process
// (signals, the cursor, CI, devtools): in the browser they do nothing, or fail as a missing program would.

// node:os
export const homedir = () => '/home/web';
export const hostname = () => location.hostname;
export const userInfo = () => ({ username: 'web' });
export const tmpdir = () => '/tmp';
export const EOL = '\n';

// node:url
export const fileURLToPath = (u) => new URL(u).pathname;
export const pathToFileURL = (p) => new URL(`file://${p}`);

// node:util
const show = (v) => (typeof v === 'string' ? v : v instanceof Error ? v.stack || v.message : JSON.stringify(v));
/** console's %s/%d/%o formatting, roughly. */
export function format(first, ...rest) {
  if (typeof first !== 'string') return [first, ...rest].map(show).join(' ');
  const text = first.replace(/%[sdifjoO%]/g, (m) => (m === '%%' ? '%' : rest.length ? show(rest.shift()) : m));
  return [text, ...rest.map(show)].join(' ');
}
export const inspect = show;

// node:child_process
const child = { stdin: { on() {}, end() {}, write() {} }, on() {}, kill() {} };
export const execFile = (...args) => {
  const cb = args.find((a) => typeof a === 'function');
  setTimeout(() => cb?.(Object.assign(new Error('Not available in the browser'), { code: 'ENOENT' }), '', ''));
  return child;
};
export const exec = execFile;
export const spawn = () => child;

// node:readline/promises
export function createInterface() {
  throw new Error('Not available in the browser');
}

// signal-exit, cli-cursor, patch-console, terminal-size, stack-utils, is-in-ci
export const onExit = () => () => {};
// Ink hides the cursor through cli-cursor, on the stream it draws on.
export const cliCursor = {
  show: (stream) => stream?.write?.('\x1b[?25h'),
  hide: (stream) => stream?.write?.('\x1b[?25l'),
  toggle: (force, stream) => stream?.write?.(force === false ? '\x1b[?25l' : '\x1b[?25h'),
};
export const patchConsole = () => () => {};
export const terminalSize = () => ({ columns: 80, rows: 24 });
export class StackUtils {
  static nodeInternals() {
    return [];
  }
  clean(stack) {
    return stack;
  }
  captureString() {
    return '';
  }
  parseLine() {
    return null;
  }
}

export default { homedir, hostname, userInfo, tmpdir, EOL, fileURLToPath, pathToFileURL, format, inspect, execFile, exec, spawn, createInterface, platform: () => 'browser' };
