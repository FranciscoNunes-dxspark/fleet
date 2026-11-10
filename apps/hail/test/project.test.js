// The project's environments (the kit's .fleet/project.json): Hail's own environment following the
// project's, /project-env, the question before production, and the lines a runbook records.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordedLines, startRecording, stopRecording } from '@fleet/kit/recording.js';
import { readActivity } from '@fleet/kit/family.js';
import { setEnvironment } from '@fleet/kit/environments.js';
import { isSafeMethod, productionFor, projectEnvironmentNames } from '../src/project.js';
import { suggestionsFor } from '../src/commands.js';
import { KEYS, start, tempHome, until } from './helpers.js';

const PROJECT = { default: 'dev', environments: { dev: { hail: { env: 'local' } }, prod: { prod: true, hail: { env: 'production' } }, qa: { prod: true } } };

let cleanup;
let dir;
let server;
const seen = [];
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-project-'));
  // A checkout of its own, so the project's file is looked for no higher than here.
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.fleet'));
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify(PROJECT));
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, at: req.url }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { host: `${host}/local` }, production: { host: `${host}/prod` } }));
  writeFileSync(join(dir, 'api.http'), '### Orders\nGET {{host}}/orders\n\n### Make one\nPOST {{host}}/orders\nContent-Type: application/json\n\n{ "id": 1 }\n');
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

async function run(app, line) {
  app.stdin.write('/');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(line.replace(/^\//, ''));
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(KEYS.enter);
}

test('which methods only read, and which of Hail\'s environments are production', () => {
  for (const m of ['GET', 'head', 'OPTIONS', undefined]) assert.ok(isSafeMethod(m), String(m));
  for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'GRAPHQL', 'GRPC', 'WEBSOCKET']) assert.ok(!isSafeMethod(m), m);
  const home = join(dir, 'pure-home');
  assert.deepEqual(productionFor(dir, 'production', { home }), { name: 'prod', prod: true });
  assert.equal(productionFor(dir, 'local', { home }), null);
  // qa is production and names none of Hail's: while it's chosen, whatever Hail uses is.
  setEnvironment(dir, 'qa', { home });
  assert.deepEqual(productionFor(dir, 'local', { home }), { name: 'qa', prod: true });
  assert.equal(productionFor(join(tmpdir(), 'nowhere-hail'), 'production'), null);
  assert.deepEqual(projectEnvironmentNames(dir), ['dev', 'prod', 'qa']);
  assert.deepEqual(suggestionsFor('/project-env p', { projectEnvs: ['dev', 'prod'] }).map((s) => s.insert), ['/project-env prod']);
});

test("Hail's environment follows the project's; /project-env switches it, asks before a POST to production, and is recorded", async () => {
  const home = process.env.FAMILY_HOME;
  startRecording(dir, { home });
  const app = start({ initialFile: join(dir, 'api.http'), cwd: dir });
  // Wide enough for the top line to say both environments beside the views.
  Object.defineProperty(app.stdout, 'columns', { value: 160 });
  app.stdout.emit('resize');
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Orders') && /env local/.test(frame()) && /project dev/.test(frame()), "the project's dev, Hail's local");
    await run(app, '/project-env');
    await until(() => frame().includes('Environment: dev. /project-env prod|qa switches every app.'), 'which it is');
    await run(app, '/project-env prod');
    await until(() => frame().includes('Every app is in prod (production) now'), 'switched');
    await until(() => /env production/.test(frame()) && /project prod \(production\)/.test(frame()), "Hail's production, within a second", 5000);
    assert.ok(readActivity({ dir: home }).some((e) => e.app === 'hail' && /to prod \(production\)/.test(e.text)), 'logged for the family');
    // A GET goes without a question.
    app.stdin.write(KEYS.enter);
    await until(() => seen.some((s) => s.url === '/prod/orders'), 'the GET sent');
    // A POST asks first; No (the first answer) sends nothing.
    app.stdin.write(KEYS.down);
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('prod is production. Send Make one?'), 'the question');
    app.stdin.write('1');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!seen.some((s) => s.method === 'POST'), 'nothing sent on No');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('prod is production. Send Make one?'), 'asked again');
    app.stdin.write('2');
    await until(() => seen.some((s) => s.method === 'POST' && s.url === '/prod/orders'), 'sent on Yes');
    // Back to dev, from another app as it might be: Hail follows.
    setEnvironment(dir, 'dev', { by: 'trawl' });
    await until(() => /env local/.test(frame()) && /project dev/.test(frame()), "back on Hail's local", 5000);
    const lines = recordedLines({ home }).map((l) => [l.app, l.line]);
    assert.deepEqual(lines, [['hail', '/project-env'], ['hail', '/project-env prod']]);
  } finally {
    app.unmount();
    stopRecording({ home });
  }
});
