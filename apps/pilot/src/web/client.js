// The UI in the browser: one function, sent as its source inside the page (page.js), so it must not
// use anything from outside itself. Hash routes (#/pages, #/page/<view>, #/graph/<node>, …) pick the
// view; everything is read from the JSON API (server.js). Text from the project is only ever set as
// text, never as HTML.
export function client(BOOT) {
  const $app = document.getElementById('app');
  const TYPES = {
    view: ['View', 'var(--t-view)'], partial: ['Partial', 'var(--t-partial)'], layout: ['Layout', 'var(--t-layout)'], action: ['Action', 'var(--t-action)'],
    script: ['Script', 'var(--t-script)'], style: ['Style', 'var(--t-style)'], bundle: ['Bundle', 'var(--t-bundle)'], cs: ['C#', 'var(--t-cs)'],
    config: ['Config', 'var(--t-config)'], missing: ['Missing', 'var(--t-missing)'], project: ['Project', 'var(--t-config)'],
  };
  const EDGES = {
    layout: '#8b5cf6', partial: '#0ea5b7', template: '#14b8a6', component: '#10b981', 'component-class': '#2f9e44', 'child-action': '#f08c00',
    renders: '#f59f00', 'renders-partial': '#fab005', script: '#c9a227', style: '#e64980', import: '#868e96', source: '#adb5bd', calls: '#e03131', link: '#94a3b8',
  };
  const DEFAULT_KINDS = Object.keys(EDGES).filter((k) => k !== 'link');
  const state = { theme: localGet('pilot.theme'), graph: { depth: 2, mode: 'layered', kinds: new Set(localGet('pilot.kinds')?.split(',') ?? DEFAULT_KINDS), vendor: false } };
  if (state.theme) document.documentElement.dataset.theme = state.theme;

  function localGet(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  function localSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private window */
    }
  }

  // ─── DOM helpers ──────────────────────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  /** An element's children replaced, nested arrays flattened and empty ones left out. */
  function put(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
    return el;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) if (v != null) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const api = async (path, params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    const res = await fetch(`${path}${q.toString() ? `?${q}` : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? res.statusText);
    return data;
  };
  const go = (hash) => {
    location.hash = hash;
  };
  const enc = encodeURIComponent;
  const base = (p) => String(p ?? '').split('/').pop();
  const color = (type) => (TYPES[type] ?? TYPES.config)[1];
  const typeName = (type) => (TYPES[type] ?? [type])[0];
  const scoreColor = (n) => (n < 30 ? 'var(--good)' : n < 55 ? '#d4a017' : n < 75 ? 'var(--warn)' : 'var(--bad)');
  const loading = () => h('div', { class: 'loading' }, 'Loading…');
  const fail = (e) => h('div', { class: 'empty' }, `Couldn't load: ${e.message}`);

  /** A `file:line` that opens the source drawer. */
  function loc(file, line, label) {
    if (!file) return h('span', { class: 'faint' }, '—');
    return h('a', { class: 'mono', title: `${file}${line ? `:${line}` : ''}`, onclick: (ev) => { ev.preventDefault(); openSource(file, line); } }, label ?? `${file}${line ? `:${line}` : ''}`);
  }
  /** A node, coloured by its type, that goes to its graph (and its page, for views and actions). */
  function nodeChip(n, { graph = true } = {}) {
    const type = n.type ?? 'config';
    return h('span', { class: 'chip', title: n.id ?? n.file ?? '' },
      h('i', { class: 'dot', style: { background: color(type) } }),
      h('a', { onclick: () => (graph ? go(`#/graph/${enc(n.id ?? n.file)}`) : openSource(n.file, n.line)) }, n.label ?? base(n.file ?? n.id)),
      n.sub ? h('span', { class: 'faint' }, n.sub) : null);
  }
  function scoreBar(score) {
    return h('span', { class: 'score' }, h('b', {}, score), h('span', { class: 'bar', style: { flex: '1' } }, h('i', { style: { width: `${score}%`, background: scoreColor(score) } })));
  }
  function gauge(score, level) {
    const r = 30;
    const c = 2 * Math.PI * r;
    return h('div', { class: 'page-head' },
      (() => {
        const svg = s('svg', { viewBox: '0 0 76 76', class: 'gauge' },
          s('circle', { cx: 38, cy: 38, r, fill: 'none', stroke: 'var(--panel2)', 'stroke-width': 8 }),
          s('circle', { cx: 38, cy: 38, r, fill: 'none', stroke: scoreColor(score), 'stroke-width': 8, 'stroke-dasharray': `${(c * score) / 100} ${c}`, transform: 'rotate(-90 38 38)', 'stroke-linecap': 'round' }),
          s('text', { x: 38, y: 43, 'text-anchor': 'middle', 'font-size': 18, 'font-weight': 650, fill: 'var(--text)' }, score));
        return svg;
      })(),
      h('div', {}, h('b', {}, `Complexity: ${level}`), h('div', { class: 'dim' }, 'Scored on the page\'s own views, scripts, widgets and requests')));
  }

  // ─── The frame ────────────────────────────────────────────────────────────────────────────
  const NAV = [['overview', 'Overview'], ['pages', 'Pages'], ['graph', 'Graph'], ['components', 'Components'], ['styles', 'Stylesheets'], ['selectors', 'Selectors'], ['problems', 'Problems']];
  const searchBox = h('input', { type: 'search', placeholder: 'Find a page, view, action, class…', 'aria-label': 'Find' });
  const results = h('div', { class: 'results', hidden: true });
  const navEl = h('nav');
  const mainEl = h('main');
  const drawerEl = h('div');
  const head = h('header', {},
    h('div', { class: 'brand' }, h('span', {}, '☸ Pilot'), h('small', { title: BOOT.root }, BOOT.root)),
    navEl, h('div', { class: 'grow' }),
    h('div', { class: 'search' }, searchBox, results),
    h('button', { title: 'Read the project again', onclick: async (ev) => { ev.target.disabled = true; try { await api('/api/refresh'); route(); } finally { ev.target.disabled = false; } } }, 'Re-index'),
    h('button', { title: 'Light or dark', onclick: () => {
      const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'light' : 'dark';
      localSet('pilot.theme', document.documentElement.dataset.theme);
    } }, '◐'));
  $app.append(head, mainEl, drawerEl);

  let searchTimer = null;
  let found = [];
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = searchBox.value.trim();
      if (!q) return (results.hidden = true);
      const data = await api('/api/find', { q }).catch(() => ({ results: [] }));
      found = data.results;
      put(results, ...(found.length ? found.map((r, i) => h('div', { class: i === 0 ? 'on' : '', onclick: () => pick(r) }, h('span', { class: 'pill' }, r.kind), h('b', {}, r.name), h('span', { class: 'faint mono' }, r.place === r.name ? '' : r.place))) : [h('div', { class: 'faint' }, 'Nothing found')]));
      results.hidden = false;
    }, 160);
  });
  searchBox.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && found[0]) pick(found[0]);
    if (ev.key === 'Escape') results.hidden = true;
  });
  document.addEventListener('click', (ev) => {
    if (!results.contains(ev.target) && ev.target !== searchBox) results.hidden = true;
  });
  function pick(r) {
    results.hidden = true;
    searchBox.value = '';
    if (r.kind === 'class' || r.kind === 'id') return go(`#/selectors/${enc(r.name)}`);
    if (r.kind === 'style variable' || r.kind === 'mixin') return openSource(r.place.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(r.place)?.[1]));
    if (r.kind === 'action') return go(`#/page/${enc(r.name)}`);
    if (r.kind === 'view') return go(`#/page/${enc(r.name)}`);
    if (/^(style|script|cs|config|bundle|view component|controller)/.test(r.kind)) return go(`#/graph/${enc(r.place.replace(/:\d+$/, ''))}`);
    openSource(r.place.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(r.place)?.[1]));
  }

  // ─── Source drawer ────────────────────────────────────────────────────────────────────────
  async function openSource(file, line, { all = false } = {}) {
    put(drawerEl, h('div', { class: 'drawer' }, loading()));
    try {
      const d = await api('/api/source', { file, line, all: all ? 1 : '' });
      if (d.error) throw new Error(d.error);
      const close = () => put(drawerEl);
      const code = h('div', { class: 'code' }, d.lines.map((t, i) => h('div', { class: d.start + i === d.line ? 'hl' : '' }, h('span', { class: 'n' }, d.start + i), t)));
      put(drawerEl, h('div', { class: 'drawer' },
        h('header', {}, h('b', { class: 'mono' }, `${d.file}${d.line ? `:${d.line}` : ''}`), h('div', { class: 'grow' }),
          h('button', { onclick: () => navigator.clipboard?.writeText(`${d.file}${d.line ? `:${d.line}` : ''}`) }, 'Copy path'),
          d.lines.length < d.total ? h('button', { onclick: () => openSource(file, line, { all: true }) }, `Whole file (${d.total})`) : null,
          h('button', { onclick: () => go(`#/graph/${enc(d.file)}`) }, 'Graph'),
          h('button', { onclick: close, 'aria-label': 'Close' }, '✕')),
        code));
      const hl = code.querySelector('.hl');
      if (hl) hl.scrollIntoView({ block: 'center' });
    } catch (e) {
      put(drawerEl, h('div', { class: 'drawer' }, h('header', {}, h('div', { class: 'grow' }), h('button', { onclick: () => put(drawerEl) }, '✕')), fail(e)));
    }
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') put(drawerEl);
  });

  // ─── Routing ──────────────────────────────────────────────────────────────────────────────
  async function route() {
    const [, name = 'overview', ...rest] = location.hash.replace(/^#/, '').split('/');
    const arg = decodeURIComponent(rest.join('/'));
    put(navEl, ...NAV.map(([k, label]) => h('a', { href: `#/${k}`, class: k === name || (name === 'page' && k === 'pages') ? 'on' : '' }, label)));
    mainEl.className = name === 'graph' ? 'full' : '';
    put(mainEl, loading());
    const views = { overview: viewOverview, pages: viewPages, page: viewPage, graph: viewGraph, components: viewComponents, styles: viewStyles, selectors: viewSelectors, problems: viewProblems };
    try {
      await (views[name] ?? viewOverview)(arg);
    } catch (e) {
      put(mainEl, fail(e));
    }
  }
  window.addEventListener('hashchange', route);

  // ─── Overview ─────────────────────────────────────────────────────────────────────────────
  async function viewOverview() {
    const [o, pages, w, st] = await Promise.all([api('/api/overview'), api('/api/pages'), api('/api/widgets'), api('/api/stylesheets')]);
    const c = o.counts;
    const stat = (n, label, href) => h('div', { class: 'card stat', style: { cursor: href ? 'pointer' : '' }, onclick: href ? () => go(href) : null }, h('b', {}, n), h('span', {}, label));
    put(mainEl, 
      h('h1', {}, 'Overview'),
      h('div', { class: 'cards' },
        stat(pages.pages.length, 'pages', '#/pages'), stat(c.views, 'views'), stat(c.partials, 'partials'), stat(c.layouts, 'layouts'),
        stat(c.actions, `actions in ${c.controllers} controllers`), stat(c.typescript + c.javascript, `scripts (${c.typescript} TS)`),
        stat(c.less + c.scss + c.css, 'stylesheets', '#/styles'), stat(w.kinds.reduce((n, k) => n + k.count, 0), 'widgets', '#/components'),
        stat(c.bundles, 'bundles'), stat(c.problems, 'unresolved', '#/problems')),
      h('div', { class: 'cols', style: { marginTop: '14px' } },
        h('div', { class: 'card' }, h('h3', {}, 'Most complex pages'), pageTable(pages.pages.slice(0, 12), { compact: true }), h('a', { href: '#/pages' }, 'All pages →')),
        h('div', { class: 'card' },
          h('h3', {}, 'Layouts'), ...o.layouts.map((l) => h('div', { class: 'flow', style: { padding: '4px 0' } }, nodeChip({ id: l.file, type: 'layout', label: base(l.file), sub: `${l.views} views` }))),
          h('h3', {}, 'Components'), h('div', { class: 'flow' }, ...w.kinds.map((k) => h('a', { class: 'chip', onclick: () => go(`#/components/${enc(k.kind)}`) }, `${k.kind} · ${k.count}`))),
          h('h3', {}, 'Largest stylesheets'), ...st.stylesheets.slice(0, 6).map((x) => h('div', { class: 'flow', style: { padding: '3px 0' } }, h('a', { onclick: () => go(`#/styles/${enc(x.file)}`), class: 'mono' }, x.file), h('span', { class: 'faint' }, `${x.lines} lines`))))),
      h('p', { class: 'faint' }, `${o.root} · ${o.projects.join(', ')} · indexed ${o.index.files} files in ${o.index.ms} ms · Pilot ${BOOT.version}`));
  }

  // ─── Pages ────────────────────────────────────────────────────────────────────────────────
  function pageTable(rows, { compact = false } = {}) {
    const cols = compact
      ? [['score', 'Score'], ['url', 'URL'], ['view', 'View']]
      : [['score', 'Score'], ['url', 'URL'], ['label', 'Action'], ['view', 'View'], ['views', 'Views'], ['depth', 'Depth'], ['scriptLines', 'Script lines'], ['widgets', 'Widgets'], ['requests', 'Requests']];
    const tbody = h('tbody');
    let sort = ['score', -1];
    const val = (r, k) => (r.metrics && k in r.metrics && k !== 'score' ? r.metrics[k] : r[k]);
    const fill = () => {
      const sorted = [...rows].sort((a, b) => {
        const x = val(a, sort[0]);
        const y = val(b, sort[0]);
        return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sort[1];
      });
      put(tbody, ...sorted.map((r) => h('tr', { class: 'click', onclick: () => go(`#/page/${enc(r.view)}`) }, cols.map(([k]) => h('td', {}, k === 'score' ? scoreBar(r.score) : k === 'view' ? h('span', { class: 'mono' }, compact ? base(r.view) : r.view) : k === 'url' ? h('span', { class: 'mono' }, r.url) : val(r, k))))));
    };
    fill();
    return h('table', { class: compact ? '' : 'sticky' }, h('thead', {}, h('tr', {}, cols.map(([k, label]) => h('th', { onclick: () => { sort = [k, sort[0] === k ? -sort[1] : -1]; fill(); } }, label)))), tbody);
  }
  async function viewPages() {
    const data = await api('/api/pages');
    const box = h('div', { class: 'card' });
    const filter = h('input', { type: 'search', placeholder: 'Filter by URL, action or view', style: { width: '320px' } });
    const draw = () => {
      const q = filter.value.toLowerCase();
      put(box, pageTable(data.pages.filter((p) => !q || `${p.url} ${p.label} ${p.view}`.toLowerCase().includes(q))));
    };
    filter.addEventListener('input', draw);
    draw();
    const levels = ['simple', 'moderate', 'complex', 'very complex'].map((l) => [l, data.pages.filter((p) => p.level === l).length]);
    put(mainEl, h('h1', {}, `Pages (${data.pages.length}), average complexity ${data.average}`),
      h('div', { class: 'toolbar' }, filter, ...levels.map(([l, n]) => h('span', { class: 'pill' }, `${l}: ${n}`))), box);
  }

  // ─── A page ───────────────────────────────────────────────────────────────────────────────
  async function viewPage(target) {
    const data = await api('/api/page', { target });
    if (data.error) {
      put(mainEl, h('h1', {}, target), h('div', { class: 'empty' }, data.error === 'ambiguous' ? 'More than one file matches:' : 'Not found.'), ...(data.candidates ?? []).map((c) => h('div', {}, h('a', { onclick: () => go(`#/page/${enc(c)}`) }, c))));
      return;
    }
    const v = data.views[0];
    if (!v) {
      put(mainEl, h('h1', {}, target), h('div', { class: 'card' }, data.actions.map((a) => h('div', {}, h('b', {}, a.label), ' ', loc(a.at.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(a.at)?.[1])), a.json ? ' → JSON' : ''))));
      return;
    }
    const m = v.metrics;
    const tabsEl = h('div', { class: 'tabs' });
    const body = h('div');
    const TABS = [
      ['structure', 'Structure', () => structure(v)],
      ['requests', `Requests (${v.calls.length})`, () => requests(v)],
      ['components', `Components (${v.widgets.length})`, () => widgetList(v.widgets)],
      ['assets', `Scripts & styles (${v.assets.length})`, () => assets(v)],
      ['score', 'Score', () => scoreView(m)],
    ];
    const show = (key) => {
      put(tabsEl, ...TABS.map(([k, label]) => h('a', { class: k === key ? 'on' : '', onclick: () => show(k) }, label)));
      put(body, TABS.find(([k]) => k === key)[2]());
    };
    put(mainEl, 
      h('div', { class: 'page-head', style: { justifyContent: 'space-between' } },
        h('div', {},
          h('h1', { style: { margin: '0' } }, data.actions[0]?.url ?? v.view),
          h('div', { class: 'kv', style: { marginTop: '8px' } },
            ...data.actions.flatMap((a) => ['Action', h('span', {}, a.label, ' ', loc(a.at.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(a.at)?.[1])))]),
            'View', loc(v.view), ...(v.model ? ['Model', h('code', {}, v.model)] : []),
            'Layouts', v.layouts.length ? h('span', { class: 'flow' }, v.layouts.map((l) => loc(l.file))) : h('span', { class: 'faint' }, 'none'))),
        h('div', { class: 'page-head' }, gauge(m.score, m.level), h('button', { class: 'primary', onclick: () => go(`#/graph/${enc(v.view)}`) }, 'Graph'))),
      tabsEl, body);
    show('structure');
  }

  function structure(v) {
    const node = (n) => {
      const kids = h('div', { class: 'kids' }, n.children.map(node));
      const tg = h('span', { class: 'tg', onclick: () => { kids.hidden = !kids.hidden; tg.textContent = kids.hidden ? '▸' : '▾'; } }, n.children.length ? '▾' : '·');
      let label;
      if (n.type === 'body') label = [h('span', { class: 'pill' }, 'body'), loc(n.file)];
      else if (n.type === 'section') label = [h('span', { class: 'pill' }, `section ${n.name}`), loc(n.file, n.line)];
      else if (n.type === 'child-action') label = [h('span', { class: 'pill' }, 'child action'), nodeChip({ id: n.action, type: 'action', label: n.action.replace(/^action:/, '') }), h('span', { class: 'faint' }, '@ '), loc(n.from, n.line)];
      else if (n.type === 'root') label = [h('i', { class: 'dot', style: { background: color('layout') } }), loc(n.file)];
      else label = [h('i', { class: 'dot', style: { background: color(n.type === 'view' ? 'view' : 'partial') } }), h('span', { class: 'pill' }, n.type === 'view' ? 'view' : `${n.type}${n.name ? ` ${n.name}` : ''}`), loc(n.file), n.how === 'guess' ? h('span', { class: 'warn' }, 'guessed') : null, n.again ? h('span', { class: 'faint' }, '(again)') : null, n.from ? [h('span', { class: 'faint' }, '@'), loc(n.from, n.line, `${base(n.from)}:${n.line}`)] : null];
      return h('div', { class: n.own ? '' : 'layout-part' }, h('div', { class: 'row' }, tg, label), n.children.length ? kids : null);
    };
    return h('div', {},
      h('p', { class: 'dim' }, 'Outermost layout first; faded rows come from the layouts, the rest is this page\'s own. Click a file to read it.'),
      h('div', { class: 'card tree' }, node(v.root)),
      v.warnings.length ? h('div', { class: 'card warn', style: { marginTop: '10px' } }, v.warnings.map((w) => h('div', {}, w))) : null,
      v.dynamic.length ? h('div', { class: 'card', style: { marginTop: '10px' } }, h('h3', {}, 'Decided at run time'), v.dynamic.map((d) => h('div', {}, loc(d.file, d.line), ' ', h('code', {}, d.what)))) : null);
  }

  function requests(v) {
    if (!v.calls.length) return h('div', { class: 'empty' }, 'No requests found in this page\'s views or scripts.');
    return h('div', { class: 'list card' }, v.calls.map((c) => h('div', {},
      h('div', { class: 'flow' },
        loc(c.from, c.line, `${base(c.from)}:${c.line}`), h('span', { class: 'arrow' }, '→'),
        h('span', { class: 'pill' }, c.method ?? '?'), h('code', {}, c.request), h('span', { class: 'arrow' }, '→'),
        nodeChip({ id: c.action, type: 'action', label: c.label }), h('span', { class: 'arrow' }, '→'),
        c.returns.length ? c.returns.map((r) => nodeChip({ id: r.file, type: r.partial ? 'partial' : 'view', label: base(r.file) })) : h('span', { class: 'pill' }, c.json ? 'JSON' : c.redirects.length ? 'redirect' : 'no view'),
        c.target ? [h('span', { class: 'arrow' }, 'into'), h('code', {}, c.target), c.targetIn?.length ? loc(c.targetIn[0].replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(c.targetIn[0])?.[1]), base(c.targetIn[0])) : null] : null,
        c.own ? null : h('span', { class: 'pill' }, 'layout')),
      c.returns.some((r) => r.includes.length) ? h('div', { class: 'faint', style: { marginLeft: '12px' } }, 'which includes ', c.returns.flatMap((r) => r.includes).map((x) => loc(x, null, base(x)))) : null)));
  }

  function widgetList(list, { pages = false } = {}) {
    if (!list.length) return h('div', { class: 'empty' }, 'No components found.');
    return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Kind'), h('th', {}, 'Library'), h('th', {}, 'Bound to'), h('th', {}, 'Set up in'), pages ? h('th', {}, 'Pages') : null)),
      h('tbody', {}, list.map((w) => h('tr', {}, h('td', {}, h('b', {}, w.kind)), h('td', {}, w.lib), h('td', {}, w.target ? h('code', {}, w.target) : '', ' ', (w.boundTo ?? []).slice(0, 1).map((b) => loc(b.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(b)?.[1]), base(b)))),
        h('td', {}, loc(w.file, w.line)), pages ? h('td', {}, (w.pages ?? []).slice(0, 5).map((p) => h('span', { class: 'pill' }, p)), (w.pages ?? []).length > 5 ? ` +${w.pages.length - 5}` : '') : null))));
  }

  function assets(v) {
    const row = (a, i) => h('tr', {},
      h('td', { class: 'faint' }, i + 1),
      h('td', {}, a.external ? h('code', {}, a.url) : a.missing ? h('span', { class: 'warn' }, `${a.url} (not found)`) : loc(a.file), a.vendor ? h('span', { class: 'pill' }, 'library') : null, a.built ? h('span', { class: 'pill' }, 'built') : null),
      h('td', {}, (a.sources ?? []).map((x) => loc(x))),
      h('td', {}, a.bundle ? h('code', {}, a.bundle) : ''),
      h('td', {}, a.from ? loc(a.from.replace(/:\d+$/, ''), Number(/:(\d+)$/.exec(a.from)?.[1]), base(a.from)) : '', a.section ? h('span', { class: 'pill' }, a.section) : null));
    const table = (list) => h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Loads'), h('th', {}, 'Edit'), h('th', {}, 'Bundle'), h('th', {}, 'From'))), h('tbody', {}, list.map(row)));
    const imported = v.scripts.filter((x) => x.imported);
    return h('div', {},
      h('h2', {}, 'Styles, in order'), h('div', { class: 'card' }, table(v.assets.filter((a) => a.kind === 'style'))),
      h('h2', {}, 'Scripts, in order'), h('div', { class: 'card' }, table(v.assets.filter((a) => a.kind === 'script'))),
      imported.length ? [h('h2', {}, 'Brought in by imports'), h('div', { class: 'card flow' }, imported.map((x) => nodeChip({ id: x.file, type: 'script', label: base(x.file) })))] : null);
  }

  function scoreView(m) {
    const max = Math.max(1, ...m.parts.map((p) => p.points));
    return h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', {}, 'What adds to the score'), h('table', {}, h('tbody', {}, m.parts.map((p) => h('tr', {}, h('td', {}, p.label), h('td', { class: 'mono' }, p.value), h('td', { style: { width: '45%' } }, h('div', { class: 'bar' }, h('i', { style: { width: `${(100 * p.points) / max}%`, background: 'var(--accent)' } }))), h('td', { class: 'faint' }, `${p.points} pts`)))))),
      h('div', { class: 'card' }, h('h3', {}, 'The page'), h('div', { class: 'kv' },
        'Own views', m.views, 'Depth', m.depth, 'Markup lines', m.markupLines, 'Own scripts', `${m.scripts} (${m.scriptLines} lines)`, 'Libraries', m.libraries,
        'Widgets', `${m.widgets} (weight ${m.widgetWeight})`, 'Requests', m.requests, 'Child actions', m.childActions, 'Components', m.components, 'Classes', m.classes,
        'Inline scripts', m.inlineScripts, 'From the layouts', `${m.layoutViews} views, ${m.layoutLines} lines`),
        h('p', { class: 'faint' }, 'Each measure adds by its logarithm, so ten partials weigh more than one but not ten times more. 0–29 simple, 30–54 moderate, 55–74 complex, 75+ very complex.')));
  }

  // ─── Graph ────────────────────────────────────────────────────────────────────────────────
  async function viewGraph(focus) {
    const g = state.graph;
    if (!focus) {
      const pages = await api('/api/pages');
      focus = pages.pages[0]?.view;
      if (!focus) return put(mainEl, h('div', { class: 'empty' }, 'No pages found to start from. Search for a file above.'));
      history.replaceState(null, '', `#/graph/${enc(focus)}`);
    }
    const focusInput = h('input', { type: 'text', value: focus, style: { width: '320px' }, title: 'A file, URL or Controller.Action' });
    focusInput.addEventListener('keydown', (ev) => ev.key === 'Enter' && go(`#/graph/${enc(focusInput.value.trim())}`));
    const depth = h('select', { onchange: (ev) => { g.depth = Number(ev.target.value); draw(); } }, [1, 2, 3, 4, 5].map((d) => h('option', { value: d, selected: d === g.depth }, `depth ${d}`)));
    const mode = h('select', { onchange: (ev) => { g.mode = ev.target.value; draw(); } }, h('option', { value: 'layered', selected: g.mode === 'layered' }, 'layered'), h('option', { value: 'force', selected: g.mode === 'force' }, 'force'));
    const vendor = h('label', { class: 'chip' }, h('input', { type: 'checkbox', checked: g.vendor, onchange: (ev) => { g.vendor = ev.target.checked; draw(); } }), 'libraries');
    const pathTo = h('input', { type: 'text', placeholder: 'path to… (file, URL, Controller.Action)', style: { width: '240px' } });
    pathTo.addEventListener('keydown', (ev) => ev.key === 'Enter' && pathTo.value.trim() && drawPath(pathTo.value.trim()));
    const legend = h('div', { class: 'legend' }, Object.entries(EDGES).map(([k, c]) => {
      const lab = h('label', { class: g.kinds.has(k) ? '' : 'off' }, h('input', { type: 'checkbox', checked: g.kinds.has(k), onchange: (ev) => {
        if (ev.target.checked) g.kinds.add(k);
        else g.kinds.delete(k);
        lab.className = ev.target.checked ? '' : 'off';
        localSet('pilot.kinds', [...g.kinds].join(','));
        draw();
      } }), h('i', { class: 'dot', style: { background: c } }), k);
      return lab;
    }));
    const svg = s('svg', { class: 'graph' });
    const side = h('div', { class: 'side' }, h('div', { class: 'dim' }, 'Click a node for its details; double-click to centre the graph on it. Drag to pan, wheel to zoom. Left of the centre: what uses it; right: what it uses.'));
    const types = h('div', { class: 'legend', style: { marginLeft: 'auto' } }, ['view', 'partial', 'layout', 'action', 'script', 'style', 'bundle', 'cs'].map((t) => h('span', { class: 'chip' }, h('i', { class: 'dot', style: { background: color(t) } }), typeName(t))));
    put(mainEl, h('div', { class: 'graph-wrap' },
      h('div', { class: 'graph-main' },
        h('div', { class: 'toolbar' }, focusInput, depth, mode, vendor, pathTo, h('button', { onclick: () => fit() }, 'Fit'), types),
        h('div', { class: 'toolbar', style: { paddingTop: '0' } }, legend),
        svg),
      side));
    let view = { x: 0, y: 0, k: 1 };
    let bounds = null;
    const layer = s('g');
    svg.append(defs(), layer);
    const apply = () => layer.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    const fit = () => {
      if (!bounds) return;
      const r = svg.getBoundingClientRect();
      const k = Math.min(1.4, Math.max(0.15, Math.min(r.width / (bounds.w + 80), r.height / (bounds.h + 80))));
      view = { k, x: r.width / 2 - (bounds.x + bounds.w / 2) * k, y: r.height / 2 - (bounds.y + bounds.h / 2) * k };
      apply();
    };
    panZoom(svg, () => view, (v2) => { view = v2; apply(); });

    async function draw() {
      put(layer, s('text', { x: 20, y: 30, fill: 'var(--dim)' }, 'Loading…'));
      const data = await api('/api/graph', { focus, depth: g.depth, kinds: [...g.kinds].join(','), vendor: g.vendor ? 1 : '', max: 300 });
      if (data.error) return put(layer, s('text', { x: 20, y: 30, fill: 'var(--bad)' }, `Not found: ${focus}`));
      render(data);
      selectNode(data.focus);
    }
    async function drawPath(to) {
      const p = await api('/api/path', { from: focus, to });
      if (!p.steps?.length) {
        put(side, h('div', { class: 'empty' }, p.error ? `Not found: ${to}` : 'No connection found.'));
        return;
      }
      const ids = [p.from, ...p.steps.map((x) => x.to)];
      const nodes = await Promise.all(ids.map((id) => api('/api/node', { id })));
      render({ focus: p.from, nodes: nodes.map((n, i) => ({ ...n, layer: i, out: undefined, in: undefined, text: undefined })), edges: p.steps.map((x) => (x.direction === 'out' ? { from: x.from, to: x.to, kind: x.kind } : { from: x.to, to: x.from, kind: x.kind })) }, { straight: true });
      put(side, h('h3', {}, 'Path'), ...ids.map((id, i) => h('div', { style: { padding: '4px 0' } },
        i ? h('div', { class: 'faint' }, `${p.steps[i - 1].direction === 'out' ? '↓' : '↑'} ${p.steps[i - 1].kind}${p.steps[i - 1].method ? ` ${p.steps[i - 1].method}` : ''}${p.steps[i - 1].url ? ` ${p.steps[i - 1].url}` : ''}`, p.steps[i - 1].line ? [' @ ', loc(p.steps[i - 1].file.startsWith('action:') ? nodes[i - (p.steps[i - 1].direction === 'out' ? 1 : 0)].file : p.steps[i - 1].file, p.steps[i - 1].line, `line ${p.steps[i - 1].line}`)] : null) : null,
        nodeChip(nodes[i]))));
    }

    function render(data, { straight = false } = {}) {
      const pos = g.mode === 'force' && !straight ? forceLayout(data) : layeredLayout(data);
      put(layer);
      const W = 190;
      const H = 34;
      const edgesG = s('g');
      const nodesG = s('g');
      layer.append(edgesG, nodesG);
      const elOf = new Map();
      const edgeEls = [];
      for (const e of data.edges) {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) continue;
        let d;
        if (Math.abs(a.x - b.x) < 1) {
          const x = a.x + W / 2;
          d = `M${x} ${a.y + H / 2} C${x + 60} ${a.y + H / 2} ${x + 60} ${b.y + H / 2} ${x} ${b.y + H / 2}`;
        } else {
          const fwd = b.x > a.x;
          const x1 = fwd ? a.x + W : a.x;
          const x2 = fwd ? b.x : b.x + W;
          const mx = (x1 + x2) / 2;
          d = `M${x1} ${a.y + H / 2} C${mx} ${a.y + H / 2} ${mx} ${b.y + H / 2} ${x2} ${b.y + H / 2}`;
        }
        const col = EDGES[e.kind] ?? '#999';
        const path = s('path', { class: 'edge', d, stroke: col, 'marker-end': `url(#arrow-${e.kind in EDGES ? e.kind : 'link'})`, 'stroke-dasharray': e.kind === 'calls' ? '6 4' : e.kind === 'link' ? '2 4' : e.kind === 'source' ? '4 3' : null },
          s('title', {}, `${e.kind}${e.method ? ` ${e.method}` : ''}${e.target ? ` into ${e.target}` : ''}: ${e.from} → ${e.to}`));
        edgesG.append(path);
        edgeEls.push({ e, el: path });
      }
      for (const n of data.nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        const col = color(n.type);
        const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
        const sub = n.sub ? (n.sub.length > 30 ? `…${n.sub.slice(-29)}` : n.sub) : '';
        const gEl = s('g', { class: `node${n.id === data.focus ? ' focus' : ''}`, transform: `translate(${p.x} ${p.y})` },
          s('rect', { width: W, height: H, rx: 7, fill: 'var(--panel)', stroke: col }),
          s('rect', { width: 6, height: H, rx: 3, fill: col }),
          s('text', { x: 12, y: sub ? 14 : 21 }, label),
          sub ? s('text', { x: 12, y: 27, class: 'sub' }, sub) : null,
          n.vendor ? s('text', { x: W - 8, y: 14, 'text-anchor': 'end', class: 'sub' }, 'lib') : null,
          s('title', {}, `${typeName(n.type)}: ${n.id}`));
        gEl.addEventListener('click', (ev) => { ev.stopPropagation(); selectNode(n.id); });
        gEl.addEventListener('dblclick', (ev) => { ev.stopPropagation(); go(`#/graph/${enc(n.id)}`); });
        gEl.addEventListener('mouseenter', () => hover(n.id));
        gEl.addEventListener('mouseleave', () => hover(null));
        nodesG.append(gEl);
        elOf.set(n.id, gEl);
      }
      function hover(id) {
        svg.classList.toggle('hovering', !!id);
        for (const x of elOf.values()) x.classList.remove('hot');
        for (const { e, el } of edgeEls) {
          const hot = id && (e.from === id || e.to === id);
          el.classList.toggle('hot', !!hot);
          if (hot) {
            elOf.get(e.from)?.classList.add('hot');
            elOf.get(e.to)?.classList.add('hot');
          }
        }
        if (id) elOf.get(id)?.classList.add('hot');
      }
      selectNode.els = elOf;
      const xs = [...pos.values()];
      bounds = xs.length ? { x: Math.min(...xs.map((p) => p.x)), y: Math.min(...xs.map((p) => p.y)), w: Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x)) + W, h: Math.max(...xs.map((p) => p.y)) - Math.min(...xs.map((p) => p.y)) + H } : null;
      if (data.truncated) layer.append(s('text', { x: bounds?.x ?? 0, y: (bounds?.y ?? 0) - 14, fill: 'var(--warn)' }, 'Cut at 300 nodes: lower the depth or hide edge kinds.'));
      requestAnimationFrame(fit);
    }

    async function selectNode(id) {
      for (const [k, el] of selectNode.els ?? []) el.classList.toggle('sel', k === id);
      const n = await api('/api/node', { id });
      if (n.error) return;
      const group = (list, dir) => {
        const by = new Map();
        for (const e of list) by.set(e.kind, [...(by.get(e.kind) ?? []), e]);
        return [...by].map(([kind, es]) => h('div', { style: { marginBottom: '8px' } },
          h('div', { class: 'faint' }, h('i', { class: 'dot', style: { background: EDGES[kind] ?? '#999' } }), `${kind} (${es.length})`),
          es.slice(0, 40).map((e) => h('div', { class: 'flow', style: { padding: '2px 0 2px 14px' } }, nodeChip(e), e.method ? h('span', { class: 'pill' }, e.method) : null, e.target ? h('code', {}, `→ ${e.target}`) : null,
            e.line ? loc(dir === 'out' ? (n.file ?? n.id) : (e.file ?? e.id), e.line, `:${e.line}`) : null)),
          es.length > 40 ? h('div', { class: 'faint' }, `… ${es.length - 40} more`) : null));
      };
      const isPage = n.type === 'view' || n.type === 'action' || n.type === 'partial';
      put(side, 
        h('div', { class: 'flow' }, h('i', { class: 'dot', style: { background: color(n.type) } }), h('b', {}, n.label), h('span', { class: 'pill' }, typeName(n.type))),
        h('div', { class: 'faint mono', style: { margin: '4px 0 10px', wordBreak: 'break-all' } }, n.id),
        h('div', { class: 'flow', style: { marginBottom: '12px' } },
          n.file ? h('button', { onclick: () => openSource(n.file, n.line) }, 'Source') : null,
          isPage ? h('button', { onclick: () => go(`#/page/${enc(n.type === 'action' ? n.id : n.id)}`) }, 'Page') : null,
          id !== focus ? h('button', { onclick: () => go(`#/graph/${enc(n.id)}`) }, 'Centre here') : null,
          n.lines ? h('span', { class: 'faint' }, `${n.lines} lines`) : null),
        n.out.length ? [h('h3', {}, 'Uses'), group(n.out, 'out')] : null,
        n.in.length ? [h('h3', {}, 'Used by'), group(n.in, 'in')] : null);
    }
    draw();
  }

  function defs() {
    return s('defs', {}, Object.entries(EDGES).map(([k, c]) => s('marker', { id: `arrow-${k}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0 0 L10 5 L0 10 z', fill: c }))));
  }

  function panZoom(svg, get, set) {
    let drag = null;
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.node')) return;
      drag = { x: ev.clientX, y: ev.clientY, v: get() };
      svg.classList.add('drag');
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      set({ ...drag.v, x: drag.v.x + ev.clientX - drag.x, y: drag.v.y + ev.clientY - drag.y });
    });
    const end = () => {
      drag = null;
      svg.classList.remove('drag');
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const v = get();
      const r = svg.getBoundingClientRect();
      const k = Math.min(3, Math.max(0.08, v.k * Math.exp(-ev.deltaY * 0.0015)));
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      set({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k });
    }, { passive: false });
  }

  /** Columns by layer (what uses the focus on the left, what it uses on the right), rows ordered to cross less. */
  function layeredLayout(data) {
    const cols = new Map();
    for (const n of data.nodes) cols.set(n.layer, [...(cols.get(n.layer) ?? []), n.id]);
    const keys = [...cols.keys()].sort((a, b) => a - b);
    const nbrs = new Map(data.nodes.map((n) => [n.id, []]));
    for (const e of data.edges) {
      nbrs.get(e.from)?.push(e.to);
      nbrs.get(e.to)?.push(e.from);
    }
    const rank = new Map();
    for (const k of keys) cols.get(k).forEach((id, i) => rank.set(id, i));
    // Each column ordered by the mean row of its neighbours, sweeping out from the centre a few times.
    for (let pass = 0; pass < 6; pass++) {
      const order = pass % 2 ? [...keys].reverse() : keys;
      for (const k of order) {
        const list = cols.get(k);
        const bary = (id) => {
          const ns = nbrs.get(id).filter((x) => rank.has(x));
          return ns.length ? ns.reduce((n, x) => n + rank.get(x), 0) / ns.length : rank.get(id);
        };
        list.sort((a, b) => bary(a) - bary(b) || (a < b ? -1 : 1));
        list.forEach((id, i) => rank.set(id, i));
      }
    }
    const pos = new Map();
    const tallest = Math.max(...keys.map((k) => cols.get(k).length));
    for (const k of keys) {
      const list = cols.get(k);
      const off = ((tallest - list.length) * 48) / 2;
      list.forEach((id, i) => pos.set(id, { x: k * 270, y: off + i * 48 }));
    }
    return pos;
  }

  /** A force layout: nodes repel, edges pull, a little gravity; run to rest before drawing. */
  function forceLayout(data) {
    const n = data.nodes.length;
    const P = data.nodes.map((x, i) => ({ id: x.id, x: x.layer * 160 + Math.cos(i) * 50, y: Math.sin(i * 1.7) * 200, vx: 0, vy: 0 }));
    const index = new Map(P.map((p, i) => [p.id, i]));
    const E = data.edges.map((e) => [index.get(e.from), index.get(e.to)]).filter(([a, b]) => a != null && b != null);
    for (let it = 0; it < 320; it++) {
      const t = 1 - it / 320;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = P[j].x - P[i].x;
          const dy = P[j].y - P[i].y;
          const d2 = Math.max(400, dx * dx + dy * dy);
          const f = 90000 / d2;
          const d = Math.sqrt(d2);
          P[i].vx -= (dx / d) * f; P[i].vy -= (dy / d) * f;
          P[j].vx += (dx / d) * f; P[j].vy += (dy / d) * f;
        }
      }
      for (const [a, b] of E) {
        const dx = P[b].x - P[a].x;
        const dy = P[b].y - P[a].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 230) * 0.04;
        P[a].vx += (dx / d) * f; P[a].vy += (dy / d) * f;
        P[b].vx -= (dx / d) * f; P[b].vy -= (dy / d) * f;
      }
      for (const p of P) {
        p.vx -= p.x * 0.01; p.vy -= p.y * 0.01;
        p.x += Math.max(-40, Math.min(40, p.vx * t)); p.y += Math.max(-40, Math.min(40, p.vy * t));
        p.vx *= 0.5; p.vy *= 0.5;
      }
    }
    return new Map(P.map((p) => [p.id, { x: p.x, y: p.y }]));
  }

  // ─── Components ───────────────────────────────────────────────────────────────────────────
  async function viewComponents(kind) {
    const data = await api('/api/widgets');
    const cards = h('div', { class: 'cards' }, data.kinds.map((k) => h('div', { class: 'card stat', style: { cursor: 'pointer', outline: k.kind === kind ? '2px solid var(--accent)' : '' }, onclick: () => go(`#/components/${enc(k.kind)}`) },
      h('b', {}, k.count), h('span', {}, k.kind), h('div', { class: 'faint', style: { fontSize: '11.5px' } }, k.libs.map((l) => `${l.lib} ${l.count}`).join(' · ')))));
    const chosen = data.kinds.find((k) => k.kind === kind);
    put(mainEl, h('h1', {}, 'Components'),
      h('p', { class: 'dim' }, 'UI widgets found in views and scripts: data tables, calendars, pickers, charts, selects, modals and more, with the element each binds to and the pages it appears on.'),
      cards,
      chosen ? [h('h2', {}, chosen.kind), h('div', { class: 'card' }, widgetList(chosen.libs.flatMap((l) => l.places), { pages: true }))] : h('p', { class: 'faint' }, 'Pick a kind to list where it is.'));
  }

  // ─── Stylesheets and splitting ────────────────────────────────────────────────────────────
  const GROUP_COLORS = ['#3b82f6', '#8b5cf6', '#0ea5b7', '#f59f00', '#e64980', '#2f9e44', '#c9a227', '#14b8a6', '#f08c00', '#7048e8', '#1098ad', '#d6336c', '#5c940d', '#495057'];
  async function viewStyles(file) {
    const list = await api('/api/stylesheets');
    const max = Math.max(1, ...list.stylesheets.map((x) => x.lines));
    const left = h('div', { class: 'card', style: { flex: '0 0 380px', maxHeight: 'calc(100vh - 140px)', overflow: 'auto' } },
      h('h3', {}, 'Stylesheets, largest first'),
      list.stylesheets.map((x) => h('div', { style: { padding: '6px 0', borderBottom: '1px solid var(--line)', cursor: 'pointer', background: x.file === file ? 'var(--accent-soft)' : '' }, onclick: () => go(`#/styles/${enc(x.file)}`) },
        h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, x.file),
        h('div', { class: 'flow' }, h('div', { class: 'bar', style: { width: '140px' } }, h('i', { style: { width: `${(100 * x.lines) / max}%`, background: 'var(--t-style)' } })), h('span', { class: 'faint' }, `${x.lines} lines · ${x.rules} rules${x.importedBy ? '' : ' · top level'}`)))));
    const right = h('div', { style: { flex: '1', minWidth: '0' } });
    put(mainEl, h('h1', {}, 'Stylesheets'), h('div', { class: 'split' }, left, right));
    if (!file) {
      right.append(h('div', { class: 'empty' }, 'Pick a stylesheet to see how it could be split by where its rules are used.'));
      return;
    }
    right.append(loading());
    const d = await api('/api/split', { file });
    if (d.error) return put(right, h('div', { class: 'empty' }, d.error));
    if (d.imports) {
      put(right, h('div', { class: 'card' }, h('h3', {}, `${file} only imports other files; split the largest`), d.imports.map((x) => h('div', { class: 'flow', style: { padding: '4px 0' } }, h('a', { class: 'mono', onclick: () => go(`#/styles/${enc(x.file)}`) }, x.file), h('span', { class: 'faint' }, `${x.lines} lines`)))));
      return;
    }
    const colorOf = new Map(d.groups.map((g, i) => [g.file, GROUP_COLORS[i % GROUP_COLORS.length]]));
    // The file as a strip: each block's lines in its group's colour, in place.
    const segments = [];
    let cursor = 1;
    const blocks = d.groups.flatMap((g) => g.blocks.map((b) => ({ ...b, file: g.file }))).sort((a, b) => a.start - b.start);
    for (const b of blocks) {
      if (b.start > cursor) segments.push({ lines: b.start - cursor, color: 'var(--panel2)' });
      segments.push({ lines: b.end - b.start + 1, color: colorOf.get(b.file), b });
      cursor = b.end + 1;
    }
    if (d.lines >= cursor) segments.push({ lines: d.lines - cursor + 1, color: 'var(--panel2)' });
    const strip = h('div', { class: 'filemap', style: { height: `${Math.min(640, Math.max(220, d.lines / 3))}px` } }, segments.map((x) => h('i', { style: { flex: `${x.lines} 0 0`, background: x.color }, title: x.b ? `${x.b.file}: lines ${x.b.start}-${x.b.end} ${x.b.selector}` : '', onclick: x.b ? () => openSource(file, x.b.start) : null })));
    const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'New file'), h('th', {}, 'Lines'), h('th', {}, 'Why'), h('th', {}, 'From'))),
      h('tbody', {}, d.groups.map((g) => h('tr', {},
        h('td', {}, h('i', { class: 'dot', style: { background: colorOf.get(g.file) } }), h('b', { class: 'mono' }, g.file)),
        h('td', {}, `${g.lines} (${g.share}%)`),
        h('td', { class: 'dim' }, g.why.join('; ')),
        h('td', {}, g.ranges.slice(0, 8).map(([a, b]) => h('a', { class: 'mono', style: { marginRight: '8px' }, onclick: () => openSource(file, a) }, a === b ? `${a}` : `${a}-${b}`)), g.ranges.length > 8 ? `+${g.ranges.length - 8}` : '')))));
    const imports = d.groups.filter((g) => !g.file.startsWith('unused')).map((g) => `@import "${g.file.replace(/\.(less|scss|css)$/, '')}";`).join('\n');
    put(right, 
      h('div', { class: 'card' },
        h('h3', {}, `Splitting ${d.file} (${d.lines} lines) into ${d.groups.length} files`),
        h('div', { class: 'split' }, strip, h('div', { style: { flex: '1', minWidth: '0', overflow: 'auto' } }, table))),
      h('div', { class: 'cols', style: { marginTop: '14px' } },
        h('div', { class: 'card' }, h('h3', {}, 'The main file becomes'), h('pre', { class: 'block' }, imports), h('button', { onclick: () => navigator.clipboard?.writeText(imports) }, 'Copy'),
          h('p', { class: 'faint' }, 'In this order the cascade within each new file stays as it was: base first, then layout, components and pages.')),
        h('div', { class: 'card' },
          d.orderSensitive.length ? [h('h3', {}, 'Order-sensitive classes'), d.orderSensitive.slice(0, 20).map((o) => h('div', {}, h('a', { onclick: () => go(`#/selectors/${enc(`.${o.class}`)}`) }, `.${o.class}`), ' ', h('span', { class: 'faint' }, o.files.join(', '))))] : h('p', { class: 'faint' }, 'No class is styled in two of the new files.'),
          d.headers.length ? [h('h3', {}, 'Section headings in the file'), d.headers.map((x) => h('div', {}, h('a', { onclick: () => openSource(file, x.line) }, `${x.line}`), ' ', x.title))] : null)));
  }

  // ─── Selectors ────────────────────────────────────────────────────────────────────────────
  async function viewSelectors(q) {
    const input = h('input', { type: 'search', value: q ?? '', placeholder: '.class, #id, [data-attr], name or .btn-*', style: { width: '340px' } });
    input.addEventListener('keydown', (ev) => ev.key === 'Enter' && go(`#/selectors/${enc(input.value.trim())}`));
    const out = h('div');
    put(mainEl, h('h1', {}, 'Selectors'), h('div', { class: 'toolbar' }, input, h('button', { onclick: () => go(`#/selectors/${enc(input.value.trim())}`) }, 'Find')), out);
    if (!q) return out.append(h('p', { class: 'dim' }, 'Where a class or id is styled, marked up and used by scripts: check this before renaming or restyling.'));
    const d = await api('/api/selector', { q });
    if (d.matches) {
      out.append(h('div', { class: 'card' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Styled'), h('th', {}, 'Markup'), h('th', {}, 'Scripts'))),
        h('tbody', {}, d.matches.map((m) => h('tr', { class: 'click', onclick: () => go(`#/selectors/${enc(m.name)}`) }, h('td', { class: 'mono' }, m.name), h('td', {}, m.styled), h('td', {}, m.markup), h('td', {}, m.script)))))));
      return;
    }
    if (!d.results.length) return out.append(h('div', { class: 'empty' }, `${q} isn't styled, marked up or scripted anywhere Pilot can see.`));
    for (const r of d.results) {
      const col = (role, title) => {
        const list = r.uses.filter((u) => u.role === role);
        return h('div', { class: 'card' }, h('h3', {}, `${title} (${list.length})`), list.length ? list.slice(0, 200).map((u) => h('div', { style: { padding: '3px 0' } }, loc(u.file, u.line), u.vendor ? h('span', { class: 'pill' }, 'library') : null, u.selector ? h('div', { class: 'faint mono' }, u.selector) : null)) : h('div', { class: 'faint' }, role === 'style' ? 'Not styled in the project' : 'None'));
      };
      out.append(h('h2', { class: 'mono' }, r.name), h('div', { class: 'cols' }, col('style', 'Styled in'), col('markup', 'Marked up in'), col('script', 'Used by scripts in')));
    }
  }

  // ─── Problems ─────────────────────────────────────────────────────────────────────────────
  async function viewProblems() {
    const d = await api('/api/problems');
    put(mainEl, h('h1', {}, `Unresolved (${d.problems.length})`),
      h('div', { class: 'card' }, d.problems.length ? h('table', {}, h('tbody', {}, d.problems.map((p) => h('tr', {}, h('td', {}, loc(p.file, p.line)), h('td', {}, p.message))))) : h('div', { class: 'empty' }, 'Everything resolved.')),
      h('h2', {}, `Decided at run time (${d.dynamic.length})`),
      h('div', { class: 'card' }, d.dynamic.length ? h('table', {}, h('tbody', {}, d.dynamic.map((p) => h('tr', {}, h('td', {}, loc(p.file, p.line)), h('td', {}, h('code', {}, p.message.replace('decided at run time: ', ''))))))) : h('div', { class: 'empty' }, 'None.')));
  }

  route();
}
