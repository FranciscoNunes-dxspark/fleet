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

function drawBar(state) {
  bar = state;
  drawTabs(state);
  drawStatus(state);
  drawStrip(state);
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
