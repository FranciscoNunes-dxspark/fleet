// Server-sent events: read as they come, shown live in the Response view until esc or the end, and
// kept whole.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventReader, eventsText, parseEvents } from '../src/sse.js';
import { prepare, prettyBody, send } from '../src/send.js';
import { parseHttpFile } from '../src/http-file.js';
import { isSafeMethod } from '../src/project.js';
import { KEYS, start, tempHome, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
const open = new Set();

before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-sse-'));
  server = createServer((req, res) => {
    if (req.url === '/plain') {
      // An event stream that doesn't say it's one: what an SSE request reads as one anyway.
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Accept': req.headers.accept ?? '' });
      res.write('data: {"first":true}\n\n');
      setTimeout(() => res.end('event: last\ndata: bye\n\n'), 20);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (req.url === '/three') {
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`);
        if (n === 3) {
          clearInterval(t);
          res.end();
        }
      }, 20);
      return;
    }
    // Never ends: an event every 40 ms until the client goes.
    open.add(res);
    let n = 0;
    res.write(': hello\n\n');
    const t = setInterval(() => res.write(`data: {"count":${++n}}\n\n`), 40);
    res.on('close', () => {
      clearInterval(t);
      open.delete(res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const r of open) r.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('events are read as the standard has them, across pieces however they are cut', () => {
  const r = eventReader();
  assert.deepEqual(r.push('data: one\r'), []);
  assert.deepEqual(r.push('\n\r\n: a comment\nid: 7\nevent: up'), [{ id: null, event: 'message', data: 'one' }]);
  assert.deepEqual(r.push('date\ndata: a\ndata:b\nretry: 300\n\n'), [{ id: '7', event: 'update', data: 'a\nb', retry: 300 }]);
  assert.deepEqual(r.push('data: two\n\n'), [{ id: '7', event: 'message', data: 'two' }]);
  assert.deepEqual(parseEvents('data: unfinished'), []);
  assert.equal(eventsText(parseEvents('id: 1\nevent: tick\ndata: {"n":1}\n\ndata: plain\n\n')), '#1  event: tick  id: 1\n{\n  "n": 1\n}\n\n#2  id: 1\nplain');
  assert.equal(prettyBody({ headers: [['Content-Type', 'text/event-stream']], body: 'data: {"a":1}\n\n' }), '#1\n{\n  "a": 1\n}');
});

test('send reads a stream as it comes, and esc keeps what came', async () => {
  const seen = [];
  const r = await send({ method: 'GET', url: `${base}/three`, headers: [] }, { onStream: (p) => seen.push(p.events) });
  assert.equal(r.stream.events, 3);
  assert.equal(r.stream.stopped, false);
  assert.deepEqual(seen.at(-1), 3);
  assert.equal(parseEvents(r.body).at(-1).data, '{"n":3}');
  const c = new AbortController();
  const endless = await send({ method: 'GET', url: `${base}/forever`, headers: [] }, { signal: c.signal, onStream: (p) => p.events >= 2 && c.abort() });
  assert.equal(endless.stream.stopped, true);
  assert.ok(endless.stream.events >= 2);
  // A run bounds an endless one with # @timeout.
  const timed = await send({ method: 'GET', url: `${base}/forever`, headers: [] }, { timeout: 150 });
  assert.equal(timed.stream.stopped, true);
});

test('through the UI: the events stream into the Response view until esc, and are kept', async () => {
  writeFileSync(join(dir, 'live.http'), `### Ticks\nGET ${base}/forever\nAccept: text/event-stream\n`);
  const app = start({ initialFile: join(dir, 'live.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Ticks'), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('streaming… (esc stops it)') && /Streaming: \d+ events/.test(f()), 'the stream, live in the Response view');
    assert.match(f(), /│ GET Ticks/);
    await until(() => /"count": [4-9]/.test(f()), 'later events on screen');
    app.stdin.write(KEYS.esc);
    await until(() => /events · stopped/.test(f()), 'stopped');
    assert.match(f(), /200 OK .*\d+ events, stopped/s);
    app.stdin.write('4');
    await until(() => f().includes('1 kept'), 'kept in the history');
  } finally {
    app.unmount();
  }
});

test("JetBrains' SSE method: a GET asking for an event stream, read as one whatever the server calls it", async () => {
  const [plain, own] = parseHttpFile(`### Feed\nSSE ${base}/plain\n\n### Own accept\nSSE ${base}/plain\nAccept: application/x-ndjson\n`).requests;
  assert.equal(plain.method, 'SSE');
  assert.equal(plain.label, 'Feed');
  assert.ok(isSafeMethod('SSE'));
  const req = await prepare(plain, {});
  assert.equal(req.method, 'GET');
  assert.equal(req.stream, true);
  assert.deepEqual(req.headers, [['Accept', 'text/event-stream']]);
  assert.deepEqual((await prepare(own, {})).headers, [['Accept', 'application/x-ndjson']]);
  const seen = [];
  const r = await send(req, { onStream: (p) => seen.push(p.events) });
  assert.equal(r.headers.find(([k]) => k === 'x-accept')[1], 'text/event-stream');
  assert.equal(r.stream.events, 2);
  assert.ok(seen.length >= 1);
  assert.equal(prettyBody(r), '#1\n{\n  "first": true\n}\n\n#2  event: last\nbye');
  writeFileSync(join(dir, 'sse.http'), `### Feed\nSSE ${base}/plain\n`);
  const app = start({ initialFile: join(dir, 'sse.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Feed'), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => /200 OK .*2 events/s.test(f()), 'the two events, as a stream');
    assert.match(f(), /event: last/);
  } finally {
    app.unmount();
  }
});
