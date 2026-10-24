// /summary in the terminal app: the web app's weekly summary as text (cli/format.js), on the demo organization.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-summary-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { summaryText, summaryWeek } = await import('../cli/format.js');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

test('which week: this one, last, N back (up to 26) or a date', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  assert.equal(summaryWeek('', now), '');
  assert.equal(summaryWeek('last', now), '2026-10-14');
  assert.equal(summaryWeek('-3', now), '2026-09-30');
  assert.equal(summaryWeek('2026-10-06', now), '2026-10-06');
  for (const bad of ['-27', 'yesterday', '2026-13-45', '3']) assert.equal(summaryWeek(bad, now), null, bad);
});

test('the summary reads as the web app\'s "Copy as text"', () => {
  const text = summaryText({
    from: '2026-10-12T00:00:00.000Z',
    to: '2026-10-18T23:59:59.999Z',
    totals: { finished: 1, features: 1, bugs: 0, merged: 3, deploys: 2, failedDeploys: 1, blocked: 1, inProgress: 9 },
    features: [{ id: 7, type: 'User Story', title: 'Refunds', projectName: 'Web', assignedTo: 'Ana' }],
    bugs: [],
    mergedByRepo: [{ projectName: 'Web', repoName: 'shop', count: 3 }],
    deploys: [{ target: 'Shop', label: 'Release-9', at: '2026-10-16T10:00:00Z', status: 'succeeded' }, { target: 'Shop', label: 'Release-8', at: '2026-10-15T10:00:00Z', status: 'failed' }],
    blocked: [{ id: 9, type: 'Bug', title: 'Totals', projectName: 'Web', assignedTo: null }],
  });
  assert.equal(text, [
    'Week of 12 Oct – 18 Oct 2026',
    '',
    '• 1 item finished (1 features and stories, 0 bugs fixed)',
    '• 3 pull requests merged',
    '• 2 deploys to production (1 failed)',
    '• 1 item blocked right now · 9 in progress',
    '',
    'Finished',
    '- Refunds (Web, User Story #7, Ana)',
    '',
    'Merged, by repository',
    '- shop (Web): 3 pull requests',
    '',
    'Deployed to production',
    '- Shop: 1 deploy, 1 failed (latest Release-9, 16 Oct)',
    '',
    'Blocked right now',
    '- Totals (Web, Bug #9)',
  ].join('\n'));
});

test('/summary shows this week, /summary last the one before', async () => {
  const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {} }));
  const frame = () => app.lastFrame() ?? '';
  const until = async (check, what) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (check()) return new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
  };
  const type = async (text) => {
    for (const ch of text) {
      app.stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  await type('/summary');
  app.stdin.write('\r');
  await until(() => frame().includes('(this week, so far)') && frame().includes('pull requests merged'), 'this week');
  app.stdin.write('\x1b');
  await until(() => !frame().includes('so far'), 'the viewer to close');
  await type('/summary last');
  app.stdin.write('\r');
  await until(() => /Week of \d+ \w+ – \d+ \w+ \d{4}\s/.test(frame()) && !frame().includes('so far'), 'last week');
  app.unmount();
});
