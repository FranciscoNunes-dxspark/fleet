// Charts in Logs: which a result makes, how it's drawn, and the toggle through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chartLines, chartOf, renderKind, short, spark } from '../src/chart.js';
import { demoQuery } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const text = (lines) => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const col = (name, type) => ({ name, type });

test('charts: the kind a query renders, a time series split by a name or per number column, bars and a pie; none without numbers', () => {
  assert.equal(renderKind('requests | summarize count() by bin(timestamp, 1h) | render timechart'), 'time');
  assert.equal(renderKind('x | render columnchart with (title="a")'), 'bars');
  assert.equal(renderKind('x | render piechart'), 'pie');
  assert.equal(renderKind('x | take 5'), null);

  const t = { columns: [col('timestamp', 'datetime'), col('code', 'string'), col('n', 'long')], rows: [['2026-10-24T10:00:00Z', '200', 5], ['2026-10-24T10:00:00Z', '500', 1], ['2026-10-24T11:00:00Z', '200', 7], ['2026-10-24T12:00:00Z', '500', 3]] };
  const c = chartOf(t, 'time');
  assert.equal(c.type, 'time');
  assert.deepEqual(c.series, [{ name: '200', values: [5, 7, null] }, { name: '500', values: [1, null, 3] }]);
  const drawn = text(chartLines(c, 80));
  assert.match(drawn, /^200\s+\S+\s+min 5 · max 7 · last 7$/m);
  assert.match(drawn, /^500\s+.+min 1 · max 3 · last 3$/m);
  assert.match(drawn, /2026-10-24 10:00\s+2026-10-24 12:00/);

  const two = chartOf({ columns: [col('t', 'datetime'), col('avg', 'real'), col('p95', 'real')], rows: [['2026-10-24T10:00:00Z', 1.5, 4], ['2026-10-24T11:00:00Z', 2.25, 9]] });
  assert.deepEqual(two.series.map((s) => s.name), ['avg', 'p95']);

  const bars = chartOf({ columns: [col('name', 'string'), col('count_', 'long')], rows: [['GET /', 40], ['GET /cart', 10]] }, 'bars');
  assert.deepEqual(bars.bars, [{ label: 'GET /', value: 40 }, { label: 'GET /cart', value: 10 }]);
  const barText = text(chartLines(bars, 40));
  assert.match(barText, /^GET \/\s+█+\s+40$/m);
  const full = (label) => new RegExp(`^${label}\\s+(█*)`, 'm').exec(barText)[1].length;
  assert.ok(Math.abs(full('GET /cart') - full('GET /') / 4) <= 1, 'a quarter as long');
  const pie = text(chartLines(chartOf({ columns: [col('k', 'string'), col('v', 'long')], rows: [['a', 3], ['b', 1]] }, 'pie'), 40));
  assert.match(pie, /a\s+█+\s+3 \(75%\)/);
  assert.match(chartOf({ columns: [col('a', 'string')], rows: [['x']] }).error, /column of numbers/);
  assert.match(chartOf({ columns: [col('a', 'long')], rows: [] }).error, /Nothing came back/);

  assert.equal(spark([1, 2, 3, 4], 2), '▄█', 'joined in pairs, summed');
  assert.equal(spark([0, null, 8], 3), '▁ █');
  assert.deepEqual([short(12), short(3.456), short(15300), short(0.0123), short(2500000)], ['12', '3.46', '15.3k', '0.012', '2.5M']);
});

test('the demo counts by bins of time and by columns, with render left to the caller', () => {
  const items = [
    { itemType: 'request', timestamp: '2026-10-24T10:05:00Z', name: 'GET /', resultCode: '200', success: true, cloud_RoleName: 'web' },
    { itemType: 'request', timestamp: '2026-10-24T10:35:00Z', name: 'GET /', resultCode: '500', success: false, cloud_RoleName: 'web' },
    { itemType: 'request', timestamp: '2026-10-24T11:05:00Z', name: 'GET /a', resultCode: '200', success: true, cloud_RoleName: 'web' },
  ];
  const t = demoQuery('requests | summarize n = count() by bin(timestamp, 1h), resultCode | render timechart', items);
  assert.deepEqual(t.columns.map((c) => [c.name, c.type]), [['timestamp', 'datetime'], ['resultCode', 'string'], ['n', 'long']]);
  assert.deepEqual(t.rows, [['2026-10-24T10:00:00.000Z', '200', 1], ['2026-10-24T10:00:00.000Z', '500', 1], ['2026-10-24T11:00:00.000Z', '200', 1]]);
  assert.deepEqual(demoQuery('requests | where success == false | summarize count() by name', items).rows, [['GET /', 1]]);
});

test('Logs draws a rendered result as a chart; v shows the grid and back, /chart too', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    app.stdin.write('/');
    await type(app.stdin, "kql requests | where cloud_RoleName == 'contoso-api' | summarize n = count() by bin(timestamp, 1h), resultCode | render timechart");
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('chart (v grid)') && /^│\s+200\s+\S+\s+min \d+ · max \d+ · last \d+/m.test(frame()), 'the time chart');
    assert.match(frame(), /^│\s+500\s+.*min \d+ · max \d+ · last \d+/m);
    assert.match(frame(), /\d+ points/);
    app.stdin.write('v');
    await until(() => /timestamp\s+│ resultCode\s+│ n/.test(frame()), 'the grid');
    app.stdin.write('/');
    await type(app.stdin, 'chart');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('chart (v grid)'), 'the chart again');
    app.stdin.write('/');
    await type(app.stdin, 'kql requests | summarize count() by name | render barchart');
    app.stdin.write(KEYS.enter);
    await until(() => /^│\s+GET \/api\/cart\s+█+\S*\s+\d+/m.test(frame()), 'the bars');
  } finally {
    app.unmount();
  }
});

test("Fleet's window draws the same chart natively: a time series as lines, bars and a pie as bars", async () => {
  const { windowChart } = await import('../src/chart.js');
  const time = { type: 'time', stamps: ['2026-10-27T10:00:00Z', '2026-10-27T11:00:00Z'], series: [{ name: '200', values: [3, 4] }] };
  assert.deepEqual(windowChart(time), { type: 'line', x: { kind: 'time', values: time.stamps }, series: time.series });
  const pie = { type: 'bars', pie: true, bars: [{ label: 'a', value: 1 }, { label: 'b', value: 3 }] };
  assert.deepEqual(windowChart(pie), { type: 'bars', labels: ['a', 'b'], series: [{ name: 'value', values: [1, 3] }], share: true });
  assert.equal(windowChart({ error: 'nothing' }), null);
  assert.equal(windowChart(null), null);
});
