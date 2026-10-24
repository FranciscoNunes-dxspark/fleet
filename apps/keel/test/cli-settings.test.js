// The terminal app's Settings overlay: the rows and what each change saves (cli/settings.js), and
// the overlay itself on demo data, driven by keys.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server's config reads these on import, so they come first: demo data, in a throwaway folder.
const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-settings-'));
process.env.AZDO_MOCK = '1';
process.env.AUTH_MODE = 'local';
process.env.DATA_DIR = dataDir;
after(() => rmSync(dataDir, { recursive: true, force: true }));

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const s = await import('../cli/settings.js');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

const P = { id: 'p1', name: 'Web' };

test('tracking keeps a project\'s repo choice; repos go in and out, and all of them again is "all repos"', () => {
  const settings = { projects: { p1: { name: 'Web', tracked: true, repos: ['a'], teams: [{ id: 't' }] } } };
  assert.deepEqual(s.withTracked(settings, P, false).p1, { name: 'Web', tracked: false, repos: ['a'], teams: [{ id: 't' }], scopeToTeamArea: false });
  assert.deepEqual(s.withTracked({ projects: {} }, P, true).p1, { name: 'Web', repos: 'all', scopeToTeamArea: false, tracked: true });
  assert.deepEqual(s.withRepo(settings, P, ['a', 'b'], 'b', true).p1.repos, 'all');
  assert.deepEqual(s.withRepo({ projects: { p1: { tracked: true, repos: 'all' } } }, P, ['a', 'b'], 'a', false).p1.repos, ['b']);
  assert.deepEqual(s.withAllRepos(settings, P, ['a', 'b'], false).p1.repos, ['a', 'b']);
  assert.equal(s.withAllRepos(settings, P, ['a', 'b'], true).p1.repos, 'all');
  assert.equal(s.repoSummary({ repos: 'all' }, 12), 'all repos (12)');
  assert.equal(s.repoSummary({ repos: ['a'] }, 12), '1 of 12 repos');
});

test('merge types and update modes go round; the check interval moves 15 seconds within 15 to 600', () => {
  assert.equal(s.cycle(s.MERGE_STRATEGIES, 'rebaseMerge'), 'squash');
  assert.equal(s.updateMode({}), 'install');
  assert.equal(s.updateMode({ KEEL_AUTO_UPDATE: '0' }), 'tell');
  assert.equal(s.updateMode({ KEEL_CHECK_UPDATES: 'off', KEEL_AUTO_UPDATE: '1' }), 'off');
  assert.deepEqual(s.updateLines('tell'), ['KEEL_CHECK_UPDATES=1', 'KEEL_AUTO_UPDATE=0']);
  assert.equal(s.stepRefresh(60, 1), 75);
  assert.equal(s.stepRefresh(15, -1), 15);
  assert.equal(s.stepRefresh(600, 1), 600);
});

test('rows: tracked projects first, an opened project\'s repos under it, the update choice only in the executable', () => {
  const view = {
    settings: { projects: { b: { tracked: true, repos: ['r1'] } }, autoComplete: { mergeStrategy: 'squash' }, refreshSeconds: 60 },
    projects: [{ id: 'a', name: 'Alpha', org: 'x' }, { id: 'b', name: 'Beta', org: 'x' }],
  };
  const rows = s.settingsRows({ view, orgs: [{ key: 'x', name: 'x', url: 'https://dev.azure.com/x', primary: true }], open: new Set(['b']), options: { b: { repos: [{ id: 'r1', name: 'one' }, { id: 'r2', name: 'two' }] } }, local: { compiled: true, env: {} } });
  const projects = rows.filter((r) => r.kind === 'project');
  assert.deepEqual(projects.map((r) => [r.label, r.tracked, r.summary]), [['Beta', true, '1 of 2 repos'], ['Alpha', false, '']]);
  assert.deepEqual(rows.filter((r) => r.kind === 'repo').map((r) => [r.repo.name, r.on]), [['one', true], ['two', false]]);
  assert.equal(rows.find((r) => r.kind === 'updates').mode, 'install');
  assert.ok(!s.settingsRows({ view, local: { compiled: false } }).some((r) => r.kind === 'updates'));
  assert.equal(s.settingsRows({ view, filter: 'alp' }).filter((r) => r.kind === 'project').length, 1);
});

test("sections: projects, when to flag things (the web app's thresholds), merging, organizations, this computer", () => {
  const view = {
    settings: { projects: { a: { tracked: true } }, thresholds: { myReviewHours: 8, stalePrDays: 5 }, blockedTag: 'Stuck', autoComplete: {}, refreshSeconds: 60 },
    projects: [{ id: 'a', name: 'Alpha' }],
  };
  const sections = s.settingsSections(s.settingsRows({ view, orgs: [{ key: 'x', name: 'x', url: 'https://dev.azure.com/x', primary: true }], local: { env: {} } }));
  assert.deepEqual(sections.map((x) => [x.id, x.short, x.label]), [
    ['projects', 'Projects', 'Projects and repositories · 1 tracked'],
    ['flags', 'When to flag things', 'When to flag things'],
    ['prs', 'Merging', 'Merging pull requests'],
    ['orgs', 'Organizations', 'Organizations · 1'],
    ['computer', 'This computer', 'This computer'],
  ]);
  const flags = sections[1].rows;
  assert.deepEqual(flags.filter((r) => r.kind === 'threshold').map((r) => [r.key, r.value]).slice(0, 3), [['myReviewHours', 8], ['prNoReviewHours', 1], ['stalePrDays', 5]]);
  assert.match(flags.find((r) => r.label === 'Blocked tag').text, /^Stuck/);
  assert.ok(flags.some((r) => r.kind === 'refresh'));
  assert.ok(sections.every((x) => x.rows.every((r) => r.section === x.id && r.kind !== 'header')));
  assert.deepEqual([s.stepThreshold(8, 1, 168), s.stepThreshold(1, -1, 168), s.stepThreshold(168, 1, 168)], [9, 1, 168]);
});

test('tab goes to the next section; + raises a threshold, saved with the web app\'s settings', async () => {
  const keel = openKeel();
  const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {}, envFile: join(dataDir, '.env') }));
  try {
    await until(app, (f) => f.includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write(',');
    await until(app, (f) => f.includes('Projects and repositories'), 'Settings');
    const before = (await keel.service.settingsView()).settings.thresholds.myReviewHours;
    app.stdin.write('\t');
    await until(app, (f) => f.includes('╭─ When to flag things') && f.includes(`Escalate a review waiting on me after ${before} hours`), 'the thresholds');
    app.stdin.write('+');
    await until(app, (f) => f.includes(`after ${before + 1} hours`), 'one hour more');
    assert.equal((await keel.service.settingsView()).settings.thresholds.myReviewHours, before + 1);
    // Round to the last section, and on to the first again.
    app.stdin.write('h');
    await until(app, (f) => f.includes('╭─ Projects and repositories'), 'back to the projects');
    app.stdin.write('h');
    await until(app, (f) => f.includes('Settings file'), 'this computer');
  } finally {
    app.unmount();
  }
});

async function until(app, check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check(app.lastFrame() ?? '')) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${app.lastFrame()}`);
}

test('the overlay opens over the tabs, stops tracking a project, picks its repos and closes with esc', async () => {
  const envFile = join(dataDir, '.env');
  const keel = openKeel();
  const app = render(React.createElement(App, { keel, poll: false, openUrl: () => {}, envFile }));
  try {
    await until(app, (f) => f.includes('Implement refund endpoint'), 'the Inbox');
    app.stdin.write(',');
    await until(app, (f) => f.includes('Projects and repositories · 3 tracked'), 'Settings');
    // The first project row (Commerce): stop tracking it, then track it again.
    app.stdin.write(' ');
    await until(app, (f) => f.includes('· 2 tracked'), 'one project fewer');
    assert.equal((await keel.service.settingsView()).settings.projects['p-commerce'].tracked, false);
    assert.match(app.lastFrame(), /2 projects/); // the header counts what's tracked
    app.stdin.write(' ');
    await until(app, (f) => f.includes('· 3 tracked'), 'tracked again');
    // ↵ shows its repos; the next row is "All repos", then each repo: take the first one out.
    app.stdin.write('\r');
    await until(app, (f) => /All repos \(\d+\)/.test(f), 'its repos');
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 100));
    app.stdin.write(' ');
    await until(app, (f) => /\d+ of \d+ repos/.test(f), 'a repo left out');
    assert.ok(Array.isArray((await keel.service.settingsView()).settings.projects['p-commerce'].repos));
    app.stdin.write('\x1b');
    await until(app, (f) => !f.includes('Projects and repositories') && f.includes('1 Inbox'), 'back to the Inbox');
    // /addorg: a GitHub owner, there from the next start.
    for (const ch of '/addorg https://github.com/octo-demo') {
      app.stdin.write(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    app.stdin.write('\r');
    await until(app, (f) => f.includes('octo-demo added'), 'the owner added');
    const { orgs } = JSON.parse(readFileSync(join(dataDir, 'orgs.mock.json'), 'utf8'));
    assert.deepEqual(orgs.map((o) => [o.key, o.kind]), [['gh-octo-demo', 'github']]);
  } finally {
    app.unmount();
  }
  assert.throws(() => readFileSync(envFile), /ENOENT/); // nothing about this computer changed
});
