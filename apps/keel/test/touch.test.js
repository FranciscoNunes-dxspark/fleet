import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PULL_READY, pullDistance } from '../client/src/touch.js';

test('a pull follows the finger, then resists, and refreshes once it has come far enough', () => {
  assert.equal(pullDistance(-20), 0);
  assert.equal(pullDistance(0), 0);
  assert.ok(pullDistance(30) < PULL_READY, 'a short pull lets go without refreshing');
  assert.ok(pullDistance(64) >= PULL_READY, 'a deliberate pull refreshes');
  assert.ok(pullDistance(100) - pullDistance(80) < pullDistance(40) - pullDistance(20), 'further down it resists');
  assert.equal(pullDistance(1000), 96, 'and stops');
});
