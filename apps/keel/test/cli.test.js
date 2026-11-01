// Drives the terminal app (cli/) against the demo organization: keys in, frames out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server's config reads these on import, so they come first: demo data, in a throwaway folder.
const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

const KEYS = { down: '\x1b[B', enter: '\r', esc: '\x1b', tab: '\t' };

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
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
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

function start(props = {}) {
  const opened = [];
  lastApp = render(React.createElement(App, { home: 'inbox', keel, poll: false, openUrl: (u) => opened.push(u), ...props }));
  lastApp.opened = opened;
  return lastApp;
}

test('the Inbox of the demo organization, with Pinch saying what needs you', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  assert.match(frame(), /Keel/);
  assert.match(frame(), /contoso-demo/);
  assert.match(frame(), /DEMO/);
  assert.match(frame(), /act now/);
  assert.match(frame(), /Welcome to Keel/);
  assert.match(frame(), /things? needs? you now/);
  app.unmount();
});

test('↵ on a pull request in the Inbox opens it in the Pull requests tab', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Waiting on your review') && frame().includes('!817 '), 'the pull request');
  assert.match(frame(), /Reviewers/);
  app.unmount();
});

test('approving a pull request records the vote and says so', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('4');
  await until(() => frame().includes('Waiting on your review'), 'the Pull requests tab');
  app.stdin.write('a');
  await until(() => /Approve !\d+/.test(frame()) && frame().includes('Approved.'), 'the vote');
  // It leaves "Waiting on your review", so the cursor is on the next one: ask Azure DevOps (the demo) instead.
  const id = Number(frame().match(/Approve !(\d+)/)[1]);
  const { prs } = await keel.service.pullRequests();
  assert.equal(prs.find((p) => p.id === id).myVote, 10);
  app.unmount();
});

test('rejecting asks first, and No leaves the vote alone', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('4');
  await until(() => frame().includes('Waiting on your review'), 'the Pull requests tab');
  app.stdin.write('x');
  await until(() => /Reject !\d+ .*\?/.test(frame()), 'the question');
  app.stdin.write('2');
  await until(() => !/Reject !\d+ .*\?/.test(frame()), 'the question to go');
  assert.doesNotMatch(frame(), /Vote recorded/);
  app.unmount();
});

test('a pull request shows its step (publish → approval → complete), and p publishes a draft', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('4');
  await until(() => frame().includes('Waiting on your review') && /● Approval|● Complete/.test(frame()), 'the steps in the pane');
  const { prs } = await keel.service.pullRequests();
  const draft = prs.find((p) => p.isDraft);
  await type(app.stdin, `/pr ${draft.id}`);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('● Publish') && frame().includes('p publish'), 'the draft at its first step');
  app.stdin.write('p');
  await until(() => frame().includes('Published: its reviewers are asked'), 'the publish');
  assert.equal((await keel.service.pullRequest(draft.projectId, draft.repoId, draft.id)).flow.step, 'approval');
  app.unmount();
});

test('the Pipelines tab lists failing pipelines first, with their latest runs', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('5');
  await until(() => frame().includes('Latest runs') && /\d{8}\.\d/.test(frame()), 'the runs of the first pipeline');
  assert.match(frame(), /✗ failing/);
  app.unmount();
});

test('/run asks first, then queues a run of the selected pipeline', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('5');
  await until(() => frame().includes('Latest runs'), 'the Pipelines tab');
  await type(app.stdin, '/run');
  app.stdin.write(KEYS.enter);
  await until(() => /Run .+ on .+\?/.test(frame()), 'the question');
  app.stdin.write('1');
  await until(() => frame().includes('Queued run'), 'the queued run');
  // The "1" that answered doesn't also switch to the Inbox.
  assert.match(frame(), /╭─ Pipelines/);
  app.unmount();
});

test('snoozing an Inbox item hides it, and /unsnooze brings it back', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('s');
  await until(() => frame().includes('Hidden from the Inbox for 1 day') && frame().includes('1 snoozed'), 'the snooze');
  assert.doesNotMatch(frame().split('Inbox')[1] ?? '', /❯ ● Review {3}Implement refund endpoint/);
  await type(app.stdin, '/unsnooze');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('1 item back in the Inbox'), 'the unsnooze');
  app.unmount();
});

test('/find filters the list, and o opens the selection in the browser', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  await type(app.stdin, '/find refund');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('matching "refund"'), 'the filter');
  app.stdin.write('o');
  await until(() => app.opened.length === 1, 'the browser');
  assert.match(app.opened[0], /pullrequest\/817/);
  app.unmount();
});

test('? shows the shortcuts, on the section for the view on screen; / searches them; esc closes them', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  app.stdin.write('?');
  await until(() => frame().includes('Keyboard shortcuts') && frame().includes('❯ Inbox') && frame().includes('Snooze for a day'), 'the help, on Inbox');
  app.stdin.write('/');
  for (const ch of 'priority') app.stdin.write(ch);
  await until(() => frame().includes('Matches for “priority”') && frame().includes('Set its priority'), 'the matches');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Matches for'), 'the search cleared');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Keyboard shortcuts'), 'the help to close');
  app.unmount();
});

test('opens on the Line: six stations with their counts, the cards of one stage most stuck first; ↵ opens a card in its tab', async () => {
  // Without a home of its own, Keel opens on the Line.
  const app = start({ home: undefined });
  await until(() => frame().includes('Planned') && frame().includes('Live') && /\d+ · \d+ stuck/.test(frame()), 'the stations');
  for (const name of ['Planned', 'Building', 'In review', 'Merged', 'Deploying', 'Live']) assert.match(frame(), new RegExp(name));
  assert.match(frame(), / 1 Line /);
  // To the first station, then two along: In review, the pull requests.
  for (let i = 0; i < 6; i++) app.stdin.write('h');
  await until(() => frame().includes('Planned: not started yet'), 'Planned');
  app.stdin.write('l');
  app.stdin.write('l');
  await until(() => frame().includes('In review: pull requests open'), 'In review');
  // Most stuck first: the first card is marked stuck.
  const first = frame().split('\n').find((l) => l.includes('❯'));
  assert.match(first, /❯ [✗!] /);
  // Its number is in the pane beside the list (the row may be cut short).
  const id = frame().split('\n').map((l) => l.split('││')[1] ?? '').find((l) => /· !\d+/.test(l)).match(/!(\d+)/)[1];
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('╭─ Pull requests') && frame().split('\n').some((l) => l.includes('❯') && l.includes(`!${id} `)), 'the pull request in its tab');
  app.unmount();
});

test('the Control room shows the production services and the last 24 hours; ↵ shows a service in full', async () => {
  const app = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  await type(app.stdin, '/control');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('╭─ Services') && frame().includes('Last 24 hours') && frame().includes('Storefront') && / events /.test(frame()), 'the Control room');
  assert.match(frame(), /\d+ms · [\d.]+% up/);
  assert.match(frame(), /\d\d:\d\d ● /);
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('esc close') && frame().includes('/health'), 'the service in full');
  app.stdin.write(KEYS.esc);
  await until(() => frame().includes('╭─ Services'), 'the viewer to close');
  // 1 goes back to the Line.
  app.stdin.write('1');
  await until(() => frame().includes('Deploying') && frame().includes('In review'), 'the Line');
  app.unmount();
});
