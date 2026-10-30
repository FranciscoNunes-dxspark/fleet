import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocal } from '../src/local.js';
import { demoLocal } from '../src/demo.js';
import { tempDir } from './helpers.js';

test('a real folder: a listing with folders first, sizes, and the work on files', async () => {
  const { dir, done } = tempDir();
  const local = createLocal({ dir });
  try {
    mkdirSync(join(dir, 'zdir'));
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const entries = await local.list(dir);
    assert.deepEqual(entries.map((e) => [e.name, e.kind]), [['zdir', 'dir'], ['a.txt', 'file']]);
    assert.equal(entries[1].size, 5);
    assert.equal(typeof entries[1].modified, 'number');
    await local.mkdir(local.join(dir, 'new'));
    await local.rename(local.join(dir, 'a.txt'), local.join(dir, 'new', 'a.txt'));
    assert.equal(await local.exists(local.join(dir, 'new', 'a.txt')), true);
    assert.equal(await local.exists(local.join(dir, 'a.txt')), false);
    await local.remove(local.join(dir, 'new'));
    assert.equal(await local.exists(local.join(dir, 'new')), false);
    assert.equal(local.parent(local.join(dir, 'zdir')), dir);
    assert.equal(local.resolve(dir, 'zdir'), join(dir, 'zdir'));
    await assert.rejects(local.list(join(dir, 'nope')));
  } finally {
    done();
  }
});

test('the demo machine has the same shape', async () => {
  const local = demoLocal();
  assert.equal(await local.home(), '/demo');
  assert.deepEqual((await local.list('/demo')).map((e) => e.name), ['Documents', 'Downloads', 'site', 'todo.txt']);
  await local.mkdir('/demo/new');
  await local.rename('/demo/todo.txt', '/demo/new/todo.txt');
  assert.equal(await local.size('/demo/new/todo.txt'), 120);
  assert.equal(local.resolve('/demo/site', '../Documents'), '/demo/Documents');
  assert.equal(local.resolve('/demo/site', '~/x'), '/demo/x');
  await local.remove('/demo/new');
  assert.equal(await local.exists('/demo/new/todo.txt'), false);
});
