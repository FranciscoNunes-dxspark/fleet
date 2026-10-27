import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextIn, logActivity, takeLine } from '@fleet/kit/family.js';
import { bosunHome, requestIdOfLine, traceLine, traceTimeline } from '../src/trace.js';

test("the line that asks an app is a log line's /take, its text and requestId the id", () => {
  const line = traceLine('abc-123456');
  assert.match(line, /^\/take family:v1:logline:/);
  assert.deepEqual(contextIn(line), { kind: 'logline', data: { process: 'trace', text: 'abc-123456', requestId: 'abc-123456' } });
  assert.equal(bosunHome({ BOSUN_HOME: '/b' }), '/b');
});

test('the request a hand-off names: its context says it, or its text does', () => {
  assert.equal(requestIdOfLine(takeLine('logline', { process: 'api', text: 'boom', requestId: 'r-1234567' })), 'r-1234567');
  assert.equal(requestIdOfLine(takeLine('exception', { message: 'x', operationId: 'op-9876543' })), 'op-9876543');
  assert.equal(requestIdOfLine(takeLine('logline', { process: 'api', text: 'failed requestId=abcdef12' })), 'abcdef12');
  assert.equal(requestIdOfLine(takeLine('commit', { hash: 'abc' })), null);
  assert.equal(requestIdOfLine('/send x-request-id: zz-998877'), 'zz-998877');
  assert.equal(requestIdOfLine('/azure-sql srv db'), null);
});

test("a timeline from the activity log and Bosun's sessions, oldest first, whatever the case", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fleet-trace-'));
  const family = join(tmp, 'family');
  logActivity('hail', { text: 'Sent GET /orders (request REQ-42abc)' }, { dir: family, now: 3000 });
  logActivity('splice', { text: 'Pushed main' }, { dir: family, now: 4000 });
  const bosun = join(tmp, 'bosun');
  const project = join(bosun, 'sessions', '0123456789abcdef');
  mkdirSync(project, { recursive: true });
  const session = [
    { type: 'session', v: 1, project: 'shop', start: 1000, procs: [] },
    { t: 2000, type: 'line', p: 'api', text: 'GET /orders requestId=req-42abc' },
    { t: 2500, type: 'line', p: 'api', text: 'something else' },
    { t: 5000, type: 'state', p: 'api', status: 'running' },
    { t: 6000, type: 'line', p: 'web', text: 'done req-42abc' },
  ];
  writeFileSync(join(project, '2026-10-27T10-00-00-000Z.jsonl'), `${session.map((e) => JSON.stringify(e)).join('\n')}\nnot json req-42abc\n`);
  // An old session is left alone.
  writeFileSync(join(project, '2026-10-20T10-00-00-000Z.jsonl'), `${JSON.stringify({ t: 1, type: 'line', p: 'api', text: 'req-42abc' })}\n`);
  utimesSync(join(project, '2026-10-20T10-00-00-000Z.jsonl'), new Date(0), new Date(0));

  const found = traceTimeline('req-42abc', { familyDir: family, bosun, since: 1000 });
  assert.deepEqual(found, [
    { at: 2000, app: 'bosun', source: 'shop api', text: 'GET /orders requestId=req-42abc' },
    { at: 3000, app: 'hail', source: 'activity', text: 'Sent GET /orders (request REQ-42abc)' },
    { at: 6000, app: 'bosun', source: 'shop web', text: 'done req-42abc' },
  ]);
  assert.equal(traceTimeline('req-42abc', { familyDir: family, bosun, since: 1000, limit: 1 })[0].at, 6000);
  assert.deepEqual(traceTimeline('  ', { familyDir: family, bosun }), []);
  assert.deepEqual(traceTimeline('x', { familyDir: join(tmp, 'none'), bosun: join(tmp, 'none') }), []);
});
