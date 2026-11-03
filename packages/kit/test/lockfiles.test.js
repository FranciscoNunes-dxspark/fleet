// lockfiles.js: where each package is written, found in one pass over the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonKeyLines, lineOf, parseNpmLock, parseNugetLock } from '../lockfiles.js';

test('jsonKeyLines: the first line of each key, of each key opening an object, and without case; never a value', () => {
  const text = '{\n  "a": "has \\"b\\": inside",\n  "b": 1,\n  "c" :\n  {\n    "A": {}\n  },\n  "a": 2\n}';
  const lines = jsonKeyLines(text);
  assert.equal(lines.key('a'), 2);
  assert.equal(lines.key('b'), 3);
  assert.equal(lines.key('c'), 4);
  assert.equal(lines.object('c'), 4);
  assert.equal(lines.object('b'), null);
  assert.equal(lines.key('A'), 6);
  assert.equal(lines.caseless('a'), 2);
  assert.equal(lines.key('missing'), null);
});

test("the parsers' lines are the ones a search of the text finds, for every lock file shape", () => {
  const v3 = JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { left: '^1' } }, 'node_modules/left': { version: '1.0.0' }, 'node_modules/left/node_modules/pad': { version: '2.0.0' } } }, null, 2);
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { left: { version: '1.0.0', dependencies: { pad: { version: '2.0.0' } } } } }, null, 2);
  const nuget = JSON.stringify({ version: 1, dependencies: { 'net8.0': { 'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' }, 'serilog': { type: 'Transitive', resolved: '3.1.1' } } } }, null, 2);
  for (const [p, re] of parseNpmLock(v3).map((p) => [p, new RegExp(`"node_modules/${p.name === 'pad' ? 'left/node_modules/' : ''}${p.name}"\\s*:`)])) assert.equal(p.line, lineOf(v3, re));
  for (const p of parseNpmLock(v1)) assert.equal(p.line, lineOf(v1, new RegExp(`"${p.name}"\\s*:\\s*\\{`)));
  for (const p of parseNugetLock(nuget)) assert.equal(p.line, lineOf(nuget, new RegExp(`"${p.name}"\\s*:`, 'i')));
});

test('a lock file of thousands of packages is read in well under a second', () => {
  const packages = { '': {} };
  for (let i = 0; i < 4000; i++) packages[`node_modules/pkg-${i}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.0.tgz` };
  const text = JSON.stringify({ lockfileVersion: 3, packages }, null, 2);
  const start = performance.now();
  const list = parseNpmLock(text);
  assert.equal(list.length, 4000);
  assert.equal(list[3999].line, text.split('\n').findIndex((l) => l.includes('"node_modules/pkg-3999"')) + 1);
  assert.ok(performance.now() - start < 1000, `took ${Math.round(performance.now() - start)} ms`);
});
