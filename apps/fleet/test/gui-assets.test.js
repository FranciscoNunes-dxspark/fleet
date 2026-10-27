// The compiled build serves the window from src/gui/assets.js, which scripts/gui-assets.js writes from
// apps/fleet/gui and the apps' logos: it must say what they say now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetsModule } from '../scripts/gui-assets.js';
import { CLIENT_FILES, LOGOS, loadClient } from '../src/gui/server.js';

test('src/gui/assets.js is up to date (node scripts/gui-assets.js writes it)', async () => {
  const files = await loadClient({ fromDisk: true });
  for (const name of CLIENT_FILES) assert.ok(files[name], name);
  for (const id of Object.keys(LOGOS)) assert.ok(files[`logo/${id}.svg`], id);
  const written = readFileSync(new URL('../src/gui/assets.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(written === assetsModule(files), 'src/gui/assets.js is out of date: run node scripts/gui-assets.js in apps/fleet');
  // What the compiled build loads is the same.
  assert.deepEqual(await loadClient({ fromDisk: false }), files);
});
