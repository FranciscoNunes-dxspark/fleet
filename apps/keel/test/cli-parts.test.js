// The terminal app's pure parts (cli/), and the Azure CLI sign-in it can use (server/azdo/azcli.js).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseDays } from '../cli/actions.js';
import { findCommand, suggestionsFor } from '../cli/commands.js';
import { prMatches, prRows, prState, runState } from '../cli/format.js';
import { moodFor, moodLine, needsYou, pinchRows } from '../cli/pinch.js';
import { wrapSegments } from '../cli/ui/parts.jsx';
import { stringWidth } from '../cli/text.js';
import { azureDevOpsToken, expiryOf } from '../server/azdo/azcli.js';
import { createClient } from '../server/azdo/client.js';
import { pinchPixels } from '../client/src/pinch.js';

const pr = (id, extra = {}) => ({
  id, key: `p/r/${id}`, title: `PR ${id}`, repoName: 'web', projectName: 'Shop', sourceBranch: 'refs/heads/feature/x', targetBranch: 'refs/heads/main',
  author: { displayName: 'Ana' }, ageHours: 1, needsMyReview: false, isMine: false, reviewState: 'in-review', hasConflicts: false, reviewers: [], ...extra,
});

test('Pinch: every mood is the same 16 × 10 drawing, five terminal rows of 16 cells', () => {
  for (const mood of ['idle', 'look', 'sleep', 'happy', 'worried']) {
    const px = pinchPixels(mood);
    assert.equal(px.length, 10, mood);
    assert.ok(px.every((row) => row.length === 16), mood);
    const rows = pinchRows(mood);
    assert.equal(rows.length, 5);
    assert.ok(rows.every((segs) => segs.length === 16));
  }
  assert.notDeepEqual(pinchPixels('sleep'), pinchPixels('idle'));
});

test('Pinch: worried after an error, glancing while busy, asleep when nothing needs you', () => {
  const now = 100_000;
  const attention = { items: [{}], summary: { high: 1 } };
  assert.equal(moodFor({ attention, lastEntry: { status: 'error', at: now - 1000 }, now }), 'worried');
  assert.equal(moodFor({ attention, lastEntry: { status: 'error', at: now - 60_000 }, now }), 'idle');
  assert.equal(moodFor({ attention, pollError: 'offline', now }), 'worried');
  assert.equal(moodFor({ attention, busy: {}, now }), 'look');
  assert.equal(moodFor({ attention, lastEntry: { status: 'ok', at: now - 1000 }, now }), 'happy');
  assert.equal(moodFor({ attention: { items: [], summary: {} }, now }), 'sleep');
  assert.equal(moodFor({ attention: null, now }), 'idle');
});

test("Pinch's line says what needs you, in whole words", () => {
  assert.equal(needsYou({ myReviews: 1, failingPipelines: 2 }), '1 review waiting on you, 2 failing pipelines');
  assert.equal(moodLine('idle', { attention: { items: [{}], summary: { high: 1, approvals: 1 } } }), '1 thing needs you now: 1 approval.');
  assert.equal(moodLine('idle', { attention: { items: [{}, {}], summary: { high: 0 } } }), 'Nothing urgent. 2 things to look at when you can.');
  assert.equal(moodLine('sleep', { attention: { items: [], summary: {} } }), 'Nothing needs you, so Pinch is having a nap.');
  assert.match(moodLine('worried', { pollError: 'Not signed in to Azure. Run: az login' }), /az login/);
});

test('pull requests: waiting on your review, then yours, then the rest, oldest first, under headers', () => {
  const prs = [pr(1, { ageHours: 5 }), pr(2, { isMine: true }), pr(3, { needsMyReview: true, ageHours: 2 }), pr(4, { needsMyReview: true, ageHours: 9 }), pr(5, { ageHours: 50 })];
  const rows = prRows(prs);
  assert.deepEqual(rows.map((r) => (r.header ? r.title : r.pr.id)), ['Waiting on your review (2)', 4, 3, 'Yours (1)', 2, 'Everyone else (2)', 5, 1]);
  assert.deepEqual(prRows(prs, { show: 'mine' }).map((r) => (r.header ? r.title : r.pr.id)), ['Yours (1)', 2]);
  // A pull request waiting on your review that is also yours shows once, in the first group.
  assert.equal(prRows([pr(6, { isMine: true, needsMyReview: true })]).filter((r) => r.pr).length, 1);
});

test('pull requests: the filter matches title, repo, branch, author or !id', () => {
  const p = pr(817, { title: 'Implement refund endpoint' });
  for (const q of ['refund', 'WEB', 'feature/x', 'ana', '!817', '817']) assert.ok(prMatches(p, q), q);
  assert.ok(!prMatches(p, 'nope'));
});

test('states: conflicts come before the review state; a declined run is not a failure', () => {
  assert.equal(prState(pr(1, { reviewState: 'approved', hasConflicts: true })).label, 'merge conflicts');
  assert.equal(prState(pr(1, { reviewState: 'waiting-author' })).label, 'waiting on the author');
  assert.equal(runState({ status: 'completed', result: 'declined' }).label, 'declined');
  assert.equal(runState({ status: 'inProgress', result: null }).label, 'running');
  assert.equal(runState({ status: 'notStarted', result: null }).label, 'queued');
});

test('/snooze takes days or weeks', () => {
  assert.equal(parseDays(''), 1);
  assert.equal(parseDays('3'), 3);
  assert.equal(parseDays('2d'), 2);
  assert.equal(parseDays('1w'), 7);
  assert.equal(parseDays('2 weeks'), 14);
  assert.equal(parseDays('soon'), null);
});

test('slash commands: prefixes, and pull request numbers offered after /pr', () => {
  assert.equal(findCommand('appr').name, 'approve');
  assert.equal(findCommand('c'), null); // complete, comment, cancel
  assert.deepEqual(suggestionsFor('/ap', {}).map((s) => s.label), ['/approve']);
  const offered = suggestionsFor('/pr 81', { prs: [pr(817, { title: 'Refund' }), pr(902)] });
  assert.deepEqual(offered.map((s) => [s.label, s.desc, s.insert]), [['817', 'Refund', '/pr 817']]);
});

test('detail lines wrap under their text, keeping the space after a label', () => {
  const lines = wrapSegments([{ text: '✗ failing' }, { text: '  64% green · failing 2 in a row · last green 2d ago' }], 30);
  assert.ok(lines.length > 1);
  assert.equal(lines[0].map((s) => s.text).join('').slice(0, 11), '✗ failing  ');
  for (const l of lines) assert.ok(stringWidth(l.map((s) => s.text).join('')) <= 30);
  assert.ok(lines[1][0].text.startsWith('           '));
  assert.deepEqual(wrapSegments([{ text: 'short' }], 30), [[{ text: 'short' }]]);
});

test('az sign-in: one az call for many requests, a new one near expiry', async () => {
  let calls = 0;
  let expires = Math.floor(Date.now() / 1000) + 3600;
  const run = async () => {
    calls++;
    return JSON.stringify({ accessToken: `t${calls}`, expires_on: expires });
  };
  const token = azureDevOpsToken({ run });
  assert.deepEqual(await Promise.all([token(), token(), token()]), ['t1', 't1', 't1']);
  assert.equal(calls, 1);
  const soon = azureDevOpsToken({ run });
  expires = Math.floor(Date.now() / 1000) + 60; // inside the five minutes kept in hand
  assert.equal(await soon(), 't2');
  assert.equal(await soon(), 't3');
  assert.equal(expiryOf({ expiresOn: '2026-10-19 23:00:00.000000' }), Date.parse('2026-10-19 23:00:00.000000'));
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the Azure DevOps client sends a Bearer token when given one, and a PAT otherwise', async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers.Authorization);
    return new Response('{"value":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await createClient({ orgUrl: 'https://dev.azure.com/acme', token: async () => 'entra' }).api('_apis/projects');
  await createClient({ orgUrl: 'https://dev.azure.com/acme', pat: 'pat' }).api('_apis/projects');
  assert.equal(seen[0], 'Bearer entra');
  assert.equal(seen[1], `Basic ${Buffer.from(':pat').toString('base64')}`);
});
