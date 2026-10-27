// e: a shell in a container or pod. The commands (with a terminal or without), the line-mode pane's
// state, and the pane and the hand-over in the app.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AGAIN_MS, MAX_LINES, SHELL_SCRIPT, commandLine, dockerShell, kubeShell, paneEnded, paneKey, paneOutput, paneScroll, paneStart, paneView } from '../src/shell.js';
import { demoShell } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('the commands: a terminal outside Fleet (-it), none inside (-i), bash else sh, names checked', () => {
  assert.deepEqual(dockerShell('a1b2c3d4e5f6'), { command: 'docker', args: ['exec', '-it', 'a1b2c3d4e5f6', 'sh', '-c', SHELL_SCRIPT] });
  assert.equal(dockerShell('web', { tty: false }).args[1], '-i');
  assert.match(SHELL_SCRIPT, /command -v bash .*exec bash \|\| exec sh/);
  assert.throws(() => dockerShell('web; rm -rf /'), /isn't a container/);
  const pod = { name: 'prometheus-0', namespace: 'monitoring' };
  assert.deepEqual(kubeShell(pod, 'config-reloader', { tty: false }), { command: 'kubectl', args: ['exec', '-i', '-n', 'monitoring', 'prometheus-0', '-c', 'config-reloader', '--', 'sh', '-c', SHELL_SCRIPT] });
  assert.deepEqual(kubeShell(pod, null).args.slice(0, 5), ['exec', '-it', '-n', 'monitoring', 'prometheus-0']);
  assert.ok(!kubeShell(pod, null).args.includes('-c') || kubeShell(pod, null).args.indexOf('-c') > 5);
  assert.throws(() => kubeShell({ name: 'x', namespace: 'a b' }, null), /isn't a name/);
  assert.equal(commandLine(dockerShell('web', { tty: false })), `docker exec -i web sh -c '${SHELL_SCRIPT}'`);
});

test('the pane: output by lines, a line still being written, colours and carriage returns taken out', () => {
  let s = paneStart();
  s = paneOutput(s, 'one\r\ntwo\nthr');
  assert.deepEqual(s.lines, ['one', 'two']);
  assert.equal(s.partial, 'thr');
  s = paneOutput(s, 'ee\n\x1b[31mred\x1b[0m\n10%\r50%\r100%\n');
  assert.deepEqual(s.lines, ['one', 'two', 'three', 'red', '100%']);
  assert.deepEqual(paneView(s, 2).lines, ['red', '100%']);
  s = paneOutput(s, '$ ');
  assert.deepEqual(paneView(s, 2).lines, ['100%', '$ ']);
  const many = paneOutput(paneStart(), 'x\n'.repeat(MAX_LINES + 10));
  assert.equal(many.lines.length, MAX_LINES);
  const ended = paneEnded(paneOutput(paneStart(), 'bye'), 0);
  assert.deepEqual(ended.lines, ['bye']);
  assert.deepEqual(ended.ended, { code: 0, error: null });
});

test('the pane: typing, ↵ sends the line, history, a paste of lines, scrolling', () => {
  let r = paneKey(paneStart(), 'ls -l', {});
  assert.equal(r.state.input, 'ls -l');
  assert.equal(r.write, undefined);
  r = paneKey(r.state, '', { backspace: true });
  assert.equal(r.state.input, 'ls -');
  r = paneKey(r.state, '', { return: true });
  assert.equal(r.write, 'ls -\n');
  assert.equal(r.state.input, '');
  assert.deepEqual(r.state.lines, ['$ ls -']);
  r = paneKey(r.state, 'pwd\necho hi\nwh', {});
  assert.equal(r.write, 'pwd\necho hi\n');
  assert.equal(r.state.input, 'wh');
  assert.deepEqual(r.state.history, ['echo hi', 'pwd', 'ls -']);
  r = paneKey(r.state, 'u', { ctrl: true });
  assert.equal(r.state.input, '');
  r = paneKey(r.state, '', { upArrow: true });
  assert.equal(r.state.input, 'echo hi');
  r = paneKey(r.state, '', { upArrow: true });
  assert.equal(r.state.input, 'pwd');
  r = paneKey(r.state, '', { downArrow: true });
  r = paneKey(r.state, '', { downArrow: true });
  assert.equal(r.state.input, '');
  let s = paneOutput(r.state, Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n');
  s = paneKey(s, '', { pageUp: true }).state;
  assert.equal(s.scroll, 10);
  assert.deepEqual(paneView(s, 3).lines, ['line 17', 'line 18', 'line 19']);
  s = paneOutput(s, 'more\n');
  assert.equal(s.scroll, 11, 'what was read stays put while more comes');
  s = paneScroll(s, -100);
  assert.equal(s.scroll, 0);
  s = paneKey(s, 'l', { ctrl: true }).state;
  assert.deepEqual(s.lines, []);
});

test('the pane: ctrl+c clears the line, then sends ^C, and twice stops the shell; esc and ctrl+d close; ↵ after the end starts another', () => {
  let r = paneKey({ ...paneStart(), input: 'sleep 100' }, 'c', { ctrl: true }, 1000);
  assert.equal(r.state.input, '');
  r = paneKey(r.state, 'c', { ctrl: true }, 2000);
  assert.equal(r.write, '\x03');
  assert.match(r.said, /ctrl\+c again stops/);
  r = paneKey(r.state, 'c', { ctrl: true }, 2000 + AGAIN_MS - 1);
  assert.equal(r.kill, true);
  assert.equal(paneKey(r.state, 'c', { ctrl: true }, 9000).kill, undefined, 'long after, it starts counting again');
  assert.equal(paneKey(paneStart(), '', { escape: true }).close, true);
  assert.equal(paneKey(paneStart(), 'd', { ctrl: true }).close, true);
  const ended = paneEnded({ ...paneStart(), history: ['pwd'] }, 0);
  assert.equal(paneKey(ended, 'x', {}).state, ended, 'nothing to type into');
  const again = paneKey(ended, '', { return: true });
  assert.equal(again.restart, true);
  assert.deepEqual(again.state.history, ['pwd']);
  assert.equal(again.state.ended, null);
});

test('inside Fleet (no terminal to hand over), e opens the line-mode pane: lines go in, answers come out, esc closes', async () => {
  const spawned = [];
  const app = start({ spawnShell: demoShell(spawned) });
  await until(() => app.lastFrame().includes('Standalone'), 'the list');
  app.stdin.write('e');
  await until(() => app.lastFrame().includes('shop-api-1 · shell') && app.lastFrame().includes('Line mode'), 'the pane');
  assert.deepEqual(spawned[0].slice(0, 3), ['docker', 'exec', '-i']);
  await type(app.stdin, 'pwd');
  await until(() => app.lastFrame().includes('$ pwd'), 'the line typed');
  app.stdin.write(KEYS.enter);
  await until(() => /\/app/.test(app.lastFrame()), 'the answer');
  // Capitals are typed as they are, not taken as alt+ shortcuts.
  await type(app.stdin, 'echo Hi');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().split('\n').some((l) => /\bHi\b/.test(l) && !l.includes('echo')), 'Hi');
  await type(app.stdin, 'exit');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('The shell ended (0)'), 'the end');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('· shell') && app.lastFrame().includes('Standalone'), 'back to the list');
  app.unmount();
});

test('outside Fleet, e hands the terminal to docker exec -it and says when it is back', async () => {
  const ran = [];
  const app = start({ runInTerminal: (command, args, opts) => (ran.push([command, ...args, opts]), { status: 0 }) });
  await until(() => app.lastFrame().includes('Standalone'), 'the list');
  app.stdin.write('e');
  await until(() => app.lastFrame().includes("Back from shop-api-1's shell"), 'back');
  assert.deepEqual(ran[0].slice(0, 4), ['docker', 'exec', '-it', 'b2c3d4e5f6a1']);
  assert.deepEqual(ran[0].at(-1), { mouse: true });
  app.unmount();
});

test("a pod's containers: c picks one for its log, e one for a shell, /shell names one", async () => {
  const spawned = [];
  const app = start({ spawnShell: demoShell(spawned) });
  await until(() => app.lastFrame().includes('Standalone'), 'the list');
  app.stdin.write('3');
  await until(() => app.lastFrame().includes('prometheus-0'), 'the pods');
  app.stdin.write('/');
  await type(app.stdin, 'shell prometheus-0 config-reloader');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('prometheus-0/config-reloader · shell'), 'the named container\'s shell');
  assert.deepEqual(spawned.at(-1).slice(0, 8), ['kubectl', 'exec', '-i', '-n', 'monitoring', 'prometheus-0', '-c', 'config-reloader']);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('· shell'), 'closed');
  // To the pod with two containers.
  for (let i = 0; i < 30 && !/❯ ● prometheus-0/.test(app.lastFrame()); i++) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 30));
  }
  app.stdin.write('c');
  await until(() => app.lastFrame().includes("Its log: which of prometheus-0's containers?"), 'the question');
  app.stdin.write('2');
  await until(() => app.lastFrame().includes('prometheus-0/config-reloader · log'), 'that container\'s log');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('· log'), 'closed');
  app.stdin.write('e');
  await until(() => app.lastFrame().includes("A shell: which of prometheus-0's containers?"), 'the question');
  app.stdin.write('1');
  await until(() => app.lastFrame().includes('prometheus-0/prometheus · shell'), 'its shell');
  app.stdin.write(KEYS.esc);
  app.unmount();
});
