// Pilot's names in what the kit (@fleet/kit) does for it, from src/app.js: the version a build bakes in,
// the release files and tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP, COMPILED, VERSION } from '../src/app.js';
import { assetName, buildTargets, tagOf } from '@fleet/kit/update.js';

test("Pilot's names: version variable, release files and tags", () => {
  assert.equal(APP.name, 'pilot');
  assert.equal(APP.title, 'Pilot');
  assert.equal(APP.versionVariable, 'PILOT_VERSION');
  // The build defines this exact expression, so it must be written out in src/app.js.
  assert.match(readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'), /version: process\.env\.PILOT_VERSION,/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.env.PILOT_VERSION == null) assert.deepEqual([VERSION, COMPILED], [pkg.version, false]);
  assert.equal(assetName('win32', 'x64'), 'pilot-windows-x64.exe');
  assert.equal(assetName('linux', 'arm64'), 'pilot-linux-arm64');
  assert.deepEqual(Object.values(buildTargets()), ['pilot-windows-x64.exe', 'pilot-linux-x64', 'pilot-linux-arm64', 'pilot-macos-x64', 'pilot-macos-arm64']);
  assert.equal(tagOf('1.2.3'), 'pilot-v1.2.3');
});
