// End to end: App over the demo project, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { demoBallast, DEMO_COMMIT, DEMO_MAIN } from '../src/demo.js';
import { decodeContext } from '@fleet/kit/family.js';
import { loadConfig } from '../src/config.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('it reads the build on opening: the chunks biggest first, the budget it is over, the weight in the pane', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  const frame = app.lastFrame();
  assert.match(frame, /5 files · 190\.0 kB gzip/);
  // At 100 columns the top line has room for its most important fact only.
  assert.match(frame.split('\n')[0], /1 over budget$/);
  assert.match(frame, /OVER 100\.0 kB/);
  assert.ok(frame.indexOf('index-B7xk2Lq9.js') < frame.indexOf('vendor-react'));
  assert.match(frame, /rollup-plugin-visualizer data, dist\/stats\.json/);
  // Compared with the last build read, quietly, and kept for the next.
  app.stdin.write('4');
  await until(shows(app, '+465 B gzip'), 'the change against the last build');
  assert.ok(app.provider.state.calls.some((c) => c[0] === 'saveRun' && c[1] === DEMO_COMMIT));
  assert.equal(app.provider.state.runs[0].key, DEMO_COMMIT);
  app.unmount();
});

test('↵ on a chunk shows what is inside it: packages grouped, biggest first, and they open', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Modules · dist/assets/index-B7xk2Lq9.js'), 'the modules');
  const frame = app.lastFrame();
  assert.match(frame, /▸ lodash 4\.17\.20/);
  assert.match(frame, /▸ date-fns 4\.1\.0/);
  assert.match(frame, /149 modules/);
  assert.match(frame, /▸ src\//);
  // date-fns is first (the biggest), so ↵ opens it.
  assert.match(frame.split('\n').find((l) => l.includes('❯')), /date-fns/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, '▾ date-fns'), 'date-fns open');
  assert.match(app.lastFrame(), /\.js/);
  app.stdin.write('h');
  await until(shows(app, '▸ date-fns'), 'date-fns closed');
  // c goes round the chunks; the calendar's has date-fns 2 from inside react-datepicker.
  app.stdin.write('c');
  await until(shows(app, 'Modules · dist/assets/vendor-react-Cq81Ma0d.js'), 'the next chunk');
  app.unmount();
});

test('Duplicates: date-fns at two versions, tslib twice through two paths; ↵ says what brings each in', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  app.stdin.write('3');
  await until(shows(app, '2 versions'), 'the duplicates');
  const frame = app.lastFrame();
  assert.match(frame, /date-fns +2 versions +4\.1\.0, 2\.30\.0/);
  assert.match(frame, /tslib +2 paths +2\.6\.2/);
  assert.match(frame, /3 Duplicates 2/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'node_modules/react-datepicker/node_modules/date-fns'), 'the copies');
  assert.match(app.lastFrame(), /\(brought in by/);
  assert.match(app.lastFrame(), /node_modules\/date-fns  170\.4 kB  \(at the top of node_modules\)/);
  app.unmount();
});

test('Compare: b against main says what grew and why; m is the Markdown for a pull request', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  app.stdin.write('4');
  await until(shows(app, 'Compare · against'), 'the comparison');
  assert.match(app.lastFrame(), /\+465 B gzip/);
  app.stdin.write('b');
  await until(shows(app, 'from date-fns 4 now imported whole'), 'against main');
  const frame = app.lastFrame();
  assert.match(frame, /\+51\.5 kB gzip/);
  assert.match(frame, /against main \(a1b2c3d/);
  assert.match(frame, /138\.5 kB → 190\.0 kB/);
  app.stdin.write('m');
  await until(shows(app, 'Markdown for a pull request'), 'the markdown');
  assert.match(app.lastFrame(), /### Bundle size: \+51\.5 kB gzip \(\+37\.2%\)/);
  assert.match(app.lastFrame(), /\| Chunk \| Before \| After \| Change \|/);
  app.unmount();
});

test("main's build isn't kept: /compare main asks, builds it in a worktree, keeps it and compares", async () => {
  const provider = demoBallast({ mainSaved: false });
  const app = start({ provider });
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  await type(app.stdin, '/compare main');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Build main (a1b2c3d) to compare with?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'from date-fns 4 now imported whole'), 'the comparison');
  assert.ok(provider.state.calls.some((c) => c[0] === 'buildRef' && c[1] === DEMO_MAIN));
  assert.ok(provider.state.runs.some((r) => r.key === DEMO_MAIN));
  app.unmount();
});

test('p shows a package: its copies, licence and advisories from OSV; w copies /why for Bilge', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  await type(app.stdin, '/why lodash');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'GHSA-35jh-r3h4-6jhm'), 'the advisories');
  const frame = app.lastFrame();
  assert.match(frame, /Licence: MIT/);
  assert.match(frame, /HIGH 7\.2 +GHSA-35jh-r3h4-6jhm \(CVE-2021-23337\) +Command Injection in lodash/);
  assert.match(frame, /Fixed in: 4\.17\.21/);
  assert.deepEqual(app.provider.state.calls.find((c) => c[0] === 'advisories'), ['advisories', ['lodash@4.17.20']]);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('GHSA-35jh'), 'the view again');
  app.stdin.write('3');
  await until(shows(app, '2 versions'), 'the duplicates');
  app.stdin.write('w');
  await until(() => app.copied.length > 0, 'the copy');
  assert.equal(app.copied[0], '/why date-fns');
  await until(shows(app, 'Copied for Bilge'), 'the note');
  app.unmount();
});

test("t hands Splice a file of the project's own; on a package's file it says to use w", async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '▸ src/'), 'the modules');
  // Down to src/ and open it, then onto its biggest file.
  const cursor = () => app.lastFrame().split('\n').find((l) => l.includes('❯')) ?? '';
  for (let i = 0; i < 12 && !/❯ ▸ src\//.test(app.lastFrame()); i++) {
    const before = cursor();
    app.stdin.write('j');
    await until(() => cursor() !== before, 'the cursor moving');
  }
  app.stdin.write(KEYS.enter);
  await until(shows(app, '▾ src/'), 'src open');
  app.stdin.write('j');
  await until(() => /pages/.test(cursor()), 'pages');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Checkout.jsx'), 'pages open');
  app.stdin.write('j');
  await until(() => /Checkout\.jsx/.test(cursor()), 'Checkout.jsx');
  app.stdin.write('t');
  await until(() => app.copied.length > 0, 'the copy');
  const ctx = decodeContext(app.copied[0].replace(/^\/take /, ''));
  assert.deepEqual(ctx, { kind: 'file', data: { path: 'src/pages/Checkout.jsx' } });
  await until(shows(app, 'Copied for Splice'), 'the note');
  app.unmount();
});

test('with nothing to read it asks to build once with stats, and reads what the build made', async () => {
  const provider = demoBallast({ noStats: true });
  const app = start({ provider });
  await until(shows(app, 'Build shop once with stats on?'), 'the question');
  assert.match(app.lastFrame(), /npx vite build --sourcemap/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  assert.ok(provider.state.calls.some((c) => c[0] === 'build' && /vite build --sourcemap/.test(c[1])));
  app.unmount();
});

test('/security lists the source maps shipped and the key in the bundle, redacted', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  await type(app.stdin, '/security');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Security of the build'), 'the findings');
  const frame = app.lastFrame();
  assert.match(frame, /CRIT Stripe live key in the bundle +dist\/assets\/index-B7xk2Lq9\.js:1/);
  assert.match(frame, /MED +Source maps shipped in dist \(3\)/);
  app.unmount();
});

test('/check and /measure: the budgets as ballast check says them, in brotli once asked', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  app.stdin.write('c');
  await until(shows(app, 'From ballast.json'), 'the budgets');
  assert.match(app.lastFrame(), /OVER {2}dist\/assets\/index-\*\.js {2}112\.7 kB gzip > 100\.0 kB/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('From ballast.json'), 'the view');
  await type(app.stdin, '/measure brotli');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'kB brotli ·'), 'brotli');
  assert.equal(loadConfig().measure, 'brotli');
  app.unmount();
});

test('/take says whose a pasted context is: Ballast takes none', async () => {
  const app = start();
  await until(shows(app, 'dist/assets/index-B7xk2Lq9.js'), 'the chunks');
  await type(app.stdin, '/take family:v1:image:eyJpbWFnZSI6Im5naW54OjEuMjUifQ');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'for Bilge'), 'whose');
  app.unmount();
});
