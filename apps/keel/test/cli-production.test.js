// The terminal app's Production tab (cli/ui/ProductionView.jsx) on the demo organization's monitors,
// and the order and numbers behind it (cli/format.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-prod-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { monitorDetail, monitorNumbers, monitorRows } = await import('../cli/format.js');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

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
const text = (lines) => lines.map((l) => (typeof l === 'string' ? l : l.map((s) => s.text).join(''))).join('\n');

test('monitors that need you come first, the rest keep their order', () => {
  const ms = [{ name: 'a', state: 'up' }, { name: 'b', state: 'unknown' }, { name: 'c', state: 'down' }, { name: 'd', state: 'deploying' }, { name: 'e', state: 'up' }, { name: 'f', state: 'degraded' }];
  assert.deepEqual(monitorRows(ms).map((m) => m.name), ['c', 'f', 'd', 'a', 'e', 'b']);
  assert.deepEqual(monitorRows(ms, 'deploy').map((m) => m.name), ['d']);
  assert.equal(monitorNumbers({ last: { ms: 1840 }, uptime24h: 0.996, ai: { failRate: 0.004 } }), '1.8s · 100% up · 0.4% failing');
});

test("the side pane says what's waiting to ship, or why it can't", () => {
  const m = { name: 'Shop', url: 'https://shop.example/health', state: 'up', issues: [], markers: [], targetKey: 'release:p:1:Prod' };
  assert.match(text(monitorDetail({ ...m, targetKey: null }, null)), /isn't linked/);
  assert.match(text(monitorDetail(m, undefined)), /Reading…/);
  const now = Date.parse('2026-10-21T12:00:00Z');
  const waiting = { name: 'Shop · Prod', branch: 'main', waiting: 3, oldestAt: '2026-10-10T12:00:00Z', pullRequests: [{ id: 7, title: 'Fix totals' }], directCommits: [{ id: 'abcdef1234', subject: 'Hotfix' }], upcoming: [{ id: 9 }], deploy: { state: 'approval', label: 'Release-9', startedAt: '2026-10-21T11:00:00Z' } };
  const shown = text(monitorDetail(m, waiting, now));
  assert.match(shown, /Waiting for approval: Release-9/);
  assert.match(shown, /3 changes on main {2}oldest merged 11d ago/);
  assert.match(shown, /!7 Fix totals/);
  assert.match(shown, /abcdef1 Hotfix/);
  assert.match(shown, /Coming next: 1 open pull request/);
  assert.match(text(monitorDetail(m, { ...waiting, waiting: 0, deploy: null, lastDeploy: { label: 'Release-8', at: '2026-10-20T12:00:00Z' } }, now)), /Nothing: main is all deployed \(Release-8, 1d ago\)/);
});

test('the Production tab lists the monitors with what is waiting to ship; ↵ shows it all; o opens the site', async () => {
  const opened = [];
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: (u) => opened.push(u) }));
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  lastApp.stdin.write('5');
  await until(() => frame().includes('Storefront (production)'), 'the monitors');
  // Move to a monitor linked to what deploys it, and wait for its environment's changes.
  for (let i = 0; i < 8 && !frame().includes('Waiting to ship'); i++) {
    lastApp.stdin.write('j');
    await new Promise((r) => setTimeout(r, 150));
  }
  await until(() => /Waiting to ship/.test(frame()) && !/Reading…/.test(frame()), "what's waiting to ship");
  lastApp.stdin.write('\r');
  await until(() => frame().includes('Deploys') && frame().includes('esc close'), 'everything about it');
  lastApp.stdin.write('G');
  await until(() => /Waiting to ship to |Coming next|Nothing: all deployed/.test(frame()), 'the end of it: what is waiting to ship');
  lastApp.stdin.write('\x1b');
  await until(() => frame().includes('╭─ Production'), 'the list again');
  lastApp.stdin.write('o');
  await until(() => opened.length === 1, 'the browser');
  assert.match(opened[0], /^https:\/\/[^/]+contoso-demo\.com$/, 'the site, not its health check');
  lastApp.unmount();
});

test('S opens Sonar on the monitor: its address, its Application Insights, at its problems', async () => {
  const sonarCalls = [];
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {}, openSonar: async (args) => (sonarCalls.push(args), { how: 'copied', command: `sonar ${args.join(' ')}` }) }));
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  lastApp.stdin.write('5');
  await until(() => frame().includes('Storefront (production)'), 'the monitors');
  lastApp.stdin.write('S');
  await until(() => frame().includes('Run it in another terminal'), 'the command copied');
  assert.equal(sonarCalls.length, 1);
  assert.equal(sonarCalls[0][0], '--url');
  assert.match(sonarCalls[0][1], /^https:\/\/.+contoso-demo\.com\/health$/);
  assert.equal(sonarCalls[0].at(-1), '--problems');
  lastApp.unmount();
});

test('Sonar in a new Windows Terminal tab where there is one, else the command copied', async () => {
  const { openSonar, sonarArgs, sonarCommand } = await import('../cli/sonar.js');
  const args = sonarArgs({ url: 'https://shop.example/health', appInsightsAppId: 'abc-1' });
  assert.deepEqual(args, ['--url', 'https://shop.example/health', '--insights', 'abc-1', '--problems']);
  assert.deepEqual(sonarArgs({ url: 'https://x/' }), ['--url', 'https://x/', '--problems']);
  assert.equal(sonarCommand(['--kql', 'requests | take 5']), 'sonar --kql "requests | take 5"');
  const spawned = [];
  const spawnImpl = (cmd, a) => {
    spawned.push([cmd, ...a]);
    const listeners = {};
    queueMicrotask(() => listeners.spawn?.());
    return { on: (e, f) => ((listeners[e] = f), undefined), unref() {} };
  };
  assert.deepEqual(await openSonar(args, { env: { WT_SESSION: '1' }, spawnImpl, copy: async () => assert.fail('no copy in a tab') }), { how: 'tab' });
  assert.deepEqual(spawned[0].slice(0, 5), ['wt', '-w', '0', 'new-tab', 'sonar']);
  const copied = [];
  assert.deepEqual(await openSonar(args, { env: {}, copy: async (t) => copied.push(t) }), { how: 'copied', command: 'sonar --url https://shop.example/health --insights abc-1 --problems' });
  assert.deepEqual(copied, ['sonar --url https://shop.example/health --insights abc-1 --problems']);
});
