// The index over test/fixtures/shop: an MVC5 project (Shop.Web: BundleConfig, an area, _ViewStart,
// nested layouts, child actions, templates, Web Compiler's LESS) and an ASP.NET Core one (Shop.Core:
// attribute routes, tag helpers, a view component, tsconfig outDir, bundleconfig.json), as one graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, routeSegment } from '../src/index.js';

const ROOT = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const idx = buildIndex(ROOT, { cache: false });
const out = (from, kind) => idx.out(from).filter((e) => !kind || e.kind === kind).map((e) => e.to);

test('controllers and actions, with ids naming the project when there are several', () => {
  assert.deepEqual([...idx.nodes.keys()].filter((k) => k.startsWith('action:')).sort(), [
    'action:Shop.Core:Products/Details',
    'action:Shop.Core:Products/Index',
    'action:Shop.Web:Admin/Users/Index',
    'action:Shop.Web:Home/About',
    'action:Shop.Web:Home/Index',
    'action:Shop.Web:Orders/CartSummary',
    'action:Shop.Web:Orders/Edit',
    'action:Shop.Web:Orders/Index',
    'action:Shop.Web:Orders/Row',
    'action:Shop.Web:Orders/Save',
  ]);
  assert.deepEqual(out('action:Shop.Web:Home/About', 'renders'), ['Shop.Web/Views/Home/Index.cshtml']);
  assert.deepEqual(out('action:Shop.Web:Orders/CartSummary', 'renders-partial'), ['Shop.Web/Views/Orders/CartSummary.cshtml']);
  assert.deepEqual(out('action:Shop.Web:Orders/Save'), []);
});

test('URLs to actions: conventional (with areas and defaults) and attribute routes', () => {
  const ids = (url) => idx.routeToAction(url).map((n) => n.id);
  assert.deepEqual(ids('/'), ['action:Shop.Web:Home/Index']);
  assert.deepEqual(ids('/orders/edit/5'), ['action:Shop.Web:Orders/Edit']);
  assert.deepEqual(ids('/Orders'), ['action:Shop.Web:Orders/Index']);
  assert.deepEqual(ids('/Admin/Users'), ['action:Shop.Web:Admin/Users/Index']);
  assert.deepEqual(ids('http://localhost:5000/products/42?x=1'), ['action:Shop.Core:Products/Details']);
  assert.deepEqual(ids('/products'), ['action:Shop.Core:Products/Index']);
  // Attribute-routed controllers aren't reachable conventionally.
  assert.deepEqual(ids('/Products/Details'), []);
  assert.deepEqual(ids('/Nope/Nothing'), []);
  assert.equal(routeSegment('{id:int}'), '-?\\d+');
  assert.equal(routeSegment('v{version?}.json'), 'v(?:[^/]+)?\\.json');
});

test('layouts: _ViewStart by folder, an area of its own, nested layouts, none for partials', () => {
  assert.deepEqual(out('Shop.Web/Views/Orders/Index.cshtml', 'layout'), ['Shop.Web/Views/Shared/_Layout.cshtml']);
  assert.deepEqual(out('Shop.Web/Areas/Admin/Views/Users/Index.cshtml', 'layout'), ['Shop.Web/Areas/Admin/Views/Shared/_AdminLayout.cshtml']);
  assert.deepEqual(out('Shop.Web/Areas/Admin/Views/Shared/_AdminLayout.cshtml', 'layout'), ['Shop.Web/Views/Shared/_Layout.cshtml']);
  assert.deepEqual(out('Shop.Core/Views/Products/Details.cshtml', 'layout'), ['Shop.Core/Views/Shared/_Layout.cshtml']);
  assert.deepEqual(out('Shop.Web/Views/Orders/_OrderRow.cshtml', 'layout'), []);
  assert.deepEqual(out('Shop.Web/Views/Orders/CartSummary.cshtml', 'layout'), []);
  assert.deepEqual(out('Shop.Web/Views/Shared/_Layout.cshtml', 'layout'), []);
});

test('views: partials, templates, components, child actions and links resolved', () => {
  assert.deepEqual(out('Shop.Web/Views/Shared/_Layout.cshtml', 'partial'), ['Shop.Web/Views/Shared/_Header.cshtml']);
  assert.deepEqual(out('Shop.Web/Views/Orders/Edit.cshtml', 'template'), ['Shop.Web/Views/Shared/EditorTemplates/DatePicker.cshtml']);
  assert.deepEqual(out('Shop.Core/Views/Shared/_Layout.cshtml', 'component'), ['Shop.Core/Views/Shared/Components/MiniCart/Default.cshtml']);
  assert.deepEqual(out('Shop.Core/Views/Shared/_Layout.cshtml', 'component-class'), ['Shop.Core/ViewComponents/MiniCartViewComponent.cs']);
  assert.deepEqual(out('Shop.Core/Views/Products/Details.cshtml', 'partial'), ['Shop.Core/Views/Products/_Price.cshtml']);
  assert.deepEqual(out('Shop.Web/Views/Shared/_Header.cshtml', 'child-action'), ['action:Shop.Web:Orders/CartSummary']);
  assert.deepEqual(out('Shop.Web/Views/Shared/_Header.cshtml', 'link').sort(), ['action:Shop.Web:Home/About', 'action:Shop.Web:Orders/Index']);
  assert.deepEqual(out('Shop.Web/Views/Orders/Edit.cshtml', 'link'), ['action:Shop.Web:Orders/Save']);
  assert.ok(!out('Shop.Web/Views/Shared/_Layout.cshtml').some((t) => /_Commented/.test(t ?? '')), 'a Razor comment is not a reference');
});

test('assets: bundles and members, compiled outputs to sources, tsconfig outDir, bundleconfig.json', () => {
  assert.deepEqual(out('Shop.Web/Views/Shared/_Layout.cshtml', 'script'), ['bundle:~/bundles/jquery', 'bundle:~/bundles/app']);
  assert.deepEqual(out('bundle:~/bundles/jquery'), ['Shop.Web/Scripts/jquery-3.4.1.js']);
  assert.deepEqual(out('bundle:~/bundles/app'), ['Shop.Web/Scripts/app/grid.js', 'Shop.Web/Scripts/shared/util.js']);
  assert.deepEqual(out('Shop.Web/Scripts/app/grid.js', 'source'), ['Shop.Web/Scripts/app/grid.ts']);
  assert.deepEqual(out('Shop.Web/Content/site.css', 'source'), ['Shop.Web/Content/site.less']);
  // orders.js isn't built: the view's <script> reaches its TypeScript directly.
  assert.deepEqual(idx.out('Shop.Web/Views/Orders/Index.cshtml').filter((e) => e.kind === 'script').map((e) => [e.to, e.built]), [['Shop.Web/Scripts/app/orders.ts', 'Shop.Web/Scripts/app/orders.js'], ['Shop.Web/Scripts/jquery-3.4.1.js', undefined]]);
  assert.deepEqual(out('Shop.Core/Views/Products/Details.cshtml', 'script'), ['Shop.Core/src/products.ts']);
  assert.deepEqual(out('Shop.Core/Views/Shared/_Layout.cshtml', 'style'), ['Shop.Core/wwwroot/css/site.css']);
  assert.deepEqual(idx.sourcesOf('Shop.Core/wwwroot/js/products.js').map((s) => [s.file, s.how]), [['Shop.Core/src/products.ts', 'tsconfig outDir']]);
  assert.ok(idx.out('Shop.Web/Views/Shared/_Layout.cshtml').some((e) => e.external && /cdn\.example\.com/.test(e.url)));
});

test('imports: TypeScript and LESS', () => {
  assert.deepEqual(out('Shop.Web/Scripts/app/orders.ts', 'import'), ['Shop.Web/Scripts/app/grid.ts']);
  assert.deepEqual(out('Shop.Web/Content/site.less', 'import'), ['Shop.Web/Content/variables.less', 'Shop.Web/Content/orders.less']);
  assert.deepEqual(out('Shop.Web/Scripts/app/orders.ts', 'calls'), ['action:Shop.Web:Orders/Save', 'action:Shop.Web:Orders/Row']);
  const row = idx.out('Shop.Web/Scripts/app/orders.ts').find((e) => e.kind === 'calls' && e.to.endsWith('/Row'));
  assert.deepEqual([row.method, row.url, row.via, row.target], ['GET', '/Orders/Row', 'jquery', '#orders']);
  assert.deepEqual(out('action:Shop.Web:Orders/Row', 'renders-partial'), ['Shop.Web/Views/Orders/_OrderRow.cshtml']);
});

test('dependents: a shared partial reaches every page through the layouts', () => {
  const deps = idx.dependents('Shop.Web/Views/Shared/_Header.cshtml').map((d) => d.id);
  for (const id of ['Shop.Web/Views/Shared/_Layout.cshtml', 'Shop.Web/Areas/Admin/Views/Users/Index.cshtml', 'action:Shop.Web:Home/Index', 'action:Shop.Web:Admin/Users/Index']) assert.ok(deps.includes(id), id);
  assert.ok(!deps.some((d) => d.startsWith('action:Shop.Core')), 'not the other project');
  const less = idx.dependents('Shop.Web/Content/variables.less').map((d) => d.id);
  for (const id of ['Shop.Web/Content/site.less', 'Shop.Web/Content/site.css', 'bundle:~/Content/css', 'Shop.Web/Views/Shared/_Layout.cshtml', 'action:Shop.Web:Orders/Index']) assert.ok(less.includes(id), id);
});

test('symbols: classes styled, marked up and scripted; variables and mixins', () => {
  const roles = (name) => [...new Set((idx.symbols.classes.get(name) ?? []).map((u) => `${u.role}:${u.file.split('/').pop()}`))].sort();
  assert.deepEqual(roles('order-row'), ['markup:_OrderRow.cshtml', 'script:orders.ts', 'style:everything.less', 'style:orders.less']);
  assert.deepEqual(roles('btn-save'), ['markup:Index.cshtml', 'script:orders.ts', 'style:everything.less', 'style:orders.less']);
  // The compiled site.css and grid.js say nothing their sources don't.
  assert.deepEqual(roles('selected'), ['script:grid.ts', 'style:orders.less']);
  assert.deepEqual(roles('ready'), ['script:Index.cshtml']);
  assert.equal(idx.symbols.vars.get('@brand').filter((u) => u.role === 'use').length, 3);
  assert.deepEqual(idx.symbols.mixins.get('rounded').map((u) => u.role).sort(), ['def', 'use']);
});

test('problems: what could not be resolved', () => {
  assert.deepEqual(idx.problems.map((p) => `${p.file}:${p.line} ${p.message}`).sort(), [
    'Shop.Web/Scripts/app/orders.ts:1 import "../typings/jquery.d.ts" not found',
    'Shop.Web/Views/Home/Index.cshtml:18 image "/images/logo.png" not found in the project',
    'Shop.Web/Views/Orders/Edit.cshtml:6 partial "_Missing" not found',
  ]);
});

test('file lookups ignore case, separators and the root', () => {
  assert.equal(idx.file('shop.web\\views\\orders\\index.cshtml').rel, 'Shop.Web/Views/Orders/Index.cshtml');
  assert.equal(idx.file(join(ROOT, 'Shop.Web/Content/site.less')).rel, 'Shop.Web/Content/site.less');
  assert.equal(idx.file('Shop.Web/Content/site.less:12').rel, 'Shop.Web/Content/site.less');
});

test('the cache: unchanged files come from it, a changed one is read again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
  const cache = mkdtempSync(join(tmpdir(), 'pilot-cache-'));
  const saved = process.env.PILOT_CACHE;
  process.env.PILOT_CACHE = cache;
  try {
    cpSync(ROOT, dir, { recursive: true });
    const first = buildIndex(dir);
    assert.equal(first.stats.cached, 0);
    const second = buildIndex(dir);
    assert.equal(second.stats.parsed, 0);
    const file = join(dir, 'Shop.Web/Views/Home/Index.cshtml');
    writeFileSync(file, '<section class="hero brand-new"></section>\n');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    const third = buildIndex(dir);
    assert.equal(third.stats.parsed, 1);
    assert.ok(third.symbols.classes.has('brand-new'));
    // A refresh of a live index (the MCP server's) re-reads only what changed, too.
    writeFileSync(file, '<section class="newer"></section>\n');
    utimesSync(file, new Date(), new Date(Date.now() + 10000));
    third.build();
    assert.equal(third.stats.parsed, 1);
    assert.ok(third.symbols.classes.has('newer') && !third.symbols.classes.has('brand-new'));
  } finally {
    if (saved === undefined) delete process.env.PILOT_CACHE;
    else process.env.PILOT_CACHE = saved;
    rmSync(dir, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});
