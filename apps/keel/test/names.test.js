// Keel's names in what the kit (@fleet/kit) does for it, from cli/app.js: the version a build bakes in,
// the credential store's entries (saved passwords must keep working), the release files and tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, COMPILED, VERSION } from '../cli/app.js';
import { target } from '@fleet/kit/credentials.js';
import { assetName, buildTargets, tagOf } from '@fleet/kit/update.js';

test("Keel's names: version variable, credential entries, release files and tags", () => {
  assert.equal(APP.name, 'keel');
  assert.equal(APP.title, 'Keel');
  assert.equal(APP.versionVariable, 'KEEL_VERSION');
  // The build defines this exact expression, so it must be written out in cli/app.js.
  assert.match(readFileSync(new URL('../cli/app.js', import.meta.url), 'utf8'), /version: process\.env\.KEEL_VERSION,/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.env.KEEL_VERSION == null) assert.deepEqual([VERSION, COMPILED], [pkg.version, false]);
  assert.equal(target('club-a'), 'Keel:club-a');
  assert.equal(assetName('win32', 'x64'), 'keel-windows-x64.exe');
  assert.equal(assetName('linux', 'arm64'), 'keel-linux-arm64');
  assert.equal(assetName('darwin', 'x64'), 'keel-macos-x64');
  assert.deepEqual(Object.values(buildTargets()), ['keel-windows-x64.exe', 'keel-linux-x64', 'keel-linux-arm64', 'keel-macos-x64', 'keel-macos-arm64']);
  assert.equal(tagOf('1.2.3'), 'keel-v1.2.3');
});
