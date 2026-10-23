// t in Crew: the latest trouble line, its request, nothing secret, as a /take line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { latestTrouble, redact, requestIdIn, troubleContext } from '../src/share.js';
import { contextIn } from '../src/family.js';
import { project, start, tempHome, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('request ids, as logs name them', () => {
  assert.equal(requestIdIn('GET /orders 500 x-request-id: 7f3a9c21-aa'), '7f3a9c21-aa');
  assert.equal(requestIdIn('{"level":"error","requestId":"req_123456","msg":"boom"}'), 'req_123456');
  assert.equal(requestIdIn('error request_id=abc-def-123 failed'), 'abc-def-123');
  assert.equal(requestIdIn('traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(requestIdIn('operation_Id=0af7651916cd43dd8448eb211c80319c.'), '0af7651916cd43dd8448eb211c80319c');
  assert.equal(requestIdIn('"operationId": "op-998877"'), 'op-998877');
  assert.equal(requestIdIn('Error: nothing to see'), null);
});

test('the latest trouble, with nothing secret in it', () => {
  assert.equal(redact('connect postgres://me:hunter2@db/x password=abc Authorization: Bearer eyJ.x.y'), 'connect postgres://me:***@db/x password=*** Authorization: Bearer ***');
  const lines = [
    { at: 1000, text: 'Error: old' },
    { at: 2000, text: 'GET /orders requestId=req_000111' },
    { at: 3000, text: 'TypeError: cannot read total (token=s3cr3t)' },
    { at: 4000, text: '── exited with 1' },
  ];
  assert.equal(latestTrouble(lines), 2);
  assert.deepEqual(troubleContext('shop', { name: 'api', lines }), { project: 'shop', process: 'api', text: 'TypeError: cannot read total (token=***)', time: new Date(3000).toISOString(), requestId: 'req_000111' });
  assert.equal(troubleContext('shop', { name: 'api', lines: [{ at: 1, text: 'fine' }] }), null);
});

test('t copies the selected process\'s latest trouble as /take logline', async () => {
  const dir = project({ procs: { api: 'node api.js' } }, { 'api.js': `console.log('GET /orders x-request-id: abc123def'); console.error('Error: the database said no'); setInterval(() => {}, 1000);` });
  const copied = [];
  const app = start({ dir, copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Error: the database said no'), 'the trouble');
    app.stdin.write('t');
    await until(() => copied.length === 1 && frame().includes('Copied for Sonar or Hail'), 'copied');
    const ctx = contextIn(copied[0]);
    assert.equal(ctx.kind, 'logline');
    assert.equal(ctx.data.process, 'api');
    assert.equal(ctx.data.text, 'Error: the database said no');
    assert.equal(ctx.data.requestId, 'abc123def');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});
