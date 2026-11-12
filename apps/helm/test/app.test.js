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
  const app = render(React.createElement(App, { family: false, session }));
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
  const app = render(React.createElement(App, { family: false, session }));
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
    const app = render(React.createElement(App, { family: false, session, cwd: dir }));
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
  const app = render(React.createElement(App, { family: false, session }));
  await sleep(30);
  await type(app, 'x');
  app.stdin.write('\x1b[15~');
  await until(() => app.lastFrame().includes('running'), 'running');
  app.stdin.write('\x1b');
  await until(() => session.stopped === 1, 'the stop');
  app.unmount();
});

test('a script printing a hundred thousand lines shows the last of them quickly, in order', async () => {
  const session = fakeSession();
  session.run = async (code, onLine) => {
    for (let i = 0; i < 100000; i++) onLine(`row ${i}`);
    return { stopped: false };
  };
  const app = render(React.createElement(App, { family: false, session }));
  await sleep(30);
  await type(app, 'x');
  const started = performance.now();
  app.stdin.write('\x1b[15~');
  await until(() => app.lastFrame().includes('row 99999'), 'the last line');
  assert.ok(performance.now() - started < 1000, 'within a second');
  const frame = app.lastFrame();
  assert.ok(frame.indexOf('row 99998') < frame.indexOf('row 99999'));
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

test('shift+arrows select, ctrl+z undoes and ctrl+y redoes, F8 runs the selection', async () => {
  const session = fakeSession();
  const app = render(React.createElement(App, { family: false, session }));
  await sleep(30);
  await type(app, 'abc');
  await sleep(40);
  app.stdin.write('\x1b[1;2D'); // shift+left
  app.stdin.write('\x1b[1;2D');
  await until(() => app.lastFrame().includes('2 selected'), 'the selection');
  app.stdin.write('\x1b[19~');
  await until(() => session.runs.length === 1, 'F8');
  assert.deepEqual(session.runs, ['bc']);
  app.stdin.write('\x1a'); // ctrl+z: nothing to undo yet except the typing
  await until(() => !app.lastFrame().includes('abc'), 'undo');
  app.stdin.write('\x19'); // ctrl+y
  await until(() => app.lastFrame().includes('abc'), 'redo');
  app.unmount();
});

test('the Console view takes the whole screen; warnings are shown; ctrl+f finds', async () => {
  const session = fakeSession();
  session.run = async (code, onLine) => {
    onLine(`\x03careful`);
    return { stopped: false };
  };
  const app = render(React.createElement(App, { family: false, session }));
  await sleep(30);
  await type(app, 'needle in a haystack');
  app.stdin.write('\x1b[15~');
  await until(() => app.lastFrame().includes('WARNING: careful'), 'the warning');
  app.stdin.write('\x14'); // ctrl+t
  await until(() => app.lastFrame().includes('tab complete'), 'the console view');
  assert.ok(!app.lastFrame().includes('needle'), 'the script is not shown in the console');
  app.stdin.write('\x14');
  await until(() => app.lastFrame().includes('needle'), 'back to the script');
  app.stdin.write('\x06'); // ctrl+f
  await sleep(20);
  await type(app, 'hay');
  app.stdin.write('\r');
  await until(() => app.lastFrame().includes('3 selected'), 'the match selected');
  app.unmount();
});

test('the mouse: a click places the cursor, a drag selects, a tab click switches views', async () => {
  const session = fakeSession();
  let emit = () => {};
  const mouse = { subscribe: (fn) => ((emit = fn), () => {}), claimDrags() {}, enable() {} };
  const app = render(React.createElement(App, { family: false, session, mouse }));
  await sleep(30);
  await type(app, 'hello');
  app.stdin.write('\r');
  await type(app, 'world');
  await until(() => app.lastFrame().includes('2:6'), 'the cursor');
  // The code starts at column 7 of the third row of the screen (top line, title row, then text).
  emit({ button: 'left', x: 9, y: 2 });
  await until(() => app.lastFrame().includes('1:3'), 'the click');
  emit({ drag: true, button: 'left', x: 12, y: 3, from: { x: 8, y: 2 } });
  await until(() => app.lastFrame().includes('selected'), 'the drag');
  emit({ button: 'left', x: 30, y: 0 }); // the Console tab
  await until(() => app.lastFrame().includes('tab complete'), 'the Console view');
  app.unmount();
});

test('the family: a run writes Spoke\'s mood and an activity line without the code; a sibling\'s worry is heard', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-family-'));
  const was = process.env.FAMILY_HOME;
  process.env.FAMILY_HOME = home;
  try {
    const { readActivity, readMoods, writeMood } = await import('@fleet/kit/family.js');
    writeMood('bosun', { mood: 'worried', reason: 'a process crashed' });
    const session = fakeSession();
    const app = render(React.createElement(App, { session, moodEvery: 50 }));
    try {
    await until(() => app.lastFrame().includes('Bosun is worried'), 'the sibling\'s mood');
    await type(app, 'secret-token-123 bad');
    app.stdin.write('\x1b[15~');
    await until(() => readActivity({}).some((a) => a.app === 'helm'), 'the activity line');
    const line = readActivity({}).find((a) => a.app === 'helm');
    assert.equal(line.kind, 'error');
    assert.ok(!JSON.stringify(line).includes('secret-token'), 'no code in the log');
    await until(() => readMoods('bosun').find((m) => m.app === 'helm')?.mood === 'worried', 'the mood');
    } finally {
      app.unmount();
    }
  } finally {
    if (was === undefined) delete process.env.FAMILY_HOME;
    else process.env.FAMILY_HOME = was;
    rmSync(home, { recursive: true, force: true });
  }
});
