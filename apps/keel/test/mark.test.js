// The web app logo's mood (client/src/mark.js logoMood): what the logo in the top bar shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logoMood } from '../client/src/mark.js';

const busy = { items: [{ key: 'a' }], summary: { high: 1 } };

test('worried only while Azure DevOps answers the live checks with an error', () => {
  assert.equal(logoMood({ attention: busy, live: { connected: true, ok: false, error: 'Azure DevOps rejected the token' } }), 'worried');
  // Losing the connection to Keel's own server is the live badge's to show, and so is the start.
  assert.equal(logoMood({ attention: busy, live: { connected: false, ok: false, error: 'old' } }), 'idle');
  assert.equal(logoMood({ attention: busy, live: { connected: true, ok: true } }), 'idle');
});

test('looks during a refresh, sleeps on an empty Inbox, watches otherwise', () => {
  assert.equal(logoMood({ attention: busy, busy: true }), 'look');
  assert.equal(logoMood({ attention: { items: [], summary: { high: 0 } } }), 'sleep');
  assert.equal(logoMood({ attention: null }), 'idle');
  assert.equal(logoMood(), 'idle');
});
