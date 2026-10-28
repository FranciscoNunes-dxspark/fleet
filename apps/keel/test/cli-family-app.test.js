// Keel in the family, end to end on the demo organization: what it hands Splice and Sonar, what /take
// does with a sibling's line, the activity it logs, and Pinch's mood and word on the others'.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The server's config reads these on import, so they come first: demo data, in a throwaway folder.
const base = mkdtempSync(join(tmpdir(), 'keel-cli-family-'));
const dataDir = join(base, 'data');
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');
const { contextIn, encodeContext, readActivity, takeLine, writeMood } = await import('@fleet/kit/family.js');

const familyHome = join(base, 'family');
const project = join(base, 'shop');
let keel;
before(() => {
  keel = openKeel();
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, '.env'), 'API_URL=https://api.shop.local\nDB_PASSWORD=hunter2\n');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
const frame = () => lastApp.lastFrame() ?? '';
const flat = () => frame().replace(/\s+/g, ' ');
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
}
const type = async (text) => {
  for (const ch of text) {
    lastApp.stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
/** A command line at the prompt, typed in and run. */
async function command(text) {
  lastApp.stdin.write('/');
  await until(() => frame().includes('> /'), 'the prompt');
  await type(text.replace(/^\//, ''));
  await new Promise((r) => setTimeout(r, 60));
  lastApp.stdin.write('\r');
}

function start(props = {}) {
  const copied = [];
  const opened = [];
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: (u) => opened.push(u), copy: (t) => copied.push(t), familyHome, familyEvery: 100, cwd: project, ...props }));
  return { copied, opened };
}

test('alt+y hands a pull request and a run to Splice; alt+s a deploying run and alt+k a regression to Sonar', async () => {
  const { copied } = start();
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    lastApp.stdin.write('2');
    await until(() => frame().includes('╭─ Pull requests'), 'the pull requests');
    lastApp.stdin.write('\x1by');
    await until(() => copied.length === 1, 'the pull request copied');
    const pr = contextIn(copied[0]);
    assert.equal(pr.kind, 'pullrequest');
    assert.ok(pr.data.id && pr.data.repo && pr.data.sourceBranch && pr.data.targetBranch === 'main');
    await until(() => flat().includes("Copied for Splice: paste it into Splice's prompt. pull request !"), 'the note');

    // The first pipeline is a failing nightly: its run goes to Splice, as a file when the failure names one, else its commit.
    lastApp.stdin.write('3');
    await until(() => frame().includes('╭─ Pipelines'), 'the pipelines');
    const [row] = (await keel.service.pipelines()).filter((r) => r.health === 'failing');
    await until(() => frame().includes(`❯ ✗ ${row.definition.name}`) || frame().includes(row.definition.name), 'the failing pipeline');
    lastApp.stdin.write('\x1by');
    await until(() => copied.length === 2, 'the run copied');
    assert.ok(['file', 'commit'].includes(contextIn(copied[1]).kind));
    await until(() => flat().includes('Copied for Splice'), 'its note');

    // A nightly deploys nothing: Sonar has nothing to find.
    lastApp.stdin.write('\x1bs');
    await until(() => flat().includes("doesn't deploy anywhere Keel knows of"), 'not a deployment');

    // The monitor whose failures went up after a deploy: Sonar's /compare-window at that deploy.
    const m = (await keel.service.production()).monitors.find((x) => x.issues?.some((i) => i.code === 'deploy-regression'));
    // The demo's monitors go down and up with the clock, and those that are down sort first: find this one in Production itself.
    lastApp.stdin.write('5');
    await until(() => frame().includes('╭─ Production'), 'Production');
    await command(`find ${m.name}`);
    await until(() => frame().split('\n').some((l) => l.includes('❯') && l.includes(m.name)), 'the monitor under the cursor');
    lastApp.stdin.write('\x1bk');
    await until(() => copied.length === 3, 'the line for Sonar');
    assert.match(copied[2], /^\/compare-window \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(Date.parse(copied[2].split(' ')[1]), Math.floor(Date.parse(m.issues.find((i) => i.code === 'deploy-regression').deploy.at) / 1000) * 1000);
    await until(() => flat().includes("Copied for Sonar: paste it into Sonar's prompt. /compare-window"), 'its note');
  } finally {
    lastApp.unmount();
  }
});

test('/take: a commit lists the runs that built it; another kind is for another app; /take alone still takes the work item', async () => {
  const { opened } = start();
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    const run = (await keel.service.pipelines()).find((r) => r.lastRun?.commit).lastRun;
    await command(takeLine('commit', { repo: run.repoName, hash: run.commit, subject: 'Nightly' }));
    await until(() => frame().includes(`${run.definition.name} ${run.buildNumber}`) && frame().includes('Leave it'), 'the runs that carry it');
    lastApp.stdin.write('\r');
    await until(() => frame().includes(`${run.definition.name} ${run.buildNumber} ·`) && frame().includes('esc close'), 'the run in full');
    lastApp.stdin.write('\x1b');
    await until(() => !frame().includes('esc close'), 'closed');

    await command(takeLine('request', { method: 'GET', url: 'http://x/a' }));
    await until(() => flat().includes("That's request GET http://x/a, for Hail: paste it into its prompt instead."), 'whose it is');

    // A bare context pasted while a view has the keys opens the prompt with it; ↵ takes it.
    lastApp.stdin.write(encodeContext('pullrequest', { repo: 'nowhere', id: 4242, sourceBranch: 'a', targetBranch: 'b', url: 'https://x/pr/4242' }));
    await until(() => frame().includes('enter run'), 'the pasted line in the prompt');
    lastApp.stdin.write('\r');
    await until(() => opened.includes('https://x/pr/4242'), 'a pull request Keel has no row for, in the browser');

    await command('take');
    await until(() => flat().includes('Pick a work item first'), '/take alone, as before');
    assert.equal(opened.length, 1);
  } finally {
    lastApp.unmount();
  }
});

test('Keel logs what it changes for /timeline, writes its mood, and says once how a sibling feels', async () => {
  writeMood('splice', { mood: 'happy', reason: 'PR #12 merged' }, { dir: familyHome });
  start();
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    await until(() => frame().includes('Twig says: PR #12 merged'), "Twig's word");
    await until(() => existsSync(join(familyHome, 'keel.mood.json')), 'its mood written');
    // Calm, or worried while one of the demo's monitors is down (they go down and up with the clock).
    assert.match(JSON.parse(readFileSync(join(familyHome, 'keel.mood.json'), 'utf8')).reason, /^watching \d+ pull requests and \d+ pipelines|is down$/);
    lastApp.stdin.write('\x1b');
    await until(() => !frame().includes('Twig says'), 'put away with esc');

    // Approving a pull request (not yours) goes into the family's log; /timeline shows it.
    const pr = (await keel.service.pullRequests()).prs.find((p) => !p.isMine);
    await command(`pr ${pr.id}`);
    await until(() => frame().includes(`!${pr.id}`) && frame().includes('╭─ Pull requests'), 'the pull request');
    lastApp.stdin.write('a');
    await until(() => flat().includes('Approved.'), 'approved');
    const [entry] = readActivity({ dir: familyHome });
    assert.equal(entry.app, 'keel');
    assert.equal(entry.kind, 'review');
    assert.match(entry.text, new RegExp(`^Approve !${pr.id} .* in ${pr.repoName}$`));
    await command('timeline');
    await until(() => frame().includes('Timeline: the family (1)') && frame().includes(`Keel  Approve !${pr.id}`), 'the timeline');
    lastApp.stdin.write('\x1b');
    await until(() => !frame().includes('Timeline: the family'), 'closed');

    // /wiring masks what's secret.
    await command('wiring');
    await until(() => frame().includes('API_URL') && frame().includes('https://api.shop.local'), 'the wiring');
    assert.doesNotMatch(frame(), /hunter2/);
  } finally {
    lastApp.unmount();
  }
});

test('without the family folder (the web terminal, other tests) Keel keeps to itself', async () => {
  const quiet = join(base, 'quiet');
  start({ familyHome: undefined });
  try {
    await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
    await command('timeline');
    await until(() => flat().includes("The family's activity log isn't kept here."), 'no timeline');
    assert.equal(existsSync(quiet), false);
  } finally {
    lastApp.unmount();
  }
});
