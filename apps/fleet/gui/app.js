// Fleet's window. The apps run on the server (`fleet gui`), each drawing into a virtual terminal there;
// this page draws their screens from the rows the server sends (server-sent events), and sends back
// what is typed and clicked as a terminal's bytes (keymap.js), so every app works here exactly as in
// a terminal. Around them, Fleet's own tools are the page's: the rail of apps with their badges, two
// apps side by side, runbooks, following a request, moving the fleet, the command palette.
import { BOX_CLASSES, splitBoxes } from './boxes.js';
import { keyBytes, mouseBytes } from './keymap.js';
import { styleCss } from './sgr.js';
import { chartSvg, pointAt } from './views.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  spaces: [],
  shown: [],
  active: null,
  previous: null,
  cwd: '',
  screens: new Map(), // id → { columns, height, rows: [runs], cursor }
  panes: new Map(), // id → { el, screen, rowsEl, rowEls: [], cursorEl, size }
  views: new Map(), // id → Map(key → { kind, data, rect }): the native views each app asked for
  prefix: false,
  drawer: null,
  runbookOpen: null,
  connected: false,
};

const byId = (id) => state.spaces.find((s) => s.id === id);

// ---- talking to the server ------------------------------------------------------------------------

async function post(action, body = {}) {
  const res = await fetch(`/api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fleet': '1' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({}));
}

// Keys go one request at a time, in order: what's typed while one is on its way goes in the next.
const typing = { pending: new Map(), busy: false };
function send(id, data) {
  if (!id || !data) return;
  typing.pending.set(id, (typing.pending.get(id) ?? '') + data);
  pump();
}
async function pump() {
  if (typing.busy) return;
  typing.busy = true;
  try {
    while (typing.pending.size) {
      const [id, data] = typing.pending.entries().next().value;
      typing.pending.delete(id);
      await post('input', { id, data });
    }
  } finally {
    typing.busy = false;
  }
}

function connect() {
  const events = new EventSource('/events');
  events.onmessage = (m) => {
    let event;
    try {
      event = JSON.parse(m.data);
    } catch {
      return;
    }
    handle(event);
  };
  events.onopen = () => {
    state.connected = true;
  };
  events.onerror = () => {
    if (state.connected) toast('Lost Fleet: trying again…');
    state.connected = false;
  };
}

function handle(e) {
  switch (e.type) {
    case 'hello':
      state.screens.clear();
      takeSpaces(e);
      for (const f of e.frames) applyFrame(f);
      state.views = new Map(Object.entries(e.views ?? {}).map(([id, vs]) => [id, new Map(Object.entries(vs))]));
      if (!state.shown.length) show(savedShown() ?? [state.spaces[0].id]);
      else renderStage();
      break;
    case 'spaces':
      takeSpaces(e);
      break;
    case 'frame':
      applyFrame(e);
      break;
    case 'view': {
      const vs = state.views.get(e.id) ?? new Map();
      if (e.view) vs.set(e.key, e.view);
      else vs.delete(e.key);
      state.views.set(e.id, vs);
      drawViews(e.id);
      break;
    }
    case 'views':
      state.views.set(e.id, new Map());
      drawViews(e.id);
      break;
    case 'focus':
      if (state.shown.includes(e.id)) {
        state.active = e.id;
        renderStage();
      }
      break;
    case 'notice':
      toast(e.text);
      break;
    case 'bell':
      bell(e.id);
      break;
    case 'copy':
      copyText(e.text).then((ok) => toast(ok ? `Copied from ${byId(e.id)?.title ?? e.id}` : 'The browser kept the clipboard to itself: copy again with the window focused'));
      break;
    case 'notify':
      notify(e.title || byId(e.id)?.title || 'Fleet', e.body, e.id);
      break;
    case 'attention':
      notify(e.title, e.reason, e.id, { always: false });
      break;
    case 'ask-move':
      openMove(e.folder, `${e.from} asks to move the fleet`);
      break;
    default:
      break;
  }
}

function takeSpaces(e) {
  const before = state.shown.join(',');
  state.spaces = e.spaces;
  state.cwd = e.cwd;
  if (e.shown?.length) {
    if (e.active && e.active !== state.active) state.previous = state.active;
    state.shown = e.shown;
    state.active = e.active;
  }
  renderRail();
  if (before !== state.shown.join(',')) renderStage();
  else for (const id of state.shown) renderCover(id);
  $('#folder-name').textContent = shortPath(state.cwd);
  $('#folder').title = `${state.cwd}: click to move every app (ctrl+] m)`;
  const count = state.spaces.filter((s) => s.badge).length;
  document.title = `${count ? `(${count}) ` : ''}Fleet · ${shortPath(state.cwd)}`;
}

const shortPath = (p) => {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
};

// ---- what's shown ---------------------------------------------------------------------------------

function show(ids) {
  const list = [...new Set([].concat(ids))].filter((id) => byId(id)).slice(0, 2);
  if (!list.length) return;
  if (list[0] !== state.active) state.previous = state.active;
  state.shown = list;
  state.active = list[0];
  try {
    localStorage.setItem('fleet.shown', JSON.stringify(list));
  } catch {}
  renderRail();
  renderStage();
  post('show', { ids: list });
}

function savedShown() {
  try {
    const list = JSON.parse(localStorage.getItem('fleet.shown') ?? 'null');
    return Array.isArray(list) && list.every((id) => byId(id)) ? list : null;
  } catch {
    return null;
  }
}

/** Switches to `id`: beside the other app when split (in the focused pane), else alone. */
function switchTo(id) {
  if (!byId(id)) return;
  if (state.shown.length === 2) {
    if (state.shown.includes(id)) show([id, ...state.shown.filter((x) => x !== id)]);
    else show([id, state.shown.find((x) => x !== state.active)]);
  } else show([id]);
}

function toggleSplit() {
  if (state.shown.length === 2) return show([state.active]);
  const other = state.previous && state.previous !== state.active ? state.previous : state.spaces[(state.spaces.findIndex((s) => s.id === state.active) + 1) % state.spaces.length].id;
  show([state.active, other]);
}

function otherPane() {
  if (state.shown.length === 2) show([state.shown.find((x) => x !== state.active), state.active]);
}

function renderRail() {
  const host = $('#spaces');
  host.innerHTML = state.spaces
    .map((s, i) => {
      const on = s.id === state.active;
      const beside = !on && state.shown.includes(s.id);
      const what = s.state === 'running' ? 'running' : s.state === 'exited' ? `exited${s.code != null ? ` (${s.code})` : ''}` : 'not started';
      const badge = s.badge?.text ? `<span class="badge${s.badge.alert ? ' alert' : ''}" title="${esc(s.badge.reason ?? '')}">${esc(s.badge.text)}</span>` : '';
      return `<button type="button" role="tab" class="space${on ? ' on' : ''}${beside ? ' beside' : ''}" data-id="${s.id}" style="--app:${s.accent}" aria-selected="${on}" title="${esc(s.title)} (alt+${i + 1})">
        <img src="logo/${s.id}.svg" alt="" data-letter="${esc(s.title[0])}">${badge}
        <span class="name"><b>${esc(s.title)}</b><small><span class="dot ${s.state}"></span>${what}</small></span>
        <span class="key">${i + 1}</span></button>`;
    })
    .join('');
  // A logo that won't load leaves the app's letter (the page's policy allows no inline handlers).
  for (const img of host.querySelectorAll('img[data-letter]')) {
    img.addEventListener('error', () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'letter', textContent: img.dataset.letter })), { once: true });
  }
  for (const tool of document.querySelectorAll('#tools [data-tool]')) {
    tool.classList.toggle('on', (tool.dataset.tool === 'split' && state.shown.length === 2) || tool.dataset.tool === state.drawer);
  }
}

function renderStage() {
  const stage = $('#stage');
  // Panes stay as they are while their app stays shown, so the screen doesn't flicker.
  for (const [id, pane] of state.panes) {
    if (!state.shown.includes(id)) {
      pane.observer.disconnect();
      pane.el.remove();
      state.panes.delete(id);
    }
  }
  state.shown.forEach((id, i) => {
    let pane = state.panes.get(id);
    if (!pane) pane = makePane(id);
    if (stage.children[i] !== pane.el) stage.insertBefore(pane.el, stage.children[i] ?? null);
    pane.el.classList.toggle('active', id === state.active);
    // Closing a pane means showing the other app alone: with one pane there's nothing to close.
    $('[data-act="close"]', pane.el).hidden = state.shown.length < 2;
    renderCover(id);
    drawCursor(id);
  });
  focusKeys();
}

function makePane(id) {
  const s = byId(id);
  const el = document.createElement('section');
  el.className = 'pane';
  el.style.setProperty('--app', s.accent);
  el.innerHTML = `<header><img src="logo/${id}.svg" alt=""><b>${esc(s.title)}</b><span class="state"></span><span class="grow"></span>
    <button type="button" data-act="restart" title="Start ${esc(s.title)} again">↻</button>
    <button type="button" data-act="close" title="Show only the other app">✕</button></header>
    <div class="screen"><div class="views"></div><div class="rows"></div><div class="cursor" hidden></div><div class="tip" hidden></div></div>`;
  const screen = $('.screen', el);
  const pane = { id, el, screen, rowsEl: $('.rows', el), viewsEl: $('.views', el), tipEl: $('.tip', el), rowEls: [], cursorEl: $('.cursor', el), size: null, observer: null };
  el.addEventListener('mousedown', () => {
    if (state.active !== id) show([id, ...state.shown.filter((x) => x !== id)]);
  });
  $('[data-act="restart"]', el).addEventListener('click', () => post('restart', { id }));
  $('[data-act="close"]', el).addEventListener('click', (ev) => {
    ev.stopPropagation();
    show(state.shown.filter((x) => x !== id));
  });
  wireMouse(pane);
  pane.observer = new ResizeObserver(() => fit(pane));
  pane.observer.observe(screen);
  state.panes.set(id, pane);
  // Draw what's kept of its screen at once, then let the server repaint it at this size.
  const kept = state.screens.get(id);
  if (kept) kept.rows.forEach((runs, y) => drawRow(pane, y, runs));
  drawViews(id, pane);
  return pane;
}

/** The pane's size in cells, from its pixels: the app is told when it changes. */
function fit(pane) {
  const r = pane.screen.getBoundingClientRect();
  const columns = Math.max(20, Math.floor((r.width - 16) / cell.w));
  const rows = Math.max(6, Math.floor((r.height - 12) / cell.h));
  if (pane.size && pane.size.columns === columns && pane.size.rows === rows) return;
  pane.size = { columns, rows };
  clearTimeout(pane.fitTimer);
  // While the window is being dragged larger, the app redraws once it stops.
  pane.fitTimer = setTimeout(() => post('resize', { id: pane.id, columns, rows }), pane.sentOnce ? 80 : 0);
  pane.sentOnce = true;
}

function renderCover(id) {
  const pane = state.panes.get(id);
  const s = byId(id);
  if (!pane || !s) return;
  const what = s.state === 'running' ? '' : s.state === 'exited' ? `exited${s.code != null ? ` with ${s.code}` : ''}` : 'starting…';
  $('.state', pane.el).textContent = what;
  pane.screen.classList.toggle('mouse', Boolean(s.mouse));
  let cover = $('.cover', pane.screen);
  if (s.state !== 'exited') return cover?.remove();
  if (!cover) {
    cover = document.createElement('div');
    cover.className = 'cover';
    pane.screen.append(cover);
  }
  cover.innerHTML = `<div class="card"><h2>${esc(s.title)} exited${s.code != null && s.code !== 0 ? ` with ${esc(s.code)}` : ''}</h2>
    <p>↵ or the button starts it again.</p>${s.stderr ? `<pre>${esc(s.stderr.trim().split('\n').slice(-30).join('\n'))}</pre>` : ''}
    <button type="button" class="btn primary">Start ${esc(s.title)} again</button></div>`;
  $('button', cover).addEventListener('click', () => post('restart', { id }));
}

// ---- drawing the screens -------------------------------------------------------------------------

const cell = { w: 8.4, h: 18 };

function measure() {
  const m = $('#measure');
  const w = m.getBoundingClientRect().width / m.textContent.length;
  const size = parseFloat(getComputedStyle(m).fontSize) || 14;
  cell.w = w || 8.4;
  cell.h = Math.round(size * 1.32);
  document.documentElement.style.setProperty('--cw', `${cell.w}px`);
  document.documentElement.style.setProperty('--ch', `${cell.h}px`);
  document.documentElement.style.setProperty('--lw', `${Math.max(1, Math.round(size / 14))}px`);
}

function applyFrame(f) {
  let screen = state.screens.get(f.id);
  if (!screen || f.whole || screen.columns !== f.columns || screen.height !== f.height) {
    screen = { columns: f.columns, height: f.height, rows: screen && !f.whole && screen.height === f.height ? screen.rows : [], cursor: null };
    if (f.whole) screen.rows = [];
    state.screens.set(f.id, screen);
  }
  for (const [y, runs] of f.rows) screen.rows[y] = runs;
  screen.cursor = f.cursor;
  const pane = state.panes.get(f.id);
  if (!pane) return;
  if (f.whole) {
    pane.rowsEl.textContent = '';
    pane.rowEls = [];
  }
  for (const [y, runs] of f.rows) drawRow(pane, y, runs);
  // Rows past the screen's height (it got shorter) go.
  for (let y = f.height; y < pane.rowEls.length; y++) pane.rowEls[y]?.remove();
  pane.rowEls.length = Math.min(pane.rowEls.length, f.height);
  drawCursor(f.id);
}

function drawRow(pane, y, runs) {
  let row = pane.rowEls[y];
  if (!row) {
    row = document.createElement('div');
    row.className = 'row';
    row.style.top = `calc(${y} * var(--ch))`;
    pane.rowsEl.append(row);
    pane.rowEls[y] = row;
  }
  let html = '';
  for (const [x, text, style, cells] of runs) {
    const css = styleCss(style);
    if (cells === 2 || !hasBox(text)) {
      html += `<span class="r" style="--x:${x};--w:${cells};${css}">${esc(text)}</span>`;
      continue;
    }
    let at = x;
    for (const [part, box] of splitBoxes(text)) {
      const n = [...part].length;
      html += box ? `<span class="r bx ${box}" style="--x:${at};--w:1;${css}"></span>` : `<span class="r" style="--x:${at};--w:${n};${css}">${esc(part)}</span>`;
      at += n;
    }
  }
  row.innerHTML = html;
}

const BOX_RE = new RegExp(`[${Object.keys(BOX_CLASSES).join('')}]`);
const hasBox = (text) => BOX_RE.test(text);

function drawCursor(id) {
  const pane = state.panes.get(id);
  const c = state.screens.get(id)?.cursor;
  if (!pane) return;
  if (!c || !c.shown) {
    pane.cursorEl.hidden = true;
    return;
  }
  pane.cursorEl.hidden = false;
  pane.cursorEl.style.left = `calc(8px + ${c.x} * var(--cw))`;
  pane.cursorEl.style.top = `calc(6px + ${c.y} * var(--ch))`;
}

// ---- native views (the kit's GuiView: a chart where the app would draw one in text) ----------------

const VIEWS = {
  chart: (data, w, h) => chartSvg(data, w, h),
};

/** Draws a pane's native views, under its text: each at its cells, at the size those cells are now. */
function drawViews(id, pane = state.panes.get(id)) {
  if (!pane) return;
  const views = state.views.get(id) ?? new Map();
  let html = '';
  for (const [key, v] of views) {
    const draw = VIEWS[v.kind];
    if (!draw) continue;
    const w = Math.round(v.rect.width * cell.w);
    const h = Math.round(v.rect.height * cell.h);
    html += `<div class="view" data-key="${esc(key)}" style="left:calc(${v.rect.x} * var(--cw));top:calc(${v.rect.y} * var(--ch));width:${w}px;height:${h}px">${draw(v.data, w, h)}</div>`;
  }
  pane.viewsEl.innerHTML = html;
  pane.tipEl.hidden = true;
}

/** The read-out of the view under the pointer, if it has one there. */
function hoverViews(pane, ev) {
  const r = pane.viewsEl.getBoundingClientRect();
  const px = ev.clientX - r.left;
  const py = ev.clientY - r.top;
  for (const [key, v] of state.views.get(pane.id) ?? []) {
    if (v.kind !== 'chart') continue;
    const x0 = v.rect.x * cell.w;
    const y0 = v.rect.y * cell.h;
    const w = Math.round(v.rect.width * cell.w);
    const h = Math.round(v.rect.height * cell.h);
    if (px < x0 || py < y0 || px > x0 + w || py > y0 + h) continue;
    const hit = pointAt(v.data, w, h, px - x0, py - y0);
    if (!hit) break;
    pane.tipEl.hidden = false;
    pane.tipEl.innerHTML = hit.lines.map((l, i) => (i ? esc(l) : `<b>${esc(l)}</b>`)).join('<br>');
    // Beside the point, on whichever side has room in the pane.
    const room = pane.screen.getBoundingClientRect().width;
    const left = 8 + x0 + hit.x + 14;
    pane.tipEl.style.left = `${left + 240 > room ? Math.max(4, left - 270) : left}px`;
    pane.tipEl.style.top = `${6 + y0 + Math.max(0, hit.y - 10)}px`;
    pane.hoverKey = key;
    return;
  }
  pane.tipEl.hidden = true;
}

// ---- keys -------------------------------------------------------------------------------------------

const keys = $('#keys');

function focusKeys() {
  if (!state.drawer && $('#modal').hidden && !window.getSelection()?.toString()) keys.focus({ preventScroll: true });
}

const PREFIX_HINT = '1-8 or s t o b h k w l switch · | split · tab other pane · x one app · m move · r runbooks · f follow · space commands · ? keys';

function setPrefix(on) {
  state.prefix = on;
  const hint = $('#hint');
  hint.hidden = !on;
  hint.textContent = on ? `ctrl+]  ${PREFIX_HINT}` : '';
}

/** Fleet's own keys, after ctrl+] (the same as in the terminal). True when the key was one. */
function prefixKey(e) {
  setPrefix(false);
  const k = e.key;
  if (e.ctrlKey && k === ']') {
    send(state.active, '\x1d');
    return true;
  }
  const i = Number(k);
  if (i >= 1 && i <= state.spaces.length) return switchTo(state.spaces[i - 1].id), true;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  const space = state.spaces.find((s) => s.letter === lower);
  if (space) return switchTo(space.id), true;
  if (k === '|' || k === '\\') return toggleSplit(), true;
  if (lower === 'x') return state.shown.length === 2 && show([state.active]), true;
  if (k === 'Tab' || k === 'ArrowLeft' || k === 'ArrowRight') return otherPane(), true;
  if (k === ']' || lower === 'n') return move(1), true;
  if (lower === 'p') return move(-1), true;
  if (lower === 'm') return openMove(), true;
  if (lower === 'r') return openDrawer('runbooks'), true;
  if (lower === 'f') return openDrawer('trace'), true;
  if (k === ' ') return openPalette(), true;
  if (k === '?') return openHelp(), true;
  return true;
}

function move(by) {
  const i = state.spaces.findIndex((s) => s.id === state.active);
  switchTo(state.spaces[(i + by + state.spaces.length) % state.spaces.length].id);
}

/**
 * Whether a key event is the app's: typed into the hidden key field, or anywhere in the page but a
 * field of Fleet's own (a drawer's, a dialog's). A click on a screen leaves the page itself focused
 * for a moment, and a key typed then still goes to the app.
 */
const forApp = (e) => {
  if (!$('#modal').hidden) return false;
  const t = e.target;
  if (t === keys) return true;
  return !(t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName)));
};

document.addEventListener('keydown', (e) => {
  if (!forApp(e)) return;
  if (e.isComposing || e.key === 'Process') return;
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
  if (state.prefix) {
    e.preventDefault();
    prefixKey(e);
    return;
  }
  if (e.ctrlKey && !e.altKey && e.key === ']') {
    e.preventDefault();
    setPrefix(true);
    return;
  }
  // alt+1 to alt+8 switch, as in the terminal.
  if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
    const s = state.spaces[Number(e.code.slice(5)) - 1];
    if (s) {
      e.preventDefault();
      switchTo(s.id);
      return;
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    openPalette();
    return;
  }
  // Pasting is the paste event's; copying what the mouse selected in the page is the browser's.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
  if ((e.metaKey || (e.ctrlKey && e.shiftKey)) && e.key.toLowerCase() === 'c' && window.getSelection()?.toString()) return;
  const data = keyBytes(e);
  if (data == null) return;
  e.preventDefault();
  send(state.active, data);
});

document.addEventListener('paste', (e) => {
  if (!forApp(e)) return;
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text) send(state.active, text.replace(/\r\n/g, '\r').replace(/\n/g, '\r'));
});

// What a keyboard composes (accents, IME) arrives as text rather than keys.
keys.addEventListener('input', (e) => {
  if (e.inputType === 'insertText' || e.inputType === 'insertCompositionText' || e.inputType === 'insertFromComposition') {
    if (!e.isComposing && keys.value) send(state.active, keys.value);
  }
  if (!e.isComposing) keys.value = '';
});
keys.addEventListener('compositionend', () => {
  if (keys.value) send(state.active, keys.value);
  keys.value = '';
});

window.addEventListener('focus', () => document.body.classList.remove('blurred'));
window.addEventListener('blur', () => document.body.classList.add('blurred'));
document.addEventListener('mouseup', () => setTimeout(focusKeys, 0));

// ---- the mouse ------------------------------------------------------------------------------------

function wireMouse(pane) {
  const at = (ev) => {
    const r = pane.rowsEl.getBoundingClientRect();
    const screen = state.screens.get(pane.id);
    const x = Math.max(0, Math.min((screen?.columns ?? 1) - 1, Math.floor((ev.clientX - r.left) / cell.w)));
    const y = Math.max(0, Math.min((screen?.height ?? 1) - 1, Math.floor((ev.clientY - r.top) / cell.h)));
    return { x, y };
  };
  const wants = () => Boolean(byId(pane.id)?.mouse);
  let held = null;
  pane.screen.addEventListener('mousedown', (ev) => {
    // An app without the mouse leaves it to the page: dragging selects its text.
    if (!wants() || ev.button > 2) return;
    ev.preventDefault();
    held = ev.button;
    const { x, y } = at(ev);
    send(pane.id, mouseBytes({ kind: 'down', button: ev.button, x, y, shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey }));
    focusKeys();
  });
  pane.screen.addEventListener('mousemove', (ev) => {
    hoverViews(pane, ev);
    if (!wants() || held == null) return;
    const { x, y } = at(ev);
    const key = `${x},${y}`;
    if (key === pane.lastMove) return;
    pane.lastMove = key;
    send(pane.id, mouseBytes({ kind: 'move', button: held, x, y }));
  });
  window.addEventListener('mouseup', (ev) => {
    if (held == null || !wants()) return (held = null);
    const { x, y } = at(ev);
    send(pane.id, mouseBytes({ kind: 'up', button: held, x, y }));
    held = null;
  });
  pane.screen.addEventListener(
    'wheel',
    (ev) => {
      if (!wants()) return;
      ev.preventDefault();
      const { x, y } = at(ev);
      send(pane.id, mouseBytes({ kind: 'wheel', deltaY: ev.deltaY, x, y }));
    },
    { passive: false },
  );
  pane.screen.addEventListener('mouseleave', () => {
    pane.tipEl.hidden = true;
  });
  pane.screen.addEventListener('contextmenu', (ev) => {
    if (wants()) ev.preventDefault();
  });
}

// ---- the clipboard, the bell, notifications --------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    focusKeys();
    return ok;
  }
}

function bell(id) {
  const btn = $(`.space[data-id="${id}"]`);
  btn?.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 180 });
}

function notify(title, body, id, { always = true } = {}) {
  const s = byId(id);
  toast(`<b>${esc(title)}</b>${body ? `<br>${esc(body)}` : ''}`, { html: true, app: s?.accent, onClick: id ? () => switchTo(id) : null });
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' && (always || document.hidden)) {
    const n = new Notification(title, { body, icon: id ? `logo/${id}.svg` : 'logo/fleet.svg', tag: id });
    n.onclick = () => {
      window.focus();
      if (id) switchTo(id);
    };
  } else if (Notification.permission === 'default' && !state.askedNotify) {
    state.askedNotify = true;
    toast('Fleet can tell you when an app needs you, even with the window in the background.', {
      button: 'Turn on notifications',
      onButton: () => Notification.requestPermission(),
    });
  }
}

function toast(text, { html = false, app, onClick, button, onButton, ms = 5000 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (app) el.style.setProperty('--app', app);
  el.innerHTML = html ? text : esc(text);
  if (button) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = button;
    b.addEventListener('click', () => {
      onButton?.();
      el.remove();
    });
    el.append(document.createElement('br'), b);
  }
  if (onClick) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      onClick();
      el.remove();
    });
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), button ? ms * 3 : ms);
}

// ---- drawers: runbooks and following a request -------------------------------------------------------

function openDrawer(kind) {
  if (state.drawer === kind) return closeDrawer();
  state.drawer = kind;
  const d = $('#drawer');
  d.hidden = false;
  renderRail();
  if (kind === 'runbooks') renderRunbooks();
  else renderTrace();
}

function closeDrawer() {
  state.drawer = null;
  $('#drawer').hidden = true;
  renderRail();
  focusKeys();
}

function drawerFrame(title, body) {
  const d = $('#drawer');
  d.innerHTML = `<header><h2>${esc(title)}</h2><button type="button" title="Close (esc)">✕</button></header><div class="body">${body}</div>`;
  $('header button', d).addEventListener('click', closeDrawer);
  return $('.body', d);
}

async function renderRunbooks() {
  const body = drawerFrame('Runbooks', '<p class="muted">Reading the runbooks…</p>');
  const { runbooks = [] } = await post('runbooks');
  if (state.drawer !== 'runbooks') return;
  const open = state.runbookOpen && runbooks.find((r) => r.file === state.runbookOpen);
  if (open) return renderRunbook(open);
  body.innerHTML = `${
    runbooks.length
      ? runbooks.map((r, i) => `<div class="item" data-i="${i}"><b>${esc(r.title)}</b><span class="muted">${r.steps.length} step${r.steps.length === 1 ? '' : 's'} · ${esc(r.where)}${r.done.length ? ` · ${r.done.length} handed over` : ''}</span></div>`).join('')
      : '<p class="muted">No runbooks yet. A runbook is a Markdown file in <span class="mono">.fleet/runbooks/</span>: each line in a code block named after an app (<span class="mono">```trawl</span>) is a step for that app\'s prompt.</p>'
  }<button type="button" class="btn" data-act="draft">Draft one from the last hour</button>`;
  body.querySelectorAll('.item').forEach((el) =>
    el.addEventListener('click', () => {
      state.runbookOpen = runbooks[Number(el.dataset.i)].file;
      renderRunbook(runbooks[Number(el.dataset.i)]);
    }),
  );
  $('[data-act="draft"]', body).addEventListener('click', async () => {
    const r = await post('runbook-draft');
    toast(r.ok ? `Drafted ${r.file}` : r.error);
    renderRunbooks();
  });
}

function renderRunbook(book) {
  const done = new Set(book.done);
  const next = book.steps.findIndex((_, i) => !done.has(i));
  const body = drawerFrame(book.title, '');
  body.innerHTML = `<button type="button" class="btn" data-act="back">← All runbooks</button>${book.steps
    .map((st, i) => {
      const s = byId(st.app);
      return `<div class="step${done.has(i) ? ' done' : ''}${i === next ? ' next' : ''}" style="--app:${s?.accent ?? 'var(--accent)'}">
        ${st.prose ? `<div class="prose">${esc(st.prose)}</div>` : ''}
        <div class="line"><span class="chip">${esc(s?.title ?? st.app)}</span><code>${esc(st.line)}</code>
        <button type="button" class="btn${i === next ? ' primary' : ''}" data-i="${i}">${done.has(i) ? '✓ Again' : 'Hand over'}</button></div></div>`;
    })
    .join('')}${book.outro ? `<p class="muted" style="white-space:pre-wrap">${esc(book.outro)}</p>` : ''}`;
  $('[data-act="back"]', body).addEventListener('click', () => {
    state.runbookOpen = null;
    renderRunbooks();
  });
  body.querySelectorAll('[data-i]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await post('runbook-step', { file: book.file, index: Number(b.dataset.i) });
      if (!r.ok) return toast(r.error);
      renderRunbook({ ...book, done: r.done });
    }),
  );
}

async function renderTrace(result) {
  const last = result ? null : await post('trace-last');
  const body = drawerFrame('Follow a request', '');
  body.innerHTML = `<p class="muted">A request, operation or trace id. Fleet types a search for it into every running app that reads logs (Sonar, Hail, Bosun, Wharf); ↵ in each one runs it.</p>
    <form><input class="field" name="rid" placeholder="req-42abc" value="${esc(result?.id ?? last?.id ?? '')}"></form>
    <div class="out"></div>`;
  const form = $('form', body);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = form.elements.rid.value.trim();
    if (!id) return;
    const r = await post('trace', { id });
    if (!r.ok) return toast(r.error);
    renderTrace({ id, ...r });
  });
  if (!result) return setTimeout(() => form.elements.rid.focus(), 0);
  const out = $('.out', body);
  out.innerHTML = `<p>${
    result.asked.length
      ? `Asked ${result.asked.map((a) => `<span class="chip" style="--app:${byId(a)?.accent}" data-go="${a}">${esc(byId(a)?.title ?? a)}</span>`).join(' ')}: click one to see it.`
      : '<span class="muted">None of the apps that read logs is running.</span>'
  }</p>${
    result.timeline.length
      ? `<table class="timeline">${result.timeline
          .map((t) => `<tr><td class="t">${new Date(t.at).toLocaleTimeString()}</td><td><span class="chip" style="--app:${byId(t.app)?.accent}">${esc(byId(t.app)?.title ?? t.app)}</span></td><td>${esc(t.text)}<div class="muted">${esc(t.source)}</div></td></tr>`)
          .join('')}</table>`
      : '<p class="muted">Nothing in the family\'s activity or Bosun\'s recordings mentions it.</p>'
  }`;
  out.querySelectorAll('[data-go]').forEach((c) => c.addEventListener('click', () => switchTo(c.dataset.go)));
}

// ---- dialogs: moving the fleet, the palette, the keys --------------------------------------------------

function openModal(html) {
  const modal = $('#modal');
  $('#modal-box').innerHTML = html;
  modal.hidden = false;
  return $('#modal-box');
}

function closeModal() {
  $('#modal').hidden = true;
  focusKeys();
}

$('#modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') closeModal();
});

function openMove(folder = state.cwd, title = 'Move the fleet') {
  const box = openModal(`<h2>${esc(title)}</h2><div class="body"><p class="muted">Every running app starts again in the folder; the others will start there. Tab completes a folder's name.</p>
    <form><input class="field" name="folder" value="${esc(folder)}"></form><div class="choices"></div></div>`);
  const form = $('form', box);
  const input = form.elements.folder;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') return closeModal();
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const r = await post('folders', { text: input.value });
    input.value = r.text;
    $('.choices', box).innerHTML = r.choices.length > 1 ? r.choices.map((c) => `<div class="choice mono">${esc(c)}</div>`).join('') : '';
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await post('move', { folder: input.value });
    if (!r.ok) return toast(r.error);
    closeModal();
  });
}

function commands() {
  const list = state.spaces.map((s, i) => ({ name: `${s.title}`, hint: `alt+${i + 1}`, app: s, run: () => switchTo(s.id) }));
  list.push(
    { name: state.shown.length === 2 ? 'One app on screen' : 'Split: two apps side by side', hint: 'ctrl+] |', run: toggleSplit },
    ...state.spaces.filter((s) => !state.shown.includes(s.id)).map((s) => ({ name: `Split with ${s.title}`, run: () => show([state.active, s.id]) })),
    { name: 'Runbooks', hint: 'ctrl+] r', run: () => openDrawer('runbooks') },
    { name: 'Follow a request across the apps', hint: 'ctrl+] f', run: () => openDrawer('trace') },
    { name: 'Move the fleet to another folder', hint: 'ctrl+] m', run: () => openMove() },
    { name: `Start ${byId(state.active)?.title ?? 'the app'} again`, run: () => post('restart', { id: state.active }) },
    { name: 'Turn on notifications', run: () => 'Notification' in window && Notification.requestPermission() },
    { name: 'Keys', hint: 'ctrl+] ?', run: openHelp },
  );
  return list;
}

function openPalette() {
  const all = commands();
  const box = openModal('<div class="body"><input class="field" placeholder="An app, or what to do…"><div class="choices"></div></div>');
  const input = $('input', box);
  const list = $('.choices', box);
  let sel = 0;
  let shown = all;
  const draw = () => {
    const q = input.value.toLowerCase().trim();
    shown = q ? all.filter((c) => q.split(/\s+/).every((w) => c.name.toLowerCase().includes(w))) : all;
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.innerHTML = shown
      .map((c, i) => `<div class="choice${i === sel ? ' sel' : ''}" data-i="${i}">${c.app ? `<img src="logo/${c.app.id}.svg" alt="" style="width:18px;height:18px;border-radius:4px">` : ''}<span class="grow">${esc(c.name)}</span><span class="k">${esc(c.hint ?? '')}</span></div>`)
      .join('');
    list.querySelectorAll('.choice').forEach((el) => el.addEventListener('click', () => run(Number(el.dataset.i))));
  };
  const run = (i) => {
    const c = shown[i];
    closeModal();
    c?.run();
  };
  input.addEventListener('input', () => {
    sel = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeModal();
    if (e.key === 'ArrowDown') sel = Math.min(shown.length - 1, sel + 1);
    else if (e.key === 'ArrowUp') sel = Math.max(0, sel - 1);
    else if (e.key === 'Enter') return run(sel);
    else return;
    e.preventDefault();
    draw();
  });
  draw();
  input.focus();
}

function openHelp() {
  const rows = [
    ['alt+1 … alt+8', 'Switch to that app'],
    ['ctrl+] then 1-8 or a letter', 'Switch to that app (s t o b h k w l)'],
    ['ctrl+] |', 'Two apps side by side, or one again'],
    ['ctrl+] tab', 'The other pane'],
    ['ctrl+] x', 'One app on screen'],
    ['ctrl+] n / p', 'The next app, the one before'],
    ['ctrl+] m', 'Move the fleet to another folder'],
    ['ctrl+] r', 'Runbooks'],
    ['ctrl+] f', 'Follow a request across the apps'],
    ['ctrl+shift+p', 'Everything Fleet does'],
    ['ctrl+] ctrl+]', 'Send ctrl+] to the app'],
    ['everything else', 'Goes to the app with the keys, as in a terminal: the apps\' own ? lists theirs'],
    ['the mouse', 'An app with the mouse on gets clicks, drags and the wheel; in one without, dragging selects text (ctrl+shift+c copies it)'],
  ];
  const box = openModal(`<h2>Keys</h2><div class="body"><table class="keys">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table><button type="button" class="btn">Close</button></div>`);
  $('button', box).addEventListener('click', closeModal);
  $('button', box).focus();
}

// ---- wiring ---------------------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) {
    e.preventDefault();
    closeModal();
  } else if (state.drawer && document.activeElement !== keys) {
    e.preventDefault();
    closeDrawer();
  }
});

$('#spaces').addEventListener('click', (e) => {
  const btn = e.target.closest('.space');
  if (!btn) return;
  // ctrl- or cmd-click puts it beside the app on screen.
  if (e.ctrlKey || e.metaKey) show([state.active, btn.dataset.id]);
  else switchTo(btn.dataset.id);
});

$('#tools').addEventListener('click', (e) => {
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (tool === 'split') toggleSplit();
  else if (tool === 'runbooks' || tool === 'trace') openDrawer(tool);
  else if (tool === 'palette') openPalette();
  else if (tool === 'help') openHelp();
  else if (tool === 'move') openMove();
});

// Fleet Desktop's menu (desktop/preload.cjs): the same tools, by name.
window.fleetDesktop?.onCommand(({ name, arg }) => {
  if (name === 'palette') openPalette();
  else if (name === 'split') toggleSplit();
  else if (name === 'runbooks' || name === 'trace') openDrawer(name);
  else if (name === 'help') openHelp();
  else if (name === 'switch') switchTo(arg);
  else if (name === 'move') post('move', { folder: arg }).then((r) => !r.ok && toast(r.error));
});

window.addEventListener('resize', () => {
  for (const pane of state.panes.values()) {
    fit(pane);
    drawViews(pane.id, pane);
  }
});

(document.fonts?.ready ?? Promise.resolve()).then(() => {
  measure();
  connect();
});
