// Structured logs: each logger's JSON lines read and drawn, the filter, and the Crew view's log with
// ctrl+l, e and the viewer's ↵ on a line.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';
import { clockOf, formatStructured, levelName, parseFilter, parseStructured, passes, shownText, troubleText, troubled } from '../src/structured.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const T = Date.UTC(2026, 9, 24, 12, 30, 5, 120);
const at = clockOf(T);

test('pino, bunyan, Serilog, winston and plain level/msg/time lines read as one shape', () => {
  const pino = parseStructured(JSON.stringify({ level: 40, time: T, pid: 9, hostname: 'box', msg: 'slow query', ms: 812, route: '/orders' }));
  assert.equal(pino.level, 'warn');
  assert.equal(pino.time, T);
  assert.equal(pino.message, 'slow query');
  assert.deepEqual(pino.fields, [['ms', 812], ['route', '/orders']]);
  assert.equal(formatStructured(pino).text, `${at} WARN  slow query ms=812 route=/orders`);

  const bunyan = parseStructured(JSON.stringify({ name: 'api', hostname: 'h', pid: 1, level: 50, msg: 'boom', time: new Date(T).toISOString(), v: 0, err: { message: 'no db', name: 'Error', stack: 'Error: no db\n at x' } }));
  assert.equal(bunyan.level, 'error');
  assert.equal(formatStructured(bunyan).text, `${at} ERROR boom name=api err="Error: no db"`);

  const serilog = parseStructured(JSON.stringify({ '@t': new Date(T).toISOString(), '@mt': 'Order {OrderId} took {Elapsed:0.0} ms', OrderId: 42, Elapsed: 12.5, '@x': 'System.Exception: oops\n   at Foo()' }));
  assert.equal(serilog.level, 'info', 'Information when @l is missing');
  assert.equal(serilog.message, 'Order 42 took 12.5 ms');
  assert.deepEqual(serilog.fields, [['OrderId', 42], ['Elapsed', 12.5], ['exception', 'System.Exception: oops']]);
  assert.equal(parseStructured('{"@t":"2026-10-24T12:30:05Z","@m":"Hi","@l":"Warning"}').level, 'warn');

  const winston = parseStructured(JSON.stringify({ level: 'error', message: 'payment failed', timestamp: new Date(T).toISOString(), service: 'pay' }));
  assert.equal(formatStructured(winston).text, `${at} ERROR payment failed service=pay`);

  const generic = parseStructured('{"severity":"DEBUG","message":"cache\\nwarm","ts":1761309005.12,"user":"a b"}');
  assert.equal(generic.level, 'debug');
  assert.equal(generic.time, 1761309005120);
  assert.match(formatStructured(generic).text, /DEBUG cache ⏎ warm user="a b"$/);

  for (const text of ['not json', '{"a":1}', '[1,2]', '{broken', '{"level":"loud"}']) assert.equal(parseStructured(text), null, text);
  assert.deepEqual([10, 20, 30, 40, 50, 60, 'Verbose', 'WARNING', 'crit', '30'].map(levelName), ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'trace', 'warn', 'fatal', 'info']);
  assert.equal(troubleText('{"level":50,"msg":"db down"}'), 'ERROR db down');
  assert.equal(troubleText('{"level":30,"msg":"Error count is 0"}'), null, 'an info line is no trouble, whatever it says');
  assert.equal(troubleText('TypeError: x is undefined'), 'TypeError: x is undefined');
});

test('the filter: levels, fields, words, together', () => {
  const line = (obj) => ({ text: typeof obj === 'string' ? obj : JSON.stringify(obj), at: 1 });
  const warn = line({ level: 40, msg: 'slow query', route: '/orders', req: { method: 'GET' }, ms: 812 });
  const info = line({ level: 30, msg: 'listening', port: 3000 });
  const plain = line('Error: plain trouble');
  const quiet = line('just text');
  const keep = (f) => [warn, info, plain, quiet].filter((l) => passes(parseFilter(f), l)).length;
  assert.equal(keep(''), 4);
  assert.equal(keep('level>=warn'), 2, 'the warning and the plain line that reads as trouble');
  assert.equal(keep('level=info'), 1);
  assert.equal(keep('level<warn'), 1);
  assert.equal(keep('route=/orders'), 1);
  assert.equal(keep('req.method=get'), 1, 'dotted paths, any case');
  assert.equal(keep('route!=/orders'), 1, 'the structured line without it; plain lines have no fields');
  assert.equal(keep('msg~QUERY'), 1);
  assert.equal(keep('port=3000 listening'), 1);
  assert.equal(keep('plain'), 1);
  assert.equal(keep('Plain'), 0, 'a capital makes it exact');
  assert.equal(keep('level>=warn slow'), 1);
  assert.equal(keep('msg="slow query"'), 1, 'quotes keep spaces in');
  assert.deepEqual(parseFilter('level>=loud').problems, ["loud isn't a level (trace, debug, info, warn, error, fatal)"]);
  assert.equal(troubled(line({ level: 50, msg: 'x' })), true);
  assert.equal(troubled(warn), false);
  assert.equal(shownText(quiet), 'just text');
});

const LOGGER = `
const log = (level, msg, extra = {}) => console.log(JSON.stringify({ level, time: Date.now(), pid: process.pid, msg, ...extra }));
log(30, 'listening', { port: 3000 });
log(40, 'slow query', { ms: 812, route: '/orders' });
log(50, 'payment failed', { orderId: 'ord_77' });
console.log('a plain line');
setInterval(() => {}, 1000);
`;

test('the Crew view draws JSON lines as time level message; ctrl+l filters them, with e and the search; ↵ in the viewer shows one whole', async () => {
  const dir = project({ procs: { api: 'node logger.js' } }, { 'logger.js': LOGGER });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /INFO\s+listening port=3000/.test(frame()) && frame().includes('a plain line'), 'the lines, formatted');
    assert.match(frame(), /WARN\s+slow query ms=812 route=\/orders/);
    assert.ok(!frame().includes('"msg"'), 'no raw JSON');
    assert.match(frame(), /api\s+running\s+\S+ !/, 'the error line is its trouble');

    app.stdin.write('\x0c');
    await until(() => frame().includes('Filter the log'), 'the filter asked for');
    await type(app.stdin, 'level>=warn');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('filter level>=warn') && !frame().includes('listening port') && !frame().includes('a plain line'), 'only warnings and worse');
    assert.match(frame(), /ERROR payment failed orderId=ord_77/);
    app.stdin.write('e');
    await until(() => frame().includes('trouble only') && !frame().includes('slow query'), 'and only trouble: the error alone');
    app.stdin.write('e');
    await until(() => frame().includes('slow query'), 'e again');
    app.stdin.write('\x0c');
    await until(() => frame().includes('Filter the log'), 'asked again, with what it was');
    app.stdin.write('\x15');
    await type(app.stdin, 'orderId=ord_77');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('filter orderId=ord_77') && !frame().includes('slow query') && frame().includes('payment failed'), 'by a field');
    app.stdin.write('\x0c');
    await until(() => frame().includes('Filter the log'), 'asked once more');
    app.stdin.write('\x15');
    app.stdin.write(KEYS.enter);
    await until(() => !frame().includes('filter ') && frame().includes('a plain line'), 'every line again');

    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('api · node logger.js') && /WARN\s+slow query/.test(frame()), 'the viewer, formatted too');
    app.stdin.write('/');
    await type(app.stdin, 'slow');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/slow 1/1'), 'the search on it');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"msg": "slow query"') && frame().includes('"route": "/orders"'), 'its object, pretty');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('api · node logger.js'), 'back to the log');
    app.stdin.write(KEYS.esc);
  } finally {
    app.stdin.write('q');
    app.unmount();
  }
});
