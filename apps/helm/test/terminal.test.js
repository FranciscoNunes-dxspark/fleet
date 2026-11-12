// The console's terminal: how it starts on each system, the output read with its marks taken out and its questions
// answered, and the real thing (sh through script here, PowerShell through the relay on Windows, and PowerShell
// itself where it's installed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualTerminal } from '@fleet/kit/vt.js';
import { encodeCommand, launchFor, openTerminal, outputReader, sttyArgs } from '../src/terminal.js';
import { locate } from '../src/powershell.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  assert.fail(`waited for ${what}`);
}
const screen = (vt) => [...vt.history.map((_, i) => vt.historyAnsi(i).replace(/\x1b\[[0-9;]*m/g, '')), ...Array.from({ length: vt.rows }, (_, y) => vt.rowText(y))].join('\n');

test('launchFor: script on Linux and macOS, with the size, the tty and the program quoted; the relay on Windows', () => {
  const linux = launchFor({ platform: 'linux', bin: 'pwsh', args: ['-c', "it's"], columns: 90, rows: 20, env: { SHELL: '/bin/zsh' } });
  assert.equal(linux.command, 'script');
  assert.deepEqual(linux.args.slice(0, 1), ['-qfec']);
  assert.match(linux.args[1], /stty cols 90 rows 20/);
  assert.match(linux.args[1], /exec 'pwsh' '-c' 'it'\\''s'$/);
  assert.equal(linux.env.SHELL, '/bin/sh');
  assert.equal(linux.env.HELM_USER_SHELL, '/bin/zsh');
  const mac = launchFor({ platform: 'darwin', bin: 'pwsh', args: [], env: {} });
  assert.deepEqual(mac.args.slice(0, 4), ['-q', '/dev/null', '/bin/sh', '-c']);
  assert.deepEqual(sttyArgs('darwin', '/dev/ttys003', 80, 24), ['-f', '/dev/ttys003', 'cols', '80', 'rows', '24']);
  assert.deepEqual(sttyArgs('linux', '/dev/pts/3', 80, 24), ['-F', '/dev/pts/3', 'cols', '80', 'rows', '24']);
  const win = launchFor({ platform: 'win32', bin: 'powershell', args: ['-Command', 'Write-Output "a b"'], columns: 100, rows: 30, env: {} });
  assert.equal(win.command, 'powershell');
  assert.equal(win.resize, 'relay');
  assert.equal(win.env.HELM_PTY_COMMAND, 'powershell -Command "Write-Output \\"a b\\""');
  assert.equal(win.env.HELM_PTY_SIZE, '100,30');
  assert.equal(launchFor({ platform: 'win32', bin: 'pwsh', env: {} }).command, 'pwsh');
  assert.equal(encodeCommand('a'), Buffer.from('a', 'utf16le').toString('base64'));
});

test('outputReader takes the marks out, answers where the cursor is, and waits for one cut between chunks', () => {
  const vt = new VirtualTerminal(20, 4);
  const marks = [];
  const answers = [];
  const read = outputReader(vt, { onMark: (code, body) => marks.push([code, body]), answer: (a) => answers.push(a) });
  read('\x1b]5380;/dev/pts/7\x07abc\x1b]53');
  read('81;1\x07de');
  read('\x1b[');
  read('6n');
  read('\r\nx\x1b[5n\x1b[c');
  assert.deepEqual(marks, [['5380', '/dev/pts/7'], ['5381', '1']]);
  assert.deepEqual(answers, ['\x1b[1;6R', '\x1b[0n', '\x1b[?1;2c']);
  assert.equal(vt.rowText(0), 'abcde');
  assert.equal(vt.rowText(1), 'x');
});

test('a real terminal: what is typed reaches the program, a resize reaches its tty, the marks come through', async (t) => {
  if (process.platform === 'win32') return t.skip('the relay is tested below');
  const marks = [];
  let ended = null;
  const term = openTerminal({
    bin: 'sh',
    args: ['-c', `printf '\\033]5381;1\\007ready\\n'; IFS= read -r x; echo "got $x"; sleep 0.3; stty size; printf '\\033]5381;0\\007'`],
    columns: 40,
    rows: 8,
    onPrompt: (ok) => marks.push(ok),
    onExit: (info) => (ended = info),
  });
  try {
    await until(() => marks.length === 1, 'the first mark');
    assert.ok(term.marks);
    term.resize(30, 6);
    term.write('abc\r');
    await until(() => ended, 'the end');
    assert.deepEqual(marks, [true, false]);
    assert.match(screen(term.vt), /got abc/);
    assert.match(screen(term.vt), /6 30/);
    assert.equal(ended.code, 0);
  } finally {
    term.close();
  }
});

test('the Windows relay runs a program in a pseudo console (Windows only)', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  let ended = null;
  const term = openTerminal({ bin: 'powershell', args: ['-NoLogo', '-NoProfile', '-Command', "Write-Output ('helm-' + 'pty-ok'); exit 3"], columns: 60, rows: 10, onExit: (info) => (ended = info) });
  try {
    await until(() => ended, 'the end', 90_000);
    assert.match(screen(term.vt), /helm-pty-ok/);
    assert.equal(ended.code, 3);
  } finally {
    term.close();
  }
});

test('real PowerShell: variables stay between commands, and the prompt says whether each went well (skipped without one)', async (t) => {
  const bin = await locate();
  if (!bin) return t.skip('no PowerShell');
  const marks = [];
  const term = openTerminal({ bin, columns: 80, rows: 20, env: { ...process.env, NO_COLOR: '1' }, onPrompt: (ok) => marks.push(ok) });
  try {
    // Windows' older pseudo consoles can drop the marks: then only what PowerShell prints is checked.
    const marked = await until(() => marks.length >= 1, 'the first prompt', 90_000).then(
      () => true,
      (err) => {
        if (process.platform !== 'win32') throw err;
        t.diagnostic('no prompt marks through this pseudo console');
        return false;
      },
    );
    term.write('$x = 21\r');
    if (marked) await until(() => marks.length >= 2, 'the second prompt', 30_000);
    term.write("'answer ' + ($x * 2)\r");
    await until(() => /answer 42/.test(screen(term.vt)), 'the answer', 30_000);
    if (marked) {
      await until(() => marks.length >= 3, 'the third prompt', 30_000);
      term.write('Write-Error boom\r');
      await until(() => marks.length >= 4, 'the prompt after an error', 30_000);
      assert.deepEqual(marks.slice(1, 4), [true, true, false]);
    }
  } finally {
    term.close();
  }
});
