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

test('a panel swiped far enough right, or flicked, closes; a scroll or a nudge does not', async () => {
  const { swipeCloses } = await import('../client/src/touch.js');
  assert.equal(swipeCloses(150, 10, 400, 412), true, 'over 30% of its width');
  assert.equal(swipeCloses(60, 5, 400, 412), false, 'a nudge springs back');
  assert.equal(swipeCloses(60, 5, 60, 412), true, 'a quick flick closes it');
  assert.equal(swipeCloses(150, 200, 400, 412), false, 'mostly down is a scroll');
  assert.equal(swipeCloses(-150, 0, 100, 412), false, 'leftwards never closes');
});
