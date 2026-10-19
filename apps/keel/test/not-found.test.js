import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateMonitor } from '../server/domain/production.js';
import { createMonitoring } from '../server/monitoring.js';

const H = 3_600_000;
const now = Date.parse('2026-10-19T12:00:00Z');
const at = (h) => new Date(now - h * H).toISOString();

test('404s: never a degradation; a jump after a deploy is a note', () => {
  const base = { url: 'https://x', latencyWarnMs: 1000, consecutiveFailures: 0, aiError: null, last: { ok: true, ms: 200, at: at(0) } };
  // Lots of 404s (bots), no server errors: up.
  const series = [];
  for (let h = 9; h >= 0; h -= 0.5) series.push({ at: at(h), total: 100, failed: 0, notFound: h > 3 ? 1 : 30 });
  const ai = { total: 200, failed: 0, failRate: 0, notFound: 60, series };
  const r = evaluateMonitor({ ...base, ai }, [{ at: at(3), label: 'Release-66' }], now);
  assert.equal(r.state, 'up');
  assert.deepEqual(r.issues.map((i) => [i.code, i.severity]), [['not-found-up', 'low']]);
  assert.match(r.issues[0].text, /404s up from 1.0% to 30% since Release-66/);
  // The same 404s without a deploy: nothing to say.
  assert.deepEqual(evaluateMonitor({ ...base, ai }, [], now).issues, []);
});

test('Application Insights: failures are 5xx, 404s are counted apart', async (t) => {
  const queries = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const q = new URL(url).searchParams.get('query') || '';
    queries.push(q);
    const table = (columns, rows) => new Response(JSON.stringify({ tables: [{ columns: columns.map((name) => ({ name })), rows }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (q.startsWith('exceptions')) return table(['n'], [[3]]);
    if (q.includes('bin(timestamp')) return table(['timestamp', 'total', 'failed', 'notFound', 'p95'], [[new Date().toISOString(), 1000, 4, 120, 300]]);
    if (q.includes('"404"')) return table(['name', 'n'], [['GET /wp-login.php', 90]]);
    return table(['name', 'resultCode', 'n'], [['POST /pay', '500', 4]]);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-ai-'));
  try {
    const monitoring = createMonitoring({ dataDir: dir, mock: false });
    const res = await monitoring.test({ appInsightsAppId: '0f1e2d3c-0000-4000-8000-000000000000', apiKey: 'k' });
    assert.deepEqual(res.ai, { ok: true, total: 1000 });
    assert.ok(queries.some((q) => q.includes('failed=countif(toint(resultCode) >= 500)')), 'failures are server errors');
    assert.ok(queries.some((q) => q.includes('notFound=countif(resultCode == "404")')));
    assert.ok(!queries.some((q) => q.includes('success == false')), 'not "any unsuccessful request"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
