// The screen over a fake session: typing into the script, running it, the console, saving and opening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';
import { ERROR_MARK, createSession, locate } from '../src/powershell.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(`waited for ${what}`);
}

function fakeSession() {
  const runs = [];
  return {
    bin: 'fake',
    runs,
    stopped: 0,
    async run(code, onLine) {
      runs.push(code);
      onLine(`ran ${code.split('\n').length} line(s)`);
      if (code.includes('bad')) onLine(`${ERROR_MARK}it failed`);
      return { stopped: false };
    },
    stop() {
      this.stopped++;
    },
    close() {},
  };
}

const type = async (app, text) => {
  for (const ch of text) {
    app.stdin.write(ch);
    await sleep(5);
  }
};

test('typing a script and F5 runs all of it; errors are shown without their mark', async () => {
  const session = fakeSession();
  const app = render(React.createElement(App, { session }));
  await sleep(30);
  await type(app, '$a = 1');
  app.stdin.write('\r');
  await sleep(10);
  await type(app, 'bad');
  await until(() => app.lastFrame().includes('2:4'), 'the cursor');
  app.stdin.write('\x1b[15~');
  await until(() => app.lastFrame().includes('it failed'), 'the output');
  assert.deepEqual(session.runs, ['$a = 1\nbad']);
  assert.match(app.lastFrame(), /ran 2 line\(s\)/);
  assert.ok(!app.lastFrame().includes(ERROR_MARK));
  app.unmount();
});

test('F8 runs the current line; the console runs what is typed there and remembers it', async () => {
  const session = fakeSession();
  const app = render(React.createElement(App, { session }));
  await sleep(30);
  await type(app, 'one');
  app.stdin.write('\r');
  await type(app, 'two');
  await sleep(40);
  app.stdin.write('\x1b[19~');
  await until(() => session.runs.length === 1, 'F8');
  assert.deepEqual(session.runs, ['two']);
  app.stdin.write('\x14'); // ctrl+t
  await sleep(20);
  await type(app, 'Get-Date');
  app.stdin.write('\r');
  await until(() => session.runs.length === 2, 'the console');
  assert.equal(session.runs[1], 'Get-Date');
  await until(() => app.lastFrame().includes('PS> Get-Date'), 'the echo');
  app.stdin.write('\x1b[A');
  await until(() => app.lastFrame().includes('> Get-Date'), 'history');
  app.unmount();
});

test('ctrl+s asks for a path and saves; ctrl+o opens a file; quitting with unsaved changes warns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-'));
  try {
    const session = fakeSession();
    const app = render(React.createElement(App, { session, cwd: dir }));
    await sleep(30);
    await type(app, 'hello');
    app.stdin.write('\x13'); // ctrl+s
    await sleep(20);
    await type(app, 'a.ps1');
    app.stdin.write('\r');
    await until(() => app.lastFrame().includes('Saved'), 'the save');
    assert.equal(readFileSync(join(dir, 'a.ps1'), 'utf8'), 'hello');
    writeFileSync(join(dir, 'b.ps1'), 'Write-Host b\nline2');
    app.stdin.write('\x0f'); // ctrl+o
    await sleep(20);
    await type(app, 'b.ps1');
    app.stdin.write('\r');
    await until(() => app.lastFrame().includes('Write-Host'), 'the opened file');
    assert.match(app.lastFrame(), /b\.ps1/);
    await type(app, 'x');
    app.stdin.write('\x11'); // ctrl+q
    await until(() => app.lastFrame().includes('unsaved changes'), 'the warning');
    app.unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('esc stops a running script through the session', async () => {
  const session = fakeSession();
  session.run = () => new Promise(() => {});
  const app = render(React.createElement(App, { session }));
  await sleep(30);
  await type(app, 'x');
  app.stdin.write('\x1b[15~');
  await until(() => app.lastFrame().includes('running'), 'running');
  app.stdin.write('\x1b');
  await until(() => session.stopped === 1, 'the stop');
  app.unmount();
});

test('a real PowerShell session keeps variables between runs and marks errors (skipped without one)', async (t) => {
  const bin = await locate();
  if (!bin) return t.skip('no PowerShell');
  const session = createSession({ bin });
  try {
    const out = [];
    await session.run('$x = 21', (l) => out.push(l));
    await session.run('$x * 2; Write-Error "boom"', (l) => out.push(l));
    assert.deepEqual(out, ['42', `${ERROR_MARK}boom`]);
  } finally {
    session.close();
  }
});
