// bilge-ignore-file: the demo's made-up findings are asserted on below.
// The Code view: bilge code, the report's Code section, and the view over the demo (the rules
// themselves are the kit's, tested in packages/kit/test/codescan.test.js).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runHeadless } from '../src/headless.js';
import { demoBilge } from '../src/demo.js';
import { markdownReport } from '../src/share.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

test('bilge code: the findings and the exit code, the JSON without the excerpts', async () => {
  let out = '';
  const code = await runHeadless(['code', '.'], { provider: demoBilge(), write: (s) => (out += s) });
  assert.equal(code, 1);
  assert.match(out, /CRIT AWS access key {2}src\/config\.js:1/);
  assert.match(out, /1 critical · 4 high · 1 medium · 2 low · failing on high and above/);
  out = '';
  assert.equal(await runHeadless(['code', '.', '--fail-on', 'critical', '--json'], { provider: demoBilge(), config: { codeIgnore: ['aws-key:src/config.js'] }, write: (s) => (out += s) }), 0);
  const j = JSON.parse(out);
  assert.equal(j.findings.length, 7);
  assert.ok(j.findings.every((f) => !('excerpt' in f)));
  assert.equal(j.counts.critical, 0);
});

test('the report has a Code section once /code has run, without the lines themselves', () => {
  const md = markdownReport({ name: 'shop', manifests: [], packages: [], found: [], code: [{ severity: 'critical', title: 'AWS access key', path: 'src/config.js', line: 1, excerpt: 'AKIA••••' }] });
  assert.match(md, /## Code/);
  assert.match(md, /\| CRIT \| AWS access key \| `src\/config\.js:1` \|/);
  assert.ok(!md.includes('AKIA'));
});

test('the Code view: /code reads the folder, ↵ shows a finding, x ignores it, t hands it to Splice', async () => {
  const app = start();
  await until(() => app.lastFrame().includes('minimist@1.2.5'), 'the findings');
  app.stdin.write('4');
  await until(() => app.lastFrame().includes('Not read yet'), 'the empty Code view');
  await type(app.stdin, '/code');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('AWS access key'), 'the code findings');
  const frame = app.lastFrame();
  assert.match(frame, /4 Code 8/);
  assert.match(frame, /CRIT secret AWS access key/);
  assert.ok(!frame.includes('AKIAZ7QX3PLM2RTW5KDN'), 'no secret on screen');
  assert.deepEqual(app.provider.state.calls.at(-1)[0], 'code');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('rotate it'), 'the finding');
  assert.match(app.lastFrame(), /Deactivate the key in IAM/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Deactivate'), 'the list again');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /family:v1:file:/);
  app.stdin.write('x');
  await until(() => app.lastFrame().includes('Ignore aws access key in src/config.js?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.lastFrame().includes('4 Code 7'), 'one fewer');
  assert.ok(!app.lastFrame().includes('AWS access key'));
  app.unmount();
});
