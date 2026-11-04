// The tools over test/fixtures/shop: changes, context packs, renames, the cascade, the audits
// (dead code, design, repeats, accessibility, weight), diagrams and screenshots (with a stand-in for
// the browser, and the PNG reader and diff on images made here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/index.js';
import { changes, gitChanges } from '../src/changes.js';
import { context, methodRange } from '../src/context.js';
import { rename, replaceInQuotes, replaceInSelector } from '../src/rename.js';
import { cascade, specificity } from '../src/cascade.js';
import { a11y, deadCode, design, normalizeColor, repeats, weight } from '../src/audit.js';
import { diagram } from '../src/diagram.js';
import { decodePng, diffImages, encodePng } from '../src/png.js';
import { compareShots, findChrome, pagePath, shot, slugOf } from '../src/shots.js';

const ROOT = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const idx = buildIndex(ROOT, { cache: false });

test('changes: changed files to the pages they reach', () => {
  const r = changes(idx, { files: ['Shop.Web/Content/variables.less', 'Shop.Web/Controllers/OrdersController.cs', { file: 'gone.cshtml', status: 'deleted' }] });
  const urls = r.data.pages.map((p) => p.url);
  assert.deepEqual(urls.slice(0, 2).sort(), ['/Orders', '/Orders/Edit']);
  assert.ok(urls.includes('/Admin/Users') && urls.includes('/Orders/Row'));
  assert.ok(!urls.some((u) => /CartSummary/.test(u)), 'child actions are not pages');
  assert.equal(r.data.files.find((f) => f.file === 'gone.cshtml').kind, null);
  // git's answers turned into project paths, under a project in a subfolder of the repository.
  const answers = { 'rev-parse --show-prefix': 'web/\n', 'rev-parse --verify HEAD': 'abc\n', 'diff --name-status -M HEAD': 'M\tweb/Views/A.cshtml\nR100\tweb/old.less\tweb/new.less\nM\tother/x.cs\n', 'ls-files --others --exclude-standard --full-name': 'web/Scripts/new.ts\n' };
  const run = (_, args) => answers[args.slice(2).join(' ')] ?? '';
  assert.deepEqual(gitChanges('/repo/web', { run }), [{ file: 'Views/A.cshtml', status: 'modified' }, { file: 'new.less', status: 'renamed' }, { file: 'Scripts/new.ts', status: 'untracked' }]);
});

test('context: the page, its actions, scripts and rules, within the budget', () => {
  const r = context(idx, '/Orders');
  const files = r.data.files.map((f) => f.file);
  assert.deepEqual(files.slice(0, 2), ['Shop.Web/Views/Orders/Index.cshtml', 'Shop.Web/Views/Orders/_OrderRow.cshtml']);
  assert.deepEqual(r.data.files.find((f) => f.file === 'Shop.Web/Controllers/OrdersController.cs').ranges, [[8, 12], [21, 26], [28, 31]]);
  assert.match(r.text, /### Shop\.Web\/Controllers\/OrdersController\.cs:28-31\n_answers GET \/Orders\/Row from Shop\.Web\/Scripts\/app\/orders\.ts:14/);
  assert.match(r.text, /```less\n\.order-table \{/);
  const small = context(idx, '/Orders', { budget: 1500 });
  assert.ok(small.data.used <= 1500 && small.data.omitted.length > 0);
  assert.match(small.text, /## Left out \(over the budget\)/);
  assert.deepEqual(methodRange(['  [HttpPost]', '  public X Y() {', '    a();', '  }'], 2), [1, 4]);
});

test('rename: a preview of every line, warnings where text can\'t be trusted, and --apply', () => {
  assert.equal(replaceInQuotes('<a class="btn btn-save">btn-save</a>', 'btn-save', 'go'), '<a class="btn go">btn-save</a>');
  assert.equal(replaceInSelector('.btn-save, .btn-saved { }', '.', 'btn-save', 'go'), '.go, .btn-saved { }');
  const r = rename(idx, '.btn-save', '.button-save');
  assert.deepEqual(r.data.changes.map((c) => `${c.file}:${c.line}`).sort(), ['Shop.Web/Content/everything.less:29', 'Shop.Web/Scripts/app/orders.ts:10', 'Shop.Web/Views/Home/Index.cshtml:7', 'Shop.Web/Views/Orders/Index.cshtml:11']);
  assert.ok(r.data.warnings.some((w) => /orders\.less:13: \.btn-save is built here/.test(w)), r.data.warnings.join('\n'));
  assert.match(rename(idx, '.order-row', '.btn').text, /\.btn already exists/);
  assert.match(rename(idx, '.nothing', '.x').text, /isn't styled, marked up or scripted/);
  const dir = mkdtempSync(join(tmpdir(), 'pilot-rename-'));
  try {
    cpSync(ROOT, dir, { recursive: true });
    const copy = buildIndex(dir, { cache: false });
    rename(copy, '#orders', '#order-list', { apply: true });
    assert.match(readFileSync(join(dir, 'Shop.Web/Views/Orders/Index.cshtml'), 'utf8'), /<table class="order-table" id="order-list">/);
    assert.match(readFileSync(join(dir, 'Shop.Web/Scripts/app/orders.ts'), 'utf8'), /\$\('#order-list'\)\.append\(html\)/);
    assert.match(readFileSync(join(dir, 'Shop.Web/Content/orders.less'), 'utf8'), /#order-list \{ font-size/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cascade: rules in load order, specificity, the winner per property, rules not loaded', () => {
  assert.deepEqual(specificity('#a .b:hover > li::before'), [1, 2, 2]);
  assert.deepEqual(specificity('a:not(.x)'), [0, 1, 1]);
  assert.deepEqual(specificity('.a:where(.b .c)'), [0, 1, 0]);
  const r = cascade(idx, '/Orders', '.order-table');
  assert.deepEqual(r.data.rules.map((x) => `${x.line} ${x.selector}`), ['1 .order-table', '3 .order-table tr', '4 .order-table tr.selected', '5 .order-table tr.late', '7 .order-table .order-row:hover', '8 .order-table .order-flag']);
  assert.equal(r.data.winners.background.line, 7);
  assert.equal(r.data.winners.position.important, true);
  assert.deepEqual(r.data.elsewhere.map((u) => u.line), [21, 38]);
  assert.match(r.text, /background: @brand {3}← overridden by orders\.less:7/);
  assert.match(cascade(idx, 'nope', '.x').text, /isn't a page/);
});

test('dead code, design, repeats, accessibility and weight', () => {
  const dead = deadCode(idx).data;
  assert.deepEqual(dead.styles.map((s) => s.file), ['Shop.Web/Content/everything.less']);
  assert.deepEqual(dead.classes.map((c) => c.name).sort(), ['legacy-banner', 'order-flag', 'promo-box']);
  assert.equal(normalizeColor('#C33'), '#cc3333');
  assert.equal(normalizeColor('rgb(204, 51, 51)'), '#cc3333');
  const d = design(idx).data;
  assert.deepEqual(d.useVariable.map((u) => [u.color, u.variables, u.uses.map((x) => x.line)]), [['#cc3333', ['@brand'], [7]]]);
  assert.deepEqual(d.near.map((n) => [n.a, n.b]), [['#cc3333', '#cc3434']]);
  assert.deepEqual(d.zindex, [{ value: '1050', places: ['Shop.Web/Content/orders.less:8'] }]);
  assert.equal(d.inline[0].file, 'Shop.Web/Views/Home/Index.cshtml');
  const rep = repeats(idx).data.blocks;
  assert.equal(rep.length, 1);
  assert.equal(rep[0].partial, '_InfoCard');
  assert.deepEqual(rep[0].places.map((p) => p.file).sort(), ['Shop.Web/Areas/Admin/Views/Users/Index.cshtml', 'Shop.Web/Views/Home/Index.cshtml']);
  const acc = a11y(idx).data.issues.map((x) => `${x.rule} ${x.file.split('/').pop()}:${x.line}`).sort();
  assert.deepEqual(acc, ['empty-button Index.cshtml:19', 'html-lang _Layout.cshtml:2', 'html-lang _Layout.cshtml:2', 'img-alt Index.cshtml:18']);
  const w = weight(idx).data;
  const orders = w.pages.find((p) => p.url === '/Orders');
  assert.deepEqual(orders.duplicates, [{ name: 'jquery', files: ['Shop.Web/Scripts/jquery-3.4.1.js'] }]);
  assert.ok(orders.scripts > 0 && orders.total === orders.scripts + orders.styles);
});

test('diagrams: a page, a path and a neighbourhood as Mermaid and DOT', () => {
  const page = diagram(idx, '/Orders').text;
  assert.match(page, /^```mermaid\n---\ntitle: \/Orders\n---\nflowchart TD/);
  assert.match(page, /n\d+ -\.->\|"GET \/Orders\/Row"\| n\d+/);
  assert.match(page, /-->\|"into #orders"\|/);
  assert.match(diagram(idx, 'Orders.Index', { to: '_OrderRow' }).text, /\|"renders"\|/);
  const dot = diagram(idx, '_Header', { format: 'dot' }).text;
  assert.match(dot, /^digraph pilot \{/);
  assert.match(dot, /label="_Header\.cshtml", color="#0ea5b7"/);
});

test('screenshots: PNGs read and written, compared, and shot with a stand-in browser', async () => {
  const img = (w, h, f) => {
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
    return { width: w, height: h, data };
  };
  const a = img(64, 64, () => [255, 255, 255, 255]);
  const b = img(64, 80, (x, y) => (x >= 32 && y < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const back = decodePng(encodePng(b));
  assert.deepEqual([back.width, back.height, back.data.equals(b.data)], [64, 80, true]);
  const d = diffImages(a, b);
  assert.equal(d.changed, 32 * 32 + 64 * 16);
  assert.deepEqual(d.boxes.map((x) => [x.x, x.y, x.width, x.height]).sort(), [[0, 64, 64, 16], [32, 0, 32, 32]].sort());

  assert.equal(slugOf('/Orders/Edit/5?x=1'), 'orders-edit-5');
  assert.deepEqual(pagePath(idx, 'Orders.Index'), { path: '/Orders' });
  assert.match(pagePath(idx, 'Products.Details').error, /\/products\/1/);
  assert.equal(findChrome({ PILOT_CHROME: '/x/chrome' }), '/x/chrome');
  assert.equal(findChrome({ PATH: '/nowhere' }, 'linux', () => false), null);

  const dir = mkdtempSync(join(tmpdir(), 'pilot-shots-'));
  try {
    cpSync(ROOT, dir, { recursive: true });
    const copy = buildIndex(dir, { cache: false });
    const frames = [a, b];
    const take = async (url) => ({ png: encodePng(frames.shift()), width: 64, height: 64, title: `t ${url}` });
    assert.match((await shot(copy, '/Orders', { capture: take })).text, /Where does the site run\?/);
    const first = await shot(copy, '/Orders', { url: 'http://localhost:5000/', widths: [64], capture: take });
    assert.deepEqual(first.data.shots.map((s) => [s.label, s.file]), [['before', '.pilot/shots/orders/before-64.png']]);
    assert.equal(first.data.url, 'http://localhost:5000/Orders');
    // The base URL is remembered; the second shot is the after, compared with the before.
    const second = await shot(copy, 'Orders.Index', { widths: [64], capture: take });
    assert.equal(second.data.shots[0].label, 'after');
    assert.ok(second.data.shots[0].compare.share > 0.3);
    assert.ok(existsSync(join(dir, '.pilot/shots/orders/diff-64.png')));
    assert.equal(readFileSync(join(dir, '.pilot/.gitignore'), 'utf8'), '*\n');
    assert.equal(compareShots(dir, 'nothing', 64), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
