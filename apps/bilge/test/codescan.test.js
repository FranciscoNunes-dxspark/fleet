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
  assert.match(out, /1 critical · 5 high · 2 medium · 4 low · failing on high and above/);
  out = '';
  assert.equal(await runHeadless(['code', '.', '--fail-on', 'critical', '--json'], { provider: demoBilge(), config: { codeIgnore: ['aws-key:src/config.js'] }, write: (s) => (out += s) }), 0);
  const j = JSON.parse(out);
  assert.equal(j.findings.length, 11);
  assert.ok(j.findings.every((f) => !('excerpt' in f)));
  // The demo's Vite config: the secret it puts in the browser's code is found, its publishable key isn't.
  assert.deepEqual(j.findings.filter((f) => f.rule === 'frontend-secret').map((f) => [f.where, f.line, f.severity, f.kind]), [['web/vite.config.js', 4, 'high', 'secret']]);
  assert.ok(!out.includes('q8ZtW2kP'), 'the value is in no output');
  assert.equal(j.counts.critical, 0);
});

test('bilge code: translation coverage, with the settings\' options, off with false, and never in bilge security', async () => {
  const run = async (args, config = {}) => {
    let out = '';
    await runHeadless(args, { provider: demoBilge(), config, write: (s) => (out += s) });
    return out;
  };
  const j = JSON.parse(await run(['code', '.', '--json', '--fail-on', 'none']));
  assert.deepEqual(j.findings.filter((f) => f.kind === 'i18n').map((f) => `${f.rule} ${f.severity} ${f.where}:${f.line}`), [
    'i18n-missing medium web/src/Basket.jsx:5',
    'i18n-plain-text low web/src/Basket.jsx:6',
    'i18n-unused low web/src/locales/pt/shop.js:4',
  ]);
  assert.match(await run(['code', '.']), /MED  No pt translation {2}web\/src\/Basket\.jsx:5/);
  // Another function name from the settings: nothing calls it, so no key is missing; false turns it off.
  const named = JSON.parse(await run(['code', '.', '--json', '--fail-on', 'none'], { i18n: { functions: ['translate'] } }));
  assert.ok(!named.findings.some((f) => f.rule === 'i18n-missing'));
  const off = JSON.parse(await run(['code', '.', '--json', '--fail-on', 'none'], { i18n: false }));
  assert.ok(!off.findings.some((f) => f.kind === 'i18n'));
  const security = JSON.parse(await run(['security', '.', '--json', '--fail-on', 'none']));
  assert.ok(!security.findings.some((f) => f.kind === 'i18n'));
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
  assert.match(frame, /Code 12/);
  assert.match(frame, /CRIT secret AWS access key/);
  assert.match(frame, /HIGH secret Secret in a browser var.* web\/vite\.config\.js:4/);
  assert.ok(!frame.includes('q8ZtW2kP9'), 'no browser secret on screen');
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
  await until(() => app.lastFrame().includes('Code 11'), 'one fewer');
  assert.ok(!app.lastFrame().includes('AWS access key'));
  app.unmount();
});
