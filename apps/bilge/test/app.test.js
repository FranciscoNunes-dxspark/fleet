// End to end: App over the demo project, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { demoBilge } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('it reads the folder and asks OSV on opening: the findings worst first, the counts in the header', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  const frame = app.lastFrame();
  assert.match(frame, /14 packages {2}2 critical {2}4 high {2}1 medium/);
  assert.ok(frame.indexOf('minimist@1.2.5') < frame.indexOf('lodash@4.17.20'));
  assert.ok(frame.indexOf('lodash@4.17.20') < frame.indexOf('jsonwebtoken@8.5.1'));
  assert.match(frame, /→ 4\.17\.21/);
  assert.match(frame, /1 Vulnerabilities 7/);
  assert.deepEqual(app.provider.state.calls.map((c) => c[0]), ['scan', 'audit']);
  app.unmount();
});

test('↵ shows a finding: its advisories, where it is and the fix', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'GHSA-xvch-5gv4-984h'), 'the finding');
  assert.match(app.lastFrame(), /CVE-2021-44906/);
  assert.match(app.lastFrame(), /Found in: package-lock\.json:48/);
  assert.match(app.lastFrame(), /Fix \(f\): npm update minimist/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Found in:'), 'the list again');
  app.unmount();
});

test('f asks, runs the fix where the manifest is, then reads and asks again: the finding is gone', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  // Down to lodash, a direct package: npm install. A step at a time, each seen before the next, so a
  // busy machine can't leave a key in flight when f goes.
  const cursorLine = () => app.lastFrame().split('\n').find((l) => l.includes('❯'));
  for (let i = 0; i < 8 && !/❯ HIGH +lodash/.test(app.lastFrame()); i++) {
    const before = cursorLine();
    app.stdin.write('j');
    await until(() => cursorLine() !== before, 'the cursor moving');
  }
  app.stdin.write('f');
  await until(shows(app, 'Move lodash from 4.17.20 to 4.17.21?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some((c) => c[0] === 'run'), 'the fix');
  const run = app.provider.state.calls.find((c) => c[0] === 'run');
  assert.equal(run[1], 'npm install lodash@^4.17.21');
  // What it needs was asked first, and npm ls checks the project once it has run.
  assert.deepEqual(app.provider.state.calls.find((c) => c[0] === 'needs'), ['needs', 'lodash', '4.17.21']);
  await until(() => app.provider.state.calls.some((c) => c[0] === 'run' && c[1] === 'npm ls lodash'), 'the check');
  await until(() => !app.lastFrame().includes('lodash@4.17.20'), 'lodash gone');
  assert.match(app.lastFrame(), /3 high/);
  assert.equal(app.provider.state.calls.filter((c) => c[0] === 'audit').length, 2);
  app.unmount();
});

test('x ignores a finding after asking, kept in the settings; /unignore all puts it back', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write('x');
  await until(shows(app, 'Ignore GHSA-xvch-5gv4-984h?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => !app.lastFrame().includes('minimist@1.2.5'), 'minimist gone');
  assert.match(app.lastFrame(), /1 critical/);
  assert.match(app.lastFrame(), /1 ignored/);
  assert.deepEqual(loadConfig().ignore, ['GHSA-xvch-5gv4-984h']);
  await type(app.stdin, '/unignore all');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'minimist@1.2.5'), 'minimist back');
  app.unmount();
});

test('the Packages view: a changes what it lists, u asks the registries, outdated and flagged ones marked', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write('2');
  await until(shows(app, '14 packages'), 'the packages');
  assert.match(app.lastFrame(), /AGPL-3\.0-only/);
  app.stdin.write('a');
  await until(shows(app, '8 direct'), 'the direct ones');
  assert.ok(!app.lastFrame().includes('minimist'));
  app.stdin.write('u');
  await until(shows(app, '→ 5.1.0'), 'the newest versions');
  assert.match(app.lastFrame(), /outdated/);
  assert.equal(app.provider.state.calls.find((c) => c[0] === 'latest')[1], 8);
  await type(app.stdin, '/packages flagged');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'ghostscript-js'), 'the flagged ones');
  assert.match(app.lastFrame(), /8 flagged/);
  assert.match(app.lastFrame(), /lodash .*HIGH/);
  await type(app.stdin, '/outdated all');
  app.stdin.write(KEYS.enter);
  await type(app.stdin, '/packages flagged');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'deprecated'), 'a deprecated one');
  app.unmount();
});

test("u marks a newest version that won't fit the project; ↵ says why and which one does", async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write('2');
  await until(shows(app, '14 packages'), 'the packages');
  app.stdin.write('u');
  await until(shows(app, "won't fit"), 'the marks');
  // Express 5 wants Node 18 (the demo says >=16); SqlClient 6 isn't built for net6.0.
  assert.match(app.lastFrame(), /2 won't fit/);
  assert.match(app.lastFrame(), /→ 5\.1\.0 +!/);
  assert.deepEqual(app.provider.state.calls.filter((c) => c[0] === 'fitting').map((c) => c[1]).sort(), ['Microsoft.Data.SqlClient', 'express']);
  await type(app.stdin, '/why express');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Before moving to 5.1.0'), 'why');
  assert.match(app.lastFrame(), /5\.1\.0 needs Node >= 18; the project says >=16/);
  assert.match(app.lastFrame(), /Newest that fits: 4\.21\.2/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Found in:'), 'the list again');
  await type(app.stdin, '/why Microsoft.Data.SqlClient');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Newest that fits: 5.2.3'), 'the NuGet one');
  assert.match(app.lastFrame(), /6\.1\.1 is built for net462, net8\.0, net9\.0, not net6\.0/);
  assert.match(app.lastFrame(), /Project targets: net6\.0/);
  app.unmount();
});

test("f says when the fixed version may not fit, and can show why rather than run it", async () => {
  const provider = demoBilge();
  // As if SqlClient's fix were built for .NET 8 only, where the demo's project targets .NET 6.
  provider.needs = async () => ({ frameworks: ['net8.0'] });
  const app = start({ provider });
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/fix Microsoft.Data.SqlClient');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'It may not fit: 1 problem'), 'the question');
  assert.match(app.lastFrame(), /5\.1\.3 is built for net8\.0, not net6\.0/);
  app.stdin.write('3');
  await until(shows(app, 'Moving to 5.1.3 may not fit this project'), 'why');
  assert.ok(!provider.state.calls.some((c) => c[0] === 'run'));
  app.unmount();
});

test("the Manifests view: each one's counts; ↵ lists its packages; t copies it for Splice", async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write('3');
  await until(shows(app, 'src/Api/packages.lock.json'), 'the manifests');
  assert.match(app.lastFrame(), /tools\/legacy\/package\.json .*no lock/);
  assert.match(app.lastFrame(), /10 packages +5 direct +4 vulnerable/);
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /^\/take family:v1:file:/);
  app.stdin.write('j');
  await until(() => /❯ src\/Api/.test(app.lastFrame()), 'the cursor on the NuGet one');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'in src/Api/packages.lock.json'), 'its packages');
  assert.match(app.lastFrame(), /Newtonsoft\.Json/);
  assert.ok(!app.lastFrame().includes('lodash'));
  app.unmount();
});

test('/sbom writes the bill of materials; /report shows the audit as Markdown', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  await type(app.stdin, '/sbom');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.written, 'the file');
  assert.match(app.provider.state.written.path, /sbom\.cdx\.json$/);
  assert.equal(JSON.parse(app.provider.state.written.text).components.length, 14);
  await type(app.stdin, '/report');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '# Dependencies of shop'), 'the report');
  app.unmount();
});

test('ctrl+r reads and asks OSV again about everything; /audit fresh too, where /audit takes what OSV said lately', async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  const audits = () => app.provider.state.calls.filter((c) => c[0] === 'audit').map((c) => c[2] ?? 'kept');
  app.stdin.write('\x12');
  await until(() => audits().length === 2, 'the second audit');
  await until(() => !app.lastFrame().includes('Asking OSV'), 'it done');
  await type(app.stdin, '/audit fresh');
  app.stdin.write(KEYS.enter);
  await until(() => audits().length === 3, 'the third audit');
  await until(() => !app.lastFrame().includes('Asking OSV'), 'it done');
  await type(app.stdin, '/audit');
  app.stdin.write(KEYS.enter);
  await until(() => audits().length === 4, 'the fourth audit');
  assert.deepEqual(audits(), ['kept', 'fresh', 'fresh', 'kept']);
  app.unmount();
});
