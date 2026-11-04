// The readers of each kind of file, on small inputs: Razor, TypeScript/JavaScript, LESS/SCSS/CSS, C#
// and the build configs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classTokens, parseRazor, staticUrl } from '../src/parse/razor.js';
import { parseScript, selectorTokens } from '../src/parse/script.js';
import { composeSelectors, parseStyle } from '../src/parse/style.js';
import { parseCSharp } from '../src/parse/csharp.js';
import { looseJson, parseConfig } from '../src/parse/config.js';
import { globRegExp } from '../src/index.js';

const names = (pairs) => [...new Set(pairs.map(([n]) => n))].sort();

test('Razor: model, layout, partials, templates, child actions, components and sections', () => {
  const v = parseRazor(`@model Shop.OrderVm
@{
    Layout = "~/Views/Shared/_Wide.cshtml";
    ViewBag.Title = "Orders";
}
@* @Html.Partial("_Gone") *@
<!-- @Html.Partial("_AlsoGone") -->
@Html.Partial("_Row", item)
@{ Html.RenderPartial("Shared/_Totals"); }
@await Html.PartialAsync("_Async")
<partial name="_Tag" model="Model" />
@Html.EditorFor(m => m.Date, "DatePicker")
@Html.Action("Summary", "Cart", new { area = "Shop" })
@await Component.InvokeAsync("MiniCart", new { max = 3 })
@await Component.InvokeAsync(typeof(BasketViewComponent))
<vc:recent-orders count="5"></vc:recent-orders>
@Html.Partial(Model.Name)
@section Scripts {
    <script src="~/js/orders.js"></script>
}
@RenderSection("Footer", required: false)
`);
  assert.equal(v.model.type, 'Shop.OrderVm');
  assert.deepEqual(v.layout, { value: '~/Views/Shared/_Wide.cshtml', line: 3 });
  assert.equal(v.title, 'Orders');
  assert.deepEqual(v.partials.map((p) => p.name), ['_Row', 'Shared/_Totals', '_Async', 'DatePicker', '_Tag']);
  assert.equal(v.partials.find((p) => p.name === 'DatePicker').template, 'EditorTemplates');
  assert.deepEqual(v.actions.map((a) => [a.action, a.controller, a.area]), [['Summary', 'Cart', 'Shop']]);
  assert.deepEqual(v.components.map((c) => c.name), ['MiniCart', 'Basket', 'RecentOrders']);
  assert.deepEqual(v.dynamic.map((d) => d.what), ['Html.Partial(Model.Name)']);
  assert.deepEqual(v.sections, [{ name: 'Scripts', line: 18, end: 20 }]);
  assert.deepEqual(v.scripts, [{ src: '~/js/orders.js', line: 19 }]);
  assert.deepEqual(v.renderSections, [{ name: 'Footer', required: false, line: 21 }]);
});

test('Razor: Layout = null, bundles, links, and RenderBody', () => {
  const v = parseRazor(`@{ Layout = null; }
<head>@Styles.Render("~/Content/css", "~/Content/theme")</head>
<body>@RenderBody()
@Scripts.Render("~/bundles/jquery")
<link rel="stylesheet" href="@Url.Content("~/Content/print.css")" media="print" />
<link rel="stylesheet" href="@ViewBag.Theme" />
@Html.ActionLink("Edit", "Edit", "Orders", new { id = 1 }, null)
@using (Html.BeginForm("Save", "Orders")) { }
<a asp-area="Admin" asp-controller="Users" asp-action="List">Users</a>
<a href="/Home/About">About</a>
</body>`);
  assert.deepEqual(v.layout, { value: null, line: 1 });
  assert.equal(v.renderBody, 3);
  assert.deepEqual(v.bundles.map((b) => [b.path, b.kind]), [['~/Content/css', 'style'], ['~/Content/theme', 'style'], ['~/bundles/jquery', 'script']]);
  assert.deepEqual(v.styles.map((s) => s.href), ['~/Content/print.css']);
  assert.equal(v.dynamic.length, 1);
  assert.deepEqual(v.links.map((l) => l.url ?? `${l.area ?? ''}/${l.controller}/${l.action}`), ['/Orders/Edit', '/Orders/Save', 'Admin/Users/List', '/Home/About']);
});

test('Razor: classes with Razor in them, ids, data- attributes, handlers and inline blocks', () => {
  const v = parseRazor(`<div class="card @(Model.Active ? "is-active" : "is-idle") @Model.Extra" id="main" data-role="panel">
  @Html.TextBoxFor(m => m.Name, new { @class = "form-control wide", data_bind = "x" })
  <button onclick="Orders.save(1); return false;">Save</button>
</div>
<script>
  $('.card .title').addClass('lit');
</script>
<style>
  .inline-only { color: red; }
</style>`);
  assert.deepEqual(names(v.classes), ['card', 'form-control', 'is-active', 'is-idle', 'wide']);
  assert.deepEqual(v.ids, [['main', 1]]);
  assert.deepEqual(names(v.attrs), ['data-bind', 'data-role']);
  assert.deepEqual(v.handlers.map((h) => [h.fn, h.line]), [['Orders.save', 3]]);
  assert.deepEqual(v.inline.script.classes.map(([n, l]) => [n, l]).sort(), [['card', 6], ['lit', 6], ['title', 6]]);
  assert.deepEqual(v.inline.style.classes.map(([n, l]) => [n, l]), [['inline-only', 9]]);
  assert.deepEqual(classTokens('a @x b-c @(y ? "d" : "")'), ['a', 'b-c', 'd']);
  assert.equal(staticUrl('@Url.Content("~/x.js")'), '~/x.js');
  assert.equal(staticUrl('@ViewBag.Src'), null);
});

test('scripts: imports of every kind, definitions, selectors, classes and routes', () => {
  const s = parseScript(`/// <reference path="../typings/jquery.d.ts" />
import { Grid } from './grid';
import './side-effect';
export * from "./reexport";
const lazy = () => import('./lazy');
const req = require('../lib/thing');
define(['jquery', 'app/util'], function ($, util) {});
// $('.commented-out')
export class OrderPage {
  render(): void {}
}
export function boot() {}
const onClick = (e) => {};
App.Orders.save = function () {};
Widget.prototype.draw = function () {};
namespace Shop.Ui { }
var SELECTORS = { row: 'tr.order-row', none: '.js' };
$('#orders .row.selected').find('[data-id]').addClass('is-busy hot');
document.querySelector('.panel > .head');
el.classList.toggle('open', true);
document.getElementById('total');
$(document).on('click', '.btn-save', go);
$('<li class="item new">');
$.post('/Orders/Save', data);
fetch(\`/api/orders/\${id}\`);
$(el).data('orderId');
`);
  assert.deepEqual(s.imports.map((i) => [i.spec, i.kind]), [
    ['../typings/jquery.d.ts', 'reference'],
    ['./grid', 'import'],
    ['./side-effect', 'import'],
    ['./reexport', 'export'],
    ['./lazy', 'import'],
    ['../lib/thing', 'require'],
    ['jquery', 'amd'],
    ['app/util', 'amd'],
  ]);
  const defs = s.defs.map((d) => `${d.kind} ${d.name}`);
  for (const d of ['class OrderPage', 'method render', 'function boot', 'function onClick', 'function App.Orders.save', 'method Widget.draw', 'namespace Shop.Ui']) assert.ok(defs.includes(d), d);
  assert.deepEqual(names(s.classes), ['btn-save', 'head', 'hot', 'is-busy', 'item', 'new', 'open', 'order-row', 'panel', 'row', 'selected']);
  assert.deepEqual(names(s.ids), ['orders', 'total']);
  assert.deepEqual(names(s.attrs), ['data-id', 'data-order-id']);
  assert.deepEqual(s.calls.map((c) => `${c.method} ${c.url} ${c.via}`), ['POST /Orders/Save jquery', 'GET /api/orders fetch']);
  assert.deepEqual(s.urls, []);
  assert.deepEqual(selectorTokens('a.btn[href$=".pdf"]:not(#x)'), { classes: ['btn'], ids: ['x'], attrs: ['href'] });
});

test('LESS: nesting and &, mixins, variables, imports, media, keyframes', () => {
  const l = parseStyle(`@import (reference) "variables";
@import "mixins.less";
// .commented { }
@brand: #c33;
.rounded(@r: 4px) { border-radius: @r; }
.card {
  color: @brand;
  .title { font-weight: bold; }
  &-header { .rounded(2px); }
  &.is-active, &:hover { color: darken(@brand, 10%); }
  @media (max-width: @screen-sm) {
    .title { font-size: 12px; }
  }
}
#orders > tr { .clearfix; }
@keyframes spin { from { opacity: 0; } to { opacity: 1; } }
.icon-@{name} { x: 1; }
`);
  assert.deepEqual(l.imports.map((i) => [i.spec, i.options]), [['variables', 'reference'], ['mixins.less', null]]);
  assert.deepEqual(l.vars.map((v) => [v.name, v.value]), [['@brand', '#c33']]);
  assert.deepEqual(l.mixins.map((m) => m.name), ['.rounded']);
  assert.deepEqual(l.mixinCalls.map(([n]) => n), ['.rounded', '.clearfix']);
  assert.deepEqual(l.rules.map((r) => r.selector), ['.card', '.card .title', '.card-header', '.card.is-active, .card:hover', '.card .title', '#orders > tr', '.icon-@{name}']);
  assert.equal(l.rules[4].media, '@media (max-width: @screen-sm)');
  // A nested rule records what it adds, not its parents' classes again.
  assert.deepEqual(l.classes.map(([n, line]) => `${n}:${line}`), ['card:6', 'title:8', 'card-header:9', 'is-active:10', 'title:12']);
  assert.deepEqual(l.ids.map(([n]) => n), ['orders']);
  assert.deepEqual([...new Set(l.varUses.map(([n]) => n))].sort(), ['@brand', '@name', '@r', '@screen-sm']);
  assert.deepEqual(composeSelectors(['.a', '.b'], '&-x, .y'), ['.a-x', '.a .y', '.b-x', '.b .y']);
});

test('SCSS and CSS: variables, mixins, includes, custom properties, url(//) kept', () => {
  const s = parseStyle(`@use "theme";
$gap: 8px;
@mixin pad($x) { padding: $x; }
.list { gap: $gap; @include pad(4px); &__item { margin: 0; } }`, 'scss');
  assert.deepEqual(s.imports.map((i) => i.spec), ['theme']);
  assert.deepEqual(s.vars.map((v) => v.name), ['$gap']);
  assert.deepEqual(s.mixins.map((m) => m.name), ['pad']);
  assert.deepEqual(s.mixinCalls.map(([n]) => n), ['pad']);
  assert.deepEqual(s.rules.map((r) => r.selector), ['.list', '.list__item']);
  const c = parseStyle(`:root { --brand: red; }
.a { background: url(//cdn.example.com/x.png); color: var(--brand); }
.b { color: blue; }`, 'css');
  assert.deepEqual(c.vars.map((v) => v.name), ['--brand']);
  assert.deepEqual(c.varUses.map(([n]) => n), ['--brand']);
  assert.deepEqual(c.rules.map((r) => r.selector), [':root', '.a', '.b']);
});

test('C#: controllers, actions and their views, routes, components, bundles', () => {
  const c = parseCSharp(`
[Area("Admin")]
[Route("admin/users")]
public class UsersController : BaseController
{
    [HttpGet("")]
    public async Task<IActionResult> Index() { return View(await _db.Users()); }

    [HttpGet("{id}")]
    public IActionResult Edit(int id) => View("EditUser", id);

    [HttpPost, ActionName("Edit")]
    public IActionResult EditPost(UserVm vm)
    {
        if (!ModelState.IsValid) return View("EditUser", vm);
        return RedirectToAction(nameof(Index));
    }

    public PartialViewResult Row() { return PartialView("_Row"); }
    public JsonResult Data() { return Json(new { a = "}" }); }
    public IActionResult Pick(string viewName) { return View(viewName); }
    [NonAction] public IActionResult Helper() { return View(); }
    private IActionResult Hidden() { return View(); }
}
public class CartViewComponent : ViewComponent
{
    public IViewComponentResult Invoke() => View("Compact");
}
public class BundleConfig {
    public static void Register(BundleCollection bundles) {
        bundles.Add(new ScriptBundle("~/bundles/app").Include("~/Scripts/a.js", "~/Scripts/b.js").IncludeDirectory("~/Scripts/x", "*.js", true));
        bundles.Add(new StyleBundle("~/Content/css").Include("~/Content/site.css"));
    }
}
routes.MapRoute(name: "Default", url: "{controller}/{action}/{id}", defaults: new { controller = "Dashboard", action = "Home" });
`);
  const [ctl] = c.controllers;
  assert.deepEqual([ctl.name, ctl.area, ctl.route, ctl.base], ['Users', 'Admin', 'admin/users', 'BaseController']);
  assert.deepEqual(ctl.actions.map((a) => [a.name, a.method, a.verbs.join(), a.routes.join(), a.views.map((v) => v.name ?? `?${v.dynamic}`).join()]), [
    ['Index', 'Index', 'GET', '', 'Index'],
    ['Edit', 'Edit', 'GET', '{id}', 'EditUser'],
    ['Edit', 'EditPost', 'POST', '', 'EditUser'],
    ['Row', 'Row', '', '', '_Row'],
    ['Data', 'Data', '', '', ''],
    ['Pick', 'Pick', '', '', '?viewName'],
  ]);
  assert.deepEqual(ctl.actions[2].redirects.map((r) => r.action), ['Index']);
  assert.equal(ctl.actions[4].json, true);
  assert.deepEqual(c.components.map((x) => [x.name, x.views.map((v) => v.name).join()]), [['Cart', 'Compact']]);
  assert.deepEqual(c.bundles.map((b) => [b.path, b.kind, b.include.length]), [['~/bundles/app', 'script', 3], ['~/Content/css', 'style', 1]]);
  assert.deepEqual(c.bundles[0].include[2], { dir: '~/Scripts/x', pattern: '*.js', deep: true });
  assert.deepEqual(c.routes.map((r) => [r.template, r.defaults]), [['{controller}/{action}/{id}', { controller: 'Dashboard', action: 'Home' }]]);
});

test('configs: bundleconfig, compilerconfig, tsconfig with comments, webpack entries', () => {
  assert.deepEqual(looseJson('{ /* c */ "a": [1, 2,], // x\n }'), { a: [1, 2] });
  assert.deepEqual(parseConfig('bundleconfig.json', '[{"outputFileName":"wwwroot/site.min.js","inputFiles":["wwwroot/js/*.js"]}]').bundles, [{ output: 'wwwroot/site.min.js', inputs: ['wwwroot/js/*.js'] }]);
  assert.deepEqual(parseConfig('compilerconfig.json', '[{"inputFile":"a.less","outputFile":"a.css"}]').compile, [{ input: 'a.less', output: 'a.css' }]);
  const ts = parseConfig('tsconfig.json', '{ "compilerOptions": { "outDir": "wwwroot/js", "rootDir": "src", }, }');
  assert.deepEqual([ts.outDir, ts.rootDir], ['wwwroot/js', 'src']);
  const wp = parseConfig('webpack.config.js', `module.exports = { entry: { main: './src/main.ts', admin: ['./src/admin.ts'] }, output: { path: path.resolve(__dirname, 'wwwroot', 'dist'), filename: '[name].bundle.js' } };`);
  assert.deepEqual(wp, { type: 'webpack', entries: { main: ['./src/main.ts'], admin: ['./src/admin.ts'] }, filename: '[name].bundle.js', outDir: 'wwwroot/dist' });
  assert.ok(globRegExp('~/Scripts/jquery-{version}.js'.slice(2)).test('Scripts/jquery-3.7.1.js'));
  assert.ok(globRegExp('Scripts/**/*.js').test('Scripts/a/b/c.js'));
  assert.ok(globRegExp('Scripts/**/*.js').test('Scripts/c.js'));
  assert.ok(!globRegExp('Scripts/*.js').test('Scripts/a/c.js'));
});

test('scripts: requests with their method, how they are made and where the answer goes', async () => {
  const { parseScript, urlOf } = await import('../src/parse/script.js');
  const s = parseScript(`
$.get('/Orders/Row/' + id, function (html) { $('#orders tbody').append(html); });
$('#details').load('@Url.Action("Details", "Orders")?id=' + id);
$.ajax({ url: 'Orders/Save', type: 'POST' }).done(function (r) { $('#msg').html(r); });
fetch(\`/api/orders/\${id}\`, { method: 'DELETE' });
axios.put('/Orders/Rename', data);
this.http.get<Order[]>('/api/orders').subscribe();
xhr.open('POST', '/Orders/Upload');
fetch(url);
someObject.load(thing);
document.getElementById('box').innerHTML = 'not a response';
`);
  assert.deepEqual(s.calls.map((c) => [c.method, c.url ?? `${c.controller}/${c.action}` ?? c.dynamic, c.via, c.target ?? null]), [
    ['GET', '/Orders/Row', 'jquery', '#orders tbody'],
    ['GET', 'Orders/Details', 'load', '#details'],
    ['POST', '/Orders/Save', 'ajax', '#msg'],
    ['DELETE', '/api/orders', 'fetch', null],
    ['PUT', '/Orders/Rename', 'axios', null],
    ['GET', '/api/orders', 'http', null],
    ['POST', '/Orders/Upload', 'xhr', null],
    ['GET', 'undefined/undefined', 'fetch', null],
  ]);
  assert.equal(s.calls.at(-1).dynamic, 'url');
  assert.deepEqual(urlOf("'@Url.Action(\"Row\", \"Orders\", new { area = \"Admin\" })'"), { action: 'Row', controller: 'Orders', area: 'Admin' });
  assert.deepEqual(urlOf("'/scripts/app.js'"), { dynamic: "'/scripts/app.js'" });
});

test('views: requests from data-ajax, htmx, data-url, Ajax.BeginForm and inline scripts', () => {
  const v = parseRazor(`<div id="lines" data-url="@Url.Action("Lines", "Orders")"></div>
<a href="/Orders/Row/1" data-ajax="true" data-ajax-update="#row">x</a>
<button hx-post="/Orders/Save" hx-target="#msg">Save</button>
@using (Ajax.BeginForm("Search", "Orders", new AjaxOptions { UpdateTargetId = "results", HttpMethod = "Get" })) { }
<script>
  var rowUrl = '@Url.Action("Row")';
  $.post('@Url.Action("Save", "Orders")', data);
</script>`);
  assert.deepEqual(v.calls.map((c) => [c.via, c.method, c.url ?? `${c.controller}/${c.action}`, c.target ?? null]), [
    ['data-url', 'GET', 'Orders/Lines', null],
    ['href', 'GET', '/Orders/Row/1', '#row'],
    ['hx-post', 'POST', '/Orders/Save', '#msg'],
    ['Ajax.BeginForm', 'GET', 'Orders/Search', '#results'],
    ['script', null, 'null/Row', null],
    ['script', null, 'Orders/Save', null],
  ]);
  assert.deepEqual(v.inline.script.calls.map((c) => [c.method, c.controller, c.action]), [['POST', 'Orders', 'Save']]);
  // A link that is also a request is listed once, as the request.
  assert.deepEqual(v.links, []);
});

test('widgets: library calls with their targets, server-side helpers and markup', async () => {
  const { findWidgets } = await import('../src/parse/widgets.js');
  const js = findWidgets(`
$('#orders').DataTable({ paging: true });
$("#start, #end").datepicker();
$(this).find('.js-pick').select2();
$('#dlg').modal('hide');
$('#dlg').modal({ backdrop: 'static' });
var cal = new FullCalendar.Calendar(document.getElementById('calendar'), {});
new Chart(document.getElementById('sales'), {});
tinymce.init({ selector: '#body' });
flatpickr('#when');
new agGrid.Grid(document.querySelector('#grid'), opts);
`);
  assert.deepEqual(js.map((w) => `${w.kind}|${w.lib}|${w.target ?? ''}`), [
    'data table|DataTables|#orders',
    'date picker|jQuery UI / bootstrap-datepicker|#start, #end',
    'select|select2|.js-pick',
    'modal|Bootstrap|#dlg',
    'calendar|FullCalendar|calendar',
    'date picker|flatpickr|#when',
    'data table|ag-Grid|#grid',
    'chart|Chart.js|sales',
    'rich editor|TinyMCE|#body',
  ]);
  const html = findWidgets(`@(Html.Kendo().Grid<Order>()
    .Name("ordersGrid"))
<table class="table datatable" id="list"></table>
<div class="modal fade" id="confirm"></div>
<input type="date" name="d" />
<form method="post"></form>`, { markup: true, scripts: false });
  assert.deepEqual(html.map((w) => `${w.kind}|${w.lib}|${w.target ?? ''}`), [
    'data table|Kendo UI (MVC)|#ordersGrid',
    'data table|DataTables (markup)|#list',
    'date picker|HTML input|',
    'modal|Bootstrap|#confirm',
    'form|HTML|',
    'table|HTML|',
  ]);
});

test('LESS: top-level blocks with their ranges, and section headings', () => {
  const l = parseStyle(`// ===== Variables =====
@brand: red;
@import "x";
/* ------------------------------
   Orders page
   ------------------------------ */
.orders {
  .row { a: b; }
}
.m(@x) { a: @x; }
// --- Buttons ---
@media (max-width: 1px) { .btn { x: y; } }
@keyframes spin { from { a: b; } }
@font-face { font-family: X; }
// just a comment about colours
.btn { c: d; }
`);
  assert.deepEqual(l.blocks.map((b) => `${b.type} ${b.start}-${b.end}`), ['var 2-2', 'import 3-3', 'rule 7-9', 'mixin 10-10', 'media 12-12', 'keyframes 13-13', 'font-face 14-14', 'rule 16-16']);
  assert.deepEqual(l.blocks[2].classes, [0, 2]);
  assert.deepEqual(l.headers, [{ line: 1, title: 'Variables' }, { line: 5, title: 'Orders page' }, { line: 11, title: 'Buttons' }]);
});
