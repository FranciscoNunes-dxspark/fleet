// The window's side of Fleet: xterm.js drawing what the pseudo-terminal (src-tauri/src/main.rs) sends,
// and sending back keys, pastes, mouse reports and the size. Fleet's chrome is drawn here, not in the
// grid: the host (run with FLEET_DESKTOP=1, which main.rs sets) sends its state as OSC 5380 (the host's
// barState: the bar, a panel's content, a toast, the folders, Claude's answer) and the palette's list as
// OSC 5382. The window answers with keys (a tab clicked types the prefix and its letter, as a person
// would) and with OSC 5381 messages (a panel's row picked, a palette line, a folder to move to,
// settings, a question for Claude), which the host takes out of its input before reading keys.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const plugin = (name) => window.__TAURI__[name];

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

// What the window remembers for itself (the font size, notifications): this browser's storage, which
// may refuse; the defaults stand then.
const stored = (key, fallback) => {
  try {
    const v = localStorage.getItem(`fleet.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(`fleet.${key}`, JSON.stringify(value));
  } catch {
    // Not kept: it lasts until the window closes.
  }
};

// JetBrains Mono is the window's own (ui/fonts, style.css's @font-face); the rest stand in for the few
// characters it lacks.
const FONT = '"JetBrains Mono", "Cascadia Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const term = new Terminal({
  fontFamily: FONT,
  fontSize: stored('fontSize', 14),
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

/**
 * Sizes the terminal to its box: the apps draw every row of it. The box is rarely a whole number of
 * rows high, and the pixels left over would show as an empty band, a row's height at most, above the
 * strip (or above the first row, where they were once). The strip takes them instead, a little taller,
 * so the apps' last row sits on it. `stripExtra` is what it took, given back to the room before it's
 * measured again, so the strip's own change of size comes to the same rows and stops there.
 */
const STRIP_HEIGHT = 26;
let stripExtra = 0;
function fitTerm() {
  const size = fit.proposeDimensions();
  if (!size || !size.cols || !size.rows) return;
  // xterm's own cell height: the screen's drawn size can still be the one before a resize.
  const rowHeight = term._core?._renderService?.dimensions?.css?.cell?.height;
  const box = document.getElementById('terminal');
  const style = getComputedStyle(box);
  const room = box.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0) + stripExtra;
  const rows = rowHeight ? Math.max(1, Math.floor(room / rowHeight)) : size.rows;
  if (term.cols !== size.cols || term.rows !== rows) term.resize(size.cols, rows);
  if (!rowHeight) return;
  const extra = Math.max(0, Math.floor(room - rows * rowHeight));
  if (extra === stripExtra) return;
  stripExtra = extra;
  document.getElementById('strip').style.height = `${STRIP_HEIGHT + extra}px`;
}
term.open(document.getElementById('terminal'));
// The GPU renderer, several times faster than drawing with the page's own elements; where the web view
// has no WebGL (or loses it), the terminal goes on with those.
let webgl = null;
try {
  webgl = new WebglAddon.WebglAddon();
  webgl.onContextLoss(() => {
    webgl.dispose();
    webgl = null;
  });
  term.loadAddon(webgl);
} catch {
  // No WebGL here: the DOM renderer it is.
  webgl = null;
}
// Links an app prints open in the browser; images an app sends (sixel, iTerm's) are drawn.
term.loadAddon(new WebLinksAddon.WebLinksAddon((_, url) => plugin('opener')?.openUrl(url)));
try {
  term.loadAddon(new ImageAddon.ImageAddon());
} catch {
  // Without images, the apps' text is all there is.
}
fitTerm();
// A page loads a font of its own on first use, so xterm measured its cells with a stand-in. Once the
// bundled faces are in, the family is set again (through another, as the same value changes nothing),
// which measures the cells and draws every glyph again in it.
Promise.all(['400', '700'].map((weight) => document.fonts.load(`${weight} ${term.options.fontSize}px "JetBrains Mono"`)))
  .then(() => {
    term.options.fontFamily = 'monospace';
    term.options.fontFamily = FONT;
    webgl?.clearTextureAtlas();
    fitTerm();
  })
  .catch(() => {
    // The font didn't load: the system's monospace face it is.
  });

const $ = (id) => document.getElementById(id);
// A write failing (Fleet gone, being restarted) is already said by pty-exit.
const send = (data) => invoke('write', { data }).catch(() => {});
/** Tells the host something (`ESC ] 5381 ; <json> BEL`, typed as keys are: the host takes it out). */
const tell = (msg) => send(`\x1b]5381;${JSON.stringify(msg)}\x07`);

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
};

let bar = null;
let commands = null;

/** Types the prefix and `key` into Fleet, as the bar's keys would be typed. */
function prefixed(key) {
  if (!bar) return;
  send(bar.key + key);
  term.focus();
}

/** The key after the prefix that switches to space `id`: its letter, else (a team's own tool) its number. */
function keyOf(id) {
  const i = bar?.spaces.findIndex((s) => s.id === id) ?? -1;
  const space = bar?.spaces[i];
  return space?.letter ?? (i >= 0 && i < 9 ? String(i + 1) : '');
}

const accentOf = (id) => bar?.spaces.find((s) => s.id === id)?.accent ?? commands?.apps.find((a) => a.id === id)?.accent ?? theme.foreground;
const titleOf = (id) => bar?.spaces.find((s) => s.id === id)?.title ?? commands?.apps.find((a) => a.id === id)?.title ?? id;

// ---- the bar ----------------------------------------------------------------------------------------

let shownTabs = '';

function drawTabs(state) {
  // Drawn again only when the tabs changed: the state comes often (a notice, the prefix waiting), and
  // a tab replaced between the press and the release of a click would lose that click.
  const key = JSON.stringify([state.spaces, state.active, state.shown]);
  if (key === shownTabs) return;
  shownTabs = key;
  $('tabs').replaceChildren(
    ...state.spaces.map((s, i) => {
      const classes = ['tab', s.state];
      if (s.id === state.active) classes.push('active');
      else if (s.id === state.shown) classes.push('shown');
      const keys = `prefix ${[i < 9 ? String(i + 1) : '', s.letter].filter(Boolean).join(' or ')}`;
      const tab = el(
        'button',
        { type: 'button', className: classes.join(' '), title: s.why ? `${s.title}: ${s.why}  (${keys})` : `${s.title}  (${keys})` },
        el('span', { className: 'dot', ariaHidden: 'true' }),
        el('span', { textContent: s.title }),
        s.badge ? el('span', { className: `badge${s.error ? ' error' : ''}`, textContent: s.badge }) : null,
        // A badge says why, in a few words, until you look.
        s.why && s.id !== state.active ? el('span', { className: 'why', textContent: s.why }) : null,
      );
      tab.style.setProperty('--accent', s.accent);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(s.id === state.active));
      // On the press, not the click: the switch shouldn't wait for the release, nor depend on it.
      tab.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        prefixed(keyOf(s.id));
      });
      tab.addEventListener('keydown', (e) => e.key === 'Enter' && prefixed(keyOf(s.id)));
      return tab;
    }),
  );
}

function drawStatus(state) {
  const pills = [];
  const { env, recording, proposals } = state.status ?? {};
  if (proposals > 0) {
    const p = el('button', { type: 'button', className: 'pill proposals', textContent: `◆${proposals} proposed`, title: "Claude's proposals (prefix P)" });
    p.addEventListener('click', () => prefixed('P'));
    pills.push(p);
  }
  if (recording) pills.push(el('span', { className: 'pill rec', textContent: '● REC' }));
  if (env?.name) {
    const e = el('button', { type: 'button', className: `pill ${env.prod ? 'prod' : 'env'}`, textContent: env.prod ? env.name.toUpperCase() : env.name, title: 'The environment (prefix e)' });
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
    const quit = el('button', { type: 'button', className: 'answer', textContent: 'y quit' });
    const stay = el('button', { type: 'button', className: 'answer', textContent: 'n stay' });
    quit.addEventListener('click', () => send('y'));
    stay.addEventListener('click', () => send('n'));
    say.replaceChildren(el('span', { className: 'question', textContent: state.confirming }), quit, stay);
  } else if (state.asking) {
    // The host edits the line (the keys go to it as they always do); this only shows it.
    const { label, text, cursor, hint } = state.asking;
    const field = el('span', { className: 'field' }, text.slice(0, cursor), el('span', { className: 'caret', textContent: text[cursor] ?? ' ' }), text.slice(cursor + 1));
    say.replaceChildren(el('span', { className: 'label', textContent: `${label}:` }), field, el('span', { textContent: hint }));
  } else if (state.prefix) {
    say.replaceChildren(el('span', { className: 'keys', textContent: `${state.prefixLabel} · ${state.hint}` }));
  } else if (state.notice) {
    say.replaceChildren(el('span', { className: 'notice', textContent: state.notice }));
  } else {
    say.replaceChildren(el('span', { textContent: `${state.prefixLabel} then a key · ^K every command · ${state.prefixLabel} ? every key` }));
  }
}

// ---- toasts and notifications -----------------------------------------------------------------------

let lastToast = null;

function drawToast(toast) {
  // The first state after a (re)load carries the last toast: old news, not shown again.
  if (lastToast == null) {
    lastToast = toast?.id ?? 0;
    return;
  }
  if (!toast || toast.id <= lastToast) return;
  lastToast = toast.id;
  const go = () => prefixed(toast.proposal ? 'P' : keyOf(toast.app));
  const node = el(
    'button',
    { type: 'button', className: 'toast' },
    el('span', { className: 'app', textContent: toast.title }),
    ' ',
    el('span', { className: 'what', textContent: toast.text }),
    '  ',
    el('span', { className: 'go', textContent: '↵ go there' }),
  );
  node.querySelector('.app').style.color = toast.error ? theme.red : accentOf(toast.app);
  node.addEventListener('click', () => (go(), node.remove()));
  $('toasts').prepend(node);
  while ($('toasts').children.length > 4) $('toasts').lastChild.remove();
  setTimeout(() => node.remove(), 8000);
  // In the background, the system says it too (once allowed).
  if (!document.hasFocus() && stored('notify', true)) notify(`${toast.title}: ${toast.text}`);
}

async function notify(body) {
  const n = plugin('notification');
  if (!n) return;
  try {
    let ok = await n.isPermissionGranted();
    if (!ok) ok = (await n.requestPermission()) === 'granted';
    if (ok) n.sendNotification({ title: 'Fleet', body });
  } catch {
    // No notifications here: the toast stays the only word.
  }
}

// ---- boxes: a panel of the host's, or one of the window's own (the palette, the settings) ------------

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
      } else if ((n === 38 || n === 48) && p[i + 1] === 5) {
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

// What a key in a hint types when it's clicked.
const KEY_TYPES = { '↵': '\r', esc: '\x1b', space: ' ', tab: '\t', '←': '\x1b[D', '→': '\x1b[C', '↑': '\x1b[A', '↓': '\x1b[B' };
const typed = (key) => KEY_TYPES[key] ?? (key.length === 1 ? key : null);

/** A hint as the terminal writes it ("↵ open · j k move · esc close"): the keys bright, each a button. */
function keyParts(hint, onKey) {
  return String(hint ?? '')
    .split(' · ')
    .filter(Boolean)
    .map((part) => {
      const words = part.split(' ');
      let n = 0;
      while (n < words.length - 1 && (KEY_TYPES[words[n]] || words[n].length === 1 || /^(\^|ctrl\+|alt\+)/.test(words[n]))) n++;
      if (n === 0) n = 1;
      const node = el('span', { className: 'keypart' });
      for (const key of words.slice(0, n)) {
        const data = onKey && typed(key);
        const k = el(data ? 'button' : 'span', { className: 'key', textContent: key, ...(data ? { type: 'button', title: `Types ${key}` } : {}) });
        if (data) k.addEventListener('click', () => onKey(data));
        node.append(k);
      }
      node.append(words.slice(n).join(' '));
      return node;
    });
}

// The box on screen: the host's panel when it has one open, else the window's own, else none.
let own = null; // { kind: 'palette' | 'settings', ... }
let shownBox = '';

function openBox({ title, top = null, rows = [], hint = '', onKey = null }) {
  $('scrim').hidden = false;
  $('box-title').textContent = title;
  $('box-top').replaceChildren(...(top ? [top] : []));
  $('box-body').replaceChildren(...rows);
  $('box-keys').replaceChildren(...keyParts(hint, onKey));
}

function closeBox() {
  $('scrim').hidden = true;
  shownBox = '';
}

function drawPanel(panel) {
  if (!panel) {
    if (!own && shownBox) closeBox();
    return;
  }
  // The host's panel wins over the window's own: it was asked for last.
  own = null;
  const json = JSON.stringify(panel);
  if (json === shownBox) return;
  shownBox = json;
  const [from, to] = panel.focus ?? [0, 0];
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
  openBox({ title: panel.title ?? '', top: panel.chart ? chart(panel.chart) : null, rows, hint: panel.hint, onKey: (data) => (send(data), term.focus()) });
  rows[from]?.scrollIntoView({ block: 'nearest' });
}

function closeOwn() {
  own = null;
  closeBox();
  term.focus();
}

$('box-close').addEventListener('click', () => (own ? closeOwn() : (tell({ close: true }), term.focus())));
$('scrim').addEventListener('mousedown', (e) => {
  // A click outside the box closes it, as esc would.
  if (e.target !== $('scrim')) return;
  if (own) closeOwn();
  else tell({ close: true });
});
// After a click in the host's panel, the keys go back to Fleet; the window's own boxes keep theirs.
$('box').addEventListener('mouseup', () => queueMicrotask(() => !own && term.focus()));

// ---- charts above a panel's rows ---------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c != null) node.append(c);
  return node;
};
const titled = (node, text) => (node.append(svg('title', {}, text)), node);
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const BAD = /crash|error|fail|gave up/i;
const FAINT = '#5c6573';

function chart(c) {
  const wrap = el('div', { className: 'chart' });
  if (c.kind === 'timeline') wrap.append(timelineChart(c));
  else if (c.kind === 'path') wrap.append(pathChart(c));
  else if (c.kind === 'severity') wrap.append(severityChart(c));
  return wrap;
}

/** What changed, on one time axis: a lane per app, a tick per event, crashes and errors red and tall. */
function timelineChart({ since, now, events }) {
  const apps = [...new Set(events.map((e) => e.app))];
  const W = 900;
  const lane = 18;
  const left = 90;
  const H = Math.max(1, apps.length) * lane + 22;
  const x = (at) => left + ((at - since) / Math.max(1, now - since)) * (W - left - 10);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${events.length} changes on a time axis` });
  apps.forEach((app, i) => {
    const y = i * lane + 9;
    root.append(svg('text', { x: 0, y: y + 4, fill: accentOf(app), 'font-size': 11 }, titleOf(app)));
    root.append(svg('line', { x1: left, x2: W - 10, y1: y, y2: y, stroke: '#2a313b' }));
  });
  for (const e of events) {
    const y = apps.indexOf(e.app) * lane + 9;
    const bad = BAD.test(e.kind ?? '') || BAD.test(e.text ?? '');
    root.append(titled(svg('line', { x1: x(e.at), x2: x(e.at), y1: y - (bad ? 7 : 4), y2: y + (bad ? 7 : 4), stroke: bad ? theme.red : accentOf(e.app), 'stroke-width': bad ? 3 : 2 }), `${clock(e.at)}  ${titleOf(e.app)}: ${e.text}`));
  }
  const axis = Math.max(1, apps.length) * lane + 16;
  root.append(svg('text', { x: left, y: axis, fill: FAINT, 'font-size': 10 }, clock(since)));
  root.append(svg('text', { x: W - 10, y: axis, fill: FAINT, 'font-size': 10, 'text-anchor': 'end' }, `now ${clock(now)}`));
  if (!events.length) root.append(svg('text', { x: left, y: 12, fill: '#8a94a3', 'font-size': 11 }, 'Nothing changed in this window.'));
  return root;
}

/** A request's path through the apps: one row per app, a dot per sighting, joined in time order. */
function pathChart({ events }) {
  const sorted = [...events].sort((a, b) => a.at - b.at);
  const apps = [...new Set(sorted.map((e) => e.app ?? e.source))];
  const W = 900;
  const lane = 20;
  const left = 90;
  const H = Math.max(1, apps.length) * lane + 22;
  const first = sorted[0]?.at ?? 0;
  const last = sorted.at(-1)?.at ?? first + 1;
  const x = (at) => left + ((at - first) / Math.max(1, last - first)) * (W - left - 14);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `The request seen ${sorted.length} times` });
  apps.forEach((app, i) => root.append(svg('text', { x: 0, y: i * lane + 14, fill: accentOf(app), 'font-size': 11 }, titleOf(app))));
  const points = sorted.map((e) => [x(e.at), apps.indexOf(e.app ?? e.source) * lane + 10]);
  if (points.length > 1) root.append(svg('polyline', { points: points.map((p) => p.join(',')).join(' '), fill: 'none', stroke: '#343c48', 'stroke-width': 1.5 }));
  sorted.forEach((e, i) => root.append(titled(svg('circle', { cx: points[i][0], cy: points[i][1], r: 4, fill: BAD.test(e.text ?? '') ? theme.red : accentOf(e.app) }), `${clock(e.at)}  ${e.text}`)));
  if (sorted.length) {
    root.append(svg('text', { x: left, y: H - 4, fill: FAINT, 'font-size': 10 }, clock(first)));
    root.append(svg('text', { x: W - 10, y: H - 4, fill: FAINT, 'font-size': 10, 'text-anchor': 'end' }, `${clock(last)}  (${Math.round((last - first) / 1000)} s)`));
  }
  return root;
}

/** Security by app: a bar each, its findings by severity, worst first. */
function severityChart({ byApp }) {
  const ORDER = [
    ['critical', theme.red],
    ['high', '#ffaf5f'],
    ['medium', theme.yellow],
    ['low', theme.blue],
    ['info', FAINT],
  ];
  const total = (c) => Object.values(c).reduce((s, n) => s + n, 0);
  const apps = Object.entries(byApp).sort((a, b) => total(b[1]) - total(a[1]));
  const max = Math.max(1, ...apps.map(([, c]) => total(c)));
  const W = 900;
  const lane = 18;
  const left = 90;
  const root = svg('svg', { viewBox: `0 0 ${W} ${apps.length * lane + 18}`, role: 'img', 'aria-label': 'Findings by app and severity' });
  apps.forEach(([app, counts], i) => {
    const y = i * lane;
    root.append(svg('text', { x: 0, y: y + 12, fill: accentOf(app), 'font-size': 11 }, titleOf(app)));
    let at = left;
    for (const [sev, colour] of ORDER) {
      const n = counts[sev] ?? 0;
      if (!n) continue;
      const w = (n / max) * (W - left - 60);
      root.append(titled(svg('rect', { x: at, y: y + 3, width: Math.max(2, w), height: 11, fill: colour }), `${n} ${sev}`));
      at += w;
    }
    root.append(svg('text', { x: at + 6, y: y + 12, fill: '#8a94a3', 'font-size': 10 }, String(total(counts))));
  });
  root.append(...ORDER.slice(0, 4).map(([sev, colour], i) => svg('text', { x: left + i * 90, y: apps.length * lane + 14, fill: colour, 'font-size': 10 }, `■ ${sev}`)));
  return root;
}

// ---- the palette: every app's commands and Fleet's ---------------------------------------------------

/** The palette's entries, the app on screen first: Fleet's actions, the proposals, every app's commands. */
function paletteEntries() {
  const out = [];
  for (const f of commands?.fleet ?? []) out.push({ group: 'FLEET', label: f.desc, end: f.keys, mark: '◆', colour: '#e6c07b', run: () => prefixed(f.key) });
  if (bar?.status?.proposals > 0) out.push({ group: 'CLAUDE', label: `Claude's proposals (${bar.status.proposals} waiting)`, end: `${bar.prefixLabel} P`, mark: '◆', colour: '#e6c07b', run: () => prefixed('P') });
  const apps = [...(commands?.apps ?? [])].sort((a, b) => (a.id === bar?.active ? -1 : b.id === bar?.active ? 1 : 0));
  for (const a of apps) {
    for (const c of a.commands) {
      out.push({
        group: a.id === bar?.active ? a.title.toUpperCase() : 'OTHER APPS',
        label: `${a.id === bar?.active ? '' : `${a.title}: `}${c.desc || c.name}`,
        end: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
        mark: '●',
        colour: a.accent,
        // Into the app's prompt, as a hand-off's line: arguments to fill in, ↵ yours to press.
        run: () => (tell({ run: { app: a.id, line: `/${c.name}${c.args ? ' ' : ''}` } }), term.focus()),
      });
    }
  }
  return out;
}

/** Whether `query`'s letters come in `text` in order (a fuzzy match), and how tightly: lower is better. */
function score(text, query) {
  if (!query) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(query);
  if (direct >= 0) return direct;
  let at = -1;
  let spread = 0;
  for (const ch of query) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    if (at >= 0) spread += next - at - 1;
    at = next;
  }
  return 100 + spread;
}

/**
 * How well entry `e` answers `q`, lower first: a command whose own name starts with it, then one that
 * has it in its name, then its words; the app on screen ahead of the others at the same rank.
 */
function rank(e, q) {
  const words = score(`${e.label} ${e.end}`, q);
  if (words == null) return null;
  const name = e.end.split(' ')[0].replace(/^\//, '').toLowerCase();
  const own = e.group !== 'OTHER APPS' ? -0.5 : 0;
  if (q && name.startsWith(q)) return -200 + own;
  if (q && name.includes(q)) return -100 + own;
  return words + own;
}

function openPalette() {
  own = { kind: 'palette', query: '', cursor: 0 };
  const input = el('input', { autocomplete: 'off', spellcheck: false, placeholder: 'a command, an app, a key…', ariaLabel: 'Search every command' });
  const count = el('span', { className: 'count' });
  const top = el('div', { className: 'field-row' }, el('span', { className: 'sign', textContent: '›' }), input, count);
  let all = paletteEntries();
  let shown = [];
  // No list yet (Fleet still starting, or the first hello lost): asked for again, and drawn when it comes.
  own.refresh = () => {
    all = paletteEntries();
    draw();
  };
  if (!commands) tell({ hello: true });
  const run = (i) => {
    const e = shown[i];
    if (!e) return;
    own = null;
    closeBox();
    e.run();
  };
  const draw = () => {
    const q = own.query.trim().toLowerCase();
    shown = all
      .map((e) => ({ e, s: rank(e, q) }))
      .filter((x) => x.s != null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 200)
      .map((x) => x.e);
    own.cursor = Math.min(own.cursor, Math.max(0, shown.length - 1));
    count.textContent = `${shown.length} of ${all.length}`;
    const rows = [];
    let group = null;
    shown.forEach((e, i) => {
      if (!q && e.group !== group) rows.push(el('div', { className: 'group', textContent: (group = e.group) }));
      const mark = el('span', { textContent: e.mark });
      mark.style.color = e.colour;
      const row = el('div', { className: `row entry${i === own.cursor ? ' focus' : ''}`, title: `${e.label}  ${e.end}` }, el('span', { className: 'label' }, mark, ` ${e.label}`), el('span', { className: 'end', textContent: e.end }));
      row.addEventListener('click', () => run(i));
      rows.push(row);
    });
    if (!all.length) rows.push(el('div', { className: 'row', textContent: 'The list comes from Fleet once it has started…' }));
    $('box-body').replaceChildren(...rows);
    $('box-body').querySelector('.focus')?.scrollIntoView({ block: 'nearest' });
  };
  openBox({ title: 'Every command', top, hint: '↑ ↓ move · ↵ into its prompt · esc close' });
  input.addEventListener('input', () => {
    own.query = input.value;
    own.cursor = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      own.cursor = Math.max(0, Math.min(shown.length - 1, own.cursor + (e.key === 'ArrowDown' ? 1 : -1)));
      draw();
      e.preventDefault();
    } else if (e.key === 'Enter') run(own.cursor);
    else if (e.key === 'Escape') closeOwn();
  });
  draw();
  input.focus();
}

// ---- settings ----------------------------------------------------------------------------------------

function openSettings() {
  own = { kind: 'settings' };
  const setting = (label, control, note = '') => el('div', { className: 'setting' }, el('label', { textContent: label }), control, note ? el('span', { className: 'note', textContent: note }) : null);
  const size = el('input', { type: 'number', min: 9, max: 28, value: term.options.fontSize, ariaLabel: 'Font size' });
  size.addEventListener('change', () => {
    const v = Math.max(9, Math.min(28, Number(size.value) || 14));
    term.options.fontSize = v;
    store('fontSize', v);
    fitTerm();
  });
  const bell = el('input', { type: 'checkbox', checked: Boolean(bar?.bell), ariaLabel: 'Bell' });
  bell.addEventListener('change', () => tell({ settings: { bell: bell.checked } }));
  const notifyBox = el('input', { type: 'checkbox', checked: stored('notify', true), ariaLabel: 'Notifications' });
  notifyBox.addEventListener('change', () => store('notify', notifyBox.checked));
  const prefix = el('input', { type: 'text', value: bar?.prefixLabel ?? 'ctrl+b', size: 10, ariaLabel: 'Prefix' });
  prefix.addEventListener('change', () => tell({ settings: { prefix: prefix.value.trim() } }));
  const apps = el('button', { type: 'button', className: 'answer', textContent: 'choose…' });
  apps.addEventListener('click', () => {
    own = null;
    closeBox();
    prefixed('a');
  });
  openBox({
    title: 'Settings',
    rows: [
      setting('Font size', size, 'this window'),
      setting('Bell when an app needs you', bell, 'kept in host.json'),
      setting('Notifications in the background', notifyBox, 'this window'),
      setting('Prefix', prefix, 'from the next start: ctrl and a key'),
      setting('Apps on the bar', apps),
    ],
    hint: 'esc close',
  });
  $('box').addEventListener('keydown', function esc(e) {
    if (e.key !== 'Escape' || own?.kind !== 'settings') return;
    $('box').removeEventListener('keydown', esc);
    closeOwn();
  });
}

// ---- the side panels: projects and Claude ------------------------------------------------------------

function toggleSide(which) {
  for (const name of ['projects', 'claude']) {
    const open = name === which && $(`side-${name}`).hidden;
    $(`side-${name}`).hidden = !open;
    $(`toggle-${name}`).setAttribute('aria-pressed', String(open));
  }
  requestAnimationFrame(() => fitTerm());
  if (which === 'claude' && !$('side-claude').hidden) $('claude-input').focus();
  else term.focus();
}

async function moveTo(path) {
  const d = plugin('dialog');
  const ok = d ? await d.ask(`Move the fleet to ${path}? Every app starts again there.`, { title: 'Fleet', kind: 'warning' }).catch(() => false) : true;
  if (ok) tell({ move: path });
  term.focus();
}

function drawProjects(state) {
  const cwd = state.cwd;
  $('projects').replaceChildren(
    ...(state.folders ?? []).map((f) => {
      const name = f.short.split(/[\\/]/).filter(Boolean).pop() ?? f.short;
      const item = el('button', { type: 'button', className: `item${f.short === cwd ? ' current' : ''}`, title: f.path }, name, ' ', el('span', { className: 'sub', textContent: f.short }));
      if (f.short !== cwd) item.addEventListener('click', () => moveTo(f.path));
      return item;
    }),
  );
}

function drawClaude(state) {
  const c = state.claude;
  const out = [];
  if (!c) out.push(el('div', { className: 'answer-text', textContent: 'Ask about a symptom. Claude reads what changed across the apps (commits, deploys, crashes and alerts) and says what likely caused it.' }));
  else {
    if (c.symptom) out.push(el('div', { className: 'group', textContent: `“${c.symptom}”` }));
    out.push(el('div', { className: 'answer-text', textContent: c.state === 'asking' ? 'Claude is reading the timeline…' : c.text || c.error || '' }));
  }
  $('claude').replaceChildren(...out);
}

$('toggle-projects').addEventListener('click', () => toggleSide('projects'));
$('toggle-claude').addEventListener('click', () => toggleSide('claude'));
$('open-folder').addEventListener('click', async () => {
  const d = plugin('dialog');
  const path = d ? await d.open({ directory: true, title: 'Move the fleet to' }).catch(() => null) : null;
  if (typeof path === 'string') moveTo(path);
});
$('claude-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('claude-input').value.trim();
  if (!q) return;
  tell({ ask: q });
  $('claude-input').value = '';
});
$('claude-proposals').addEventListener('click', () => prefixed('P'));

// ---- the host's messages ------------------------------------------------------------------------------

function drawBar(state) {
  bar = state;
  drawTabs(state);
  drawStatus(state);
  drawStrip(state);
  drawPanel(state.panel);
  drawToast(state.toast);
  drawProjects(state);
  drawClaude(state);
}

const parsed = (fn) => (data) => {
  try {
    fn(JSON.parse(data));
  } catch {
    // A message cut short or from another program: the last one stays.
  }
  return true;
};
term.parser.registerOscHandler(5380, parsed(drawBar));
term.parser.registerOscHandler(
  5382,
  parsed((list) => {
    commands = list;
    // A palette opened before the list came fills in now.
    if (own?.kind === 'palette') own.refresh?.();
  }),
);

$('add').addEventListener('click', () => prefixed('a'));
$('open-palette').addEventListener('click', openPalette);
$('open-settings').addEventListener('click', openSettings);
for (const b of document.querySelectorAll('#tools button[data-key]')) b.addEventListener('click', () => prefixed(b.dataset.key));

// ctrl+k (cmd+k on a Mac) opens the palette rather than reaching the app; ctrl+shift+p too.
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if (((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === 'k') || ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'p')) {
    e.preventDefault();
    openPalette();
    return false;
  }
  return true;
});

// ---- the pseudo-terminal -------------------------------------------------------------------------------

const ended = $('ended');
const endedText = $('ended-text');

// Fleet's output: raw bytes through a channel (main.rs), straight to xterm.js. What xterm.js has drawn
// goes back as `ack`, a few times a second at most rather than once a message: main.rs holds the
// output back while too much of it waits to be drawn, so a flood can't bury the next keystroke.
let drawn = 0;
let ackTimer = null;
const ackDrawn = () => {
  ackTimer = null;
  const bytes = drawn;
  drawn = 0;
  if (bytes) invoke('ack', { bytes }).catch(() => {});
};
const output = new window.__TAURI__.core.Channel();
output.onmessage = (data) => {
  const bytes = new Uint8Array(data);
  term.write(bytes, () => {
    drawn += bytes.length;
    if (drawn >= 128 * 1024) {
      clearTimeout(ackTimer);
      ackDrawn();
    } else if (!ackTimer) ackTimer = setTimeout(ackDrawn, 20);
  });
};
listen('pty-exit', (e) => finished(`Fleet ended${e.payload ? ` (exit ${e.payload})` : ''}.`));

term.onData(send);
// Old-style mouse reports come as bytes above 127, which onData doesn't carry.
term.onBinary(send);
// While the window's edge is dragged the size changes many times a second, and every change makes each
// running app draw again: the pseudo-terminal hears the size once it has settled.
let resizeTimer = null;
term.onResize(({ cols, rows }) => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    invoke('resize', { cols, rows });
    // The GPU renderer can keep its old picture after a resize: drawn again once the apps have redrawn.
    setTimeout(() => {
      webgl?.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
    }, 250);
  }, 60);
});

new ResizeObserver(() => fitTerm()).observe($('terminal'));

function finished(text) {
  endedText.textContent = text;
  ended.hidden = false;
  $('again').focus();
}

async function begin() {
  ended.hidden = true;
  term.reset();
  lastToast = null;
  try {
    await invoke('start', { cols: term.cols, rows: term.rows, output });
    term.focus();
    // The palette's list (and the state, again): the host sends them at its start and when asked.
    // Asked again a few times while none has come, in case Fleet wasn't reading yet.
    const hello = (tries) =>
      setTimeout(() => {
        if (tries === 5 || !commands) tell({ hello: true });
        if (tries > 1 && !commands) hello(tries - 1);
      }, 1500);
    hello(5);
  } catch (err) {
    finished(String(err));
  }
}

// ---- updates -----------------------------------------------------------------------------------------

/**
 * Looks for a newer Fleet once the window is up: the Desktop workflow publishes each one as a release
 * (desktop-v…) and keeps latest.json on the desktop-latest release, which tauri.conf.json points the
 * updater at. A newer one is said as a toast; a click downloads it, checks its signature against the
 * public key built into this window, installs it and starts it. Fleet's apps come with it.
 */
async function lookForUpdate() {
  const updater = plugin('updater');
  if (!updater) return;
  let update;
  try {
    update = await updater.check();
  } catch {
    return; // Offline, or no release yet: the next start looks again.
  }
  if (!update) return;
  const go = el('span', { className: 'go', textContent: '↵ install and restart' });
  const node = el('button', { type: 'button', className: 'toast' }, el('span', { className: 'app', textContent: 'Fleet' }), ' ', el('span', { className: 'what', textContent: `${update.version} is out (you have ${update.currentVersion})` }), '  ', go);
  node.querySelector('.app').style.color = '#e6c07b';
  node.addEventListener('click', async () => {
    if (node.dataset.busy) return;
    node.dataset.busy = '1';
    go.textContent = 'downloading…';
    try {
      await update.downloadAndInstall();
      go.textContent = 'restarting…';
      // Fleet and its apps stop with the old window; the new one starts them again.
      await invoke('stop');
      await plugin('process').relaunch();
    } catch (e) {
      go.textContent = `couldn't: ${e}`;
      delete node.dataset.busy;
    }
  });
  $('toasts').prepend(node);
}

$('again').addEventListener('click', async () => {
  await invoke('stop');
  bar = null;
  commands = null;
  shownTabs = '';
  begin();
});

// The title bar's buttons: the system's own bar is off (tauri.conf.json), so these are the window's.
// Maximise shows the restore icon while maximised (style.css's body.maximised), as Windows' own does,
// and a double click on the bar's empty parts maximises too (Tauri's drag region).
const win = window.__TAURI__.window.getCurrentWindow();
$('win-min').addEventListener('click', () => win.minimize());
$('win-max').addEventListener('click', () => win.toggleMaximize());
$('win-close').addEventListener('click', () => win.close());
const showMaximised = async () => {
  const on = await win.isMaximized().catch(() => false);
  $('win-max').title = on ? 'Restore' : 'Maximise';
  document.body.classList.toggle('maximised', on);
};
win.onResized(showMaximised);
showMaximised();

begin();
setTimeout(lookForUpdate, 10_000);
