// The UI's one HTML page: the styles below and the client (client.js) inline, the client passed as
// its function's source so the page needs no bundler and the executable carries it. Colours are
// tokens with a dark set; nothing is loaded from the network.
import { client } from './client.js';

const CSS = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --panel2: #f0f2f5; --line: #dfe3e8; --text: #1d2330; --dim: #667085; --faint: #98a2b3;
  --accent: #2f6fed; --accent-soft: #e5edfd; --good: #2f9e44; --warn: #e8590c; --bad: #e03131;
  --t-view: #3b82f6; --t-partial: #0ea5b7; --t-layout: #8b5cf6; --t-action: #f59f00; --t-script: #c9a227; --t-style: #e64980;
  --t-bundle: #868e96; --t-cs: #2f9e44; --t-config: #748094; --t-missing: #e03131;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.08);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f1218; --panel: #171b23; --panel2: #1e232d; --line: #2a303c; --text: #e6e9ef; --dim: #9aa4b2; --faint: #6b7483;
  --accent: #6ea2ff; --accent-soft: #1d2a44; --shadow: none;
} }
:root[data-theme="dark"] {
  --bg: #0f1218; --panel: #171b23; --panel2: #1e232d; --line: #2a303c; --text: #e6e9ef; --dim: #9aa4b2; --faint: #6b7483;
  --accent: #6ea2ff; --accent-soft: #1d2a44; --shadow: none;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); text-decoration: none; cursor: pointer; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
button, input, select { font: inherit; color: inherit; }
button { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
input[type=text], input[type=search], select { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; min-width: 0; }
input:focus, select:focus, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
header { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 14px; padding: 8px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header.top { display: block; padding: 0; }
.menubar { display: flex; align-items: center; gap: 6px; padding: 4px 10px; }
.menubar .logo { font-size: 18px; color: #c08030; padding: 0 4px; }
.menubar .search input { width: min(420px, 34vw); padding: 4px 9px; }
.menubar .project { max-width: 28vw; overflow: hidden; }
.menubar .project .pill { font-size: 12.5px; padding: 2px 10px; color: var(--text); }
.menus { display: flex; }
.menu { position: relative; }
.menu .mt { border: 0; background: none; padding: 4px 9px; border-radius: 5px; font-size: 13.5px; }
.menu .mt:hover, .menu.open .mt { background: var(--panel2); }
.menu .dropdown { display: none; position: absolute; top: 100%; left: 0; min-width: 260px; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 8px 28px rgba(16,24,40,.18); z-index: 50; }
.menu.open .dropdown { display: block; }
.menu .mi { display: flex; width: 100%; gap: 18px; align-items: center; text-align: left; border: 0; background: none; padding: 6px 10px; border-radius: 5px; font-size: 13.5px; white-space: nowrap; }
.menu .mi:hover:not([disabled]), .menu .mi:focus { background: var(--accent-soft); outline: none; }
.menu .mi[disabled] { color: var(--faint); cursor: default; }
.menu .mi .key { color: var(--faint); font-size: 12px; }
.menu .sep { height: 1px; background: var(--line); margin: 4px 6px; }
header.top nav { padding: 2px 12px 6px; }
nav { display: flex; gap: 2px; flex-wrap: wrap; }
nav a { padding: 5px 7px; border-radius: 6px; color: var(--dim); font-size: 13.5px; }
nav a.on { background: var(--accent-soft); color: var(--accent); text-decoration: none; }
nav a:hover { text-decoration: none; color: var(--text); }
.grow { flex: 1; }
.search { position: relative; }
.search input { width: 220px; }
.results { position: absolute; right: 0; top: 36px; width: 520px; max-width: 92vw; max-height: 70vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); z-index: 30; }
.results div { padding: 6px 10px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
.results div:hover, .results div.on { background: var(--accent-soft); }
main { padding: 16px; max-width: 1500px; margin: 0 auto; }
main.full { max-width: none; padding: 0; height: calc(100vh - var(--top, 53px)); }
h1 { font-size: 20px; margin: 4px 0 12px; }
h2 { font-size: 15px; margin: 18px 0 8px; }
h3 { font-size: 13px; margin: 12px 0 6px; color: var(--dim); text-transform: uppercase; letter-spacing: .04em; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; box-shadow: var(--shadow); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.stat b { display: block; font-size: 24px; font-weight: 650; }
.stat span { color: var(--dim); font-size: 12px; }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 14px; }
.dim { color: var(--dim); }
.faint { color: var(--faint); }
.pill { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 11.5px; background: var(--panel2); color: var(--dim); border: 1px solid var(--line); white-space: nowrap; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 3px; vertical-align: middle; margin-right: 5px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--dim); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; background: var(--panel); }
table.sticky th { position: sticky; top: var(--top, 53px); z-index: 1; }
tr.click:hover td { background: var(--panel2); cursor: pointer; }
.bar { height: 8px; background: var(--panel2); border-radius: 99px; overflow: hidden; min-width: 60px; }
.bar i { display: block; height: 100%; border-radius: 99px; }
.score { display: inline-flex; align-items: center; gap: 8px; min-width: 120px; }
.score b { width: 26px; text-align: right; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 12px 0; flex-wrap: wrap; }
.tabs a { padding: 7px 12px; color: var(--dim); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs a.on { color: var(--accent); border-color: var(--accent); text-decoration: none; }
.tree { font-size: 13px; }
.tree .row { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.tree .kids { margin-left: 18px; border-left: 1px dashed var(--line); padding-left: 8px; }
.tree .row .tg { width: 14px; color: var(--faint); cursor: pointer; user-select: none; }
.tree .layout-part { opacity: .55; }
.flow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.flow .arrow { color: var(--faint); }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel2); font-size: 12.5px; }
.list > div { padding: 8px 0; border-bottom: 1px solid var(--line); }
.drawer { position: fixed; top: var(--top, 53px); right: 0; bottom: 0; width: min(760px, 96vw); background: var(--panel); border-left: 1px solid var(--line); box-shadow: -8px 0 24px rgba(0,0,0,.12); z-index: 25; display: flex; flex-direction: column; }
.drawer header { position: static; }
.code { flex: 1; overflow: auto; font-family: var(--mono); font-size: 12.5px; line-height: 1.55; padding: 8px 0; }
.code div { white-space: pre; padding: 0 12px 0 0; display: flex; }
.code span.n { color: var(--faint); width: 56px; text-align: right; padding-right: 12px; flex: none; user-select: none; }
.code div.hl { background: var(--accent-soft); }
.graph-wrap { display: grid; grid-template-columns: 1fr 360px; height: 100%; }
.graph-wrap.nopanel { grid-template-columns: 1fr; }
.graph-main { position: relative; overflow: hidden; display: flex; flex-direction: column; }
.graph-main .toolbar { padding: 10px 12px; margin: 0; border-bottom: 1px solid var(--line); background: var(--panel); }
svg.graph { flex: 1; width: 100%; height: 100%; cursor: grab; background: var(--bg); user-select: none; }
svg.graph.drag { cursor: grabbing; }
svg.graph .node rect { stroke-width: 1.5; }
svg.graph .node text { font-size: 12px; fill: var(--text); pointer-events: none; }
svg.graph .node text.sub { font-size: 10px; fill: var(--dim); }
svg.graph .node { cursor: pointer; }
svg.graph .edge { fill: none; stroke-width: 1.4; opacity: .65; }
svg.graph.hovering .edge { opacity: .12; }
svg.graph.hovering .node { opacity: .3; }
svg.graph.hovering .edge.hot { opacity: 1; stroke-width: 2.2; }
svg.graph.hovering .node.hot { opacity: 1; }
svg.graph .node.focus rect { stroke-width: 3; }
svg.graph .node.sel rect { stroke: var(--accent) !important; stroke-width: 3; }
.side { border-left: 1px solid var(--line); background: var(--panel); overflow: auto; padding: 14px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px; }
.legend label { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 6px; border: 1px solid var(--line); }
.legend label.off { opacity: .4; }
.legend input { display: none; }
.filemap { display: flex; flex-direction: column; width: 46px; border-radius: 6px; overflow: hidden; border: 1px solid var(--line); flex: none; }
.filemap i { display: block; min-height: 1px; cursor: pointer; }
.split { display: flex; gap: 16px; align-items: stretch; }
pre.block { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow: auto; font-family: var(--mono); font-size: 12.5px; margin: 6px 0; }
.empty { color: var(--dim); padding: 30px; text-align: center; }
.warn { color: var(--warn); }
.loading { color: var(--dim); padding: 40px; text-align: center; }
.gauge { width: 76px; height: 76px; flex: none; }
.page-head { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; font-size: 13px; }
.kv > :nth-child(odd) { color: var(--dim); }
button.ghost { border-color: transparent; background: none; padding: 3px 7px; color: var(--dim); }
button.ghost:hover { border-color: var(--line); color: var(--text); }
.overlay { position: fixed; inset: 0; background: rgba(10,14,20,.38); z-index: 60; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; }
.dialog { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 18px 48px rgba(0,0,0,.28); width: min(520px, 94vw); max-height: 76vh; display: flex; flex-direction: column; }
.dialog.wide { width: min(720px, 94vw); }
.dialog-head { display: flex; align-items: center; padding: 10px 12px 6px 16px; }
.dialog-body { padding: 6px 16px 14px; overflow: auto; }
.dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); }
.prose p { margin: 0 0 10px; }
.folders { border: 1px solid var(--line); border-radius: 8px; height: 42vh; overflow: auto; margin-bottom: 8px; }
.folder { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--line); }
.folder:hover { background: var(--accent-soft); }
.folder .ico, .recent .ico { color: var(--faint); width: 16px; text-align: center; }
.spinner { width: 16px; height: 16px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
main.start { max-width: 1180px; padding-top: 5vh; }
.start-title { display: flex; align-items: center; gap: 16px; margin-bottom: 26px; }
.start-title h1 { font-size: 30px; margin: 0; font-weight: 600; }
.big-logo { font-size: 46px; color: #c08030; }
.start-cols { display: grid; grid-template-columns: 1.35fr 1fr; gap: 40px; }
.start-cols h2 { font-size: 17px; font-weight: 600; margin: 0 0 12px; }
.recent { margin-top: 8px; max-height: 60vh; overflow: auto; }
.recent .group { font-size: 12px; color: var(--dim); padding: 12px 6px 4px; font-weight: 600; }
.recent .item { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 7px; cursor: pointer; }
.recent .item:hover, .recent .item:focus { background: var(--accent-soft); outline: none; }
.recent .item .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.recent .item .when { font-size: 12px; white-space: nowrap; }
.recent .item .pin { opacity: 0; filter: grayscale(1); }
.recent .item:hover .pin, .recent .item .pin.on { opacity: 1; }
.recent .item .pin.on { filter: none; }
.recent .item.missing { opacity: .5; cursor: default; }
button.big { display: flex; gap: 14px; align-items: flex-start; width: 100%; text-align: left; padding: 14px 16px; margin-bottom: 10px; border-radius: 10px; background: var(--panel); }
button.big .ico { font-size: 24px; line-height: 1; }
button.big b { display: block; font-size: 15px; font-weight: 600; margin-bottom: 2px; }
button.big small { color: var(--dim); font-size: 12.5px; }
@media (max-width: 860px) { .start-cols { grid-template-columns: 1fr; } }
@media (max-width: 900px) { .graph-wrap { grid-template-columns: 1fr; } .side { display: none; } .search input { width: 160px; } }
`;

export function pageHtml({ root = null, name = null, version, app = false, picker = false }) {
  const boot = JSON.stringify({ root, name, version, app, picker }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#14202c">
<title>${name ? `${escape(name)} - Pilot` : 'Pilot'}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%2314202c'/%3E%3Ccircle cx='8' cy='8' r='4.5' fill='none' stroke='%23e0b060' stroke-width='1.6'/%3E%3Cpath d='M8 1v14M1 8h14' stroke='%23c08030' stroke-width='1.4'/%3E%3Ccircle cx='8' cy='8' r='1.4' fill='%237fd4ff'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<div id="app"></div>
<script>(${client.toString()})(${boot});</script>
</body>
</html>`;
}

const escape = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
