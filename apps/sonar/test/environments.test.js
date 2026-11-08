// The project's environments in Sonar: what its sonar section picks, /env, production asking first, and
// the commands that ran recorded for Fleet's runbook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { theme } from '@fleet/kit/theme.js';
import { recordedLines, startRecording, stopRecording } from '@fleet/kit/recording.js';
import { readActivity } from '@fleet/kit/family.js';
import { environmentPicks, namesSomething } from '../src/environment.js';
import { loadSubscription } from '../src/load.js';
import { demoAzure } from '../src/demo.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const PROJECT = {
  default: 'dev',
  environments: {
    dev: { sonar: { subscription: 'Contoso Dev', app: 'contoso-web-dev' } },
    prod: { prod: true, sonar: { subscription: 'sub-prod', resourceGroup: 'contoso-prod', app: 'contoso-web', slot: 'staging', component: 'contoso-prod-ai' } },
  },
};

function project(name, json = PROJECT) {
  const dir = join(process.env.SONAR_HOME, name);
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify(json));
  return dir;
}

test('what a sonar section picks: another subscription, an app, a slot, its Application Insights, and what isn\'t there', async () => {
  const data = await loadSubscription(demoAzure(), 'sub-prod');
  assert.deepEqual(environmentPicks({ name: 'dev', subscription: 'Contoso Dev' }, data), { switchTo: 'sub-dev' });
  const prod = environmentPicks({ name: 'prod', ...PROJECT.environments.prod.sonar }, data);
  assert.equal(prod.target.id, '/subscriptions/sub-prod/resourceGroups/contoso-prod/providers/Microsoft.Web/sites/contoso-web/slots/staging');
  assert.equal(prod.component.name, 'contoso-prod-ai');
  assert.deepEqual(prod.missing, []);
  assert.equal(environmentPicks({ name: 'p', app: 'contoso-web', slot: 'production' }, data).target.slot, null, 'production is the app itself');
  assert.deepEqual(environmentPicks({ name: 'x', app: 'nope', component: 'none-ai', subscription: 'Contoso Production' }, data).missing, ['the app nope', 'the Application Insights none-ai']);
  assert.deepEqual(environmentPicks({ name: 'x', subscription: 'Elsewhere' }, data).missing, ['the subscription Elsewhere']);
  assert.ok(!namesSomething({ name: 'x', prod: false }));
});

test('/env says which and switches every app; its section picks the app; production asks first; the commands are recorded', async () => {
  const dir = project('shop');
  startRecording(dir);
  const a = start({ cwd: dir });
  const frame = () => a.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Contoso Dev') && /❯ ● contoso-web-dev/.test(frame()), "dev's subscription and app");
    assert.match(frame(), /dev {2}last /);
    a.stdin.write('/');
    await type(a.stdin, 'env');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('Environment: dev. /env prod switches every app.'), 'which one');

    a.stdin.write('/');
    await type(a.stdin, 'env pr');
    await until(() => frame().includes('/env prod'), 'completion offers it');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('Environment prod (production): contoso-web/staging, contoso-prod-ai'), "prod's slot and Application Insights", 10_000);
    assert.ok(frame().includes('Contoso Production'));
    assert.match(frame(), / prod /);
    assert.equal(theme.envProd, true, 'the frames are red');
    assert.match(readActivity()[0].text, /^Switched shop to prod \(production\)/);
    assert.equal(readActivity()[0].app, 'sonar');

    // The kit's question first: no stops there.
    a.stdin.write('/');
    await type(a.stdin, 'restart contoso-web/staging');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('prod is production. Restart contoso-web/staging?') && frame().includes('Yes, in production'), "production's question");
    a.stdin.write('2');
    await until(() => !frame().includes('prod is production.'), 'answered no');
    assert.ok(!frame().includes('Type contoso-web to go ahead'), "Sonar's own question never came");
    a.stdin.write('/');
    await type(a.stdin, 'restart contoso-web/staging');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('Yes, in production'), "production's question again");
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('Type contoso-web to go ahead'), "then Sonar's own");
    await type(a.stdin, 'contoso-web');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('contoso-web/staging is restarting'), 'restarted');

    const lines = recordedLines().map((l) => [l.app, l.line]);
    assert.deepEqual(lines, [
      ['sonar', '/env'],
      ['sonar', '/env prod'],
      ['sonar', '/restart contoso-web/staging'],
      ['sonar', '/restart contoso-web/staging'],
    ]);
  } finally {
    a.unmount();
    stopRecording();
  }
});

test('without a project file /env says how to name them, and nothing is asked twice', async () => {
  const dir = join(process.env.SONAR_HOME, 'plain');
  mkdirSync(dir, { recursive: true });
  const a = start({ cwd: dir });
  const frame = () => a.lastFrame() ?? '';
  try {
    await until(() => frame().includes('contoso-orders'), 'the apps');
    a.stdin.write('/');
    await type(a.stdin, 'env');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('No environments: a .fleet/project.json names them'), 'how to name them');
    a.stdin.write('/');
    await type(a.stdin, 'env prod');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('No .fleet/project.json here or above'), 'nothing to switch');
    a.stdin.write('/');
    await type(a.stdin, 'restart contoso-web');
    a.stdin.write(KEYS.enter);
    await until(() => frame().includes('Type contoso-web to go ahead'), "Sonar's own question, alone");
    assert.ok(!frame().includes('is production.'));
    assert.equal(theme.envProd, false);
  } finally {
    a.unmount();
  }
});
