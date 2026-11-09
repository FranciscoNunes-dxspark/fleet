// The project's environments (the kit's environments.js) in Wharf: /env, kubectl sent to the
// environment's context and namespace, production asking first, and the lines a runbook records.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRecording, recordedLines } from '@fleet/kit/recording.js';
import { createKube } from '../src/kube.js';
import { kubeShell } from '../src/shell.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

function project() {
  const root = join(process.env.WHARF_HOME, 'shop');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, '.fleet'));
  const environments = { dev: { wharf: { namespace: 'monitoring' } }, prod: { prod: true, wharf: { context: 'aks-prod', namespace: 'shop' } } };
  writeFileSync(join(root, '.fleet', 'project.json'), JSON.stringify({ default: 'dev', environments }));
  return root;
}

test("an environment's context goes to every kubectl call as --context, never through use-context", async () => {
  const calls = [];
  const kube = createKube({ run: async (command) => (calls.push(command), { stdout: '{"items":[]}', stderr: '' }) });
  kube.pin('aks-prod');
  assert.equal(await kube.current(), 'aks-prod');
  await kube.pods({ namespace: 'shop' });
  await kube.deletePod({ namespace: 'shop', name: 'web-1' });
  kube.pin(null);
  await kube.pods({ namespace: 'shop' });
  assert.deepEqual(calls, ['kubectl --context aks-prod get pods -n shop -o json', 'kubectl --context aks-prod delete pod -n shop web-1', 'kubectl get pods -n shop -o json']);
  assert.throws(() => kube.pin('a b'), /isn't a context/);
  assert.deepEqual(kubeShell({ name: 'web-1', namespace: 'shop' }, null, { context: 'aks-prod' }).args.slice(0, 3), ['--context', 'aks-prod', 'exec']);
  assert.throws(() => kubeShell({ name: 'web-1', namespace: 'shop' }, null, { context: 'a;b' }), /isn't a context/);
});

test('/env switches the environment: the Pods view follows its context and namespace, and production asks before a stop', async () => {
  const root = project();
  startRecording(root);
  const app = start({ cwd: join(root, 'src') });
  await until(shows(app, 'Standalone'), 'the list');
  assert.match(app.lastFrame(), /demo {2}dev/);
  app.stdin.write('3');
  await until(shows(app, 'prometheus-0'), 'the pods of monitoring');
  assert.ok(!app.lastFrame().includes('db-0'));
  await type(app.stdin, '/env');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Environment: dev. /env prod switches every app.'), 'which one');
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Environment: prod (production: changes ask first). kubectl goes to context aks-prod'), 'the switch');
  await until(() => app.kube.state.pinned === 'aks-prod', 'the context pinned');
  await until(shows(app, 'aks-prod · shop'), 'the pods of shop in aks-prod');
  // kubectl's own context is left as it was.
  assert.equal(app.kube.state.current, 'docker-desktop');
  await type(app.stdin, '/context docker-desktop');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'The prod environment sends'), 'the context kept');
  app.stdin.write('1');
  await until(shows(app, 'Standalone'), 'the containers');
  app.stdin.write('s');
  await until(shows(app, 'prod is production. Stop shop-api-1?'), 'the production question');
  app.stdin.write('2');
  await until(() => !app.lastFrame().includes('is production'), 'the answer no');
  assert.equal(app.provider.state.calls.length, 0);
  await type(app.stdin, '/env nowhere');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No environment nowhere: dev, prod.'), 'the miss');
  assert.deepEqual(recordedLines().map((l) => [l.app, l.line]), [['wharf', '/env'], ['wharf', '/env prod'], ['wharf', '/context docker-desktop'], ['wharf', '/env nowhere']]);
  app.unmount();
});
