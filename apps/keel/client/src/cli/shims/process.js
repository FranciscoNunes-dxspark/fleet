// The terminal app (cli/) and Ink read Node's `process` as they load; in the browser they get this.
// boot.js imports it first, before either, and only the /cli page loads boot.js.
const noop = () => proc;
const proc = globalThis.process ?? {
  env: {},
  platform: 'browser',
  version: 'v22.17.0',
  versions: {},
  argv: [],
  cwd: () => '/',
  exit: () => {},
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  on: noop,
  once: noop,
  off: noop,
  addListener: noop,
  removeListener: noop,
  emit: () => false,
  listeners: () => [],
};
// Colours as a modern terminal has them.
proc.env = { TERM: 'xterm-256color', COLORTERM: 'truecolor', ...proc.env };
globalThis.process = proc;
globalThis.setImmediate ??= (fn, ...args) => setTimeout(fn, 0, ...args);
globalThis.clearImmediate ??= (t) => clearTimeout(t);

export default proc;
export const { env, platform, nextTick, cwd } = proc;
