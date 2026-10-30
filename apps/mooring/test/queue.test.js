import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, etaOf, rateOf } from '../src/queue.js';
import { demoSession } from '../src/demo.js';

// A demo host whose transfers wait at each step until `drain` lets them on.
function gated() {
  const waiting = [];
  const session = demoSession({ chunks: 2, tick: () => new Promise((resolve) => waiting.push(resolve)) });
  const drain = async (queue) => {
    let idle = false;
    queue.idle().then(() => (idle = true));
    while (!idle) {
      waiting.splice(0).forEach((release) => release());
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  return { session, drain };
}

test('a transfer runs, reports its progress and finishes; the host gets the file', async () => {
  const session = demoSession();
  const seen = [];
  const queue = createQueue({ session, interval: 0, onChange: (items) => seen.push(items[0].status) });
  queue.add({ kind: 'upload', name: 'a.txt', from: '/demo/a.txt', to: '/home/demo/a.txt', size: 40 });
  await queue.idle();
  assert.deepEqual([...new Set(seen)], ['queued', 'running', 'done']);
  assert.deepEqual(queue.items()[0].bytes, 40);
  assert.equal(session.state.tree.get('/home/demo/a.txt').size, 40);
  assert.deepEqual(queue.counts(), { queued: 0, running: 0, done: 1, failed: 0, cancelled: 0 });
  queue.add({ kind: 'download', name: 'notes.txt', from: '/home/demo/notes.txt', to: '/demo/notes.txt' });
  await queue.idle();
  assert.equal(queue.items()[1].total, 312);
  assert.equal(queue.items()[1].status, 'done');
});

test('only `concurrency` run at once, the rest wait their turn in order', async () => {
  const { session, drain } = gated();
  const queue = createQueue({ session, concurrency: 2 });
  const names = ['a', 'b', 'c'];
  for (const n of names) queue.add({ kind: 'upload', name: n, from: `/demo/${n}`, to: `/home/demo/${n}`, size: 10 });
  assert.deepEqual(queue.items().map((i) => i.status), ['running', 'running', 'queued']);
  await drain(queue);
  assert.deepEqual(queue.items().map((i) => i.status), ['done', 'done', 'done']);
});

test('cancelling a running transfer stops it; cancelling a queued one stops it from starting', async () => {
  const { session, drain } = gated();
  const queue = createQueue({ session, concurrency: 1 });
  const first = queue.add({ kind: 'upload', name: 'a', from: '/demo/a', to: '/home/demo/a', size: 10 });
  const second = queue.add({ kind: 'upload', name: 'b', from: '/demo/b', to: '/home/demo/b', size: 10 });
  queue.cancel(second);
  assert.equal(queue.items()[1].status, 'cancelled');
  queue.cancel(first);
  await drain(queue);
  assert.equal(queue.items()[0].status, 'cancelled');
  assert.equal(queue.items()[0].error, null);
  assert.equal(session.state.tree.has('/home/demo/a'), false);
  assert.equal(session.state.tree.has('/home/demo/b'), false);
});

test('a failure keeps its words, and retry runs it again', async () => {
  const session = demoSession();
  const queue = createQueue({ session });
  const id = queue.add({ kind: 'download', name: 'ghost', from: '/home/demo/ghost', to: '/demo/ghost' });
  await queue.idle();
  assert.equal(queue.items()[0].status, 'failed');
  assert.match(queue.items()[0].error, /No such file/);
  assert.equal(queue.counts().failed, 1);
  session.state.tree.set('/home/demo/ghost', { kind: 'file', size: 3 });
  queue.retry(id);
  await queue.idle();
  assert.equal(queue.items()[0].status, 'done');
  assert.equal(queue.items()[0].error, null);
});

test('remove and clear take finished items off, never a running one', async () => {
  const { session, drain } = gated();
  const queue = createQueue({ session, concurrency: 1 });
  const a = queue.add({ kind: 'upload', name: 'a', from: '/demo/a', to: '/home/demo/a', size: 1 });
  queue.add({ kind: 'upload', name: 'b', from: '/demo/b', to: '/home/demo/b', size: 1 });
  queue.remove(a);
  assert.equal(queue.items().length, 2);
  await drain(queue);
  queue.remove(a);
  assert.deepEqual(queue.items().map((i) => i.name), ['b']);
  queue.clear();
  assert.equal(queue.items().length, 0);
});

test('rate and time left, from what has been moved', () => {
  const item = { status: 'running', startedAt: 1000, bytes: 2000, total: 6000 };
  assert.equal(rateOf(item, 3000), 1000);
  assert.equal(etaOf(item, 3000), 4);
  assert.equal(rateOf({ status: 'queued', bytes: 0 }), 0);
  assert.equal(etaOf({ ...item, total: null }, 3000), null);
  assert.equal(etaOf({ ...item, status: 'done' }, 3000), null);
});
