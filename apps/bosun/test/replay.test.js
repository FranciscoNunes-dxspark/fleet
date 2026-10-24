// Recording a session and reading it back: the recorder's file, pruning and size limit; the reader's
// crew at a moment, its marks and the timeline; and /replay in the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, listSessions, projectHash, sessionFile, sessionStart, sessionsDir, toPrune } from '../src/recorder.js';
import { Replayer, clock, marksOf, nextMark, parseSession, timeline } from '../src/replay.js';
import { Supervisor } from '../src/supervisor.js';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('session files: named by their start, pruned to the newest ten, one folder per project', () => {
  const name = sessionFile(Date.UTC(2026, 9, 23, 9, 15, 2, 123));
  assert.equal(name, '2026-10-23T09-15-02-123Z.jsonl');
  assert.equal(sessionStart(name), Date.UTC(2026, 9, 23, 9, 15, 2, 123));
  assert.equal(sessionStart('notes.txt'), null);
  const names = Array.from({ length: 12 }, (_, i) => sessionFile(Date.UTC(2026, 0, 1, 0, i)));
  assert.deepEqual(toPrune([...names, 'other.txt'], 10), [names[1], names[0]]);
  assert.equal(projectHash('C:\\Shop', 'win32'), projectHash('c:\\shop', 'win32'));
  assert.notEqual(projectHash('/a'), projectHash('/b'));
  assert.match(sessionsDir('/a', '/home/x'), /sessions[\\/][0-9a-f]{16}$/);
});

test('the recorder writes nothing until a process says something, prunes, and stops at its size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bosun-rec-'));
  try {
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, sessionFile(Date.UTC(2020, 0, 1, 0, i))), '');
    const r = new Recorder({ dir, project: '/shop', procs: [{ name: 'api', port: 3000, run: 'node api.js' }], now: Date.UTC(2026, 0, 1), maxBytes: 600 });
    r.state('api', { status: 'starting' }, Date.UTC(2026, 0, 1) + 10);
    r.flush();
    assert.equal(readdirSync(dir).length, 10, 'nothing yet');
    r.line('api', { at: Date.UTC(2026, 0, 1) + 20, text: 'listening' });
    r.flush();
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 10, 'the oldest went');
    assert.equal(files.at(-1), sessionFile(Date.UTC(2026, 0, 1)));
    const s = parseSession(readFileSync(r.file, 'utf8'));
    assert.equal(s.project, '/shop');
    assert.deepEqual(s.header.procs, [{ name: 'api', port: 3000, run: 'node api.js' }]);
    assert.deepEqual(s.events.map((e) => e.type), ['state', 'line']);
    for (let i = 0; i < 20; i++) r.line('api', { at: Date.UTC(2026, 0, 1) + 100 + i, text: 'x'.repeat(50) });
    r.close();
    const cut = parseSession(readFileSync(r.file, 'utf8'));
    assert.equal(cut.cut, true);
    assert.ok(readFileSync(r.file).length < 800);
    r.line('api', { at: 1, text: 'after' });
    assert.deepEqual(listSessions('/nowhere', { home: dir }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SESSION = [
  { type: 'session', v: 1, project: '/shop', start: 0, procs: [{ name: 'api', port: 3000, run: 'node api.js' }, { name: 'web', port: null, run: 'vite' }] },
  { t: 100, type: 'state', p: 'api', status: 'starting' },
  { t: 150, type: 'line', p: 'api', text: '── node api.js' },
  { t: 200, type: 'state', p: 'api', status: 'running' },
  { t: 1200, type: 'state', p: 'api', status: 'running', portOpen: true },
  { t: 3000, type: 'line', p: 'web', text: 'Error: cannot reach api', err: true },
  { t: 5000, type: 'line', p: 'api', text: 'TypeError: x is undefined' },
  { t: 5100, type: 'state', p: 'api', status: 'crashed', code: 1 },
  { t: 9000, type: 'line', p: 'web', text: 'ok now' },
].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';

test('the reader: the crew at any moment, forwards and back, and the marks between', () => {
  const s = parseSession(SESSION);
  assert.equal(s.start, 0);
  assert.equal(s.end, 9000);
  const r = new Replayer(s);
  let procs = r.at(1500);
  assert.equal(procs[0].status, 'running');
  assert.equal(procs[0].portOpen, true);
  assert.ok(procs[0].child);
  assert.equal(procs[1].lines.length, 0);
  procs = r.at(6000);
  assert.equal(procs[0].status, 'crashed');
  assert.equal(procs[0].code, 1);
  assert.equal(procs[0].trouble, 'TypeError: x is undefined');
  assert.equal(procs[1].lines.length, 1);
  procs = r.at(150);
  assert.equal(procs[0].status, 'starting');
  assert.equal(procs[0].lines.length, 1);
  const marks = marksOf(s);
  assert.deepEqual(marks.map((m) => [m.t, m.kind]), [[3000, 'trouble'], [5000, 'trouble'], [5100, 'crash']]);
  assert.equal(nextMark(marks, 3000, 1).t, 5000);
  assert.equal(nextMark(marks, 3000, -1), null);
  assert.equal(nextMark(marks, 9000, -1).kind, 'crash');
  const bar = timeline(s, marks, 4500, 10);
  assert.equal(bar.cells.join(''), '───!─✗────');
  assert.equal(bar.cursor, 5);
  assert.equal(clock(65_000), '1:05');
  assert.equal(clock(3_725_000), '1:02:05');
});

test('a supervisor records its processes\' lines and states', async () => {
  const lines = [];
  const states = [];
  const recorder = { line: (p, l) => lines.push([p, l.text]), state: (p, s) => states.push([p, s.status]), procs: () => {}, close: () => {} };
  const sup = new Supervisor([{ name: 'hi', run: 'node -e "console.log(42)"', cwd: '.', env: {} }], { dir: process.cwd(), recorder });
  sup.start('hi');
  await until(() => sup.get('hi').status === 'exited', 'it ran');
  sup.dispose();
  assert.ok(lines.some(([p, t]) => p === 'hi' && t === '42'));
  assert.deepEqual(states.map((s) => s[1]).filter((s, i, a) => s !== a[i - 1]), ['starting', 'running', 'exited']);
});

test('/replay plays back this session: ] jumps to the crash, ← → step, space plays', async () => {
  const dir = project({ procs: { queue: 'node crash.js', ok: 'node tick.js' } }, {
    'crash.js': `console.log('connecting'); setTimeout(() => { console.error('Error: the queue is not there'); process.exit(2); }, 1500);`,
    'tick.js': `let n = 0; setInterval(() => console.log('tick ' + ++n), 200);`,
  });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /queue\s+crashed/.test(frame()), 'the crash');
    await new Promise((r) => setTimeout(r, 1200));
    app.stdin.write('/');
    await type(app.stdin, 'replay');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('this one, so far'), 'the sessions');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('as it was then') && frame().includes('0:00 /'), 'the replay at its start');
    assert.match(frame(), /✗/);
    app.stdin.write(']');
    await until(() => /Error: the queue is not there/.test(frame()) && /● queue\s+running/.test(frame()), 'the trouble line, before the crash');
    app.stdin.write(']');
    await until(() => /● queue\s+crashed/.test(frame()) && frame().includes('queue crashed (2)'), 'the crash');
    app.stdin.write('\x1b[D');
    await until(() => /● queue\s+running/.test(frame()), 'a second back');
    app.stdin.write('+');
    await until(() => frame().includes('2×'), 'faster');
    app.stdin.write(' ');
    await until(() => frame().includes('▶'), 'playing');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('this one, so far'), 'back to the sessions');
    app.stdin.write(KEYS.esc);
    await until(() => /❯ ● queue/.test(frame()), 'back to the crew');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});
