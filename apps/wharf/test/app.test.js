// End to end: App over the demo Docker, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { demoDocker } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('the containers are listed by compose project, with the standalone ones last', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the standalone heading');
  const frame = app.lastFrame();
  assert.match(frame, /5\/7 running/);
  assert.match(frame, /1 not well|2 not well/);
  assert.ok(frame.indexOf('shop') < frame.indexOf('Standalone'));
  assert.match(frame, /redis-cache/);
  assert.match(frame, /8080→80/);
  app.unmount();
});

test('s stops the container under the cursor, and starts it again', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  // The first container is the project's first: api, which is running.
  app.stdin.write('s');
  await until(() => app.provider.state.calls.some(([verb]) => verb === 'stop'), 'the stop');
  const stopped = app.provider.state.calls.find(([verb]) => verb === 'stop')[1];
  assert.equal(app.provider.state.containers.find((c) => c.id === stopped).state, 'exited');
  await until(shows(app, 'Stopped shop-api-1'), 'the activity line');
  app.stdin.write('s');
  await until(() => app.provider.state.calls.some(([verb]) => verb === 'start'), 'the start');
  assert.equal(app.provider.state.containers.find((c) => c.id === stopped).state, 'running');
  app.unmount();
});

test('x asks before removing, and a running container is forced after the yes', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write('x');
  await until(shows(app, 'Remove shop-api-1?'), 'the question');
  assert.match(app.lastFrame(), /still running/);
  app.stdin.write('2');
  await until(() => !app.lastFrame().includes('Remove shop-api-1?'), 'the answer no');
  assert.equal(app.provider.state.calls.length, 0);
  app.stdin.write('x');
  await until(shows(app, 'Remove shop-api-1?'), 'the question again');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([verb]) => verb === 'rm -f'), 'the forced removal');
  assert.ok(!app.provider.state.containers.some((c) => c.name === 'shop-api-1'));
  app.unmount();
});

test('↵ opens the log, coloured by level, and esc closes it', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'shop-api-1 · log'), 'the log');
  // Following, so it's the newest lines; Docker's long timestamp is cut to the time.
  await until(shows(app, 'request 1059 handled'), 'its lines');
  assert.match(app.lastFrame(), /09:06:53 INFO shop-api-1/);
  assert.match(app.lastFrame(), /following/);
  app.stdin.write('e');
  await until(() => !app.lastFrame().includes('request 1059 handled'), 'only the trouble');
  assert.match(app.lastFrame(), /upstream timed out/);
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Standalone'), 'the list again');
  app.unmount();
});

test('/ searches the log: matches as you type, n goes to the next, esc clears and then closes', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'request 1059 handled'), 'the log');
  app.stdin.write('/');
  await type(app.stdin, 'timed out');
  await until(shows(app, '/timed out▏ 6/6'), 'six matches, starting from the newest');
  app.stdin.write(KEYS.enter);
  app.stdin.write('n');
  await until(shows(app, '/timed out 1/6'), 'the next, round to the first');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('/timed out'), 'the search cleared');
  assert.match(app.lastFrame(), /shop-api-1 · log/);
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'Standalone'), 'the list again');
  app.unmount();
});

test("q closes a log, the help and the inspect text without quitting the app", async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  for (const [open, shown] of [[KEYS.enter, 'shop-api-1 · log'], ['?', 'Anywhere'], ['i', 'inspect shop-api-1']]) {
    app.stdin.write(open);
    await until(shows(app, shown), shown);
    app.stdin.write('q');
    await until(shows(app, 'Standalone'), `${shown} closed`);
    // Still running: a key still does something.
    app.stdin.write('2');
    await until(shows(app, 'Images'), 'the app still answering');
    app.stdin.write('1');
    await until(shows(app, 'Standalone'), 'back on the containers');
  }
  app.unmount();
});

test('o opens the first published port, y copies the id, i shows inspect', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write('o');
  await until(() => app.opened.length === 1, 'the browser');
  assert.deepEqual(app.opened, ['http://localhost:3000']);
  app.stdin.write('y');
  await until(() => app.copied.length === 1, 'the clipboard');
  assert.deepEqual(app.copied, ['b2c3d4e5f6a1']);
  app.stdin.write('i');
  await until(shows(app, 'inspect shop-api-1'), 'the inspect');
  assert.match(app.lastFrame(), /"Image": "shop\/api:1.4"/);
  app.unmount();
});

test('/stop on a project asks once for all its running containers', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  await type(app.stdin, '/stop shop');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Stop 3 containers?'), 'the question');
  assert.match(app.lastFrame(), /shop-api-1, shop-db-1, shop-web-1|shop-web-1/);
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([verb]) => verb === 'stop'), 'the stop');
  assert.equal(app.provider.state.containers.filter((c) => c.project === 'shop' && c.state === 'running').length, 0);
  app.unmount();
});

test('a is for only the running ones; images and prune work from their tab', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  assert.match(app.lastFrame(), /old-experiment/);
  app.stdin.write('a');
  await until(() => !app.lastFrame().includes('old-experiment'), 'only the running ones');
  app.stdin.write('2');
  await until(shows(app, 'untagged'), 'the images');
  assert.match(app.lastFrame(), /postgres:16/);
  app.stdin.write('p');
  await until(shows(app, 'Remove the images nothing uses?'), 'the prune question');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([verb]) => verb === 'prune'), 'the prune');
  await until(() => !app.lastFrame().includes('untagged'), 'the image gone');
  app.unmount();
});

test('/pull fetches an image that then shows under Images', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  await type(app.stdin, '/pull nginx:1.27');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.images.some((i) => i.repo === 'nginx'), 'the pull');
  app.stdin.write('2');
  await until(shows(app, 'nginx:1.27'), 'the image listed');
  app.unmount();
});

test('/down asks, then takes a compose project away; /up brings it back; /exec shows what a command printed', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  await type(app.stdin, '/exec redis-cache ls');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([verb]) => verb === 'exec'), 'the exec');
  await until(shows(app, 'redis-cache$ ls'), 'its output');
  await type(app.stdin, '/down shop');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Take shop down?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => !app.provider.state.containers.some((c) => c.project === 'shop'), 'the project gone');
  await until(() => !app.lastFrame().includes('Take shop down?'), 'the question answered');
  await type(app.stdin, '/up shop');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No compose project matches "shop"'), 'nothing left to bring up');
  app.unmount();
});

test('an unknown container is said, not run', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  await type(app.stdin, '/restart nothing-here');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No container or project matches'), 'the error');
  assert.equal(app.provider.state.calls.length, 0);
  app.unmount();
});

test("a Docker that isn't running is explained and /refresh tries again", async () => {
  const real = demoDocker();
  let up = false;
  const gate = (name) => async (...args) => {
    if (!up) throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');
    return real[name](...args);
  };
  const app = start({ provider: { name: 'docker', containers: gate('containers'), images: gate('images'), stats: gate('stats') } });
  await until(shows(app, "Docker isn't running"), 'the explanation');
  assert.match(app.lastFrame(), /\/refresh tries again/);
  up = true;
  await type(app.stdin, '/refresh');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Standalone'), 'the list once Docker is back');
  assert.ok(!app.lastFrame().includes("Docker isn't running"));
  app.unmount();
});

test('the theme and accent commands change the config', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  await type(app.stdin, '/accent #ff00ff');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Accent: #ff00ff'), 'the accent');
  await type(app.stdin, '/accent red');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'An accent is #rrggbb'), 'the error');
  await type(app.stdin, '/accent default');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Accent: default'), 'the accent back');
  app.unmount();
});

test('the Pods tab lists the cluster by namespace; ↵ opens a pod\'s log, x deletes after asking, r restarts its deployment', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write('3');
  await until(shows(app, 'CrashLoopBackOff'), 'the pods');
  assert.match(app.lastFrame(), /docker-desktop · all namespaces/);
  assert.match(app.lastFrame(), /monitoring/);
  assert.match(app.lastFrame(), /1 not well/);
  // The cursor starts on the first pod of the first namespace: prometheus-0.
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prometheus-0 · log'), 'its log');
  await until(shows(app, 'served request'), 'its lines');
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'CrashLoopBackOff'), 'the pods again');
  // Down to the crash-looping api pod, shop's first.
  app.stdin.write('j');
  await new Promise((r) => setTimeout(r, 60));
  app.stdin.write('r');
  await until(shows(app, 'Restart deployment api?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.kube.state.calls.some(([verb]) => verb === 'rollout restart'), 'the restart');
  assert.deepEqual(app.kube.state.calls[0], ['rollout restart', 'shop', 'api']);
  await until(() => !app.lastFrame().includes('CrashLoopBackOff'), 'the pod running again');
  app.stdin.write('x');
  await until(shows(app, 'Delete pod'), 'the delete question');
  app.stdin.write('2');
  await until(() => !app.lastFrame().includes('Delete pod'), 'the answer no');
  assert.equal(app.kube.state.calls.length, 1);
  app.unmount();
});

test('/namespace narrows the pods, /context asks before switching, and /logs finds a pod when no container has the name', async () => {
  const app = start();
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write('3');
  await until(shows(app, 'monitoring'), 'the pods');
  await type(app.stdin, '/namespace shop');
  app.stdin.write(KEYS.enter);
  await until(() => !app.lastFrame().includes('prometheus-0') && app.lastFrame().includes('· shop ·'), 'only shop');
  await type(app.stdin, '/namespace nowhere');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No namespace called "nowhere"'), 'the error');
  await type(app.stdin, '/context aks');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Switch kubectl to aks-prod?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.kube.state.current === 'aks-prod', 'the switch');
  await type(app.stdin, '/logs db-0');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'db-0 · log'), 'the pod log');
  app.unmount();
});

test("a cluster that can't be reached is explained on the Pods tab, and Docker's tabs still work", async () => {
  const down = async () => {
    throw new Error('Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout');
  };
  const app = start({ kube: { name: 'kubectl', pods: down, current: down, top: down } });
  await until(shows(app, 'Standalone'), 'the list');
  app.stdin.write('3');
  await until(shows(app, "The cluster can't be reached"), 'the explanation');
  app.stdin.write('1');
  await until(shows(app, 'Standalone'), 'Docker\'s list');
  app.unmount();
});
