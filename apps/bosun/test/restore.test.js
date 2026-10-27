// /replay's r: what the recording keeps for it (the profile, the checkout, a hash of each start's env
// files), reading the checkout from git's files, and the plan of what to start, stop and say.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, envHash } from '../src/recorder.js';
import { Replayer, parseSession } from '../src/replay.js';
import { branchTip, gitHead } from '../src/githead.js';
import { planLines, restorePlan } from '../src/restore.js';
import { KEYS, project, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test("the checkout is read from git's files: a branch, packed refs, detached, a linked worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bosun-git-'));
  try {
    const git = join(dir, '.git');
    mkdirSync(join(git, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(git, 'refs', 'heads', 'main'), `${A}\n`);
    writeFileSync(join(git, 'packed-refs'), `# pack-refs with: peeled\n${B} refs/heads/feature/x\n`);
    mkdirSync(join(dir, 'api'));
    assert.deepEqual(gitHead(join(dir, 'api')), { branch: 'main', commit: A });
    assert.equal(branchTip(dir, 'feature/x'), B);
    assert.equal(branchTip(dir, 'nope'), null);
    writeFileSync(join(git, 'HEAD'), `${B}\n`);
    assert.deepEqual(gitHead(dir), { branch: null, commit: B });
    // A linked worktree: its .git file names its folder, whose commondir has the refs.
    const wt = join(git, 'worktrees', 'other');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(wt, 'commondir'), '../..\n');
    const other = join(dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, '.git'), `gitdir: ${wt}\n`);
    assert.deepEqual(gitHead(other), { branch: 'main', commit: A });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the env files' hash keeps no value, and changes with any of them", () => {
  assert.equal(envHash({}), null);
  assert.equal(envHash(undefined), null);
  const h = envHash({ B: '2', A: 'secret' });
  assert.equal(h, envHash({ A: 'secret', B: '2' }), 'the order is not a change');
  assert.notEqual(h, envHash({ A: 'other', B: '2' }));
  assert.ok(!h.includes('secret'));
  assert.match(h, /^[0-9a-f]{12}$/);
});

test("a recording keeps the profile, the checkout when it moves, and each start's env hash", () => {
  const dir = mkdtempSync(join(tmpdir(), 'bosun-rec-'));
  try {
    let head = { branch: 'main', commit: A };
    const r = new Recorder({ dir, project: '/shop', procs: [{ name: 'api', run: 'node api.js' }], profile: 'mock', readGit: () => head, now: 0 });
    r.started('api', { env: 'abc' }, 10);
    r.line('api', { at: 11, text: '── node api.js' });
    head = { branch: 'feature', commit: B };
    r.profile(null, 20);
    r.started('api', { env: 'def' }, 30);
    r.close();
    const s = parseSession(readFileSync(r.file, 'utf8'));
    assert.equal(s.header.profile, 'mock');
    assert.deepEqual(s.header.git, { branch: 'main', commit: A });
    assert.deepEqual(s.events.map((e) => e.type), ['start', 'line', 'profile', 'git', 'start']);
    const rp = new Replayer(s);
    let procs = rp.at(15);
    assert.equal(rp.profile, 'mock');
    assert.equal(rp.git.branch, 'main');
    assert.equal(procs[0].env, 'abc');
    procs = rp.at(40);
    assert.equal(rp.profile, null);
    assert.deepEqual(rp.git, { branch: 'feature', commit: B });
    assert.equal(procs[0].env, 'def');
    rp.at(5);
    assert.equal(rp.profile, 'mock', 'back in time starts over');
    // Reading the checkout failing is no checkout, never an error.
    const plain = new Recorder({ dir, project: '/shop', readGit: () => { throw new Error('no'); }, now: 1 });
    assert.equal(plain.git(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const was = (name, status, extra = {}) => ({ name, status, restartAt: null, gaveUp: false, ...extra });
const now = (name, running, fileEnv = {}) => ({ name, child: running ? {} : null, restartAt: null, spec: { fileEnv } });

test("the plan starts what ran then, stops what didn't, and says what it can't put back", () => {
  const plan = restorePlan(
    { procs: [was('api', 'running', { env: envHash({ PORT: '1' }) }), was('web', 'crashed', { restartAt: 5 }), was('worker', 'stopped'), was('old', 'running')], profile: 'mock', git: { branch: 'main', commit: A } },
    { procs: [now('api', false, { PORT: '2' }), now('web', true), now('worker', true), now('jobs', true)], profile: null, profiles: ['mock'], git: { branch: 'feature', commit: B }, tipOf: (b) => (b === 'main' ? A : null) },
  );
  assert.equal(plan.profile, 'mock');
  assert.deepEqual(plan.start, ['api']);
  assert.deepEqual(plan.stop, ['worker', 'jobs'], 'web waited to restart then, and runs now: left alone');
  assert.deepEqual(plan.missing, ['old']);
  assert.deepEqual(plan.envChanged, ['api']);
  assert.deepEqual(plan.git, { branch: 'main', commit: A, same: false, line: '/checkout main' });
  assert.equal(plan.nothing, false);
  const lines = planLines(plan);
  assert.equal(lines[0], 'Switch to the profile mock');
  assert.ok(lines.includes('Stop worker and jobs'));
  assert.ok(lines.includes('Start api'));
  assert.ok(lines.includes('Copy /checkout main for Splice'));
  assert.ok(lines.some((l) => /old isn't in the crew/.test(l)));
  assert.ok(lines.some((l) => /\.env changed since then for api/.test(l)));
  assert.ok(lines.some((l) => /main at aaaaaaaaaaaa then, feature at bbbbbbbbbbbb now/.test(l)));
  assert.ok(!lines.join('\n').includes('PORT'), 'no values');
});

test('the plan: the commit when the branch moved on, a profile gone, nothing to do, an old recording', () => {
  const moved = restorePlan({ procs: [was('api', 'running')], profile: 'gone', git: { branch: 'main', commit: A } }, { procs: [now('api', true)], profile: null, profiles: [], git: { branch: 'main', commit: B }, tipOf: () => B });
  assert.equal(moved.git.line, '/checkout aaaaaaaaaaaa');
  assert.equal(moved.profile, undefined);
  assert.ok(moved.warnings.some((w) => /profile gone isn't in the crew/.test(w)));
  assert.equal(moved.nothing, true);
  assert.deepEqual(moved.envChanged, [], 'a recording from before env hashes says nothing about them');
  const same = restorePlan({ procs: [was('api', 'stopped')], profile: null, git: { branch: 'main', commit: A } }, { procs: [now('api', false)], profile: null, git: { branch: 'main', commit: A } });
  assert.equal(same.nothing, true);
  assert.equal(same.git.same, true);
  assert.deepEqual(same.warnings, []);
  assert.deepEqual(planLines(same), []);
  const noGit = restorePlan({ procs: [was('api', 'crashed', { restartAt: 3, gaveUp: true })], profile: null, git: null }, { procs: [now('api', false)], profile: 'mock', profiles: ['mock'], git: null });
  assert.equal(noGit.git, null);
  assert.equal(noGit.profile, null, 'leave the profile');
  assert.deepEqual(noGit.start, [], "one that had given up wasn't running");
  assert.equal(planLines(noGit)[0], 'Leave the profile');
});

test('r in /replay asks, then starts what ran at that moment', async () => {
  const dir = project({ procs: { api: 'node api.js' } }, { 'api.js': `setInterval(() => console.log('up'), 300);` });
  const app = start({ dir });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /api\s+running/.test(frame()), 'api running');
    await new Promise((r) => setTimeout(r, 1200));
    app.stdin.write('s');
    await until(() => /api\s+stopped/.test(frame()), 'api stopped');
    app.stdin.write('/');
    await type(app.stdin, 'replay');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('this one, so far'), 'the sessions');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('as it was then'), 'the replay');
    app.stdin.write('\x1b[C');
    await until(() => /● api\s+running/.test(frame()), 'a moment when it ran');
    app.stdin.write('r');
    await until(() => frame().includes('Restore the crew as it was at') && frame().includes('Start api'), 'the question');
    app.stdin.write(KEYS.enter);
    await until(() => !frame().includes('as it was then') && /api\s+(starting|running)/.test(frame()), 'api started again');
  } finally {
    app.unmount();
    rmSync(dir, { recursive: true, force: true });
  }
});
