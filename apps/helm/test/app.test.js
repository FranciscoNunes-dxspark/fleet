// The screen over a fake shell: typing into the script, running it in the console, the Console view taking the
// keys, saving and opening, selection and undo, the mouse and the family.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { VirtualTerminal } from '@fleet/kit/vt.js';
import { App, psQuote } from '../src/ui/App.jsx';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(`waited for ${what}`);
}

// A shell that keeps what is typed into it; `say` puts text on its screen, `prompt(ok)` is PowerShell's prompt coming
// back (terminal.js's marks), `end()` its exit.
function fakeShell({ marks = true } = {}) {
  const shell = {
    name: 'fake',
    opened: [],
    get term() {
      return this.opened.at(-1);
    },
    open(options) {
      const vt = new VirtualTerminal(options.columns, options.rows, { scrollback: 100 });
      const term = {
        vt,
        options,
        typed: '',
        alive: true,
        marks,
        sizes: [],
        write(text) {
          this.typed += text;
        },
        resize(c, r) {
          if (c === vt.columns && r === vt.rows) return;
          this.sizes.push([c, r]);
          vt.fit(c, r);
        },
        close() {
          this.alive = false;
        },
        say(text) {
          vt.write(text);
          options.onChange();
        },
        prompt(ok) {
          options.onPrompt(ok);
        },
        end(code) {
          this.alive = false;
          options.onExit({ code });
        },
      };
      shell.opened.push(term);
      return term;
    },
  };
  return shell;
}

const type = async (app, text) => {
  for (const ch of text) {
    app.stdin.write(ch);
    await sleep(5);
  }
};

const start = (props = {}) => {
  const scratch = mkdtempSync(join(tmpdir(), 'helm-scratch-'));
  const shell = props.shell ?? fakeShell();
  const app = render(React.createElement(App, { family: false, scratch, ...props, shell }));
  return { app, shell, scratch, done: () => (app.unmount(), rmSync(scratch, { recursive: true, force: true })) };
};

test('psQuote doubles quotes, the curly ones too', () => {
  assert.equal(psQuote(`C:\\it's here`), `'C:\\it''s here'`);
  assert.equal(psQuote('a\u2019b'), `'a\u2019\u2019b'`);
});

test('F5 types the script into PowerShell as one dot-sourced file; the console shows what it says, and the prompt ends the run', async () => {
  const { app, shell, scratch, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    await type(app, '$a = 1');
    app.stdin.write('\r');
    await sleep(10);
    await type(app, 'bad');
    await until(() => app.lastFrame().includes('2:4'), 'the cursor');
    app.stdin.write('\x1b[15~');
    await until(() => shell.term.typed.endsWith('\r'), 'the run typed');
    const file = join(scratch, 'untitled.ps1');
    assert.equal(shell.term.typed, `. ${psQuote(file)}\r`);
    assert.equal(readFileSync(file, 'utf8'), '$a = 1\nbad');
    await until(() => app.lastFrame().includes('running'), 'running');
    shell.term.say('PS> . untitled.ps1\r\nit failed\r\n');
    await until(() => app.lastFrame().includes('it failed'), 'the output');
    shell.term.prompt(false);
    await until(() => !app.lastFrame().includes('running'), 'the run over');
  } finally {
    done();
  }
});

test('a saved script without changes runs from where it is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-'));
  try {
    writeFileSync(join(dir, 'b.ps1'), 'Write-Host b');
    const { app, shell, done } = start({ cwd: dir, file: 'b.ps1' });
    try {
      await until(() => app.lastFrame().includes('Write-Host'), 'the file');
      app.stdin.write('\x1b[15~');
      await until(() => shell.term.typed.endsWith('\r'), 'the run typed');
      assert.equal(shell.term.typed, `. ${psQuote(join(dir, 'b.ps1'))}\r`);
    } finally {
      done();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('F8 types the current line; the Console view gives PowerShell every key until ctrl+t', async () => {
  const { app, shell, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    await type(app, 'one');
    app.stdin.write('\r');
    await type(app, '\ttwo');
    await sleep(40);
    app.stdin.write('\x1b[19~');
    await until(() => shell.term.typed === 'two\r', 'F8');
    shell.term.prompt(true);
    app.stdin.write('\x14'); // ctrl+t
    await until(() => app.lastFrame().includes('keys go to PowerShell'), 'the Console view');
    shell.term.typed = '';
    await type(app, 'Get-Da');
    app.stdin.write('\t');
    app.stdin.write('\x1b[A');
    app.stdin.write('\x03');
    app.stdin.write('\r');
    await until(() => shell.term.typed === 'Get-Da\t\x1b[A\x03\r', 'the keys as they came');
    app.stdin.write('\x14');
    await until(() => app.lastFrame().includes('F5 run'), 'back to the script');
    assert.ok(!shell.term.typed.includes('\x14'), 'ctrl+t is not typed');
  } finally {
    done();
  }
});

test('the console follows its room: the Console view gives it the whole screen', async () => {
  const { app, shell, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    const first = shell.term.options.rows;
    app.stdin.write('\x14');
    await until(() => shell.term.sizes.length, 'a resize');
    assert.ok(shell.term.sizes.at(-1)[1] > first, 'taller in the Console view');
    void app;
  } finally {
    done();
  }
});

test('a shell that ended says so; ↵ in the Console view starts another', async () => {
  const { app, shell, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    shell.term.end(3);
    await until(() => app.lastFrame().includes('ended (exit 3)'), 'the end');
    app.stdin.write('\x14');
    await sleep(20);
    app.stdin.write('\r');
    await until(() => shell.opened.length === 2, 'a new shell');
  } finally {
    done();
  }
});

test('ctrl+s asks for a path and saves; ctrl+o opens a file; quitting with unsaved changes warns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-'));
  try {
    const { app, done } = start({ cwd: dir });
    try {
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
    } finally {
      done();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('esc stops a running script: ctrl+c to PowerShell, which keeps its variables', async () => {
  const { app, shell, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    await type(app, 'x');
    app.stdin.write('\x1b[15~');
    await until(() => app.lastFrame().includes('running'), 'running');
    shell.term.typed = '';
    app.stdin.write('\x1b');
    await until(() => shell.term.typed === '\x03', 'the stop');
    assert.equal(shell.opened.length, 1, 'the same session');
  } finally {
    done();
  }
});

test('without prompt marks a run is typed and nothing waits for it', async () => {
  const { app, shell, done } = start({ shell: fakeShell({ marks: false }) });
  try {
    await until(() => shell.term, 'the shell');
    await type(app, 'Get-Date');
    app.stdin.write('\x1b[19~');
    await until(() => shell.term.typed === 'Get-Date\r', 'the line');
    await sleep(30);
    assert.ok(!app.lastFrame().includes('running'));
  } finally {
    done();
  }
});

test('shift+arrows select, ctrl+z undoes and ctrl+y redoes, F8 runs the selection; several lines go as a file', async () => {
  const { app, shell, scratch, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    await type(app, 'abc');
    await sleep(40);
    app.stdin.write('\x1b[1;2D'); // shift+left
    app.stdin.write('\x1b[1;2D');
    await until(() => app.lastFrame().includes('2 selected'), 'the selection');
    app.stdin.write('\x1b[19~');
    await until(() => shell.term.typed === 'bc\r', 'F8');
    shell.term.prompt(true);
    app.stdin.write('\x1a'); // ctrl+z: nothing to undo yet except the typing
    await until(() => !app.lastFrame().includes('abc'), 'undo');
    app.stdin.write('\x19'); // ctrl+y
    await until(() => app.lastFrame().includes('abc'), 'redo');
    app.stdin.write('\x1b[F'); // end: the selection goes
    await sleep(20);
    app.stdin.write('\r');
    await type(app, 'def');
    await sleep(40);
    app.stdin.write('\x01'); // ctrl+a
    await until(() => app.lastFrame().includes('selected'), 'all selected');
    shell.term.typed = '';
    app.stdin.write('\x1b[19~');
    await until(() => shell.term.typed.endsWith('\r'), 'the selection run');
    assert.equal(shell.term.typed, `. ${psQuote(join(scratch, 'selection.ps1'))}\r`);
    assert.equal(readFileSync(join(scratch, 'selection.ps1'), 'utf8'), 'abc\ndef');
  } finally {
    done();
  }
});

test('the Console view takes the whole screen; shift+pgup looks back; ctrl+f finds', async () => {
  const { app, shell, done } = start();
  try {
    await until(() => shell.term, 'the shell');
    await type(app, 'needle in a haystack');
    shell.term.say(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\r\n'));
    app.stdin.write('\x14'); // ctrl+t
    await until(() => app.lastFrame().includes('keys go to PowerShell'), 'the console view');
    assert.ok(!app.lastFrame().includes('needle'), 'the script is not shown in the console');
    assert.match(app.lastFrame(), /line 59/);
    app.stdin.write('\x1b[5;2~');
    await until(() => app.lastFrame().includes('lines up'), 'looking back');
    assert.ok(!app.lastFrame().includes('line 59'));
    assert.ok(!shell.term.typed.includes('\x1b[5;2~'), 'not typed');
    app.stdin.write('\x14');
    await until(() => app.lastFrame().includes('needle'), 'back to the script');
    app.stdin.write('\x06'); // ctrl+f
    await sleep(20);
    await type(app, 'hay');
    app.stdin.write('\r');
    await until(() => app.lastFrame().includes('3 selected'), 'the match selected');
  } finally {
    done();
  }
});

test('the mouse: a click places the cursor, a drag selects, a tab click switches views', async () => {
  let emit = () => {};
  const mouse = { subscribe: (fn) => ((emit = fn), () => {}), claimDrags() {}, enable() {} };
  const { app, done } = start({ mouse });
  try {
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
    await until(() => app.lastFrame().includes('keys go to PowerShell'), 'the Console view');
  } finally {
    done();
  }
});

test("the family: a failed run writes Spoke's mood and an activity line without the code; a sibling's worry is heard", async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-family-'));
  const was = process.env.FAMILY_HOME;
  process.env.FAMILY_HOME = home;
  try {
    const { readActivity, readMoods, writeMood } = await import('@fleet/kit/family.js');
    writeMood('bosun', { mood: 'worried', reason: 'a process crashed' });
    const { app, shell, done } = start({ family: true, moodEvery: 50 });
    try {
      await until(() => app.lastFrame().includes('Bosun is worried'), "the sibling's mood");
      await type(app, 'secret-token-123 bad');
      app.stdin.write('\x1b[15~');
      await until(() => shell.term.typed.endsWith('\r'), 'the run');
      shell.term.prompt(false);
      await until(() => readActivity({}).some((a) => a.app === 'helm'), 'the activity line');
      const line = readActivity({}).find((a) => a.app === 'helm');
      assert.equal(line.kind, 'error');
      assert.ok(!JSON.stringify(line).includes('secret-token'), 'no code in the log');
      await until(() => readMoods('bosun').find((m) => m.app === 'helm')?.mood === 'worried', 'the mood');
    } finally {
      done();
    }
  } finally {
    if (was === undefined) delete process.env.FAMILY_HOME;
    else process.env.FAMILY_HOME = was;
    rmSync(home, { recursive: true, force: true });
  }
});
