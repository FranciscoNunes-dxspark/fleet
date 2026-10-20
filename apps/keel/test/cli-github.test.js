// The terminal app with a GitHub owner added (the demo one, server/mock/github.js): its pull
// requests and workflows show next to Azure DevOps', and o opens them on GitHub.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server's config reads these on import, so they come first: demo data, in a throwaway
// folder that already has the GitHub owner added and tracked.
const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-gh-'));
process.env.AZDO_MOCK = '1';
process.env.AUTH_MODE = 'local';
process.env.DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'orgs.mock.json'), JSON.stringify({ orgs: [{ key: 'gh-octo-demo', url: 'https://github.com/octo-demo', name: 'octo-demo', kind: 'github' }] }));
writeFileSync(join(dataDir, 'settings.mock.json'), JSON.stringify({ projects: { 'gh-octo-demo': { name: 'octo-demo', tracked: true, repos: 'all', teams: [], scopeToTeamArea: false } } }));

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

after(() => rmSync(dataDir, { recursive: true, force: true }));

async function until(app, check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check(app.lastFrame() ?? '')) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${app.lastFrame()}`);
}

test('a GitHub owner\'s pull requests and workflows are in the terminal app, and o opens them on GitHub', async () => {
  const opened = [];
  const app = render(React.createElement(App, { keel: openKeel(), poll: false, openUrl: (u) => opened.push(u) }));
  await until(app, (f) => f.includes('Dark mode toggle in settings'), 'the GitHub review in the Inbox');
  app.stdin.write('2');
  await until(app, (f) => f.includes('Rate limit the search endpoint'), 'the GitHub pull requests');
  app.stdin.write('3');
  await until(app, (f) => f.includes('Terraform plan'), 'the GitHub workflows');
  app.stdin.write('o');
  await until(app, () => opened.length > 0, 'a link opened');
  assert.match(opened[0], /^https:\/\/github\.com\/octo-demo\//);
  app.unmount();
});
