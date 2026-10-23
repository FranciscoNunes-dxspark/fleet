import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asEnvelope, historyPoint, platformInfo, readTotals } from '../server/platform.js';
import { evaluateMonitor } from '../server/domain/production.js';

const env = (over = {}) => ({
  schema: 'platform/v1', kind: 'totals', product: 'Storefront', site: 'shopeu', version: '1.0.0.0', status: 'ok',
  generatedAt: '2026-10-16T09:45:03.118Z', durationMs: 4120,
  checks: [{ name: 'platformTotals', status: 'ok', durationMs: 3870, message: null }],
  data: {
    season: { scope: 'season', id: '6f0c3b7e-2a51-4f1e-9d0b-2b6f8f0a1c33', name: '2026/2027' },
    totals: [
      { typeId: 1, type: 'players', areas: ['administration'], total: 523, monthly: true, months: [{ month: 7, count: 401 }, { month: 8, count: 122 }] },
      { typeId: 2, type: 'usersAll', areas: ['administration'], total: 1210, monthly: false, months: null },
    ],
  },
  ...over,
});

test('platform envelope: only platform/v1 with a known status counts', () => {
  assert.ok(asEnvelope(env()));
  assert.equal(asEnvelope({ ...env(), schema: 'platform/v2' }), null);
  assert.equal(asEnvelope({ status: 'ok' }), null);
  assert.equal(asEnvelope('<html>Service Unavailable</html>'), null);
  const info = platformInfo({ ...env(), kind: 'health', status: 'down', checks: [{ name: 'database', status: 'down', message: 'The database did not answer in time.' }] });
  assert.deepEqual([info.status, info.product, info.site, info.failing[0].message], ['down', 'Storefront', 'shopeu', 'The database did not answer in time.']);
});

test('platform totals: figures, months, season; degraded keeps the rest', () => {
  const { snapshot } = readTotals(200, env(), '2026-10-16T10:00:00.000Z');
  assert.equal(snapshot.season.name, '2026/2027');
  assert.deepEqual(snapshot.totals.map((x) => [x.type, x.total]), [['players', 523], ['usersAll', 1210]]);
  assert.deepEqual(snapshot.totals[0].months, [{ month: 7, count: 401 }, { month: 8, count: 122 }]);
  assert.equal(snapshot.totals[1].months, null);
  assert.deepEqual(historyPoint(snapshot), { at: '2026-10-16T10:00:00.000Z', seasonId: '6f0c3b7e-2a51-4f1e-9d0b-2b6f8f0a1c33', values: { players: 523, usersAll: 1210 } });

  const degraded = readTotals(200, env({ status: 'degraded', checks: [{ name: 'appLogins', status: 'degraded', message: 'This figure could not be read from the audit log.' }] }));
  assert.equal(degraded.snapshot.status, 'degraded');
  assert.equal(degraded.snapshot.failing[0].name, 'appLogins');
  assert.equal(historyPoint({ ...degraded.snapshot, season: { scope: 'all', id: null } }).seasonId, 'all');
});

test('platform totals: 404 means the key, 503 and 400 carry the check message, no envelope is an error', () => {
  assert.match(readTotals(404, null).error, /check the totals key/);
  assert.equal(readTotals(503, env({ status: 'down', data: null, checks: [{ name: 'platformTotals', status: 'down', message: 'The figures could not be calculated.' }] })).error, 'The figures could not be calculated.');
  assert.equal(readTotals(400, env({ status: 'down', data: null, checks: [{ name: 'season', status: 'down', message: 'Unknown season.' }] })).error, 'Unknown season.');
  assert.match(readTotals(502, null).error, /HTTP 502/);
  assert.match(readTotals(200, env({ kind: 'health', data: null })).error, /"health" response/);
});

test('platform health verdicts: envelope down at once, no envelope after 3 polls, degraded flagged', () => {
  const now = Date.parse('2026-10-16T10:00:00Z');
  const at = new Date(now - 60_000).toISOString();
  const platform = { product: 'Storefront', site: 'shopeu', version: '1.0.0.0' };
  const base = { url: 'https://shop-eu.example.com/health', latencyWarnMs: 2000, platform };

  const dbDown = evaluateMonitor({ ...base, consecutiveFailures: 1, last: { at, ok: false, status: 503, ms: 3000, error: 'The database did not answer in time.', platform: { status: 'down' } } }, [], now);
  assert.equal(dbDown.state, 'down');
  assert.match(dbDown.issues[0].text, /database did not answer/);

  const restarting = (n) => evaluateMonitor({ ...base, consecutiveFailures: n, last: { at, ok: false, status: 503, ms: 900, error: 'HTTP 503' } }, [], now);
  assert.equal(restarting(2).state, 'degraded');
  assert.equal(restarting(2).issues[0].severity, 'low'); // not in the Inbox yet
  assert.equal(restarting(3).state, 'down');

  const degraded = evaluateMonitor({ ...base, consecutiveFailures: 0, last: { at, ok: true, status: 200, ms: 120, error: null, platform: { status: 'degraded', failing: [{ name: 'storage', status: 'degraded', message: 'Storage is slow.' }] } } }, [], now);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.issues[0].text, 'Degraded: Storage is slow.');

  // Other monitors keep the old rule: down after 2 failed checks.
  const plain = evaluateMonitor({ url: 'https://shop.example.com', latencyWarnMs: 2000, consecutiveFailures: 2, last: { at, ok: false, status: 503, ms: 10, error: 'HTTP 503' } }, [], now);
  assert.equal(plain.state, 'down');
});
