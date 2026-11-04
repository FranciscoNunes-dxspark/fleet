// The doctor, view models, hard-coded text, images, the style guide, the refactors (split and
// extract, written in a temp copy), the Claude Code hook, the report, the live tools' pure parts
// (no browser here), and the UI's actions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/index.js';
import { doctor, images, modelName, models, styleguide, texts } from '../src/insight.js';
import { balance, compareCss, extractPartial, splitApply, tagDepth } from '../src/refactor.js';
import { afterEdit, installHook, runHook } from '../src/hook.js';
import { report } from '../src/report.js';
import { breakpointWidths, cssRules, pageSet, shots, usedBytes } from '../src/live.js';
import { ACTIONS, handler } from '../src/web/server.js';

const ROOT = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const idx = buildIndex(ROOT, { cache: false });
const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-more-'));
  cpSync(ROOT, dir, { recursive: true });
  return dir;
};

test('doctor: what Pilot followed, by kind, and the patterns it could not', () => {
  const d = doctor(idx).data;
  const row = (what) => d.rows.find((r) => r.what === what);
  assert.deepEqual([row('partials and templates').found, row('partials and templates').missing, row('partials and templates').dynamic], [4, 1, 1]);
  assert.deepEqual([row('images').found, row('images').missing], [0, 1]);
  assert.equal(row('server requests').found, 3);
  assert.ok(d.score > 80 && d.score < 100);
  assert.deepEqual(d.patterns.map((p) => p.key).sort(), ['@import "…" not found', 'image "…" not found in the project', 'partial "…" not found', 'run time: Html.Partial(…)'].map((k) => k.replace('@import', 'import')).sort());
});

test('view models: the class, the views, properties read, never read, and read but missing', () => {
  assert.equal(modelName('IEnumerable<Shop.Web.Models.OrderRow>'), 'OrderRow');
  assert.equal(modelName('OrderViewModel?'), 'OrderViewModel');
  const m = Object.fromEntries(models(idx).data.models.map((x) => [x.name, x]));
  assert.deepEqual(m.OrderRow.views.map((v) => [v.file, v.uses.sort()]), [['Shop.Web/Views/Orders/_OrderRow.cshtml', ['Id', 'Late', 'Number']]]);
  assert.deepEqual(m.OrderRow.unused, ['Notes']);
  assert.deepEqual(m.OrdersViewModel.unused, ['Total', 'PartialName']);
  // Edit.cshtml reads Model.PartialName, which OrderViewModel doesn't have.
  assert.deepEqual(m.OrderViewModel.unknown, ['PartialName']);
  assert.equal(m.Product.class, null);
});

test('hard-coded text, images and the style guide', () => {
  const t = texts(idx).data;
  assert.equal(t.localizing, 0);
  const home = t.views.find((v) => v.file === 'Shop.Web/Views/Home/Index.cshtml');
  assert.deepEqual(home.texts.map((x) => x.text), ['Welcome', 'More', 'Tip']);
  assert.ok(!t.views.some((v) => v.texts.some((x) => /RenderSection|=>/.test(x.text))), 'Razor and lambdas are not text');
  const im = images(idx).data;
  assert.deepEqual(im.missing.map((m) => [m.file, m.url]), [['Shop.Web/Views/Home/Index.cshtml', '/images/logo.png']]);
  const sg = styleguide(idx).data;
  assert.deepEqual(sg.colours.map((c) => c.name), ['@brand', '@gray', '@brand-dark']);
  assert.deepEqual(sg.sizes.map((c) => c.name), ['@radius']);
  assert.ok(sg.components.some((c) => c.name === 'btn' && c.classes.includes('btn-save') && /class="btn btn-save"/.test(c.example.markup)));
  assert.deepEqual(sg.breakpoints.map((b) => b.query), ['max-width 600px']);
});

test('split applied: the files written, the original backed up and importing them; compiled CSS compared', () => {
  const css = '.a{x:1}.b{y:2}@media (max-width:1px){.a{z:3}}';
  assert.deepEqual(compareCss(css, '.a{x:1}.b{y:2}@media (max-width:1px){.a{z:3}}'), { rules: 3, same: true, missing: [], extra: [], reordered: [] });
  const moved = compareCss(css, '@media (max-width:1px){.a{z:3}}.a{x:1}.b{y:2}');
  assert.deepEqual([moved.same, moved.reordered], [true, ['.a']]);
  assert.deepEqual(compareCss(css, '.a{x:1}').missing.length, 2);
  const dir = copy();
  try {
    const i = buildIndex(dir, { cache: false });
    const preview = splitApply(i, 'everything.less', { compiler: null });
    assert.equal(preview.data.applied, false);
    assert.ok(!existsSync(join(dir, 'Shop.Web/Content/base')));
    const r = splitApply(i, 'everything.less', { apply: true, compiler: null });
    assert.equal(r.data.applied, true);
    const main = readFileSync(join(dir, 'Shop.Web/Content/everything.less'), 'utf8');
    assert.match(main, /@import "base\/variables";\n@import "base\/mixins";[\s\S]*@import "pages\/orders";\n@import "unused"; \/\/ rules no view/);
    assert.match(readFileSync(join(dir, 'Shop.Web/Content/pages/orders.less'), 'utf8'), /\/\/ ===== Orders =====\n\.order-table \{ border-collapse: collapse; \}[\s\S]*@media \(max-width: 600px\)/);
    assert.match(readFileSync(join(dir, 'Shop.Web/Content/base/variables.less'), 'utf8'), /@gray: #777;\n\n@radius: 4px;/);
    assert.ok(readdirSync(join(dir, '.pilot/backup')).length === 1);
    // Again: it only imports now, so there's nothing left to split.
    assert.equal(splitApply(buildIndex(dir, { cache: false }), 'everything.less', { apply: true, compiler: null }).data.error, 'only imports');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('extract: tags balanced, the partial written once, each copy a call to it', () => {
  assert.equal(tagDepth(['<div class="a">', '<img src="x">', '<span>t</span>']), 1);
  const all = ['</section>', '<div>', '  <p>x</p>', '  <div>', '  </div>', '</div>', '<b>after</b>'];
  assert.deepEqual(balance(all, 1, 4), [2, 6]);
  const dir = copy();
  try {
    const i = buildIndex(dir, { cache: false });
    const preview = extractPartial(i, 1);
    assert.deepEqual(preview.data.places.map((p) => [p.file, p.start, p.end]), [['Shop.Web/Areas/Admin/Views/Users/Index.cshtml', 5, 14], ['Shop.Web/Views/Home/Index.cshtml', 8, 17]]);
    assert.equal(preview.data.file, 'Shop.Web/Views/Shared/_InfoCard.cshtml');
    extractPartial(i, 1, { apply: true });
    const partial = readFileSync(join(dir, 'Shop.Web/Views/Shared/_InfoCard.cshtml'), 'utf8');
    assert.equal(tagDepth(partial.split('\n')), 0);
    assert.match(partial, /^<div class="info-card">[\s\S]*<\/div>\n$/);
    const home = readFileSync(join(dir, 'Shop.Web/Views/Home/Index.cshtml'), 'utf8');
    assert.match(home, /<a class="btn btn-save">x<\/a>\n@Html\.Partial\("_InfoCard"\)\n<img/);
    assert.doesNotMatch(home, /info-card-header/);
    assert.match(extractPartial(buildIndex(dir, { cache: false }), 9).text, /There are 0 repeated blocks|No repeated markup/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook: what Claude hears after an edit, and its install beside other hooks', async () => {
  const lines = await afterEdit(idx, 'Shop.Web/Views/Home/Index.cshtml');
  assert.match(lines[0], /is on 2 pages: \/, \/Home\/About/);
  assert.ok(lines.some((l) => /image "\/images\/logo\.png" not found/.test(l)));
  assert.ok(lines.some((l) => /no stylesheet in the project styles[^:]*: \.hero/.test(l)));
  assert.match((await afterEdit(idx, 'Shop.Web/Content/everything.less'))[0], /no page loads Shop\.Web\/Content\/everything\.less/);
  assert.deepEqual(await afterEdit(idx, 'Shop.Web/Scripts/jquery-3.4.1.js'), [], 'libraries are left alone');
  const out = await runHook({ input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'Shop.Web/Views/Orders/Index.cshtml') } }), env: { CLAUDE_PROJECT_DIR: ROOT }, build: () => idx });
  assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Index\.cshtml is on 1 page: \/Orders/);
  assert.equal(await runHook({ input: JSON.stringify({ tool_input: { file_path: '/elsewhere/x.cshtml' } }), env: { CLAUDE_PROJECT_DIR: ROOT }, build: () => idx }), '');
  assert.equal(await runHook({ input: 'not json', env: {}, build: () => idx }), '');
  const dir = mkdtempSync(join(tmpdir(), 'pilot-hook-'));
  try {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['x'] }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] } }));
    installHook(dir, 'pilot', { shots: true });
    installHook(dir, 'pilot', { shots: true });
    const s = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'));
    assert.deepEqual(s.permissions, { allow: ['x'] });
    assert.deepEqual(s.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }, { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'pilot hook', async: true, timeout: 120 }] }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.pilot/config.json'), 'utf8')).hook, { shots: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report: one self-contained HTML file, text escaped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-report-'));
  try {
    const r = report(idx, { out: join(dir, 'r.html') });
    const html = readFileSync(r.data.file, 'utf8');
    for (const s of ['Pages by complexity', 'How much Pilot understood', 'Style guide', 'Design consistency', 'Dead code', 'Accessibility', 'Images', 'Hard-coded text']) assert.ok(html.includes(s), s);
    assert.doesNotMatch(html, /<script|https?:\/\/(?!www\.w3)/);
    assert.match(html, /&lt;img src=&quot;\/images\/logo\.png&quot;&gt; without alt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the live tools without a browser: CSS rules, V8 coverage, widths, page sets, many shots', async () => {
  assert.deepEqual(cssRules('a{x:1}@media (x){.b{y:2}}@font-face{f:1}/* .c{} */.d,.e{z:3}@keyframes k{from{o:0}}').map((r) => r.selector), ['a', '.b', '.d,.e']);
  assert.deepEqual(usedBytes([{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] }, { ranges: [{ startOffset: 10, endOffset: 40, count: 0 }] }]), { used: 70, total: 100 });
  assert.deepEqual(breakpointWidths(idx), [360, 600, 601]);
  assert.deepEqual(pageSet(idx, 'all'), ['/Orders', '/Orders/Edit', '/', '/Admin/Users', '/Home/About', '/products']);
  assert.deepEqual(pageSet(idx, ['/a']), ['/a']);
  const dir = copy();
  try {
    const i = buildIndex(dir, { cache: false });
    const seen = [];
    const fake = async (_, page) => {
      seen.push(page);
      return { data: { url: `http://x${page}`, slug: page.slice(1) || 'home', shots: [{ width: '1280', label: 'after', compare: { share: page === '/Orders' ? 0.2 : 0 } }] } };
    };
    const r = await shots(i, ['/Orders', '/'], { shoot: fake, threshold: 5 });
    assert.deepEqual(seen, ['/Orders', '/']);
    assert.deepEqual(r.data.failed, ['http://x/Orders']);
    assert.equal(r.data.error, 'over threshold');
    assert.match(readFileSync(join(dir, '.pilot/shots/report.html'), 'utf8'), /20\.00% changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the UI\'s actions: only a POST with the header, and they do what the commands do', async () => {
  const dir = copy();
  try {
    let i = buildIndex(dir, { cache: false });
    const serve = handler({ index: () => i, refresh: () => (i = buildIndex(dir, { cache: false })), root: dir, port: () => 4170 });
    const call = (method, url, body, headers = {}) => new Promise((ok) => {
      const listeners = {};
      const req = { method, url, headers: { host: 'localhost:4170', ...headers }, on: (ev, fn) => { listeners[ev] = fn; } };
      const res = { headers: {}, setHeader() {}, writeHead(status) { this.status = status; return this; }, end(b) { ok({ status: this.status, body: String(b ?? '') }); } };
      serve(req, res);
      if (body != null) {
        listeners.data?.(JSON.stringify(body));
        listeners.end?.();
      }
    });
    assert.equal((await call('GET', '/api/action/rename')).status, 403);
    assert.equal((await call('POST', '/api/action/rename', {})).status, 403, 'no header');
    const preview = JSON.parse((await call('POST', '/api/action/rename', { from: '.order-row', to: '.order-line' }, { 'x-pilot': '1' })).body);
    assert.equal(preview.applied, false);
    assert.match(preview.text, /Would rename \.order-row → \.order-line/);
    const applied = JSON.parse((await call('POST', '/api/action/rename', { from: '.order-row', to: '.order-line', apply: true }, { 'x-pilot': '1' })).body);
    assert.equal(applied.applied, true);
    assert.ok(i.symbols.classes.has('order-line'), 'the index is read again after a write');
    const init = JSON.parse((await call('POST', '/api/action/init', { mcp: true, hook: true, command: 'pilot' }, { 'x-pilot': '1' })).body);
    assert.equal(init.done.length, 3);
    assert.ok(existsSync(join(dir, '.mcp.json')) && existsSync(join(dir, '.claude/settings.json')));
    assert.equal(JSON.parse((await call('POST', '/api/action/nope', {}, { 'x-pilot': '1' })).body).error, 'no such action');
    assert.equal((await call('GET', '/shots/..%2F..%2Fx.png')).status, 404);
    assert.deepEqual(Object.keys(ACTIONS).sort(), ['coverage', 'extract', 'init', 'inspect', 'rename', 'responsive', 'shots', 'split']);
    for (const kind of ['images', 'texts', 'models']) assert.ok(!JSON.parse((await call('GET', `/api/audit?kind=${kind}`)).body).error, kind);
    assert.ok(JSON.parse((await call('GET', '/api/doctor')).body).rows.length > 5);
    assert.ok(JSON.parse((await call('GET', '/api/styleguide')).body).colours.length);
    assert.match((await call('GET', '/report.html')).body, /^<!doctype html>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
