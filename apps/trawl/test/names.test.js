// Trawl's names in what the kit (@fleet/kit) does for it, from src/app.js: the version a build bakes in,
// the credential store's entries (saved passwords must keep working), the release files and tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, COMPILED, VERSION } from '../src/app.js';
import { target } from '@fleet/kit/credentials.js';
import { assetName, buildTargets, tagOf } from '@fleet/kit/update.js';

test("Trawl's names: version variable, credential entries, release files and tags", () => {
  assert.equal(APP.name, 'trawl');
  assert.equal(APP.title, 'Trawl');
  assert.equal(APP.versionVariable, 'TRAWL_VERSION');
  // The build defines this exact expression, so it must be written out in src/app.js.
  assert.match(readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'), /version: process\.env\.TRAWL_VERSION,/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.env.TRAWL_VERSION == null) assert.deepEqual([VERSION, COMPILED], [pkg.version, false]);
  assert.equal(target('club-a'), 'Trawl:club-a');
  assert.equal(assetName('win32', 'x64'), 'trawl-windows-x64.exe');
  assert.equal(assetName('linux', 'arm64'), 'trawl-linux-arm64');
  assert.equal(assetName('darwin', 'x64'), 'trawl-macos-x64');
  assert.deepEqual(Object.values(buildTargets()), ['trawl-windows-x64.exe', 'trawl-linux-x64', 'trawl-linux-arm64', 'trawl-macos-x64', 'trawl-macos-arm64']);
  assert.equal(tagOf('1.2.3'), 'trawl-v1.2.3');
});
