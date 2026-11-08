// The window's side of Fleet: xterm.js drawing what the pseudo-terminal (src-tauri/src/main.rs) sends,
// and sending back keys, pastes, mouse reports and the size. Fleet's bar is drawn here, not in the
// grid: the host (run with FLEET_DESKTOP=1, which main.rs sets) sends its state as OSC 5380 (the host's
// barState), and a click on a tab or a tool types the prefix and its key, as a person would.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The shell look's palette, so Fleet's apps draw on the ground they were designed for.
const theme = {
  background: '#0f1115',
  foreground: '#d6dbe3',
  cursor: '#e6c07b',
  cursorAccent: '#0f1115',
  selectionBackground: '#263040',
  black: '#1a1e24',
  red: '#ff5f5f',
  green: '#7ee2a1',
  yellow: '#ffd75f',
  blue: '#5fafff',
  magenta: '#b48cff',
  cyan: '#3fb8b0',
  white: '#d6dbe3',
  brightBlack: '#5c6573',
  brightRed: '#ff8f8f',
  brightGreen: '#a6f0c0',
  brightYellow: '#ffe58f',
  brightBlue: '#8fc8ff',
  brightMagenta: '#d0b8ff',
  brightCyan: '#7fe0d8',
  brightWhite: '#f2f4f7',
};

const term = new Terminal({
  fontFamily: '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 14,
  lineHeight: 1.15,
  theme,
  allowProposedApi: true,
  macOptionIsMeta: true,
  // Fleet and its apps draw full-screen on the alternate screen: nothing to scroll back to.
  scrollback: 0,
  cursorBlink: false,
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));
fit.fit();

const $ = (id) => document.getElementById(id);
const send = (data) => invoke('write', { data });

// ---- the bar, from the host's state -------------------------------------------------------------

let bar = null;

/** Types the prefix and `key` into Fleet, as the bar's keys would be typed. */
function prefixed(key) {
  if (!bar) return;
  send(bar.key + key);
  term.focus();
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

function drawTabs(state) {
  const tabs = $('tabs');
  tabs.replaceChildren(
    ...state.spaces.map((s, i) => {
      const classes = ['tab', s.state];
      if (s.id === state.active) classes.push('active');
      else if (s.id === state.shown) classes.push('shown');
      const tab = el(
        'button',
        { type: 'button', className: classes.join(' '), title: `${s.title}  (prefix ${i < 9 ? `${i + 1} or ` : ''}${s.letter})` },
        el('span', { className: 'dot' }),
        el('span', { textContent: s.title }),
        s.badge ? el('span', { className: `badge${s.error ? ' error' : ''}`, textContent: s.badge }) : null,
      );
      tab.style.setProperty('--accent', s.accent);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(s.id === state.active));
      tab.addEventListener('click', () => prefixed(s.letter));
      return tab;
    }),
  );
}

function drawStatus(state) {
  const pills = [];
  const { env, recording, proposals } = state.status ?? {};
  if (proposals > 0) {
    const p = el('button', { type: 'button', className: 'pill proposals', textContent: `◆ ${proposals} proposed`, title: "Claude's proposals (prefix P)" });
    p.addEventListener('click', () => prefixed('P'));
    pills.push(p);
  }
  if (recording) pills.push(el('span', { className: 'pill rec', textContent: '● REC' }));
  if (env?.name) {
    const e = el('button', { type: 'button', className: `pill ${env.prod ? 'prod' : 'env'}`, textContent: env.prod ? `◆ ${env.name.toUpperCase()}` : env.name, title: 'The environment (prefix e)' });
    e.addEventListener('click', () => prefixed('e'));
    pills.push(e);
  }
  $('status').replaceChildren(...pills);
  document.body.classList.toggle('prod', Boolean(env?.prod));
  // The folder's own name; the whole path when the pointer rests on it.
  const cwd = state.cwd ?? '';
  $('where').textContent = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  $('where').title = cwd;
}

function drawStrip(state) {
  const say = $('say');
  if (state.confirming) {
    const quit = el('button', { type: 'button', className: 'answer danger', textContent: 'Quit' });
    const stay = el('button', { type: 'button', className: 'answer', textContent: 'Stay' });
    quit.addEventListener('click', () => send('y'));
    stay.addEventListener('click', () => send('n'));
    say.replaceChildren(el('span', { className: 'question', textContent: state.confirming }), quit, stay);
  } else if (state.asking) {
    // The host edits the line (the keys go to it as they always do); this only shows it.
    const { label, text, cursor, hint } = state.asking;
    const field = el('span', { className: 'field' }, text.slice(0, cursor), el('span', { className: 'caret', textContent: text[cursor] ?? ' ' }), text.slice(cursor + 1));
    say.replaceChildren(el('span', { className: 'label', textContent: label }), field, el('span', { textContent: hint }));
  } else if (state.prefix) {
    say.replaceChildren(el('span', { className: 'keys', textContent: `${state.prefixLabel} · ${state.hint}` }));
  } else if (state.notice) {
    say.replaceChildren(el('span', { className: 'notice', textContent: state.notice }));
  } else {
    say.replaceChildren(el('span', { textContent: `${state.prefixLabel} then a key, or click above · ${state.prefixLabel} ? every key` }));
  }
}

// ---- a panel, from the host's content -------------------------------------------------------------

// xterm's 256 colours: the 16 of the theme, the 6×6×6 cube, the greys.
const BASE16 = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'].map((n) => theme[n]);
const STEPS = [0, 95, 135, 175, 215, 255];
const hex = (r, g, b) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
function colour256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) return hex(STEPS[Math.floor((n - 16) / 36)], STEPS[Math.floor((n - 16) / 6) % 6], STEPS[(n - 16) % 6]);
  const v = 8 + (n - 232) * 10;
  return hex(v, v, v);
}

/** A segment's SGR (the host's colours, "\x1b[1m\x1b[38;5;114m") as CSS for a span. */
function sgrStyle(sgr) {
  const style = {};
  for (const [, body] of sgr.matchAll(/\x1b\[([\d;]*)m/g)) {
    const p = body.split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if (n === 0 || Number.isNaN(n)) for (const k of Object.keys(style)) delete style[k];
      else if (n === 1) style.fontWeight = '700';
      else if (n === 2) style.opacity = '0.62';
      else if (n === 3) style.fontStyle = 'italic';
      else if (n === 4) style.textDecoration = 'underline';
      else if (n === 22) {
        delete style.fontWeight;
        delete style.opacity;
      }
      else if ((n === 38 || n === 48) && p[i + 1] === 5) {
        style[n === 38 ? 'color' : 'background'] = colour256(p[i + 2]);
        i += 2;
      } else if ((n === 38 || n === 48) && p[i + 1] === 2) {
        style[n === 38 ? 'color' : 'background'] = hex(p[i + 2], p[i + 3], p[i + 4]);
        i += 4;
      } else if (n >= 30 && n <= 37) style.color = BASE16[n - 30];
      else if (n >= 90 && n <= 97) style.color = BASE16[n - 82];
    }
  }
  return style;
}

/** Tells the host something (`ESC ] 5381 ; <json> BEL`, typed as keys are: the host takes it out). */
const tell = (msg) => send(`\x1b]5381;${JSON.stringify(msg)}\x07`);

// What a key in a panel's hint types when its chip is clicked.
const KEY_TYPES = { '↵': '\r', esc: '\x1b', space: ' ', tab: '\t', '←': '\x1b[D', '→': '\x1b[C', '↑': '\x1b[A', '↓': '\x1b[B', '-': '-', '+': '+' };
const typed = (key) => KEY_TYPES[key] ?? (key.length === 1 ? key : null);

let shownPanel = '';

function drawPanel(panel) {
  const scrim = $('scrim');
  if (!panel) {
    scrim.hidden = true;
    shownPanel = '';
    return;
  }
  const json = JSON.stringify(panel);
  if (json === shownPanel) return;
  shownPanel = json;
  scrim.hidden = false;
  $('panel-title').textContent = panel.title ?? '';
  const [from, to] = panel.focus ?? [0, 0];
  const body = $('panel-body');
  const rows = panel.lines.map((line, i) => {
    const row = el('div', { className: `row${!panel.help && i >= from && i <= to ? ' focus' : ''}` });
    if (!line.length) row.textContent = ' ';
    for (const seg of line) {
      const span = el('span', { textContent: seg.text });
      Object.assign(span.style, sgrStyle(seg.sgr ?? ''));
      row.append(span);
    }
    if (!panel.help) {
      row.setAttribute('role', 'option');
      row.addEventListener('click', () => (tell({ pick: i }), term.focus()));
      row.addEventListener('dblclick', () => (tell({ pick: i, open: true }), term.focus()));
    }
    return row;
  });
  body.replaceChildren(...rows);
  rows[from]?.scrollIntoView({ block: 'nearest' });
  // The panel's keys, each one a button that types it, and what they do: "↵ open", "j k move",
  // "- + the window" (a run of keys before the words shares them).
  const chips = String(panel.hint ?? '')
    .split(' · ')
    .filter(Boolean)
    .map((part) => {
      const words = part.split(' ');
      let n = 0;
      while (n < words.length - 1 && (KEY_TYPES[words[n]] || words[n].length === 1)) n++;
      if (n === 0) n = 1;
      const chip = el('span', { className: 'chip' });
      for (const key of words.slice(0, n)) {
        const data = typed(key);
        const k = el(data ? 'button' : 'span', { className: 'key', ...(data ? { type: 'button', title: `Types ${key}` } : {}) }, el('kbd', { textContent: key }));
        if (data) k.addEventListener('click', () => (send(data), term.focus()));
        chip.append(k);
      }
      chip.append(words.slice(n).join(' '));
      return chip;
    });
  $('panel-keys').replaceChildren(...chips);
}

$('panel-close').addEventListener('click', () => (tell({ close: true }), term.focus()));
$('scrim').addEventListener('mousedown', (e) => {
  // A click outside the panel closes it, as esc would.
  if (e.target === $('scrim')) tell({ close: true });
});
// The wheel scrolls the panel's rows here; its cursor stays where the host has it.
$('panel').addEventListener('mouseup', () => queueMicrotask(() => term.focus()));

function drawBar(state) {
  bar = state;
  drawTabs(state);
  drawStatus(state);
  drawStrip(state);
  drawPanel(state.panel);
}

term.parser.registerOscHandler(5380, (data) => {
  try {
    drawBar(JSON.parse(data));
  } catch {
    // A state cut short or from another program: the last one stays.
  }
  return true;
});

$('add').addEventListener('click', () => prefixed('a'));
for (const b of document.querySelectorAll('#tools button')) b.addEventListener('click', () => prefixed(b.dataset.key));

// ---- the pseudo-terminal ------------------------------------------------------------------------

const ended = $('ended');
const endedText = $('ended-text');

const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
listen('pty-data', (e) => term.write(bytes(e.payload)));
listen('pty-exit', (e) => finished(`Fleet ended${e.payload ? ` (exit ${e.payload})` : ''}.`));

term.onData(send);
// Old-style mouse reports come as bytes above 127, which onData doesn't carry.
term.onBinary(send);
term.onResize(({ cols, rows }) => invoke('resize', { cols, rows }));

new ResizeObserver(() => fit.fit()).observe($('terminal'));

function finished(text) {
  endedText.textContent = text;
  ended.hidden = false;
  $('again').focus();
}

async function begin() {
  ended.hidden = true;
  term.reset();
  try {
    await invoke('start', { cols: term.cols, rows: term.rows });
    term.focus();
  } catch (err) {
    finished(String(err));
  }
}

$('again').addEventListener('click', async () => {
  await invoke('stop');
  bar = null;
  begin();
});

begin();
