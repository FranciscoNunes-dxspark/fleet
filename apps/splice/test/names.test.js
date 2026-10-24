// Splice's names in what the kit (@fleet/kit) does for it, from src/app.js: the version a build bakes in,
// the credential store's entries (saved passwords must keep working), the release files and tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, COMPILED, VERSION } from '../src/app.js';
import { target } from '@fleet/kit/credentials.js';
import { assetName, buildTargets, tagOf } from '@fleet/kit/update.js';

test("Splice's names: version variable, credential entries, release files and tags", () => {
  assert.equal(APP.name, 'splice');
  assert.equal(APP.title, 'Splice');
  assert.equal(APP.versionVariable, 'SPLICE_VERSION');
  // The build defines this exact expression, so it must be written out in src/app.js.
  assert.match(readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'), /version: process\.env\.SPLICE_VERSION,/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.env.SPLICE_VERSION == null) assert.deepEqual([VERSION, COMPILED], [pkg.version, false]);
  assert.equal(target('club-a'), 'Splice:club-a');
  assert.equal(assetName('win32', 'x64'), 'splice-windows-x64.exe');
  assert.equal(assetName('linux', 'arm64'), 'splice-linux-arm64');
  assert.equal(assetName('darwin', 'x64'), 'splice-macos-x64');
  assert.deepEqual(Object.values(buildTargets()), ['splice-windows-x64.exe', 'splice-linux-x64', 'splice-linux-arm64', 'splice-macos-x64', 'splice-macos-arm64']);
  assert.equal(tagOf('1.2.3'), 'splice-v1.2.3');
});
