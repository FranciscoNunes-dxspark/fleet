// `fleet <file>`: the app that opens a file, by its extension.
import './../src/app.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spaceForFile } from '../src/spaces.js';

test('a file goes to the app that opens its kind', () => {
  assert.equal(spaceForFile('C:\\work\\query.sql').id, 'trawl');
  assert.equal(spaceForFile('QUERY.SQL').id, 'trawl');
  assert.equal(spaceForFile('api.http').id, 'hail');
  assert.equal(spaceForFile('notes.txt'), undefined);
  assert.equal(spaceForFile('noextension'), undefined);
});
