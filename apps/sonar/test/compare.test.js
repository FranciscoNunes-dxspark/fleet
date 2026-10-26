// /compare-window: the windows and what changed across them, pure; then K in Problems over the demo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { compareQueries, compareWindows, windowsAround } from '../src/insights.js';
import { demoAzure, demoQuery } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const HOUR = 3600_000;

test('two equal windows round a point, as long as there is time after it, and the queries for them', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const w = windowsAround(now - 3 * 24 * HOUR, now);
  assert.deepEqual([w.from, w.point, w.to], ['2026-10-17T12:00:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-23T12:00:00.000Z']);
  assert.equal(w.timespan, '2026-10-17T12:00:00.000Z/2026-10-23T12:00:00.000Z');
  assert.equal(windowsAround(now - 30 * 24 * HOUR, now).len, 7 * 24 * HOUR);
  const q = compareQueries("o'web", w);
  assert.match(q.exceptions, /^exceptions \| where cloud_RoleName == 'o\\'web' \| where timestamp between \(datetime\(2026-10-17T12:00:00\.000Z\) \.\. datetime\(2026-10-23T12:00:00\.000Z\)\) \| extend window = iff\(timestamp < datetime\(2026-10-20T12:00:00\.000Z\), 'before', 'after'\) \| summarize n = count\(\), message = take_any\(outerMessage\) by type, window$/);
  assert.match(q.dependencies, /summarize p95 = percentile\(duration, 95\), n = count\(\) by target, window$/);
  assert.match(q.requests, /countif\(toint\(resultCode\) >= 500\) by name, window$/);
});

test('what changed: new, gone and twice as frequent types, p95 moves of a tenth or more, operations failing more', () => {
  const c = compareWindows({
    exceptions: [
      { type: 'A', window: 'after', n: 4, message: 'new' },
      { type: 'B', window: 'before', n: 3 },
      { type: 'C', window: 'before', n: 2 },
      { type: 'C', window: 'after', n: 5 },
      { type: 'D', window: 'before', n: 2 },
      { type: 'D', window: 'after', n: 3 },
    ],
    dependencies: [
      { target: 'sql', window: 'before', p95: 100 },
      { target: 'sql', window: 'after', p95: 250 },
      { target: 'blob', window: 'before', p95: 100 },
      { target: 'blob', window: 'after', p95: 105 },
      { target: 'only-after', window: 'after', p95: 900 },
    ],
    requests: [
      { name: 'GET /a', window: 'before', n: 100, failed: 1 },
      { name: 'GET /a', window: 'after', n: 100, failed: 9 },
      { name: 'GET /b', window: 'before', n: 10, failed: 5 },
      { name: 'GET /b', window: 'after', n: 10, failed: 1 },
    ],
  });
  assert.deepEqual(c.fresh.map((t) => [t.type, t.after, t.message]), [['A', 4, 'new']]);
  assert.deepEqual(c.gone.map((t) => t.type), ['B']);
  assert.deepEqual(c.rising.map((t) => t.type), ['C']);
  assert.deepEqual(c.deps.map((d) => [d.target, d.change]), [['sql', 1.5]]);
  assert.deepEqual(c.ops.map((o) => [o.name, o.before, o.after]), [['GET /a', 0.01, 0.09]]);
});

test("the demo answers the windows' queries", () => {
  const items = [
    { itemType: 'exception', cloud_RoleName: 'w', timestamp: '2026-10-19T00:00:00.000Z', type: 'X', outerMessage: 'x' },
    { itemType: 'exception', cloud_RoleName: 'w', timestamp: '2026-10-21T00:00:00.000Z', type: 'Y', outerMessage: 'y' },
    { itemType: 'request', cloud_RoleName: 'w', timestamp: '2026-10-21T00:00:00.000Z', name: 'GET /', resultCode: '500', duration: 5 },
    { itemType: 'exception', cloud_RoleName: 'other', timestamp: '2026-10-21T00:00:00.000Z', type: 'Z' },
  ];
  const q = compareQueries('w', windowsAround(Date.parse('2026-10-20T12:00:00Z'), Date.parse('2026-10-23T12:00:00Z')));
  const t = demoQuery(q.exceptions, items);
  assert.deepEqual(t.columns.map((c) => c.name), ['type', 'window', 'n', 'message']);
  assert.deepEqual(t.rows, [['X', 'before', 1, 'x'], ['Y', 'after', 1, 'y']]);
  assert.deepEqual(demoQuery(q.requests, items).rows, [['GET /', 'after', 1, 1]]);
});

test('K in Problems compares round the latest deployment; /compare-window takes a time, and refuses one to come', async () => {
  const provider = demoAzure();
  const spans = [];
  const query = provider.query;
  provider.query = (c, kql, opts) => (spans.push(opts.timespan), query(c, kql, opts));
  const app = start({ provider });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('p');
    await until(() => /\d+ problems/.test(frame()), "contoso-web's problems");
    app.stdin.write('\x1bk');
    await until(() => frame().includes('Before and after the deployment 3d ago (Release 2.14.0') && frame().includes('New exception types'), 'the comparison');
    assert.match(frame(), /The 3d before it, against the 3d after/);
    assert.match(frame(), /New exception types\s*│\n│\s+\d+× TypeError\s+Cannot read properties/);
    assert.ok(spans.some((s) => /^\S+Z\/\S+Z$/.test(s)), 'asked over the two windows');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Before and after'), 'closed');

    app.stdin.write('/');
    await type(app.stdin, 'compare-window 2099-01-01');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("2099-01-01 isn't a time in the past"), 'a time to come refused');
    const t = new Date(Date.now() - 6 * HOUR).toISOString();
    app.stdin.write('/');
    await type(app.stdin, `compare-window ${t}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Before and after ${t.replace('T', ' ').replace(/\.\d+Z$/, '')}`), 'round the time given');
    assert.match(frame(), /The 6h before it, against the 6h after/);
  } finally {
    app.unmount();
  }
});
