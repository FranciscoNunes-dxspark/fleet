// The project's environments (the kit's environments.js): Trawl opens on the connection the chosen one
// names, /env shows or switches it for every app, a switch made elsewhere is followed, a production
// environment asks once more before a write, and a recording keeps the commands but never the SQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { setEnvironment } from '@fleet/kit/environments.js';
import { recordedLines, startRecording, stopRecording } from '@fleet/kit/recording.js';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { App } from '../src/ui/App.jsx';

let base;
let project;
let home;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-env-'));
  process.env.TRAWL_HOME = join(base, 'trawl');
  home = process.env.FAMILY_HOME = join(base, 'family');
  project = join(base, 'shop');
  mkdirSync(join(project, '.fleet'), { recursive: true });
  writeFileSync(
    join(project, '.fleet', 'project.json'),
    JSON.stringify({
      default: 'local',
      environments: {
        local: { trawl: { connection: 'demo' } },
        staging: { trawl: { connection: 'dev' }, hail: { env: 'staging' } },
        prod: { prod: true, trawl: { connection: 'demo' } },
        docs: {},
      },
    }),
  );
});
after(() => rmSync(base, { recursive: true, force: true }));

const DEV = { name: 'dev', demo: true, server: 'demo', database: 'ClubB' };
let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}
const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const frame = () => lastApp.lastFrame();
const header = () => frame().split('\n')[0];
const line = async (app, text) => {
  await type(app.stdin, text);
  app.stdin.write('\r');
};
const start = (props = {}) => {
  const config = { connections: [...DEMO_CONNECTIONS, DEV], history: [], ran: [], limit: 500, last: 'dev' };
  return (lastApp = render(React.createElement(App, { config, projectDir: project, familyHome: home, ...props })));
};

test("Trawl opens on the environment's connection, /env says which, and switching moves Trawl and is recorded", async () => {
  startRecording(project, { home });
  const app = start();
  // The last connection was dev, but the project's environment (local, its default) names demo.
  await until(() => /demo +demo\/ClubA/.test(header()), 'connected to demo');
  assert.match(header(), /local/);
  app.stdin.write('/');
  await line(app, 'env');
  await until(() => frame().includes('Environment: local. /env staging|prod|docs switches every app.'), 'which environment');
  app.stdin.write('/');
  await line(app, 'env staging');
  await until(() => /staging +dev +demo\/ClubB/.test(header()), 'switched to staging, on dev');
  assert.match(frame(), /Environment staging: switching to dev\./);
  app.stdin.write('/');
  await line(app, 'env nowhere');
  await until(() => frame().includes('No environment nowhere: local, staging, prod, docs.'), 'an unknown environment');
  // An environment that names no connection leaves Trawl where it is.
  app.stdin.write('/');
  await line(app, 'env docs');
  await until(() => frame().includes('Environment docs names no connection for Trawl, so it stays where it is.'), 'docs, no connection');
  assert.match(header(), /dev +demo\/ClubB/);
  app.stdin.write('!');
  await line(app, 'SELECT TOP (1) * FROM dbo.Clubs');
  await until(() => frame().includes('1 row'), 'the query ran');
  app.unmount();
  const kept = stopRecording({ home }).map((l) => `${l.app} ${l.line}`);
  assert.deepEqual(kept, ['trawl /env', 'trawl /env staging', 'trawl /env nowhere', 'trawl /env docs'], 'the commands, never the SQL');
});

test('a switch made by another app is followed, and a production environment asks once more before a write', async () => {
  setEnvironment(project, 'staging', { by: 'hail', home });
  const app = start({ initialConnection: 'demo' });
  // Asked for on the command line, demo wins over the environment's dev.
  await until(() => /demo +demo\/ClubA/.test(header()), 'connected to demo');
  setEnvironment(project, 'prod', { by: 'bosun', home });
  await until(() => / prod /.test(header()) && frame().includes('Environment prod (production): on demo already.'), 'prod, followed', 6000);
  app.stdin.write('!');
  await line(app, "UPDATE dbo.Clubs SET Name = N'X' WHERE Id = 1");
  await until(() => frame().includes('prod is production. Run this write on demo?'), 'the production question');
  assert.match(frame(), /The project marks this environment "prod": true\./);
  app.stdin.write('2');
  await until(() => !frame().includes('is production. Run'), 'answered no');
  assert.doesNotMatch(frame(), /1 row affected/);
  app.stdin.write('!');
  await line(app, "UPDATE dbo.Clubs SET Name = N'X' WHERE Id = 1");
  await until(() => frame().includes('prod is production. Run this write on demo?'), 'asked again');
  app.stdin.write('1');
  await until(() => frame().includes('1 row affected'), 'the write ran');
  // Reads ask nothing.
  app.stdin.write('!');
  await line(app, 'SELECT TOP (2) * FROM dbo.Clubs');
  await until(() => frame().includes('2 rows'), 'a read');
  assert.doesNotMatch(frame(), /is production\. Run/);
  app.unmount();
  setEnvironment(project, 'local', { home });
});

test('/env without a project file says how to name environments', async () => {
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo', projectDir: base })));
  await until(() => /demo +demo\/ClubA/.test(header()), 'connected');
  app.stdin.write('/');
  await line(app, 'env');
  await until(() => frame().includes('No environments: a .fleet/project.json names them'), 'no environments');
  app.stdin.write('/');
  await line(app, 'env prod');
  await until(() => frame().includes('No .fleet/project.json here or above'), 'nothing to switch');
  assert.deepEqual(recordedLines({ home }), [], 'nothing recorded while not recording');
  app.unmount();
});
