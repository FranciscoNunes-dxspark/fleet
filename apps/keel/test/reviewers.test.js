import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFolders, suggestReviewers } from '../server/domain/reviewers.js';

const D = 86_400_000;
const NOW = Date.parse('2026-10-17T12:00:00Z');
const person = (id, email) => ({ id, displayName: id.toUpperCase(), uniqueName: email, isContainer: false });
const commit = (email, daysAgo, message = 'Work') => ({ message, author: { name: '?', email, date: new Date(NOW - daysAgo * D).toISOString() } });

test('reviewers: folders a change touches, busiest first', () => {
  assert.deepEqual(changedFolders(['/src/api/a.cs', '/src/api/b.cs', '/src/web/c.tsx', '/README.md']), [{ dir: '/src/api', files: 2 }, { dir: '/src/web', files: 1 }]);
  assert.deepEqual(changedFolders(['/README.md', '/LICENSE']), [{ dir: '/', files: 2 }], 'the root only when nothing else changed');
  assert.equal(changedFolders(Array.from({ length: 20 }, (_, i) => `/d${i}/x`), 8).length, 8);
});

test('reviewers: recent work in the same folders, weighed by reviews owed', () => {
  const people = [person('ana', 'ana@x'), person('ben', 'ben@x'), person('cy', 'cy@x'), person('me', 'me@x')];
  const histories = [
    { dir: '/src/api', files: 3, commits: [commit('ana@x', 2), commit('ana@x', 5), commit('ben@x', 3), commit('me@x', 1), commit('ben@x', 1, 'Merged PR 7: x')] },
    { dir: '/src/web', files: 1, commits: [commit('cy@x', 100), commit('stranger@x', 1)] },
  ];
  const load = [{ person: people[0], reviewsPending: 6, overloaded: true }, { person: people[1], reviewsPending: 0 }];
  const s = suggestReviewers({ histories, people, load, exclude: ['me'], now: NOW });
  assert.deepEqual(s.map((x) => x.person.id), ['ben', 'ana', 'cy']);
  const ana = s.find((x) => x.person.id === 'ana');
  assert.deepEqual([ana.commits, ana.reviewsOwed, ana.overloaded, ana.folders], [2, 6, true, ['/src/api']]);
  assert.equal(s.find((x) => x.person.id === 'ben').commits, 1, 'merge commits are not the work');
  assert.equal(suggestReviewers({ histories, people, exclude: ['me'], now: NOW })[0].person.id, 'ana', 'without load, the most work wins');
});

test('reviewers: "me" is whoever is signed in, when adding a reviewer or creating a pull request', async () => {
  const { createService } = await import('../server/service.js');
  const { DEFAULT_SETTINGS } = await import('../server/settings.js');
  let current = { ...structuredClone(DEFAULT_SETTINGS), projects: { p1: { name: 'Shop', tracked: true, repos: 'all', teams: [] } } };
  const settings = { load: async () => current, save: async (patch) => (current = { ...current, ...patch }) };
  const added = [];
  let created;
  const provider = {
    me: async () => ({ id: 'u-me', displayName: 'Me' }),
    listProjects: async () => [{ id: 'p1', name: 'Shop' }],
    listRepos: async () => [{ id: 'r1', name: 'web', projectId: 'p1', projectName: 'Shop', defaultBranch: 'main' }],
    addReviewer: async (projectId, repoId, prId, reviewerId) => added.push(reviewerId),
    createPullRequest: async (projectId, repoId, pr) => {
      created = pr;
      return { projectId, repoId, id: 1, title: pr.title };
    },
  };
  const service = createService({ provider, settings });
  await service.prAction('p1', 'r1', 1, { type: 'addReviewer', reviewerId: 'me' });
  await service.prAction('p1', 'r1', 1, { type: 'addReviewer', reviewerId: 'u-ana' });
  assert.deepEqual(added, ['u-me', 'u-ana']);
  await service.createPullRequest({ projectId: 'p1', repoId: 'r1', source: 'feature/x', target: 'main', title: 'X', reviewers: [{ id: 'me' }, { id: 'u-ana', isRequired: true }] });
  assert.deepEqual(created.reviewers, [{ id: 'u-me', isRequired: false }, { id: 'u-ana', isRequired: true }]);
});
