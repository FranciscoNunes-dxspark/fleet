// The data viewer's pure side (datatree.js): reading text as data, the tree, the path query, pretty-printing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, parseData, prettyLines, prettyText, query, tableOf } from '../datatree.js';

test('parseData reads JSON, JSON lines, CSV and TSV, and says what it could not read', () => {
  assert.deepEqual(parseData('{"a":[1,2]}'), { kind: 'json', value: { a: [1, 2] } });
  assert.deepEqual(parseData('{"a":1}\n{"a":2}\n'), { kind: 'jsonl', value: [{ a: 1 }, { a: 2 }] });
  assert.deepEqual(parseData('id,name\n1,"Smith, J"\n2,"say ""hi"""\n'), { kind: 'csv', value: [{ id: '1', name: 'Smith, J' }, { id: '2', name: 'say "hi"' }] });
  assert.deepEqual(parseData('a\tb\n1\t2'), { kind: 'tsv', value: [{ a: '1', b: '2' }] });
  assert.match(parseData('{"a":').error, /Not valid JSON/);
  assert.match(parseData('just words').error, /Not JSON/);
  assert.match(parseData('  ').error, /nothing/);
});

test('tableOf takes an array of objects, with the union of their keys', () => {
  const t = tableOf([{ a: 1 }, { b: 2, a: 3 }]);
  assert.deepEqual(t, { columns: ['a', 'b'], rows: [[1, undefined], [3, 2]] });
  assert.equal(tableOf([1, 2]), null);
  assert.equal(tableOf({ a: 1 }), null);
});

test('flatten lists the rows of a tree, children only under what is open', () => {
  const v = { name: 'x', items: [{ id: 1 }, { id: 2 }], odd: { 'a b': true } };
  assert.deepEqual(flatten(v, new Set()).map((r) => r.path), ['']);
  const rows = flatten(v, new Set(['', '.items', '.items[0]', '.odd']));
  assert.deepEqual(rows.map((r) => r.path), ['', '.name', '.items', '.items[0]', '.items[0].id', '.items[1]', '.odd', '.odd."a b"']);
  assert.equal(rows[3].depth, 2);
  assert.equal(rows[2].open, true);
  const big = flatten(Array.from({ length: 600 }, (_, i) => i), new Set(['']));
  assert.equal(big.length, 502);
  assert.equal(big.at(-1).more, 100);
});

test('query follows .a.b[0], .items[], and says what is wrong', () => {
  const v = { a: { b: [10, 20, 30] }, items: [{ name: 'x' }, { name: 'y' }], n: 5 };
  assert.deepEqual(query(v, '.a.b[0]').values, [10]);
  assert.deepEqual(query(v, '.a.b[-1]').values, [30]);
  assert.deepEqual(query(v, '.items[].name').values, ['x', 'y']);
  assert.deepEqual(query(v, '.items[]').values, v.items);
  assert.deepEqual(query(v, 'a.b').values, [[10, 20, 30]]);
  assert.deepEqual(query(v, '.').values, [v]);
  assert.deepEqual(query(v, '.nope.deeper').values, [null]);
  assert.deepEqual(query(v, '.items | length').values, [2]);
  assert.deepEqual(query(v, '. | keys').values, [['a', 'items', 'n']]);
  assert.match(query(v, '.n.x').error, /Can't take "x" from a number/);
  assert.match(query(v, '.n[]').error, /items of a number/);
  assert.match(query(v, '.items[x]').error, /isn't an index/);
  assert.match(query(v, '.a[').error, /missing its \]/);
  assert.match(query(v, '.a | sort').error, /isn't known/);
});

test('prettyLines gives the tokens of indented JSON, as prettyText does', () => {
  const v = { a: [1, 'x', null], b: {}, c: true };
  const lines = prettyLines(v);
  assert.equal(lines.map((l) => l.map((t) => t.text).join('')).join('\n'), prettyText(v));
  assert.deepEqual(lines[1].filter((t) => t.kind !== 'punct').map((t) => t.kind), ['key']);
  assert.deepEqual(lines[2].map((t) => t.kind), ['punct', 'number', 'punct']);
  assert.equal(prettyLines(Array.from({ length: 10 }, (_, i) => i), { max: 3 }).at(-1)[0].text, '… 9 more lines');
});
