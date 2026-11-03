// The shared run.js: programs started without a terminal, and signals of their own for calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callSignal, run } from '../run.js';

test('callSignal ties a call to a long-lived signal only until it is done', () => {
  const task = new AbortController();
  const calls = Array.from({ length: 50 }, () => callSignal(task.signal));
  assert.equal(getEventListeners(task.signal, 'abort').length, 50);
  for (const c of calls.slice(1)) c.done();
  assert.equal(getEventListeners(task.signal, 'abort').length, 1, 'only the call still going listens');
  task.abort('stopped');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[0].signal.reason, 'stopped');
  assert.equal(calls[1].signal.aborted, false, 'a call already done is left alone');
  assert.equal(callSignal(task.signal).signal.aborted, true, 'already aborted: so is the call');
  assert.equal(callSignal(undefined).signal, undefined);
  callSignal(undefined).done();
});

test('run gives a program its output, and a cancelled one says so', async () => {
  const { stdout } = await run('node -e "process.stdout.write(\'hi\')"');
  assert.equal(stdout, 'hi');
  const c = new AbortController();
  const p = run('node -e "setTimeout(() => {}, 10000)"', { signal: c.signal });
  setTimeout(() => c.abort(), 100);
  await assert.rejects(p, (e) => e.cancelled === true);
  assert.equal(getEventListeners(c.signal, 'abort').length, 0);
});

test("run hands each line to onLine as it's written, and gives bytes as a Buffer with binary", async () => {
  // The scripts go in files: quoting one for both sh and cmd.exe on one command line isn't the same
  // (cmd.exe leaves a backslash before a quote as it is).
  const dir = mkdtempSync(join(tmpdir(), 'kit-run-'));
  try {
    const script = (name, code) => {
      const file = join(dir, name);
      writeFileSync(file, code);
      return `${JSON.stringify(process.execPath)} ${JSON.stringify(file)}`;
    };
    const heard = [];
    const lines = script('lines.js', "process.stdout.write('one\\ntw'); setTimeout(() => { process.stdout.write('o\\nthree'); process.stderr.write('warn\\n'); }, 50);");
    const r = await run(lines, { onLine: (line, which) => heard.push([which, line]) });
    assert.equal(r.stdout, 'one\ntwo\nthree');
    assert.deepEqual(heard.filter(([w]) => w === 'stdout').map(([, l]) => l), ['one', 'two', 'three']);
    assert.deepEqual(heard.filter(([w]) => w === 'stderr').map(([, l]) => l), ['warn']);
    // Bytes that aren't UTF-8 come back as they were written.
    const bytes = await run(script('bytes.js', 'process.stdout.write(Buffer.from([0xff, 0x00, 0xfe]));'), { binary: true });
    assert.ok(Buffer.isBuffer(bytes.stdout));
    assert.deepEqual([...bytes.stdout], [0xff, 0x00, 0xfe]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
