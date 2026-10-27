// The data viewer drawn and driven (ui/DataViewer.jsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { DataViewer } from '../ui/DataViewer.jsx';

const wait = (ms = 90) => new Promise((r) => setTimeout(r, ms));
const make = (props) => {
  const copied = [];
  let closed = false;
  const ctx = { overlayHasKeys: () => true, copy: (t, what) => copied.push([t, what]), mouseHandlers: [] };
  const app = render(React.createElement(DataViewer, { title: 'Body', ctx, width: 60, height: 12, active: true, onClose: () => (closed = true), ...props }));
  return { app, copied, closed: () => closed, frame: () => app.lastFrame() };
};
const press = async (app, s) => {
  app.stdin.write(s);
  await wait();
};

test('a JSON tree opens and closes, copies a value and its path, and answers a query', async () => {
  const v = make({ text: JSON.stringify({ name: 'fleet', items: [{ id: 1, tag: 'a' }, { id: 2, tag: 'b' }] }) });
  await wait();
  assert.match(v.frame(), /Body/);
  assert.match(v.frame(), /name: "fleet"/);
  assert.match(v.frame(), /▸ items \[2\]/);
  await press(v.app, 'j');
  await press(v.app, 'j');
  await press(v.app, '\r');
  assert.match(v.frame(), /▾ items/);
  assert.match(v.frame(), /▸ \[0\] \{2\}/);
  await press(v.app, 'j');
  await press(v.app, 'l');
  assert.match(v.frame(), /id: 1/);
  await press(v.app, 'j');
  await press(v.app, 'p');
  assert.deepEqual(v.copied.at(-1), ['.items[0].id', 'the path']);
  await press(v.app, 'y');
  assert.equal(v.copied.at(-1)[0], '1');

  await press(v.app, '/');
  for (const ch of '.items[].tag') await press(v.app, ch);
  await press(v.app, '\r');
  assert.match(v.frame(), /"a"/);
  assert.match(v.frame(), /"b"/);
  assert.match(v.frame(), /2 matches/);
  await press(v.app, 'y');
  assert.equal(v.copied.at(-1)[0], '"a"\n"b"');
  await press(v.app, '\x1b');
  assert.doesNotMatch(v.frame(), /2 matches/);
  assert.equal(v.closed(), false);

  await press(v.app, '/');
  for (const ch of '.name.x') await press(v.app, ch);
  await press(v.app, '\r');
  assert.match(v.frame(), /Can't take "x" from a string/);
  await press(v.app, 'q');
  assert.equal(v.closed(), true);
  v.app.unmount();
});

test('CSV and result rows draw as a table, ↵ opens a row as a tree, and bad text says why', async () => {
  const v = make({ text: 'id,name\n1,Ann\n2,Bob\n' });
  await wait();
  assert.match(v.frame(), /id\s+name/);
  assert.match(v.frame(), /Ann/);
  await press(v.app, 'j');
  await press(v.app, 'l');
  await press(v.app, 'y');
  assert.deepEqual(v.copied.at(-1), ['Bob', "name's value"]);
  await press(v.app, '\r');
  assert.match(v.frame(), /name: "Bob"/);
  await press(v.app, '\x1b');
  assert.match(v.frame(), /id\s+name/);
  assert.equal(v.closed(), false);
  v.app.unmount();

  const r = make({ rows: { columns: ['n', 'when'], rows: [[1, new Date('2026-01-02T00:00:00Z')]] } });
  await wait();
  assert.match(r.frame(), /2026-01-02T00:00:00\.000Z/);
  r.app.unmount();

  const bad = make({ text: '{"a":' });
  await wait();
  assert.match(bad.frame(), /Not valid JSON/);
  bad.app.unmount();
});
