// Fleet's names in what the kit (@fleet/kit) does for it, from src/app.js: the version a build bakes in,
// the release files and tags, and how it starts each app from a checkout and from its own build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP, COMPILED, VERSION } from '../src/app.js';
import { assetName, buildTargets, tagOf } from '@fleet/kit/update.js';
import { APPS_DIR, launchCommand, spaceNamed, SPACES } from '../src/spaces.js';

test("Fleet's names: version variable, release files and tags", () => {
  assert.equal(APP.name, 'fleet');
  assert.equal(APP.title, 'Fleet');
  assert.equal(APP.versionVariable, 'FLEET_VERSION');
  // The build defines this exact expression, so it must be written out in src/app.js.
  assert.match(readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'), /version: process\.env\.FLEET_VERSION,/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (process.env.FLEET_VERSION == null) assert.deepEqual([VERSION, COMPILED], [pkg.version, false]);
  assert.equal(assetName('win32', 'x64'), 'fleet-windows-x64.exe');
  assert.equal(assetName('linux', 'x64'), 'fleet-linux-x64');
  assert.deepEqual(Object.values(buildTargets()), ['fleet-windows-x64.exe', 'fleet-linux-x64', 'fleet-linux-arm64', 'fleet-macos-x64', 'fleet-macos-arm64']);
  assert.equal(tagOf('0.1.0'), 'fleet-v0.1.0');
  // The build bakes every app's version in, each from its own package.json.
  assert.deepEqual(pkg.fleet.includes.map((d) => d.replace('../', '')).sort(), SPACES.map((s) => s.id).sort());
});

test('each app starts from its own entry point in a checkout, and as fleet --run in the build', () => {
  const [file, args] = launchCommand('hail', ['--demo'], { execPath: 'node' });
  assert.equal(file, 'node');
  assert.deepEqual(args, [join(APPS_DIR, 'hail/bin/hail.js'), '--demo']);
  for (const { id } of SPACES) assert.ok(readFileSync(launchCommand(id, [])[1][0], 'utf8').includes('cli.jsx'), id);
  assert.deepEqual(launchCommand('splice', ['.'], { compiled: true, execPath: '/opt/fleet' }), ['/opt/fleet', ['--run', 'splice', '.']]);
  assert.throws(() => launchCommand('notepad'));
  assert.equal(spaceNamed('O').id, 'sonar');
  assert.equal(spaceNamed('Trawl').id, 'trawl');
  assert.equal(spaceNamed('x'), undefined);
});
