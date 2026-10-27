// A shell in a container or pod (e). Outside Fleet the terminal is handed over and the exec gets one
// (-it); inside Fleet the app has pipes, not a terminal, so the exec runs without one (-i) and the
// shell pane (ui/ShellPane.jsx) sends it a line at a time. Pure: the commands and the pane's state.
import { safe } from './docker.js';
import { safeName } from './kube.js';

// bash where the image has it, else sh, which every image with a shell has.
export const SHELL_SCRIPT = 'command -v bash >/dev/null && exec bash || exec sh';

const need = (ok, s, what) => {
  if (!ok(s)) throw new Error(`"${s}" isn't a ${what}.`);
  return s;
};

/** docker exec into container `id`: { command, args }, with a terminal (`tty`) or without. */
export function dockerShell(id, { tty = true } = {}) {
  return { command: 'docker', args: ['exec', tty ? '-it' : '-i', need(safe, id, 'container Docker would have named'), 'sh', '-c', SHELL_SCRIPT] };
}

/** kubectl exec into pod `pod` ({ name, namespace }), its `container` when given: { command, args }. */
export function kubeShell(pod, container, { tty = true } = {}) {
  const name = (s) => need(safeName, s, 'name Kubernetes would have given');
  return {
    command: 'kubectl',
    args: ['exec', tty ? '-it' : '-i', '-n', name(pod.namespace), name(pod.name), ...(container ? ['-c', name(container)] : []), '--', 'sh', '-c', SHELL_SCRIPT],
  };
}

/** The command as a line, to say what runs. */
export const commandLine = ({ command, args }) => [command, ...args.map((a) => (/^[\w./:@=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))].join(' ');

// The line-mode pane. Lines kept: the oldest go past this.
export const MAX_LINES = 5000;
// A second ctrl+c within this stops the shell.
export const AGAIN_MS = 2000;

// Colours and cursor moves: a program that thinks it has a terminal may still send some.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** A new pane's state: what it shows (`lines`, and `partial`, the line still being written), what's typed, the history. */
export const paneStart = () => ({ lines: [], partial: '', input: '', history: [], pos: -1, scroll: 0, ended: null, lastInterrupt: 0 });

/** The shell said `text`: its lines added, a line without its end kept as `partial` until the rest comes. */
export function paneOutput(state, text) {
  const clean = String(text).replace(ESCAPES, '').replace(/\r\n/g, '\n');
  const parts = (state.partial + clean).split('\n');
  const partial = parts.pop();
  // A carriage return alone (a progress line) starts the line over.
  const lines = [...state.lines, ...parts.map((l) => l.slice(l.lastIndexOf('\r') + 1))];
  return { ...state, lines: lines.slice(-MAX_LINES), partial: partial.slice(partial.lastIndexOf('\r') + 1), scroll: state.scroll ? state.scroll + parts.length : 0 };
}

/** The shell ended (with `code`, or the error that kept it from starting). */
export const paneEnded = (state, code, error = null) => ({ ...paneOutput(state, state.partial ? '\n' : ''), ended: { code, error } });

/** What's on screen: the output (the partial line last) as lines, scrolled `scroll` lines up from the end. */
export function paneView(state, height) {
  const all = state.partial ? [...state.lines, state.partial] : state.lines;
  const scroll = Math.max(0, Math.min(state.scroll, all.length - height));
  return { lines: all.slice(Math.max(0, all.length - height - scroll), all.length - scroll), scroll };
}

const sendLine = (state, line) => ({
  ...state,
  lines: [...state.lines, ...(state.partial ? [state.partial] : []), `$ ${line}`].slice(-MAX_LINES),
  partial: '',
  input: '',
  history: line.trim() && state.history[0] !== line ? [line, ...state.history].slice(0, 100) : state.history,
  pos: -1,
  scroll: 0,
});

/**
 * A key in the pane: { state, write?, kill?, close?, restart?, said? }. ↵ sends the line (`write`);
 * ctrl+c clears what's typed, else sends ^C to the shell, and stops it (`kill`) when pressed again
 * within AGAIN_MS; ctrl+d and esc close the pane; ↑ ↓ go through what was sent; pgup pgdn scroll;
 * ctrl+l clears the output, ctrl+u the line. A paste with line ends sends each whole line. Once the
 * shell has ended, ↵ starts another.
 */
export function paneKey(state, input, key, now = Date.now()) {
  if (key.escape || (key.ctrl && input === 'd')) return { state, close: true };
  if (state.ended) return key.return ? { state: { ...paneStart(), history: state.history }, restart: true } : { state };
  if (key.ctrl && input === 'c') {
    if (state.input) return { state: { ...state, input: '' } };
    if (now - state.lastInterrupt < AGAIN_MS) return { state: { ...state, lastInterrupt: 0 }, kill: true };
    return { state: { ...state, lastInterrupt: now }, write: '\x03', said: 'Sent ctrl+c. Without a terminal most programs ignore it: ctrl+c again stops the shell.' };
  }
  if (key.return) return { state: sendLine(state, state.input), write: `${state.input}\n` };
  if (key.upArrow || key.downArrow) {
    const pos = Math.max(-1, Math.min(state.history.length - 1, state.pos + (key.upArrow ? 1 : -1)));
    return { state: { ...state, pos, input: pos < 0 ? '' : state.history[pos] } };
  }
  if (key.pageUp || key.pageDown) return { state: { ...state, scroll: Math.max(0, state.scroll + (key.pageUp ? 10 : -10)) } };
  if (key.backspace || key.delete) return { state: { ...state, input: [...state.input].slice(0, -1).join('') } };
  if (key.ctrl && input === 'u') return { state: { ...state, input: '' } };
  if (key.ctrl && input === 'w') return { state: { ...state, input: state.input.replace(/\S+\s*$/, '') } };
  if (key.ctrl && input === 'l') return { state: { ...state, lines: [], partial: '', scroll: 0 } };
  if (key.ctrl || key.meta || !input) return { state };
  const text = input.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
  const parts = (state.input + text).split('\n');
  const rest = parts.pop();
  let next = state;
  for (const line of parts) next = sendLine(next, line);
  return { state: { ...next, input: rest }, ...(parts.length ? { write: parts.map((l) => `${l}\n`).join('') } : {}) };
}

/** Scrolls the pane by `n` lines (the wheel: up is positive). */
export const paneScroll = (state, n) => ({ ...state, scroll: Math.max(0, state.scroll + n) });
