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

test("GitHub: a can't approve your own pull request, and a branch that needs no review skips approval", async () => {
  const keel = openKeel();
  const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const type = async (text) => {
    for (const ch of text) {
      app.stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until(app, (f) => f.includes('Dark mode toggle in settings'), 'the Inbox');
  const { prs } = await keel.service.pullRequests();
  const own = prs.find((p) => p.isMine && p.reviewRequired !== undefined);
  await type(`/pr ${own.id}`);
  app.stdin.write('\r');
  await until(app, (f) => f.includes(`!${own.id} `) && f.includes('● Complete'), 'your own pull request');
  app.stdin.write('a');
  await until(app, (f) => f.includes("GitHub doesn't let you review your own pull request.") && f.includes('there: o opens it'), 'the refusal');

  const noReview = prs.find((p) => p.reviewRequired === false && !p.isDraft);
  await type(`/pr ${noReview.id}`);
  app.stdin.write('\r');
  await until(app, (f) => f.includes('– Approval (not required)') && f.includes('This branch needs no review.'), 'approval skipped');
  app.unmount();
});

test('GitHub: a pull request is held while its checks run: the pane says so, and c waits for them', async () => {
  const keel = openKeel();
  const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  await until(app, (f) => f.includes('Dark mode toggle in settings'), 'the Inbox');
  for (const ch of '/pr 87') {
    app.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  app.stdin.write('\r');
  await until(app, (f) => f.includes('!87 ') && f.includes('Its checks are still running'), 'the held pull request');
  // In the list and the pane too, in place of "approved".
  assert.match(app.lastFrame(), /❯ ◔ !87/);
  assert.match(app.lastFrame(), /◔ checks running/);
  app.stdin.write('c');
  await until(app, (f) => f.includes("!87 Rate limit the search endpoint's checks are still running"), 'c waiting for them');
  assert.ok((await keel.service.pullRequests()).prs.some((p) => p.id === 87 && p.status === 'active'));
  app.unmount();
});

test('GitHub releases are below the release pipelines; D downloads a file of one in the browser, n says they are made on GitHub', async () => {
  const opened = [];
  const app = render(React.createElement(App, { keel: openKeel(), poll: false, openUrl: (u) => opened.push(u) }));
  await until(app, (f) => f.includes('Dark mode toggle in settings'), 'the Inbox');
  app.stdin.write('6');
  await until(app, (f) => /↓ api\s+v2\.4\.0 · 4 files · 6d ago\s+v2\.5\.0/.test(f), 'the api repo with its latest release, and the newer pre-release');
  // The repo released most lately first, so web-app is last.
  app.stdin.write('G');
  await until(app, (f) => /❯ ↓ web-app/.test(f), 'web-app selected');
  app.stdin.write('k');
  await until(app, (f) => /❯ ↓ api/.test(f) && f.includes('api-2.5.0-rc.1-linux-x64.tar.gz'), 'api with its files beside it');
  app.stdin.write('n');
  await until(app, (f) => f.includes('api is a GitHub repo: its releases are made on GitHub'), 'n refused');
  app.stdin.write('D');
  await until(app, (f) => f.includes('Download from which release of api?'), 'the releases');
  app.stdin.write('2');
  await until(app, (f) => f.includes('Download which file of v2.4.0?'), 'the files');
  app.stdin.write('1');
  await until(app, () => opened.length > 0, 'the download opened');
  assert.equal(opened[0], 'https://github.com/octo-demo/api/releases/download/v2.4.0/api-2.4.0-linux-x64.tar.gz');
  app.unmount();
});
