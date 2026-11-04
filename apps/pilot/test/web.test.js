// The web UI's server: the page, the API over the fixture, the Host check and the source guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/index.js';
import { claudeSetup, handler } from '../src/web/server.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageHtml } from '../src/web/page.js';
import { client } from '../src/web/client.js';

const ROOT = fileURLToPath(new URL('./fixtures/shop', import.meta.url));
const idx = buildIndex(ROOT, { cache: false });

/** Calls the handler as a server would, without a socket. */
function get(url, host = 'localhost:4170') {
  const serve = handler({ index: () => idx, refresh: () => idx, root: ROOT, port: () => 4170 });
  return new Promise((ok) => {
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      writeHead(status, headers) {
        this.status = status;
        Object.assign(this.headers, headers);
        return this;
      },
      end(body) {
        ok({ status: this.status, headers: this.headers, body: String(body ?? '') });
      },
    };
    serve({ method: 'GET', url, headers: { host } }, res);
  });
}

test('the page: one HTML file, the client inline and valid, a strict CSP, nothing from the network', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.doesNotMatch(r.body, /https?:\/\/(?!www\.w3\.org|localhost[:/])/, 'no external URL');
  assert.doesNotThrow(() => new Function(`return (${client.toString()})`));
  // The project's path can't end the script early.
  assert.doesNotMatch(pageHtml({ root: '</script><b>', version: '1' }), /<\/script><b>/);
});

test('the API answers the queries as JSON', async () => {
  const pages = JSON.parse((await get('/api/pages')).body);
  assert.equal(pages.pages[0].url, '/Orders');
  const p = JSON.parse((await get('/api/page?target=%2FOrders')).body);
  assert.equal(p.views[0].root.type, 'root');
  assert.equal(p.views[0].calls.length, 2);
  const g = JSON.parse((await get('/api/graph?focus=Shop.Web%2FViews%2FOrders%2FIndex.cshtml&depth=1')).body);
  assert.ok(g.nodes.length > 2 && g.edges.length > 1);
  const n = JSON.parse((await get('/api/node?id=action%3AShop.Web%3AOrders%2FRow')).body);
  assert.deepEqual([n.type, n.out.map((e) => e.id)], ['action', ['Shop.Web/Views/Orders/_OrderRow.cshtml']]);
  const src = JSON.parse((await get('/api/source?file=Shop.Web%2FViews%2FOrders%2FIndex.cshtml&line=5')).body);
  assert.equal(src.lines[src.line - src.start], '<table class="order-table" id="orders">');
  for (const path of ['/api/overview', '/api/widgets', '/api/stylesheets', '/api/split?file=everything.less', '/api/find?q=order', '/api/path?from=Orders.Index&to=Orders.Row', '/api/problems', '/api/selector?q=.order-row']) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    JSON.parse(r.body);
  }
  assert.equal((await get('/api/nope')).status, 404);
});

test("only this machine, and only the project's files", async () => {
  assert.equal((await get('/api/overview', 'evil.example:4170')).status, 403);
  assert.equal((await get('/api/overview', '127.0.0.1:4170')).status, 200);
  for (const f of ['../../../package.json', '/etc/passwd', 'Shop.Web/../../../../package.json']) {
    const r = JSON.parse((await get(`/api/source?file=${encodeURIComponent(f)}`)).body);
    assert.equal(r.error, 'not a file of the project', f);
  }
});

test('the Claude Code card: whether the skill and the .mcp.json entry are there', async () => {
  const fresh = JSON.parse((await get('/api/claude')).body);
  assert.deepEqual([fresh.skill, fresh.mcp], [false, false]);
  const dir = mkdtempSync(join(tmpdir(), 'pilot-cc-'));
  try {
    mkdirSync(join(dir, '.claude', 'skills', 'pilot'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'pilot', 'SKILL.md'), 'x');
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { pilot: { command: 'pilot', args: ['mcp'] } } }));
    assert.deepEqual(claudeSetup(dir), { root: dir, skill: true, mcp: true, hook: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots over the API: listed, served only by name, taken only by a POST with the header', async () => {
  const shots = JSON.parse((await get('/api/shots?page=%2FOrders')).body);
  assert.deepEqual([shots.slug, shots.shots], ['orders', []]);
  assert.equal((await get('/api/shot-image?slug=..&name=before-1280.png')).status, 404);
  assert.equal((await get('/api/shot-image?slug=orders&name=..%2F..%2Fx.png')).status, 404);
  // A GET (an <img> on some page elsewhere) can't make it take one.
  assert.equal((await get('/api/shoot?page=%2FOrders')).status, 403);
  for (const kind of ['dead', 'design', 'repeats', 'a11y', 'weight']) assert.ok(!JSON.parse((await get(`/api/audit?kind=${kind}`)).body).error, kind);
  assert.equal(JSON.parse((await get('/api/cascade?page=%2FOrders&selector=.order-table')).body).rules.length, 6);
  assert.match(JSON.parse((await get('/api/diagram?target=%2FOrders')).body).diagram, /^---\ntitle: \/Orders/);
  assert.match(JSON.parse((await get('/api/context?target=%2FOrders&budget=2000')).body).text, /^# Context for \/Orders/);
});
