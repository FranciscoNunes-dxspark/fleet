// Pinch's mood in the web app (client/src/pinch.js): what the sidebar logo and the Dashboard show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinchMood, pinchPixels } from '../client/src/pinch.js';

const busy = { items: [{ key: 'a' }], summary: { high: 1 } };

test('worried only while Azure DevOps answers the live checks with an error', () => {
  assert.equal(pinchMood({ attention: busy, live: { connected: true, ok: false, error: 'Azure DevOps rejected the token' } }), 'worried');
  // Losing the connection to Keel's own server is the live badge's to show, and so is the start.
  assert.equal(pinchMood({ attention: busy, live: { connected: false, ok: false, error: 'old' } }), 'idle');
  assert.equal(pinchMood({ attention: busy, live: { connected: true, ok: true } }), 'idle');
});

test('glances during a refresh, naps on an empty Inbox, watches otherwise', () => {
  assert.equal(pinchMood({ attention: busy, busy: true }), 'look');
  assert.equal(pinchMood({ attention: { items: [], summary: { high: 0 } } }), 'sleep');
  assert.equal(pinchMood({ attention: null }), 'idle');
  assert.equal(pinchMood(), 'idle');
});

test('an unknown mood draws the idle crab', () => {
  assert.deepEqual(pinchPixels('grumpy'), pinchPixels('idle'));
});
