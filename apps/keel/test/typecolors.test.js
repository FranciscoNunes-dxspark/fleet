import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTypeColors, createTypeColorStore } from '../server/typecolors.js';
import { autoTypeColor, closestPaletteKey, typeColorKey } from '../client/src/typecolors.js';

test('Azure DevOps default colors map to their palette hue', () => {
  const ado = { Epic: 'FF7B00', Feature: '773B93', 'User Story': '009CCC', Bug: 'CC293D', Task: 'F2CB1D', Issue: 'B4009E', 'Change Request': '339947', Risk: '5C5C5C' };
  assert.deepEqual(Object.fromEntries(Object.entries(ado).map(([k, v]) => [k, closestPaletteKey(v)])), {
    Epic: 'orange', Feature: 'violet', 'User Story': 'blue', Bug: 'red', Task: 'yellow', Issue: 'magenta', 'Change Request': 'green', Risk: 'gray',
  });
});

test('types without a color fall back by name, then blue', () => {
  assert.equal(autoTypeColor('Bug', null), 'red');
  assert.equal(autoTypeColor('Incident', 'not-a-color'), 'blue');
});

test("an Admin's choice wins over automatic, unknown keys don't", () => {
  assert.equal(typeColorKey('Bug', 'CC293D', { Bug: 'green' }), 'green');
  assert.equal(typeColorKey('Bug', 'CC293D', { Bug: '#ff0000' }), 'red');
});

test('only palette keys are saved; empty means automatic', () => {
  assert.deepEqual(cleanTypeColors({ Bug: 'red', Task: '' }), { Bug: 'red' });
  assert.throws(() => cleanTypeColors({ Bug: 'url(x)' }), /approved palette/);
  assert.throws(() => cleanTypeColors(['red']), /type name/);
});

test('choices are shared through the data folder', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-tc-')), 'type-colors.json');
  createTypeColorStore(file).set({ Bug: 'magenta' });
  assert.deepEqual(createTypeColorStore(file).get(), { Bug: 'magenta' });
});
