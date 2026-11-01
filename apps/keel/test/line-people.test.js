import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peopleLine, samePerson } from '../client/src/line/people.js';

const ana = { id: 'a', displayName: 'Ana', uniqueName: 'ana@x' };
const bo = { id: 'b', displayName: 'Bo', uniqueName: 'bo@x' };
const stages = [
  { id: 'planned', cards: [{ key: 'w1', kind: 'workitem', person: ana, stuck: 'bad' }, { key: 'w2', kind: 'workitem', person: null }] },
  { id: 'building', cards: [{ key: 'w3', kind: 'workitem', person: { ...bo, id: 'other-org-id' } }] },
  { id: 'review', cards: [{ key: 'p1', kind: 'pr', person: bo, waitingOn: [ana] }] },
  { id: 'deploying', cards: [{ key: 'x', kind: 'pipeline', person: null, stuck: 'bad' }] },
];

test('each person holds their work items and pull requests, matched across organizations by account name', () => {
  const rows = peopleLine(stages);
  const bob = rows.find((r) => r.person?.displayName === 'Bo');
  assert.equal(bob.total, 2);
  assert.equal(bob.stages.building.cards.length, 1);
  assert.equal(bob.stages.review.cards.length, 1);
});

test('reviews waiting on someone are theirs to owe; pipelines and the like belong to nobody', () => {
  const rows = peopleLine(stages);
  assert.deepEqual(rows.find((r) => r.person?.displayName === 'Ana').reviews.map((c) => c.key), ['p1']);
  assert.ok(!rows.some((r) => r.stages.deploying.cards.length));
});

test('most stuck first, and the work nobody has comes last', () => {
  const rows = peopleLine(stages);
  assert.equal(rows[0].person.displayName, 'Ana');
  assert.equal(rows.at(-1).person, null);
  assert.ok(samePerson({ uniqueName: 'ANA@x' }, ana));
});
