// What Claude reads: the queries' text and data over the fixture, the command line and the MCP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/index.js';
import { file, find, impact, overview, page, problems, resolveTarget, routes, selector, styleSymbol } from '../src/queries.js';
import { mcpServer, parseArgs, run, writeMcpJson } from '../src/cli.js';
import { writeFileSync } from 'node:fs';
import { TOOLS, createServer } from '../src/mcp.js';
import { mcpHandler } from '@fleet/kit/mcp.js';

const ROOT = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const idx = buildIndex(ROOT, { cache: false });

test('targets: URLs, Controller.Action, paths and names', () => {
  assert.deepEqual(resolveTarget(idx, '/Orders/Edit/3').actions, ['action:Shop.Web:Orders/Edit']);
  assert.deepEqual(resolveTarget(idx, 'OrdersController.Edit').actions, ['action:Shop.Web:Orders/Edit']);
  assert.deepEqual(resolveTarget(idx, 'Admin/Users.Index').actions, ['action:Shop.Web:Admin/Users/Index']);
  assert.deepEqual(resolveTarget(idx, 'Orders/Edit').actions, ['action:Shop.Web:Orders/Edit']);
  assert.deepEqual(resolveTarget(idx, '_Header').files, ['Shop.Web/Views/Shared/_Header.cshtml']);
  assert.deepEqual(resolveTarget(idx, 'orders.less').files, ['Shop.Web/Content/orders.less']);
  assert.equal(resolveTarget(idx, '_Layout').candidates.length, 2);
});

test('page: action, view, layouts, render tree and assets in load order with their sources', () => {
  const { data, text } = page(idx, '/Admin/Users');
  assert.match(text, /^Action {2}Admin\/UsersController\.Index {2}Shop\.Web\/Areas\/Admin\/Controllers\/UsersController\.cs:5 {3}\/Admin\/Users$/m);
  const [v] = data.views;
  assert.deepEqual(v.layouts.map((l) => l.file), ['Shop.Web/Areas/Admin/Views/Shared/_AdminLayout.cshtml', 'Shop.Web/Views/Shared/_Layout.cshtml']);
  assert.match(text, /▸ body ← Shop\.Web\/Areas\/Admin\/Views\/Shared\/_AdminLayout\.cshtml\n\s+▸ body ← Shop\.Web\/Areas\/Admin\/Views\/Users\/Index\.cshtml/);
  assert.match(text, /child action OrdersController\.CartSummary \(child-only\)/);
  assert.deepEqual(v.assets.map((a) => a.file ?? a.url), ['Shop.Web/Content/site.css', 'https://cdn.example.com/icons.css', 'Shop.Web/Scripts/jquery-3.4.1.js', 'Shop.Web/Scripts/app/grid.js', 'Shop.Web/Scripts/shared/util.js', 'Shop.Web/Scripts/app/admin.js']);
  assert.match(text, /Shop\.Web\/Content\/site\.css ← edit Shop\.Web\/Content\/site\.less via bundle ~\/Content\/css/);
  assert.match(text, /Shop\.Web\/Scripts\/app\/grid\.js ← edit Shop\.Web\/Scripts\/app\/grid\.ts via bundle ~\/bundles\/app/);
  // The view's section Scripts goes where the layout renders it, after the bundles.
  const orders = page(idx, 'Orders.Index').data.views[0];
  assert.deepEqual(orders.assets.at(-1), { kind: 'script', url: '~/Scripts/app/orders.js', file: 'Shop.Web/Scripts/app/orders.js', built: true, vendor: false, sources: ['Shop.Web/Scripts/app/orders.ts'], from: 'Shop.Web/Views/Orders/Index.cshtml:15', section: 'Scripts', own: true });
  assert.match(page(idx, 'Orders.Save').text, /returns JSON, no view/);
  assert.match(page(idx, 'Orders/Edit').text, /Html\.Partial\(Model\.PartialName\)/);
  assert.match(page(idx, '/products/3').text, /component MiniCart → Shop\.Core\/Views\/Shared\/Components\/MiniCart\/Default\.cshtml/);
});

test('file: a view, a script, a stylesheet and a controller in context', () => {
  const view = file(idx, 'Shop.Web/Views/Orders/Index.cshtml').text;
  assert.match(view, /^ {2}\.order-table {2}Shop\.Web\/Content\/everything\.less:21, Shop\.Web\/Content\/everything\.less:38, Shop\.Web\/Content\/orders\.less:1$/m);
  assert.match(view, /onclick="Orders\.save\(\)" line 11 → Shop\.Web\/Scripts\/app\/orders\.ts:5/);
  assert.match(view, /Shown on 1 page/);
  const ts = file(idx, 'orders.ts').text;
  assert.match(ts, /builds to Shop\.Web\/Scripts\/app\/orders\.js/);
  assert.match(ts, /calls +OrdersController\.Save \[POST\]/);
  assert.match(ts, /\.is-dirty {2}\(no style found\)/);
  const css = file(idx, 'Shop.Web/Content/site.css').text;
  assert.match(css, /built from Shop\.Web\/Content\/site\.less \(compilerconfig\.json\): edit that instead/);
  const cs = file(idx, 'OrdersController.cs').text;
  assert.match(cs, /Edit \[GET\] line 15 {2}\/Orders\/Edit {2}→ Shop\.Web\/Views\/Orders\/Edit\.cshtml/);
  assert.match(cs, /Save \[POST\] line 23 {2}\/Orders\/Save {2}→ JSON/);
  assert.doesNotMatch(cs, /Helper/);
});

test('impact: a LESS partial reaches the stylesheet, the bundle, the layout and every page using it', () => {
  const { data, text } = impact(idx, 'variables.less');
  assert.deepEqual(data.files.sort(), ['Shop.Web/Content/site.css', 'Shop.Web/Content/site.less', 'bundle:~/Content/css'].sort());
  assert.deepEqual(data.pages.map((p) => p.url).sort(), ['/', '/Admin/Users', '/Home/About', '/Orders', '/Orders/Edit']);
  assert.match(text, /^Changing Shop\.Web\/Content\/variables\.less reaches 5 pages/);
});

test('selector: styled (nested, in media), marked up, scripted; wildcards; not found', () => {
  const row = selector(idx, '.order-row', { snippets: false }).text;
  assert.match(row, /Styled in \(2\):\n {4}Shop\.Web\/Content\/everything\.less:22 {2}\.order-row\n {4}Shop\.Web\/Content\/orders\.less:7 {2}\.order-table \.order-row:hover/);
  assert.match(row, /Marked up in \(1\):\n {4}Shop\.Web\/Views\/Orders\/_OrderRow\.cshtml:2/);
  assert.match(row, /Used by scripts in \(1\):\n {4}Shop\.Web\/Scripts\/app\/orders\.ts:6/);
  assert.match(selector(idx, '#orders').text, /orders\.less:19 {2}#orders {2}\(in @media \(max-width: 600px\)\)/);
  assert.match(selector(idx, 'orders').text, /^#orders:/m);
  assert.match(selector(idx, '.btn-save').text, /Shop\.Web\/Views\/Orders\/Index\.cshtml:11 {3}<button type="button" class="btn btn-save"/);
  assert.deepEqual(selector(idx, '.order-*').data.matches.map((m) => m.name), ['.order-row', '.order-table']);
  assert.deepEqual(selector(idx, '[data-order-id]').data.results[0].uses.map((u) => u.role), ['markup']);
  assert.match(selector(idx, '.nothing-like-it').text, /isn't used, styled or scripted anywhere/);
});

test('style, find, routes, problems, overview', () => {
  const brand = styleSymbol(idx, '@brand').text;
  assert.match(brand, /Shop\.Web\/Content\/variables\.less:1 {2}= #c33/);
  assert.match(brand, /Compiled into: Shop\.Web\/Content\/site\.less → Shop\.Web\/Content\/site\.css$/m);
  assert.match(styleSymbol(idx, '.rounded').text, /^mixin \.rounded/);
  assert.deepEqual(find(idx, 'cart').data.results.map((r) => `${r.kind} ${r.name}`).slice(0, 3), ['action Orders.CartSummary', 'view Shop.Web/Views/Orders/CartSummary.cshtml', 'view component MiniCart']);
  assert.match(routes(idx).text, /^ {2}\/products\/\{id:int\} +ProductsController\.Details \[GET\] +Shop\.Core\/Views\/Products\/Details\.cshtml$/m);
  assert.equal(problems(idx).data.problems.length, 2);
  const o = overview(idx);
  assert.deepEqual(o.data.counts.views, 19);
  assert.deepEqual([o.data.counts.layouts, o.data.counts.partials, o.data.counts.actions], [3, 6, 10]);
  assert.deepEqual(o.data.rootStylesheets.sort(), ['Shop.Web/Content/everything.less', 'Shop.Web/Content/site.less']);
});

test('the command line: arguments, text, --json, exit codes, init', async () => {
  assert.deepEqual(parseArgs(['--root', ROOT, 'selector', '.btn', '--json', '--ignore', 'a,b/c']).ignore, ['a', 'b/c']);
  const output = [];
  const errors = [];
  const io = { write: (s) => output.push(s), error: (s) => errors.push(s) };
  assert.equal(await run(['--root', ROOT, '--no-cache', 'page', '/Orders'], io), 0);
  assert.match(output.join(''), /Action {2}OrdersController\.Index/);
  output.length = 0;
  assert.equal(await run(['--root', ROOT, '--no-cache', '--json', 'selector', '#orders'], io), 0);
  assert.equal(JSON.parse(output.join('')).results[0].name, '#orders');
  assert.equal(await run(['--root', ROOT, '--no-cache', 'page'], io), 2);
  assert.match(errors.join(''), /pilot page needs a URL/);
  assert.equal(await run(['--root', ROOT, '--no-cache', 'file', 'nope.cshtml'], io), 1);
  assert.equal(await run(['--root', ROOT, 'frobnicate'], io), 2);
  const dir = mkdtempSync(join(tmpdir(), 'pilot-init-'));
  try {
    assert.equal(await run(['--root', dir, 'init'], io), 0);
    assert.match(readFileSync(join(dir, '.claude', 'skills', 'pilot', 'SKILL.md'), 'utf8'), /^---\nname: pilot\ndescription: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the MCP server: tools, answers, errors as results', async () => {
  const server = createServer({ root: ROOT, build: (root) => buildIndex(root, { cache: false }) });
  const handle = mcpHandler({ name: 'pilot', version: 'test', tools: TOOLS, call: server.call });
  const list = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['overview', 'page', 'file', 'impact', 'selector', 'style', 'find', 'path', 'widgets', 'complexity', 'stylesheets', 'split', 'routes', 'problems']);
  assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint));
  const call = (name, args) => handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  const sel = await call('selector', { selector: '.late' });
  assert.match(sel.result.content[0].text, /orders\.less:5 {2}\.order-table tr\.late/);
  const err = await call('impact', {});
  assert.equal(err.result.isError, true);
  assert.equal(err.result.content[0].text, 'path is required.');
  const unknown = await call('nope', {});
  assert.equal(unknown.error.code, -32602);
});

test('init --mcp: the skill, and Pilot added to .mcp.json beside the servers already there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-mcp-'));
  const io = { write: () => {}, error: () => {} };
  try {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }));
    assert.equal(await run(['--root', dir, 'init', '--mcp', '--command', 'pilot'], io), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers, { other: { command: 'x', args: [] }, pilot: { type: 'stdio', command: 'pilot', args: ['mcp'] } });
    assert.ok(readFileSync(join(dir, '.claude', 'skills', 'pilot', 'SKILL.md'), 'utf8').length > 100);
    // Again: replaced, not added twice.
    writeMcpJson(dir, { command: 'C:\\tools\\pilot.exe', args: ['mcp'] });
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers), ['other', 'pilot']);
    writeFileSync(join(dir, '.mcp.json'), '{ not json');
    assert.equal(await run(['--root', dir, 'init', '--mcp'], io), 2);
    assert.equal(readFileSync(join(dir, '.mcp.json'), 'utf8'), '{ not json', 'a broken file is left alone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A build runs as `pilot` from the PATH; a checkout through node and its own bin/pilot.js.
  assert.deepEqual(mcpServer(null, { compiled: true }), { command: 'pilot', args: ['mcp'] });
  const fromCheckout = mcpServer(null, { compiled: false });
  assert.equal(fromCheckout.command, 'node');
  assert.match(fromCheckout.args[0], /bin[\\/]pilot\.js$/);
  assert.deepEqual(mcpServer('/opt/pilot'), { command: '/opt/pilot', args: ['mcp'] });
});
