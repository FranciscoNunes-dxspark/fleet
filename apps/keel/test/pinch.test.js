// Pinch, the terminal app's crab (client/src/pinch.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchPixels } from '../client/src/pinch.js';

test('an unknown mood draws the idle crab', () => {
  assert.deepEqual(pinchPixels('grumpy'), pinchPixels('idle'));
});
