import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, branchFor, buildPrompt, cliLink, desktopLink, folderProblem } from '../client/src/claude.js';

const item = (over = {}) => ({
  id: 4126, type: 'User Story', title: 'Refund endpoint: partial refunds!', projectName: 'Commerce', state: 'Active', priority: 2,
  assignedTo: { displayName: 'Dana Dev' }, tags: ['payments'], parent: { type: 'Feature', id: 4000, title: 'Refunds' },
  webUrl: 'https://dev.azure.com/org/Commerce/_workitems/edit/4126', description: 'Allow partial refunds.', acceptanceCriteria: 'Given an order…',
  children: [{ type: 'Task', id: 4127, state: 'New', title: 'API' }], comments: [{ author: { displayName: 'Lena' }, text: 'Watch the currency rounding.' }],
  pullRequests: [], ...over,
});
const repo = { id: 'r1', name: 'storefront-web', defaultBranch: 'main' };

test('claude prompt carries the item, the repo and how to work', () => {
  const p = buildPrompt(item(), repo);
  assert.match(p, /User Story 4126: Refund endpoint/);
  assert.match(p, /Repository: storefront-web \(default branch main\)/);
  assert.match(p, /Acceptance criteria:\nGiven an order/);
  assert.match(p, /Task 4127 \(New\): API/);
  assert.match(p, /Lena: Watch the currency rounding/);
  assert.match(p, /new branch feature\/4126-refund-endpoint-partial-refunds from main/);
  assert.match(p, /AB#4126/);
  assert.equal(branchFor(item({ type: 'Bug', title: '!!!' })), 'bugfix/4126-work');
});

test('claude prompt shrinks long fields to fit each link limit', () => {
  const long = item({ description: 'x'.repeat(20000), acceptanceCriteria: 'y'.repeat(9000), comments: [{ author: null, text: 'z'.repeat(5000) }] });
  const cli = buildPrompt(long, repo, LIMITS.cli);
  const desktop = buildPrompt(long, repo, LIMITS.desktop);
  assert.ok(cli.length <= LIMITS.cli && desktop.length <= LIMITS.desktop);
  assert.ok(desktop.length > cli.length);
  assert.match(cli, /truncated, see the work item/);
  assert.match(cli, /AB#4126/); // the working instructions survive
});

test('claude links: encoded prompt and folder, folder optional', () => {
  assert.equal(cliLink('C:\\src\\shop', 'a b\nc'), 'claude-cli://open?cwd=C%3A%5Csrc%5Cshop&q=a%20b%0Ac');
  assert.equal(desktopLink('', 'hi'), 'claude://code/new?q=hi');
  assert.equal(desktopLink('/home/me/shop', 'hi'), 'claude://code/new?folder=%2Fhome%2Fme%2Fshop&q=hi');
});

test('claude folders must be absolute local paths', () => {
  assert.equal(folderProblem('C:\\src\\shop'), null);
  assert.equal(folderProblem('/home/me/shop'), null);
  assert.equal(folderProblem(''), null);
  assert.ok(folderProblem('src\\shop'));
  assert.ok(folderProblem('\\\\server\\share\\shop'));
  assert.ok(folderProblem('C:\\src\\..\\shop'));
});
