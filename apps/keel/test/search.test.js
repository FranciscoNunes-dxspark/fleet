import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, rank, score } from '../client/src/search.js';

const entries = [
  { key: 'page:/pipelines', kind: 'page', title: 'Pipelines', keywords: ['builds', 'ci'], boost: 1 },
  { key: 'pr:1', kind: 'pr', title: 'Add refund endpoint', ids: [815], sub: '!815 · checkout-api · Ana' },
  { key: 'wi:1', kind: 'workitem', title: 'Refund flow for partial shipments', ids: [4107], sub: 'User Story #4107 · Active' },
  { key: 'wi:2', kind: 'workitem', title: 'UI polish — Refund flow', ids: [4113], sub: 'Task #4113' },
  { key: 'pipe:1', kind: 'pipeline', title: 'checkout-api-CI', sub: 'Commerce · checkout-api' },
];

test('search: what was typed', () => {
  assert.deepEqual(parseQuery('  #4107 '), { text: '#4107', words: ['4107'], workItemId: 4107, prId: null });
  assert.deepEqual(parseQuery('!815'), { text: '!815', words: ['815'], workItemId: null, prId: 815 });
  assert.equal(parseQuery('AB#12').workItemId, 12);
  assert.deepEqual(parseQuery('Refund Flow').words, ['refund', 'flow']);
  assert.equal(parseQuery('Implantação').text, 'implantacao', 'accents are ignored');
});

test('search: every word must match; titles and word starts count most', () => {
  assert.deepEqual(rank(entries, 'refund').map((e) => e.key), ['wi:1', 'pr:1', 'wi:2']);
  assert.deepEqual(rank(entries, 'refund flow').map((e) => e.key), ['wi:1', 'wi:2']);
  assert.deepEqual(rank(entries, 'builds').map((e) => e.key), ['page:/pipelines'], 'keywords match too');
  assert.deepEqual(rank(entries, 'checkout').map((e) => e.key), ['pipe:1', 'pr:1']);
  assert.equal(score(entries[1], parseQuery('refund zebra')), null);
  assert.deepEqual(rank(entries, '').map((e) => e.key), entries.map((e) => e.key), 'nothing typed keeps the list order');
});

test('search: numbers find work items and pull requests by id', () => {
  assert.equal(rank(entries, '#4107')[0].key, 'wi:1');
  assert.equal(rank(entries, '!815')[0].key, 'pr:1');
  assert.equal(rank(entries, '815')[0].key, 'pr:1', 'a bare number also finds a PR');
});
