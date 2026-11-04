// `pilot report`: one HTML file with what Pilot found, to share with people who don't run it: the
// overview, how much Pilot understood, the pages by complexity, the components, the style guide,
// design consistency, dead code, accessibility, images, hard-coded text and what couldn't be
// resolved. Self-contained (styles inline, no script, nothing from the network); written to
// .pilot/report.html unless told otherwise.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from './app.js';
import { overview, problems } from './queries.js';
import { complexity, widgets } from './analysis.js';
import { a11y, deadCode, design } from './audit.js';
import { doctor, images, styleguide, texts } from './insight.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const table = (head, rows) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const section = (title, body, open = false) => `<details${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="body">${body}</div></details>`;
const code = (s) => `<code>${esc(s)}</code>`;
const swatch = (c) => `<i class="sw" style="background:${esc(/^[#\w(),.\s%-]+$/.test(c) ? c : 'transparent')}"></i>`;

export function report(idx, { out = null } = {}) {
  const o = overview(idx).data;
  const doc = doctor(idx).data;
  const pages = complexity(idx).data;
  const w = widgets(idx, { pages: false }).data;
  const sg = styleguide(idx).data;
  const des = design(idx).data;
  const dead = deadCode(idx).data;
  const acc = a11y(idx).data;
  const img = images(idx).data;
  const tx = texts(idx).data;
  const pr = problems(idx, { limit: 100000 }).data;
  const c = o.counts;
  const level = (s) => (s < 30 ? 'ok' : s < 55 ? 'mid' : s < 75 ? 'warn' : 'bad');
  const body = [
    `<header><h1>${esc(o.root.split(/[\\/]/).pop())}</h1><p>${esc(o.root)} · ${esc(o.projects.join(', '))} · ${new Date().toLocaleString()} · Pilot ${esc(VERSION)}</p></header>`,
    `<div class="cards">${[[pages.pages.length, 'pages'], [c.views, 'views'], [c.partials, 'partials'], [c.layouts, 'layouts'], [c.actions, 'actions'], [c.typescript + c.javascript, 'scripts'], [c.less + c.scss + c.css, 'stylesheets'], [w.kinds.reduce((n, k) => n + k.count, 0), 'widgets'], [`${doc.score}%`, 'understood'], [acc.issues.length, 'a11y issues']].map(([n, l]) => `<div class="card"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join('')}</div>`,
    section(`Pages by complexity (average ${pages.average})`, table(['Score', 'URL', 'Action', 'View', 'Views', 'Script lines', 'Widgets', 'Requests'], pages.pages.map((p) => [`<span class="score ${level(p.score)}">${p.score}</span>`, code(p.url), esc(p.label), code(p.view), p.metrics.views, p.metrics.scriptLines, p.metrics.widgets, p.metrics.requests])), true),
    section(`How much Pilot understood: ${doc.score}%`, table(['What', 'Found', 'Guessed', 'Missing', 'Run time'], doc.rows.map((r) => [esc(r.what), r.found, r.guessed, r.missing, r.dynamic])) + (doc.patterns.length ? `<h3>Not followed, by pattern</h3>${table(['Count', 'Pattern', 'For example'], doc.patterns.slice(0, 20).map((p) => [p.count, esc(p.key), esc(p.examples.join('; '))]))}` : '')),
    section('Components', table(['Kind', 'Libraries', 'Count'], w.kinds.map((k) => [esc(k.kind), esc(k.libs.map((l) => `${l.lib} (${l.count})`).join(', ')), k.count]))),
    section('Style guide', [
      sg.colours.length ? `<h3>Colour variables</h3>${table(['', 'Name', 'Value', 'Uses'], sg.colours.map((v) => [swatch(v.value), code(v.name), code(v.value), v.uses]))}` : '',
      sg.literalColours.length ? `<h3>Colours written out</h3>${table(['', 'Value', 'Uses'], sg.literalColours.map((v) => [swatch(v.value), code(v.value), v.uses]))}` : '',
      sg.sizes.length ? `<h3>Size variables</h3>${table(['Name', 'Value', 'Uses'], sg.sizes.map((v) => [code(v.name), code(v.value), v.uses]))}` : '',
      sg.fonts.length ? `<h3>Fonts</h3><p>${sg.fonts.map((f) => `${code(f.value)} (${f.uses})`).join(' · ')}</p>` : '',
      sg.breakpoints.length ? `<h3>Breakpoints</h3><p>${sg.breakpoints.map((b) => `${code(b.query)} (${b.places.length})`).join(' · ')}</p>` : '',
      sg.components.length ? `<h3>Components</h3>${sg.components.map((cmp) => `<p><b>.${esc(cmp.name)}</b> ${cmp.classes.map((x) => code(`.${x}`)).join(' ')}</p>${cmp.example ? `<pre>${esc(cmp.example.markup)}</pre>` : ''}`).join('')}` : '',
    ].join('')),
    section(`Design consistency (${des.useVariable.length + des.near.length} colour issues, ${des.inline.reduce((n, x) => n + x.places.length, 0)} inline styles)`, [
      des.useVariable.length ? `<h3>Colours a variable already holds</h3>${table(['', 'Colour', 'Variable', 'Places'], des.useVariable.map((u) => [swatch(u.color), code(u.color), code(u.variables.join(' / ')), esc(u.uses.map((x) => `${x.file}:${x.line}`).join(', '))]))}` : '',
      des.near.length ? `<h3>Colours that look the same</h3>${table(['', '', 'Colours', 'Uses'], des.near.map((n) => [swatch(n.a), swatch(n.b), code(`${n.a} ≈ ${n.b}`), n.uses]))}` : '',
      des.zindex.length ? `<h3>z-index</h3>${table(['Value', 'Places'], des.zindex.map((z) => [code(z.value), esc(z.places.join(', '))]))}` : '',
      des.important.length ? `<h3>!important</h3>${table(['Count', 'File'], des.important.map((x) => [x.count, code(x.file)]))}` : '',
    ].join('') || '<p>Nothing to report.</p>'),
    section(`Dead code (${dead.views.length + dead.scripts.length + dead.styles.length} files, ${dead.classes.length} classes)`, [
      ['Views', dead.views.map((v) => `${v.file}${v.maybe ? ` (maybe: ${v.maybe})` : ''}`)], ['Scripts', dead.scripts.map((s) => s.file)], ['Stylesheets', dead.styles.map((s) => s.file)],
      ['Variables', dead.vars.map((v) => v.name)], ['Mixins', dead.mixins.map((m) => `.${m.name}`)], ['Classes', dead.classes.map((x) => `.${x.name}`)],
    ].filter(([, l]) => l.length).map(([t, l]) => `<h3>${t} (${l.length})</h3><p>${l.slice(0, 300).map(code).join(' ')}</p>`).join('') || '<p>Nothing unused found.</p>'),
    section(`Accessibility (${acc.issues.length})`, acc.issues.length ? table(['Rule', 'Where', 'What'], acc.issues.map((x) => [esc(x.rule), code(`${x.file}:${x.line}`), esc(x.what)])) : '<p>Nothing the markup shows.</p>'),
    section(`Images (${img.missing.length} missing, ${img.heavy.length} heavy, ${img.unused.length} unused)`, [
      img.missing.length ? `<h3>Missing</h3>${table(['Where', 'URL'], img.missing.map((m) => [code(`${m.file}:${m.line}`), code(m.url)]))}` : '',
      img.heavy.length ? `<h3>Heavy</h3>${table(['KB', 'File'], img.heavy.map((h) => [Math.round(h.bytes / 1024), code(h.file)]))}` : '',
      img.unused.length ? `<h3>Unused</h3><p>${img.unused.map((u) => code(u.file)).join(' ')}</p>` : '',
    ].join('') || '<p>Nothing to report.</p>'),
    section(`Hard-coded text (${tx.total} in ${tx.views.filter((v) => v.texts.length).length} views)`, tx.views.filter((v) => v.texts.length).slice(0, 80).map((v) => `<h3>${esc(v.file)}</h3><p>${v.texts.slice(0, 20).map((t) => code(t.text)).join(' · ')}</p>`).join('') || '<p>None.</p>'),
    section(`Unresolved (${pr.problems.length}) and decided at run time (${pr.dynamic.length})`, table(['Where', 'What'], [...pr.problems, ...pr.dynamic].map((p) => [code(`${p.file}:${p.line}`), esc(p.message)]))),
  ].join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pilot report: ${esc(o.root.split(/[\\/]/).pop())}</title><style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#dfe3e8;--text:#1d2330;--dim:#667085}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--panel:#171b23;--line:#2a303c;--text:#e6e9ef;--dim:#9aa4b2}}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:1300px;margin:auto}
header p{color:var(--dim);margin-top:-8px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:16px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:22px}.card span{color:var(--dim);font-size:12px}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:10px 0}summary{padding:12px 14px;cursor:pointer;font-weight:600}.body{padding:0 14px 14px;overflow:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--dim);font-size:12px}
code{font:12.5px ui-monospace,Menlo,Consolas,monospace}pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:12px}
.sw{display:inline-block;width:16px;height:16px;border-radius:4px;border:1px solid var(--line);vertical-align:middle}
.score{display:inline-block;min-width:28px;text-align:center;border-radius:6px;color:#fff;font-weight:600}.ok{background:#2f9e44}.mid{background:#d4a017}.warn{background:#e8590c}.bad{background:#e03131}
</style></head><body>${body}</body></html>`;
  const file = resolve(out ?? join(idx.root, '.pilot', 'report.html'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return { data: { file, bytes: html.length }, text: `Wrote ${file} (${Math.round(html.length / 1024)} KB): open it in a browser, or send it.` };
}
