// A project's environments: the file, the choice kept per project for every app, a section per app, and recording a runbook's lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentEnvironment, describeEnvironments, isProduction, environmentFor, markProduction, productionQuestion, readProject, setEnvironment, watchEnvironment } from '../environments.js';
import { recordCommand, recordedLines, recordingState, startRecording, stopRecording } from '../recording.js';
import { readActivity } from '../family.js';
import { theme } from '../theme.js';

function project(json) {
  const root = mkdtempSync(join(tmpdir(), 'kit-env-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.fleet'));
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  if (json !== undefined) writeFileSync(join(root, '.fleet', 'project.json'), typeof json === 'string' ? json : JSON.stringify(json));
  const home = join(root, 'home');
  return { root, home, sub: join(root, 'src', 'api'), done: () => rmSync(root, { recursive: true, force: true }) };
}

const SHOP = { default: 'dev', environments: { dev: { hail: { env: 'dev' }, trawl: { connection: 'Shop (dev)' } }, prod: { prod: true, hail: { env: 'production' }, sonar: { app: 'shop-api' } } } };

test("the project's file, found from a folder in it; its default until one is chosen; a section per app", () => {
  const p = project(SHOP);
  try {
    assert.deepEqual(readProject(p.sub).names, ['dev', 'prod']);
    assert.equal(currentEnvironment(p.sub, { home: p.home }).name, 'dev');
    assert.deepEqual(environmentFor('trawl', p.sub, { home: p.home }), { connection: 'Shop (dev)', name: 'dev', prod: false });
    assert.deepEqual(environmentFor('sonar', p.sub, { home: p.home }), { name: 'dev', prod: false });
    assert.match(describeEnvironments(p.sub, { home: p.home }), /Environment: dev\. \/env prod switches every app/);
  } finally {
    p.done();
  }
});

test('choosing one moves every app, kept per project and logged; a wrong name says which there are', () => {
  const p = project(SHOP);
  try {
    assert.deepEqual(setEnvironment(p.sub, 'staging', { home: p.home }), { ok: false, error: 'No environment staging: dev, prod.' });
    const r = setEnvironment(p.root, 'PROD', { by: 'hail', home: p.home });
    assert.equal(r.ok, true);
    assert.deepEqual(environmentFor('sonar', p.sub, { home: p.home }), { app: 'shop-api', name: 'prod', prod: true });
    assert.match(readActivity({ dir: p.home })[0].text, /Switched .* to prod \(production\)/);
    assert.deepEqual(productionQuestion(environmentFor('hail', p.sub, { home: p.home }), 'Send this request'), { title: 'prod is production. Send this request?', detail: 'The project marks this environment "prod": true.', danger: true });
    assert.equal(productionQuestion({ name: 'dev', prod: false }, 'x'), null);
  } finally {
    p.done();
  }
});

test('no file, or a broken one: no environment, and a sentence that says why', () => {
  const none = project();
  const broken = project('{ nope');
  try {
    assert.equal(currentEnvironment(none.sub, { home: none.home }), null);
    assert.match(describeEnvironments(none.sub, { home: none.home }), /No environments/);
    assert.equal(currentEnvironment(broken.sub, { home: broken.home }), null);
    assert.match(setEnvironment(broken.sub, 'dev', { home: broken.home }).error, /can't be read/);
  } finally {
    none.done();
    broken.done();
  }
});

test('a switch in another app reaches a watcher; production turns the frames red', async () => {
  const p = project(SHOP);
  try {
    const seen = [];
    const stop = watchEnvironment(p.sub, (env) => seen.push(env.name), { home: p.home, interval: 20 });
    setEnvironment(p.sub, 'prod', { home: p.home });
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
    stop();
    assert.deepEqual(seen, ['prod']);
    markProduction(true);
    assert.equal(theme.envProd, true);
    markProduction(false);
  } finally {
    p.done();
  }
});

test('recording: only while on, only slash commands, secrets masked; stopping hands the lines back', () => {
  const p = project();
  try {
    recordCommand('trawl', '/tables');
    assert.equal(recordingState({ home: p.home }), null);
    startRecording(p.root, { home: p.home, now: 5 });
    assert.deepEqual(recordingState({ home: p.home }), { project: p.root, since: 5 });
    recordCommand('bosun', '/start api', { home: p.home, now: 6 });
    recordCommand('trawl', '!DROP TABLE x', { home: p.home });
    recordCommand('hail', '/send login password=hunter2', { home: p.home, now: 7 });
    const lines = stopRecording({ home: p.home });
    assert.deepEqual(lines.map((l) => [l.app, l.line.includes('hunter2')]), [['bosun', false], ['hail', false]]);
    assert.equal(lines[0].line, '/start api');
    assert.equal(recordingState({ home: p.home }), null);
    assert.deepEqual(recordedLines({ home: p.home }), []);
  } finally {
    p.done();
  }
});

test("a switch in this process reaches its watchers at once; another environment's production flag; the app's own command", async () => {
  const p = project(SHOP);
  try {
    const seen = [];
    // A poll far longer than the test: only the in-process notice can reach it.
    const stop = watchEnvironment(p.sub, (env) => seen.push(env.name), { home: p.home, interval: 60_000 });
    setEnvironment(p.sub, 'prod', { home: p.home });
    stop();
    assert.deepEqual(seen, ['prod']);
    assert.equal(isProduction(p.sub, 'prod'), true);
    assert.equal(isProduction(p.sub, 'dev'), false);
    assert.deepEqual(Object.keys(currentEnvironment(p.sub, { home: p.home }).environments), ['dev', 'prod']);
    assert.match(describeEnvironments(p.sub, { home: p.home, command: '/project-env' }), /\/project-env dev switches/);
  } finally {
    p.done();
  }
});

test("askFirst: an app's own question as it is, and in production with the title saying so", async () => {
  const { askFirst } = await import('../environments.js');
  const asked = [];
  const confirm = async (req) => (asked.push(req), 'yes');
  assert.equal(await askFirst({ confirm, env: { name: 'dev', prod: false } }, null, 'Restart api'), true);
  assert.equal(asked.length, 0, 'nothing asked outside production without a question of its own');
  await askFirst({ confirm, env: { name: 'dev', prod: false } }, { title: 'Restart api?', detail: 'It drops connections.' });
  assert.deepEqual(asked.at(-1), { title: 'Restart api?', detail: 'It drops connections.' });
  assert.equal(await askFirst({ confirm, env: { name: 'prod', prod: true } }, { title: 'Restart api?', detail: 'It drops connections.', options: [1] }), 'yes');
  assert.deepEqual(asked.at(-1), { title: 'prod is production. Restart api?', detail: 'It drops connections. The project marks this environment "prod": true.', danger: true, options: [1] });
  await askFirst({ confirm, env: { name: 'prod', prod: true } }, null, 'Upload 3 files');
  assert.equal(asked.at(-1).title, 'prod is production. Upload 3 files?');
});
