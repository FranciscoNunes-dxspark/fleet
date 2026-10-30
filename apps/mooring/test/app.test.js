// End to end: App over the demo host and machine, typing keys and reading the frame. Nothing reaches
// ssh, the clipboard or a real file.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const ALT_G = '\x1bg';
const full = (app, text) => app.lastFrame().split('\n').find((l) => l.includes(text)) ?? '';
// The line holding `text` in one pane (the screen is 100 columns, the panes 50 each).
const row = (app, side, text) => app.lastFrame().split('\n').map((l) => (side === 'local' ? l.slice(0, 50) : l.slice(50))).find((l) => l.includes(text)) ?? '';

test('it opens the host and shows both folders side by side', async () => {
  const app = start();
  await until(shows(app, 'demo  /home/demo'), 'the host connected');
  await until(shows(app, 'site'), 'the server folder read');
  const frame = app.lastFrame();
  assert.match(frame, /This machine {2}\/demo/);
  assert.match(frame, /Documents/);
  assert.match(frame, /todo\.txt/);
  assert.match(frame, /backups/);
  assert.match(frame, /notes\.txt/);
  assert.match(frame, /\/home\/demo/);
  assert.match(frame, /● demo/);
  app.unmount();
});

test('↵ opens a folder and backspace comes back with the cursor on the one you left', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write('j');
  await until(() => row(app, 'remote', 'site').includes('❯'), 'the cursor on site');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'index.html'), 'the folder opened');
  assert.match(app.lastFrame(), /\/home\/demo\/site/);
  app.stdin.write(KEYS.backspace);
  await until(shows(app, 'notes.txt'), 'back up');
  assert.ok(row(app, 'remote', 'site').includes('❯'), 'the cursor is on site again');
  app.unmount();
});

test('c queues an upload, Transfers shows it, and the file arrives and is listed', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write(KEYS.left);
  app.stdin.write(ALT_G);
  await until(() => row(app, 'local', 'todo.txt').includes('❯'), 'the cursor on todo.txt');
  app.stdin.write('c');
  await until(() => app.host.state.tree.has('/home/demo/todo.txt'), 'the file on the host');
  assert.deepEqual(app.host.state.calls.filter((c) => c[0] === 'put').map((c) => c.slice(1, 3)), [['/demo/todo.txt', '/home/demo/todo.txt']]);
  await until(() => row(app, 'remote', 'todo.txt') && app.lastFrame().includes('Transfers finished'), 'the finish noted');
  app.stdin.write('2');
  await until(shows(app, 'Transfers'), 'the queue');
  assert.match(app.lastFrame(), /↑ todo\.txt/);
  assert.match(app.lastFrame(), /done/);
  app.unmount();
});

test('a file that is there already asks first; skip leaves it', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write(KEYS.left);
  app.stdin.write(ALT_G);
  await until(() => row(app, 'local', 'todo.txt').includes('❯'), 'the cursor on todo.txt');
  app.stdin.write('c');
  await until(() => app.host.state.tree.has('/home/demo/todo.txt'), 'the first copy');
  await until(shows(app, 'todo.txt'), 'listed');
  await new Promise((r) => setTimeout(r, 500));
  app.stdin.write('c');
  await until(shows(app, 'is in /home/demo already. Replace it?'), 'the question');
  app.stdin.write('3');
  await until(() => !app.lastFrame().includes('Replace it?'), 'answered');
  assert.equal(app.host.state.calls.filter((c) => c[0] === 'put').length, 1);
  app.unmount();
});

test('d asks, says what goes, and deletes on the server', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write(ALT_G);
  await until(() => row(app, 'remote', 'notes.txt').includes('❯'), 'the cursor on notes.txt');
  app.stdin.write('d');
  await until(shows(app, 'Delete notes.txt on demo?'), 'the question');
  assert.match(app.lastFrame(), /This can not be undone/);
  app.stdin.write('1');
  await until(() => !app.host.state.tree.has('/home/demo/notes.txt'), 'deleted');
  await until(() => !row(app, 'remote', 'notes.txt'), 'gone from the pane');
  app.unmount();
});

test('m makes a folder, typed in the prompt box', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write('m');
  await until(shows(app, 'New folder in /home/demo'), 'the question');
  await type(app.stdin, 'releases');
  app.stdin.write(KEYS.enter);
  await until(() => app.host.state.tree.has('/home/demo/releases'), 'made');
  await until(shows(app, 'releases'), 'listed');
  app.unmount();
});

test('space marks, c copies all that is marked', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write(KEYS.left);
  await until(shows(app, 'Documents'), 'this machine');
  app.stdin.write(' ');
  app.stdin.write(' ');
  await until(shows(app, '2 marked'), 'two marked');
  app.stdin.write('c');
  await until(() => app.host.state.tree.has('/home/demo/Documents') && app.host.state.tree.has('/home/demo/Downloads'), 'both folders sent');
  assert.deepEqual(app.host.state.calls.filter((c) => c[0] === 'put').map((c) => c[3]), [{ recursive: true }, { recursive: true }]);
  app.unmount();
});

test('/cd and /lcd go to typed paths', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'the server folder');
  await type(app.stdin, '/cd /var/log');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'syslog'), 'the server folder changed');
  await type(app.stdin, '/lcd Documents');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'report.pdf'), 'this machine changed');
  await type(app.stdin, '/cd /nope');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '/nope: No such file'), 'the failure said');
  app.unmount();
});

test('Hosts lists the saved ones with the open one marked; /add saves another and /forget asks', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'connected');
  app.stdin.write('4');
  await until(shows(app, 'ci@build.example.com'), 'the hosts');
  assert.match(full(app, 'demo@demo.example.com'), /●/);
  assert.match(full(app, 'build.example.com'), /~\/\.ssh\/ci/);
  await type(app.stdin, '/add web me@web.example.com:2222 key=~/.ssh/web');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'me@web.example.com:2222'), 'the new host listed');
  await type(app.stdin, '/forget web');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Forget web'), 'the question');
  app.stdin.write('1');
  await until(shows(app, 'Forgot web'), 'forgotten');
  app.unmount();
});

test('a bad /add says what is wrong', async () => {
  const app = start();
  await until(shows(app, 'notes.txt'), 'connected');
  await type(app.stdin, '/add bad -oProxyCommand=x');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'starts with a dash'), 'refused');
  app.unmount();
});

test('a transfer in flight shows its progress and x cancels it', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const app = start({ tick: () => gate });
  await until(shows(app, 'notes.txt'), 'the server folder');
  app.stdin.write(ALT_G);
  await until(() => row(app, 'remote', 'notes.txt').includes('❯'), 'the cursor on notes.txt');
  app.stdin.write('c');
  app.stdin.write('2');
  await until(shows(app, '↓ notes.txt'), 'the download listed');
  await until(shows(app, '0%'), 'running');
  app.stdin.write('x');
  release();
  await until(shows(app, 'cancelled'), 'cancelled');
  app.unmount();
});

test('not connected: the remote pane says how to connect, and c says so', async () => {
  const app = start({ connectTo: undefined });
  await until(shows(app, 'Documents'), 'this machine');
  assert.match(app.lastFrame(), /Not connected/);
  app.stdin.write('c');
  await until(shows(app, 'Not connected: /connect <host>'), 'the refusal');
  app.unmount();
});
