// /move: another folder, picked from the ones beside this one or named, its first .http file opened.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('/move picks a folder beside this one and opens its first .http file; /open then looks there', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hail-move-'));
  for (const name of ['shop', 'orders', 'notes']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'shop', 'shop.http'), '### Shop ping\nGET http://127.0.0.1:1/shop\n');
  writeFileSync(join(root, 'orders', 'a.http'), '### Orders list\nGET http://127.0.0.1:1/orders\n');
  writeFileSync(join(root, 'orders', 'b.http'), '### Orders other\nGET http://127.0.0.1:1/other\n');
  const app = start({ initialFile: join(root, 'shop', 'shop.http'), cwd: join(root, 'shop') });
  const has = (t) => app.lastFrame().includes(t);
  await until(() => has('Shop ping'), 'the first file');
  await type(app.stdin, '/move');
  app.stdin.write(KEYS.enter);
  await until(() => has('Move to') && has('orders') && has('(no .http files)'), 'the picker');
  // notes first (by name, no .http files), then orders.
  app.stdin.write('j');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(KEYS.enter);
  await until(() => has('Orders list') && has('2 .http files in orders'), "orders' first file");
  await type(app.stdin, '/open b.http');
  app.stdin.write(KEYS.enter);
  await until(() => has('Orders other'), '/open from the new folder');
  await type(app.stdin, '/move notes');
  app.stdin.write(KEYS.enter);
  await until(() => has('which has no .http files'), 'a folder without any');
  await type(app.stdin, '/move nowhere');
  app.stdin.write(KEYS.enter);
  await until(() => has("There's no folder nowhere"), 'a folder that isn\'t there');
  await until(() => (loadConfig().folders ?? [])[0]?.endsWith('notes'), 'remembered');
  assert.ok(loadConfig().folders.some((f) => f.endsWith('orders')));
  app.unmount();
});
