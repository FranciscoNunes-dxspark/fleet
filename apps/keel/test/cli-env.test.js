// The project's environments in the terminal app (cli/environment.js and /env): what the keel section
// names goes first and is production for DORA, a production environment asks before changing a
// deployment, and every slash command run is kept while Fleet records a runbook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-env-'));
const home = join(dataDir, 'family');
const project = join(dataDir, 'shop');
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;
// The kit's useEnvironment reads the family's folder from FAMILY_HOME.
process.env.FAMILY_HOME = home;
mkdirSync(join(project, '.fleet'), { recursive: true });
writeFileSync(join(project, '.fleet', 'project.json'), JSON.stringify({
  default: 'dev',
  environments: {
    dev: { keel: { environment: 'QA' } },
    prod: { prod: true, keel: { environment: 'Production' } },
  },
}));

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const a = await import('../cli/actions.js');
const { environmentFirst, inProduction, monitorNames, namesEnvironment, productionAsk } = await import('../cli/environment.js');
const { recordedLines, startRecording } = await import('@fleet/kit/recording.js');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('a name names the environment as a whole word, any case', () => {
  assert.equal(namesEnvironment('Approve Shop release → Production', 'production'), true);
  assert.equal(namesEnvironment('Shop · Pre-Production', 'Production'), false);
  assert.equal(namesEnvironment('Live-EU', 'live-eu'), true);
  assert.equal(namesEnvironment('Live-EU', 'Live'), false);
  assert.equal(namesEnvironment('QA', ''), false);
  const monitors = [{ name: 'Shop API' }, { name: 'Shop web', link: { stage: 'Production' } }, { name: 'Billing' }];
  assert.deepEqual(environmentFirst(monitors, 'Production', monitorNames).map((m) => m.name), ['Shop web', 'Shop API', 'Billing']);
  assert.equal(environmentFirst(monitors, undefined, monitorNames), monitors);
});

test('a change is in production only in a prod environment, and only where it names it', () => {
  const prod = { name: 'prod', prod: true, environment: 'Production' };
  assert.equal(inProduction(prod, ['Production']), true);
  assert.equal(inProduction(prod, ['QA']), false);
  assert.equal(inProduction(prod, true), true);
  assert.equal(inProduction(prod, []), false);
  assert.equal(inProduction({ name: 'prod', prod: true }, ['QA']), true, 'no stage named: every deployment counts');
  assert.equal(inProduction({ name: 'dev', prod: false, environment: 'QA' }, ['QA']), false);
  const req = { title: 'Approve Release-65 to Production?', detail: 'Ship it.', options: [] };
  assert.equal(productionAsk({ name: 'dev' }, ['Production'], req), req);
  const asked = productionAsk(prod, ['Production'], req);
  assert.equal(asked.title, 'prod is production. Approve Release-65 to Production?');
  assert.match(asked.detail, /"prod": true.*Ship it\./);
  assert.equal(asked.danger, true);
});

test('approving, running and deploying in production ask the production question', async () => {
  const asked = [];
  const ctx = {
    env: () => ({ name: 'prod', prod: true, environment: 'Production' }),
    confirm: async (req) => (asked.push(req), false),
    note: () => {},
    current: () => ({}),
    data: { production: { monitors: [{ targetKey: 'pipeline:p1:7' }] } },
  };
  await a.decide(ctx, { kind: 'approval', title: 'Approve Shop release → Production', reasons: [{ text: 'Waiting on you' }], target: {} }, 'approved');
  await a.decide(ctx, { kind: 'approval', title: 'Approve Shop release → QA', reasons: [{ text: 'Waiting on you' }], target: {} }, 'approved');
  await a.runPipeline(ctx, { projectId: 'p1', definition: { id: 7, name: 'shop-cd' }, branch: 'main' });
  await a.runPipeline(ctx, { projectId: 'p1', definition: { id: 8, name: 'shop-ci' }, branch: 'main' });
  assert.deepEqual(asked.map((q) => q.title), [
    'prod is production. Approve Shop release → Production?',
    'Approve Shop release → QA?',
    'prod is production. Run shop-cd on main?',
    'Run shop-ci on main?',
  ]);
});

let lastApp = null;
const frame = () => lastApp.lastFrame() ?? '';
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
}
const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const run = async (stdin, line) => {
  stdin.write('/');
  await type(stdin, line.slice(1));
  stdin.write('\r');
};

test('/env says which environment, switches every app to another, shows it, and slash commands are recorded', async () => {
  startRecording(project, { home });
  lastApp = render(React.createElement(App, { home: 'inbox', keel, poll: false, openUrl: () => {}, cwd: project, familyHome: home }));
  const app = lastApp;
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    assert.match(frame(), /dev · QA/);
    await run(app.stdin, '/env');
    await until(() => frame().includes('Environment: dev. /env prod switches every app.'), 'which environment');
    await run(app.stdin, '/env PROD');
    await until(() => frame().includes('prod (production) · Production'), 'the production environment in the header');
    assert.match(frame(), /Production goes first in Production and Releases, and \/dora counts it as production/);
    const lines = recordedLines({ home }).map((l) => l.line);
    assert.deepEqual(lines, ['/env', '/env PROD']);
    assert.ok(recordedLines({ home }).every((l) => l.app === 'keel'));
  } finally {
    app.unmount();
  }
});
