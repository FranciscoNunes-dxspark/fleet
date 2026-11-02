// The project's environments (the kit's environments.js) end to end: Locker compares what the chosen
// one's section names, /env switches it for every app, a production one asks once more before a change,
// and the prompt's lines go to a runbook Fleet is recording.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActivity } from '@fleet/kit/family.js';
import { recordedLines, startRecording } from '@fleet/kit/recording.js';
import { environmentPicks } from '../src/load.js';
import { demoAzure, demoLocal } from '../src/demo.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
beforeEach(() => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'locker-project-'));
  mkdirSync(join(dir, '.fleet'));
  writeFileSync(
    join(dir, '.fleet', 'project.json'),
    JSON.stringify({
      default: 'dev',
      environments: {
        dev: { locker: { vault: 'kv-shared', app: 'shop-api', slot: 'staging' } },
        prod: { prod: true, locker: { vault: 'kv-shop', app: 'shop-api', resourceGroup: 'shop', healthPath: '/healthz' } },
      },
    }),
  );
});
afterEach(() => {
  cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const startHere = () => start({ local: demoLocal({ dir }), cwd: dir });

test("environmentPicks finds the app, slot and vault an environment's section names, and says what isn't there", async () => {
  const azure = { sites: [{ id: '1', name: 'shop-api', slot: null, resourceGroup: 'shop' }, { id: '2', name: 'shop-api', slot: 'staging', resourceGroup: 'shop' }], vaults: [{ name: 'kv-shop' }] };
  assert.equal(environmentPicks(azure, { app: 'shop-api', slot: 'staging' }).target.id, '2');
  assert.equal(environmentPicks(azure, { app: 'SHOP-API' }).target.id, '1');
  assert.equal(environmentPicks(azure, { vault: 'KV-shop' }).vault.name, 'kv-shop');
  assert.deepEqual(environmentPicks(azure, { app: 'shop-api', resourceGroup: 'other', vault: 'kv-x' }).missing, ['no app shop-api in other', 'no key vault kv-x']);
  assert.deepEqual(environmentPicks(azure, null), { target: null, vault: null, missing: [] });
});

test("Locker compares what the environment's section names; /env switches it, and production asks once more", async () => {
  const app = startHere();
  await until(shows(app, 'shop-api/staging · kv-shared'), "dev's app and vault");
  assert.match(app.lastFrame(), /dev/);
  await type(app.stdin, '/env');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Environment: dev. /env prod switches every app.'), '/env alone');
  await type(app.stdin, '/env prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'shop-api · kv-shop'), "prod's app and vault");
  assert.match(app.lastFrame(), /prod \(production\)/);
  assert.ok(readActivity().some((e) => e.app === 'locker' && /to prod \(production\)/.test(e.text)), 'the switch logged');
  // A change in production: Locker's own question, then the production one.
  app.stdin.write('2');
  await until(shows(app, 'Vault kv-shop'), 'the Vault view');
  await until(shows(app, 'Redis--Password'), 'its secrets');
  for (let i = 0; i < 8 && !app.lastFrame().split('\n').some((l) => l.includes('❯') && l.includes('Redis--Password')); i++) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 30));
  }
  app.stdin.write('x');
  await until(shows(app, 'Disable Redis--Password in kv-shop?'), "Locker's question");
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod is production. Disable Redis--Password in kv-shop?'), 'the production question');
  app.stdin.write('2');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!app.provider.state.calls.some(([op]) => op === 'disableSecret'), 'nothing disabled on no');
  app.stdin.write('x');
  await until(shows(app, 'Disable Redis--Password in kv-shop?'), 'asked again');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'prod is production.'), 'the production question again');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([op]) => op === 'disableSecret'), 'the disable');
  app.unmount();
});

test("the prompt's slash commands go to a runbook while Fleet records one", async () => {
  startRecording(dir, { home: process.env.FAMILY_HOME });
  const app = start({ provider: demoAzure(), local: demoLocal({ dir }), cwd: dir });
  await until(shows(app, 'kv-shared'), 'loaded');
  await type(app.stdin, '/only diff');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'only what differs'), 'the filter');
  await type(app.stdin, '!echo hi');
  app.stdin.write(KEYS.enter);
  await until(() => recordedLines({ home: process.env.FAMILY_HOME }).length === 1, 'the line recorded');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(recordedLines({ home: process.env.FAMILY_HOME }).map((l) => [l.app, l.line]), [['locker', '/only diff']]);
  app.unmount();
});
