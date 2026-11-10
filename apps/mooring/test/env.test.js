// The project's environments (the kit's environments.js) in Mooring: /env, the host and folder an
// environment opens, production asking first, and the lines a runbook records (never a command).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordedLines, startRecording } from '@fleet/kit/recording.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const ALT_G = '\x1bg';

function project() {
  const root = join(process.env.MOORING_HOME, 'shop');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.fleet'));
  const environments = { dev: { mooring: { host: 'demo' } }, prod: { prod: true, mooring: { host: 'demo', folder: '/home/demo/site' } } };
  writeFileSync(join(root, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments }));
  return root;
}

test("the environment's host opens at start, /env prod opens its folder, and production asks before an upload", async () => {
  const root = project();
  startRecording(root);
  const app = start({ cwd: root, connectTo: undefined });
  await until(shows(app, 'demo  /home/demo'), "the dev environment's host opened");
  assert.match(app.lastFrame(), /demo {2}dev/);
  await type(app.stdin, '/env');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Environment: dev. /env prod switches every app.'), 'which one');
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '/home/demo/site'), "prod's folder opened");
  // An upload in production asks first; no says no upload.
  app.stdin.write(KEYS.left);
  app.stdin.write(ALT_G);
  await new Promise((r) => setTimeout(r, 80));
  app.stdin.write('c');
  await until(shows(app, 'prod is production. Upload todo.txt to demo?'), 'the production question');
  app.stdin.write('2');
  await until(() => !app.lastFrame().includes('is production'), 'the answer no');
  assert.ok(!app.host.state.calls.some((c) => c[0] === 'put'));
  // A command run on the server is never recorded; the slash commands are.
  await type(app.stdin, '/ssh uptime');
  app.stdin.write(KEYS.enter);
  await until(() => app.host.state.calls.some((c) => c[0] === 'terminal'), 'the shell');
  app.stdin.write('\x1c');
  await type(app.stdin, '/hidden off');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Hiding files'), 'hidden off');
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['mooring', '/env'], ['mooring', '/env prod'], ['mooring', '/hidden off']]);
  app.unmount();
});

test('/env names what is wrong: no project, or no such environment', async () => {
  const app = start();
  await until(shows(app, 'demo  /home/demo'), 'the host');
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No .fleet/project.json here or above'), 'no project');
  app.unmount();
  const root = project();
  const again = start({ cwd: root });
  await until(shows(again, 'demo  /home/demo'), 'the host');
  await type(again.stdin, '/env staging');
  again.stdin.write(KEYS.enter);
  await until(shows(again, 'No environment staging: dev, prod.'), 'the miss');
  again.unmount();
});
