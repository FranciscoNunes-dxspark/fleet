// The project's environment (.fleet/project.json): what it gives the crew (FLEET_ENV, Bosun's
// variables, never one that reads as a secret, and its profile), /env showing and switching it, a
// switch from another app heard, the running processes keeping the old one until restarted; and every
// line the prompt runs kept while Fleet records a runbook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';
import { environmentProfile, environmentVars, looksSecret } from '../src/environment.js';
import { setEnvironment } from '@fleet/kit/environments.js';
import { recordedLines, startRecording, stopRecording } from '@fleet/kit/recording.js';
import { familyDir, readActivity } from '@fleet/kit/family.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('an environment gives every process FLEET_ENV and its variables, never a secret, and names a profile', () => {
  assert.deepEqual(environmentVars(null), { vars: {}, refused: [] });
  const { vars, refused } = environmentVars({
    name: 'staging',
    variables: { API_URL: 'https://api.staging.example', RETRIES: 3, VERBOSE: true, DB_PASSWORD: 'x', GITHUB_TOKEN: 'y', ConnectionStrings__Shop: 'Server=x', DATABASE_URL: 'postgres://me:secret@db/shop', FLEET_ENV: 'other', 'bad name': '1', LIST: [1] },
  });
  assert.deepEqual(vars, { API_URL: 'https://api.staging.example', RETRIES: '3', VERBOSE: 'true', FLEET_ENV: 'staging' });
  assert.deepEqual(refused.map((r) => r.name), ['DB_PASSWORD', 'GITHUB_TOKEN', 'ConnectionStrings__Shop', 'DATABASE_URL', 'bad name', 'LIST']);
  assert.match(refused[0].why, /reads as a secret: keep it in an env file/);
  assert.equal(looksSecret('LOG_LEVEL', 'debug'), false);
  assert.equal(looksSecret('AZURE_CLIENT_SECRET'), true);
  assert.deepEqual(environmentProfile({ name: 'dev' }, { mock: {} }), { profile: null });
  assert.deepEqual(environmentProfile({ name: 'dev', profile: 'mock' }, { mock: {} }), { profile: 'mock' });
  assert.match(environmentProfile({ name: 'dev', profile: 'fast' }, { mock: {} }).problem, /dev's profile "fast" isn't in bosun.json's "profiles" \(there's mock\)/);
});

/** A project whose api prints its FLEET_ENV, MODE and PROFILE each start, with three environments. */
function envProject() {
  const dir = project(
    { procs: { api: { run: 'node api.js', port: null } }, profiles: { stage: { api: { env: { PROFILE: 'stage' } } } } },
    { 'api.js': "console.log(`env=${process.env.FLEET_ENV} mode=${process.env.MODE} profile=${process.env.PROFILE ?? '-'} secret=${process.env.DB_PASSWORD ?? '-'}`); setInterval(() => {}, 1000);\n" },
  );
  mkdirSync(join(dir, '.fleet'));
  writeFileSync(
    join(dir, '.fleet', 'project.json'),
    JSON.stringify({
      default: 'dev',
      environments: {
        dev: { bosun: { variables: { MODE: 'local' } } },
        staging: { bosun: { profile: 'stage', variables: { MODE: 'cloud', DB_PASSWORD: 'hunter2' } } },
        prod: { prod: true },
      },
    }),
  );
  return dir;
}

test('/env shows and switches the environment; the running process keeps the old one until restarted; another app\'s switch is heard; the prompt\'s lines are recorded', async () => {
  const dir = envProject();
  startRecording(dir, { home: familyDir() });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('env=dev mode=local profile=- secret=-'), 'started in dev');
    assert.match(frame(), /│\s+dev/, 'the header names it');

    app.stdin.write(':');
    await type(app.stdin, 'env');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Environment: dev. /env staging|prod switches every app.'), 'which one');

    app.stdin.write(':');
    await type(app.stdin, 'env staging');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Restart api in staging?'), 'the restart offered');
    assert.ok(frame().includes('with profile stage'), 'its profile');
    assert.ok(frame().includes('api keeps dev until restarted'), 'the old one kept');
    assert.ok(frame().includes('DB_PASSWORD reads as a secret'), 'the secret left out');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('env=staging mode=cloud profile=stage secret=-'), 'restarted in staging');
    assert.ok(readActivity({ project: dir }).some((e) => e.app === 'bosun' && /to staging$/.test(e.text)), 'in the activity');

    app.stdin.write(':');
    await type(app.stdin, 'env staging');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Environment staging already.'), 'already');
    app.stdin.write(':');
    await type(app.stdin, 'env qa');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('No environment qa: dev, staging, prod.'), 'no such one');
    app.stdin.write(':');
    await type(app.stdin, '!node -e 0');
    app.stdin.write(KEYS.enter);

    // Fleet (or a sibling) switches it: heard within a second or so, frames and header in production's red.
    assert.equal(setEnvironment(dir, 'prod', { by: 'splice' }).ok, true);
    await until(() => frame().includes('Restart api in prod (production)?'), 'another app\'s switch', 10_000);
    assert.ok(frame().includes('prod (production)'));
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Restart api in prod'), 'not restarted');
    assert.ok(frame().includes('env=staging mode=cloud profile=stage'), 'it keeps staging until restarted');

    const lines = recordedLines({ home: familyDir() }).map((l) => [l.app, l.line]);
    assert.deepEqual(lines, [['bosun', '/env'], ['bosun', '/env staging'], ['bosun', '/env staging'], ['bosun', '/env qa']]);
  } finally {
    stopRecording({ home: familyDir() });
    app.stdin.write('q');
    app.unmount();
  }
});
