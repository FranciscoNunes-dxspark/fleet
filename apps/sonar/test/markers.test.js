// What changed an app, as marks: the rules (markers.js), the demo's deployments and activity log, and
// the marks in Problems, a chart in Logs, a grid, Resources, the incident and /changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logActivity } from '@fleet/kit/family.js';
import { changeKind, changesFrom, commitOf, firstSeenAfter, firstSeenText, markerDetail, markersFrom, placeMarkers, rowMarkers } from '../src/markers.js';
import { chartLines } from '../src/chart.js';
import { demoAzure } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

const HOUR = 3600_000;
const MIN = 60_000;
let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const app = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/web';
const ev = (op, id, at, status = 'Succeeded', correlationId = `${op}|${at}`) => ({ operationName: { value: op }, resourceId: id, eventTimestamp: at, status: { value: status }, caller: 'ana@contoso.com', correlationId });

test('a deployment\'s commit, the activity log\'s operations in words, and changes for an app or a slot', () => {
  assert.equal(commitOf({ name: '9B1C7E2D4F60A8C3E1F2B7D9A5C4E3F2A1B0C9D8', message: '' }), '9b1c7e2d4f60a8c3e1f2b7d9a5c4e3f2a1b0c9d8', 'a git deployment is named by its commit');
  assert.equal(commitOf({ name: 'd3', message: 'Release\n\nCommit 9b1c7e2' }), '9b1c7e2');
  assert.equal(commitOf({ name: 'd3', message: "Preparing deployment for commit id '4f2a9c1'" }), '4f2a9c1');
  assert.equal(commitOf({ name: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', message: 'Zip deploy' }), null, "a zip deployment's id is no commit");
  assert.equal(changeKind('Microsoft.Web/sites/slots/slotsswap/action'), 'swap');
  assert.equal(changeKind('microsoft.web/sites/config/write'), 'setting');
  assert.equal(changeKind('Microsoft.Web/sites/slots/restart/action'), 'restart');
  assert.equal(changeKind('Microsoft.Web/sites/stop/action'), 'restart');
  assert.equal(changeKind('Microsoft.Web/sites/config/list/action'), null, 'reading the settings changes nothing');
  const events = [
    ev('Microsoft.Web/sites/config/write', app, '2026-10-20T10:00:00Z', 'Started', 'c1'),
    ev('Microsoft.Web/sites/config/write', app, '2026-10-20T10:00:04Z', 'Succeeded', 'c1'),
    ev('Microsoft.Web/sites/config/write', app, '2026-10-20T10:00:05Z', 'Succeeded', 'c1'),
    ev('Microsoft.Web/sites/slots/slotsswap/action', `${app}/slots/staging`, '2026-10-21T10:00:00Z'),
    ev('Microsoft.Web/sites/slots/config/write', `${app}/slots/staging`, '2026-10-19T10:00:00Z'),
    ev('Microsoft.Web/sites/stop/action', app, '2026-10-22T10:00:00Z'),
    ev('Microsoft.Web/sites/write', app, '2026-10-22T11:00:00Z'),
    ev('Microsoft.Web/sites/restart/action', `${app}2`, '2026-10-22T12:00:00Z'),
  ];
  const mine = changesFrom(events, { id: app, slot: null });
  assert.deepEqual(mine.map((c) => [c.kind, c.what]), [['setting', 'settings saved'], ['swap', 'staging swapped into production'], ['restart', 'stopped']], 'one per operation, a slot swapped in, not another app');
  assert.equal(mine[0].who, 'ana@contoso.com');
  const slot = changesFrom(events, { id: `${app}/slots/staging`, slot: 'staging' });
  assert.deepEqual(slot.map((c) => c.kind), ['setting', 'swap']);
});

test('marks from deployments, changes and the family; where they fall; what came shortly before a problem', () => {
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const markers = markersFrom({
    deployments: [
      { name: 'd2', status: 'succeeded', start: iso(t0 + 2 * HOUR), author: 'Ana', deployer: 'GitHub Actions', message: 'Release 2\n\nCommit abcdef1' },
      { name: 'd1', status: 'failed', start: iso(t0 + HOUR), author: 'Rui', message: 'Release 1' },
    ],
    changes: [{ at: iso(t0 + 5 * HOUR), kind: 'setting', what: 'settings saved', who: 'rui@contoso.com' }],
    activity: [
      { at: t0 + 3 * HOUR, app: 'keel', kind: 'info', text: 'Ran the pipeline shop-deploy' },
      { at: t0 + 3 * HOUR, app: 'splice', kind: 'push', text: 'pushed main to origin' },
      { at: t0 + 3 * HOUR, app: 'splice', kind: 'delete', text: 'deleted the branch x' },
      { at: t0 + 4 * HOUR, app: 'locker', kind: 'change', text: 'set Payments__Key in kv-shop' },
      { at: t0 + 4 * HOUR, app: 'locker', kind: 'copy', text: 'copied Payments__Key' },
      { at: t0 + 4 * HOUR, app: 'hail', kind: 'send', text: 'sent GET /' },
      { at: t0 + 6 * HOUR, app: 'fleet', kind: 'change', text: 'Switched shop to prod (production)' },
    ],
    from: t0,
  });
  assert.deepEqual(markers.map((m) => m.kind), ['deploy', 'pipeline', 'push', 'secret', 'setting', 'env'], 'a failed deployment changed nothing; a deleted branch, a copy and a send neither');
  assert.equal(markers[0].commit, 'abcdef1');
  assert.equal(markers[0].who, 'Ana');

  // An hour a stamp, with a gap at 03:00: a mark in the gap goes to the stamp before it.
  const stamps = [0, 1, 2, 4, 5, 6].map((h) => iso(t0 + h * HOUR));
  const cells = placeMarkers(markers, stamps, { step: HOUR });
  assert.deepEqual(cells.map((c) => c.map((m) => m.kind)), [[], [], ['deploy', 'pipeline', 'push'], ['secret'], ['setting'], ['env']]);
  const two = placeMarkers(markers, stamps, { cells: 2, step: HOUR });
  assert.deepEqual(two.map((c) => c.length), [3, 3], 'three stamps a cell');
  assert.deepEqual(placeMarkers(markers, stamps.slice(0, 2), { step: HOUR }).flat(), [], 'none before the first or after the last one ends');

  const first = t0 + 5 * HOUR + 17 * MIN;
  const f = firstSeenAfter(first, markers, { since: t0 });
  assert.equal(f.marker.kind, 'setting');
  assert.equal(f.minutes, 17);
  assert.equal(firstSeenText(f), 'first seen 17 min after a setting change by rui@contoso.com');
  assert.equal(firstSeenText(firstSeenAfter(t0 + 2 * HOUR + 40 * MIN, markers, { since: t0 })), 'first seen 40 min after deployment Release 2 by Ana (abcdef1)');
  assert.equal(firstSeenAfter(t0 + 9 * HOUR, markers, { since: t0 }), null, 'too long after');
  assert.equal(firstSeenAfter(first, markers, { since: first - 10 * MIN }), null, 'first seen at the start of the span may have been there before it');

  const d = markerDetail(markers[0], t0 + 3 * HOUR);
  assert.match(d.text, /^Release 2\n/);
  assert.match(d.text, /who {6}Ana/);
  assert.match(d.text, /commit {3}abcdef1/);
  assert.match(d.text, /when {5}2026-10-20 02:00:00 \(1h ago\)/);

  // Rows newest first: the setting change (05:00) goes beside the first row after it, the 05:30 one.
  const rows = [[iso(t0 + 6 * HOUR)], [iso(t0 + 5.5 * HOUR)], [iso(t0 + 4.5 * HOUR)]];
  const by = rowMarkers(markers, rows, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.map((m) => m.kind)])), { 0: ['env'], 1: ['setting'] }, 'the 04:00 ones have no row before them');
});

test('a time chart draws the marks on a line of their own, with their legend', () => {
  const t0 = Date.parse('2026-10-20T00:00:00Z');
  const stamps = Array.from({ length: 10 }, (_, i) => new Date(t0 + i * HOUR).toISOString());
  const chart = { type: 'time', stamps, series: [{ name: 'n', values: stamps.map((_, i) => i) }], more: 0 };
  const markers = [{ at: t0 + 3 * HOUR + 5 * MIN, kind: 'deploy', title: 'Release 2' }, { at: t0 + 7 * HOUR, kind: 'swap', title: 'staging swapped into production' }];
  const text = (line) => line.map((s) => s.text).join('');
  const lines = chartLines(chart, 80, { markers }).map(text);
  const spark = lines[0].indexOf('▁');
  const marks = lines.find((l) => l.startsWith('change '));
  assert.equal(marks.slice(spark), '···D···S··');
  assert.ok(lines.some((l) => l.includes('D deployment  S slot swap')), lines.join('\n'));
  assert.ok(!chartLines(chart, 80).map(text).some((l) => l.startsWith('change ')), 'no line without marks');
});

test('the demo: its slots\' release candidate, its activity log, and what a change through it leaves there', async () => {
  const demo = demoAzure();
  const web = demo.state.sites.find((s) => s.name === 'contoso-web' && !s.slot);
  const staging = demo.state.sites.find((s) => s.name === 'contoso-web' && s.slot);
  const [latest] = await demo.deployments(staging);
  assert.deepEqual([latest.name, latest.active, latest.commit], ['d4', true, '3e8d0a6c1b7f4e2d9a5c8b1f0e7d6c3a2b4f9e1d']);
  assert.equal((await demo.deployments(web))[0].commit, '9b1c7e2d4f60a8c3e1f2b7d9a5c4e3f2a1b0c9d8');
  const week = { hours: 24 * 7, iso: 'P7D' };
  assert.deepEqual((await demo.changes(web, { span: week })).map((c) => c.kind), ['restart', 'setting']);
  await demo.restart(web);
  assert.deepEqual((await demo.changes(web, { span: week })).map((c) => c.kind), ['restart', 'setting', 'restart']);
});

test('Problems marks what changed the app over the sparklines and says what came shortly before a problem; alt+m lists them, ↵ one whole', async () => {
  const project = join(process.env.SONAR_HOME, 'shop');
  mkdirSync(project, { recursive: true });
  logActivity('keel', { text: 'Ran the pipeline shop-deploy on main', kind: 'info', project }, { now: Date.now() - 2 * HOUR });
  const a = start({ cwd: project, config: { history: [], timespan: 2 } });
  const frame = () => a.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    a.stdin.write('p');
    await until(() => /\d+ problems · 7d/.test(frame()) && frame().includes('what changed it:'), "contoso-web's problems with their marks");
    assert.match(frame(), /what changed it: D deployment\s+C setting change\s+R restart\s+K Keel pipeline/);
    assert.match(frame(), /TypeError .* \d+m after setting/);
    // The cursor goes to the cart's problem, and the sentence under the list says it whole.
    for (let i = 0; i < 5 && !/❯[^\n]*TypeError/.test(frame()); i++) {
      a.stdin.write('j');
      await new Promise((r) => setTimeout(r, 60));
    }
    await until(() => frame().includes('TypeError: first seen 17 min after a setting change by rui.costa@contoso.com'), 'the sentence');
    a.stdin.write('\x1bi');
    await until(() => frame().includes('Incident: TypeError') && frame().includes('first seen 17 min after a setting change'), 'the incident says it');
    assert.match(frame(), /Other changes in the 24 h before first seen/);
    a.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Incident:'), 'the incident closed');

    a.stdin.write('\x1bm');
    await until(() => frame().includes('What changed contoso-web in the last 7d (4)'), 'the list of changes');
    assert.match(frame(), /K\s+2h ago\s+Keel pipeline\s+Keel\s+Ran the pipeline shop-deploy/);
    assert.match(frame(), /D\s+3d ago\s+deployment\s+Ana Silva\s+9b1c7e2\s+Release 2\.14\.0/);
    a.stdin.write('j');
    a.stdin.write('j');
    await until(() => /❯ D/.test(frame()), 'the deployment');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('commit   9b1c7e2d4f60a8c3e1f2b7d9a5c4e3f2a1b0c9d8') && frame().includes('through  GitHub Actions'), 'the deployment whole');
    a.stdin.write(KEYS.esc);
    await until(() => frame().includes('What changed contoso-web'), 'back to the list');
    a.stdin.write(KEYS.esc);
    await until(() => !frame().includes('What changed contoso-web'), 'closed');

  } finally {
    a.unmount();
  }
});

test('Logs: a time chart and a grid with a time column carry the marks; /changes names an app', async () => {
  const a = start({ config: { history: [], timespan: 2 } });
  const frame = () => a.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    a.stdin.write('l');
    await until(() => frame().includes('rows · 7d'), 'its latest requests');
    a.stdin.write('/');
    await type(a.stdin, "kql requests | where cloud_RoleName == 'contoso-web' | summarize n = count() by bin(timestamp, 1h) | render timechart");
    a.stdin.write(KEYS.enter);
    await until(() => /change\s+[·DCR]+/.test(frame()), 'the marks under the chart');
    assert.match(frame(), /D deployment\s+C setting change\s+R restart\s+\(alt\+m lists them\)/);
    a.stdin.write('/');
    await type(a.stdin, "kql requests | where cloud_RoleName == 'contoso-web' | order by timestamp desc | take 500");
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('beside the first row after it'), 'the legend under the grid');

    a.stdin.write('/');
    await type(a.stdin, 'changes contoso-web/staging');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('What changed contoso-web/staging in the last 7d'), "the slot's");
    assert.match(frame(), /Release 2\.15\.0-rc\.1/);
    assert.match(frame(), /setting change\s+ana\.silva@contoso\.com/);
  } finally {
    a.unmount();
  }
});
