// The analysis over test/fixtures/shop: a page's model (requests and what answers them, widgets,
// metrics and score), complexity, the widget inventory, splitting a stylesheet, paths and graphs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/index.js';
import { complexity, graph, level, pageModel, path, split, stylesheets, widgets } from '../src/analysis.js';
import { page } from '../src/queries.js';

const ROOT = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const idx = buildIndex(ROOT, { cache: false });
const ORDERS = 'Shop.Web/Views/Orders/Index.cshtml';

test("a page's requests: the script, the action, the partial it returns and where it lands", () => {
  const m = pageModel(idx, ORDERS);
  assert.deepEqual(m.calls.map((c) => [c.from, c.method, c.request, c.action, c.returns.map((r) => r.file), c.json, c.target, c.targetIn]), [
    ['Shop.Web/Scripts/app/orders.ts', 'POST', '/Orders/Save', 'action:Shop.Web:Orders/Save', [], true, null, undefined],
    ['Shop.Web/Scripts/app/orders.ts', 'GET', '/Orders/Row', 'action:Shop.Web:Orders/Row', ['Shop.Web/Views/Orders/_OrderRow.cshtml'], false, '#orders', ['Shop.Web/Views/Orders/Index.cshtml:5']],
  ]);
  assert.ok(m.calls.every((c) => c.own));
  // orders.ts imports grid.ts: both are the page's scripts.
  assert.deepEqual(m.scripts.filter((s) => s.own && !s.vendor).map((s) => s.file).sort(), ['Shop.Web/Scripts/app/grid.ts', 'Shop.Web/Scripts/app/orders.ts']);
  // The layout's bundle loads grid.js too, and its util.js is the layout's alone.
  assert.equal(m.scripts.find((s) => s.file === 'Shop.Web/Scripts/shared/util.js').own, false);
  const text = page(idx, '/Orders').text;
  assert.match(text, /orders\.ts:14 {2}GET \/Orders\/Row → OrdersController\.Row .* → partial Shop\.Web\/Views\/Orders\/_OrderRow\.cshtml → into #orders \(Shop\.Web\/Views\/Orders\/Index\.cshtml:5\)/);
});

test("a page's widgets, bound to its markup", () => {
  const m = pageModel(idx, ORDERS);
  const w = m.widgets.find((x) => x.kind === 'data table');
  assert.deepEqual([w.lib, w.target, w.file, w.boundTo], ['DataTables', '#orders', 'Shop.Web/Scripts/app/orders.ts', ['Shop.Web/Views/Orders/Index.cshtml:5']]);
  assert.match(page(idx, '/Orders').text, /data table +DataTables on #orders {2}Shop\.Web\/Scripts\/app\/orders\.ts:19 → Shop\.Web\/Views\/Orders\/Index\.cshtml:5/);
});

test('metrics and the score count the page itself, not its layouts', () => {
  const m = pageModel(idx, ORDERS).metrics;
  assert.deepEqual([m.views, m.depth, m.scripts, m.requests, m.widgets, m.childActions, m.layoutViews], [2, 2, 2, 2, 3, 0, 3]);
  assert.ok(m.score > 0 && m.score < 100);
  assert.equal(m.level, level(m.score));
  assert.equal(m.parts.reduce((n, p) => n + p.points, 0).toFixed(1), m.raw.toFixed(1));
  // The home page has less of its own than Orders, though both share the layout's child action.
  assert.ok(pageModel(idx, 'Shop.Web/Views/Home/Index.cshtml').metrics.score < m.score);
  assert.deepEqual([level(10), level(40), level(60), level(90)], ['simple', 'moderate', 'complex', 'very complex']);
});

test('complexity ranks pages; widgets are listed by kind with their pages', () => {
  const c = complexity(idx);
  assert.equal(c.data.pages[0].url, '/Orders');
  assert.ok(c.data.pages.every((p, i, all) => i === 0 || all[i - 1].score >= p.score));
  assert.ok(!c.data.pages.some((p) => /CartSummary/.test(p.label)), 'child actions are not pages');
  const w = widgets(idx);
  const table = w.data.kinds.find((k) => k.kind === 'data table');
  assert.deepEqual(table.libs[0].places.map((p) => [p.file, p.target, p.pages, p.boundTo]), [['Shop.Web/Scripts/app/orders.ts', '#orders', ['/Orders'], ['Shop.Web/Views/Orders/Index.cshtml:5']]]);
  assert.deepEqual(widgets(idx, { kind: 'picker' }).data.kinds.map((k) => k.kind), ['date picker']);
});

test('split: a stylesheet grouped by what each block is and where its classes are used', () => {
  const { data, text } = split(idx, 'everything.less');
  const by = Object.fromEntries(data.groups.map((g) => [g.file, g.ranges.map(([a, b]) => `${a}-${b}`).join(',')]));
  assert.deepEqual(by, {
    'base/variables.less': '2-3',
    'base/mixins.less': '5-5',
    'base/fonts.less': '7-7',
    'base/elements.less': '10-11',
    'base/animations.less': '35-35',
    'layout.less': '14-18',
    'components/btn.less': '28-29',
    'pages/orders.less': '21-25,37-39',
    'unused.less': '32-33',
  });
  assert.deepEqual(data.headers.map((h) => h.title), ['Variables', 'Base', 'Header', 'Orders', 'Buttons', 'Old stuff']);
  assert.match(text, /@import "base\/variables";\n {2}@import "base\/mixins";/);
  assert.doesNotMatch(text, /@import "unused"/);
  // A file that only imports others points at the largest of them.
  assert.deepEqual(split(idx, 'site.less').data.imports.map((i) => i.file), ['Shop.Web/Content/orders.less', 'Shop.Web/Content/variables.less']);
  assert.equal(stylesheets(idx).data.stylesheets[0].file, 'Shop.Web/Content/everything.less');
  assert.match(split(idx, 'orders.ts').text, /not a stylesheet/);
});

test('path: forward first, through requests', () => {
  const p = path(idx, 'Orders.Index', 'Orders.Row');
  assert.deepEqual(p.data.steps.map((s) => [s.kind, s.direction]), [['renders', 'out'], ['script', 'out'], ['calls', 'out']]);
  assert.match(p.text, /↓ calls GET \/Orders\/Row @ Shop\.Web\/Scripts\/app\/orders\.ts:14/);
  // Only backwards: the partial is used by the action that returns it.
  const back = path(idx, '_OrderRow', 'Orders.Row');
  assert.deepEqual(back.data.steps.map((s) => [s.kind, s.direction]), [['renders-partial', 'in']]);
  assert.match(path(idx, 'nope.cshtml', 'Orders.Row').text, /Not found/);
});

test('graph: what uses a node on the left, what it uses on the right, each at its nearer side', () => {
  const g = graph(idx, ORDERS, { depth: 2 });
  const layer = Object.fromEntries(g.data.nodes.map((n) => [n.id, n.layer]));
  assert.equal(layer[ORDERS], 0);
  assert.equal(layer['action:Shop.Web:Orders/Index'], -1);
  assert.equal(layer['Shop.Web/Scripts/app/orders.ts'], 1);
  assert.equal(layer['action:Shop.Web:Orders/Row'], 2);
  // _OrderRow is a partial of the view (+1), and also what Row returns: the nearer side wins.
  assert.equal(layer['Shop.Web/Views/Orders/_OrderRow.cshtml'], 1);
  assert.ok(g.data.edges.some((e) => e.kind === 'calls' && e.method === 'GET' && e.target === '#orders'));
  assert.ok(!g.data.nodes.some((n) => n.vendor), 'libraries left out unless asked');
  const onlyLayouts = graph(idx, ORDERS, { depth: 3, kinds: ['layout'] });
  assert.deepEqual(onlyLayouts.data.nodes.map((n) => n.id).sort(), [ORDERS, 'Shop.Web/Views/Shared/_Layout.cshtml']);
});
