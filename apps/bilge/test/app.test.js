// End to end: App over the demo project, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { loadConfig } from '../src/config.js';

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
  // Down to lodash, a direct package: npm install.
  app.stdin.write('j');
  app.stdin.write('j');
  await until(() => /❯ HIGH +express/.test(app.lastFrame()) || /❯ HIGH +lodash/.test(app.lastFrame()), 'the cursor on a high one');
  while (!/❯ HIGH +lodash/.test(app.lastFrame())) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 60));
  }
  app.stdin.write('f');
  await until(shows(app, 'Move lodash from 4.17.20 to 4.17.21?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some((c) => c[0] === 'run'), 'the fix');
  const run = app.provider.state.calls.find((c) => c[0] === 'run');
  assert.equal(run[1], 'npm install lodash@^4.17.21');
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
