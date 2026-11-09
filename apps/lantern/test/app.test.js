// End to end: App over the demo shop, typing keys and reading the frame.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { loadHistory } from '../src/history.js';
import { demoLantern } from '../src/demo.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

test('it lists the pages, one per environment, none audited yet', async () => {
  const app = start();
  await until(shows(app, 'https://shop.example/checkout'), 'the pages');
  const frame = app.lastFrame();
  assert.match(frame, /staging +\/ +https:\/\/staging\.shop\.example\//);
  assert.match(frame, /not audited/);
  assert.match(frame, /1 Pages 4/);
  assert.deepEqual(app.provider.state.calls.map((c) => c[0]), ['pages']);
  app.unmount();
});

test('a audits the page: the vitals in the list, the findings worst first, kept for next time', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  app.stdin.write('a');
  await until(shows(app, 'LCP 1.8 s'), 'the audit');
  assert.deepEqual(app.provider.state.calls.find((c) => c[0] === 'audit'), ['audit', 'https://staging.shop.example/', 3]);
  app.stdin.write('2');
  await until(shows(app, 'Images must have alternative text'), 'the findings');
  const frame = app.lastFrame();
  assert.match(frame, /1 critical · 2 high/);
  assert.match(frame, /LCP 1\.8 s · CLS 0\.02 · INP <16 ms · TTFB 410 ms {2}\(lab, median of 3\)/);
  assert.ok(frame.indexOf('Images must have alternative text') < frame.indexOf('Plain http'));
  assert.match(frame, /CRIT a11y Images must have alternative text +#hero/);
  assert.equal(loadHistory()['https://staging.shop.example/'].length, 1);
  app.unmount();
});

test('↵ on a finding: the element, the WCAG rule, why and the fix', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  app.stdin.write('a');
  await until(shows(app, 'LCP 1.8 s'), 'the audit');
  app.stdin.write('2');
  await until(shows(app, 'Images must have alternative text'), 'the findings');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'WCAG 1.1.1 (A)'), 'the finding');
  assert.match(app.lastFrame(), /Element +#hero/);
  assert.match(app.lastFrame(), /Fix: Fix any of the following: +Element does not have an alt attribute/);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('WCAG 1.1.1'), 'the list again');
  app.unmount();
});

test('f and s filter the findings by category and severity; x ignores one, kept in the settings', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  app.stdin.write('a');
  await until(shows(app, 'LCP 1.8 s'), 'the audit');
  app.stdin.write('2');
  await until(shows(app, 'Images must have alternative text'), 'the findings');
  // all → perf → a11y → seo → security
  for (const want of ['Performance', 'Accessibility', 'SEO and basics', 'Security']) {
    app.stdin.write('f');
    await until(shows(app, `showing ${want}`), want);
  }
  assert.match(app.lastFrame(), /Plain http isn't sent to https/);
  assert.doesNotMatch(app.lastFrame(), /Images must have/);
  app.stdin.write('s');
  await until(shows(app, 'critical and worse'), 'critical and worse');
  assert.match(app.lastFrame(), /Nothing that is Security, critical and worse/);
  app.stdin.write('s');
  await until(shows(app, 'HIGH sec  Plain http'), 'high and worse');
  app.stdin.write('x');
  await until(shows(app, 'Ignore no-https-redirect on https://staging.shop.example/?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Nothing that is Security, high and worse'), 'it gone');
  assert.deepEqual(loadConfig().ignore, ['no-https-redirect:https://staging.shop.example/']);
  app.unmount();
});

test('Compare puts the page beside the same page in prod: "staging LCP is 1.8 s, prod 2.9 s"', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  app.stdin.write('3');
  await until(shows(app, "hasn't been audited: a audits both"), 'compare, empty');
  app.stdin.write('a');
  await until(() => app.provider.state.calls.filter((c) => c[0] === 'audit').length === 2 && app.lastFrame().includes('staging LCP is'), 'both audited');
  const frame = app.lastFrame();
  assert.match(frame, /staging LCP is 1\.8 s, prod 2\.9 s; INP <16 ms against 240 ms \(lab numbers\)\./);
  assert.match(frame, /LCP +1\.8 s +2\.9 s +\+1\.1 s \(61% worse\)/);
  assert.match(frame, /with prod/);
  app.stdin.write('y');
  await until(() => app.copied.length === 1, 'the copy');
  assert.match(app.copied[0], /^staging LCP is 1\.8 s/);
  app.unmount();
});

test('the Waterfall lists the requests in order; ↵ hands one to Hail as a request context without headers', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  app.stdin.write('a');
  await until(shows(app, 'LCP 1.8 s'), 'the audit');
  app.stdin.write('4');
  await until(shows(app, 'vendor.js'), 'the waterfall');
  const frame = app.lastFrame();
  assert.ok(frame.indexOf('styles.css') < frame.indexOf('app.js'));
  assert.match(frame, /▼ LCP 1\.8 s/);
  assert.match(frame, /404 script +old\.js/);
  app.stdin.write('j');
  app.stdin.write(KEYS.enter);
  await until(() => app.copied.length === 1, 'the copy');
  const { contextIn } = await import('@fleet/kit/family.js');
  const ctx = contextIn(app.copied[0]);
  assert.equal(ctx.kind, 'request');
  assert.equal(ctx.data.url, 'https://staging.shop.example/static/styles.css');
  assert.deepEqual(ctx.data.headers, {});
  assert.match(app.lastFrame(), /Copied for Hail/);
  app.unmount();
});

test('/domains checks every host: CAA, https enforced, the certificate', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  await type(app.stdin, '/domains');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'cert 9 days'), 'the domains');
  const frame = app.lastFrame();
  assert.match(frame, /staging\.shop\.example +→ shop-staging\.azurewebsites\S* +https not enforced +cert 9 days/);
  assert.match(frame, /shop\.example +20\.50\.2\.10 +https enforced +cert 61 days/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No CAA record'), 'the details');
  assert.match(app.lastFrame(), /MX +0 shop-example\.mail\.protection\.outlook\.com/);
  app.unmount();
});

test('without Chrome it says so and still checks headers and the certificate', async () => {
  const app = start({ provider: demoLantern({ chrome: false }) });
  await until(shows(app, 'no Chrome found'), 'the warning');
  app.stdin.write('a');
  await until(shows(app, 'No Chrome, Edge or Chromium'), 'the note');
  app.stdin.write('2');
  await until(shows(app, 'Plain http'), 'the findings');
  assert.match(app.lastFrame(), /No lang on <html>/);
  assert.doesNotMatch(app.lastFrame(), /Images must have/);
  app.unmount();
});

test('/open audits a URL the folder doesn\'t name; /take of a page does the same', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  await type(app.stdin, '/open shop.example/checkout?x=1');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some((c) => c[0] === 'audit' && c[1] === 'https://shop.example/checkout?x=1'), 'the audit');
  await until(shows(app, 'Findings · /checkout?x=1'), 'its findings');
  assert.match(app.lastFrame(), /1 Pages 5/);
  const { takeLine } = await import('@fleet/kit/family.js');
  await type(app.stdin, takeLine('page', { url: 'https://shop.example/', findings: 3 }));
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some((c) => c[0] === 'audit' && c[1] === 'https://shop.example/'), 'the page taken');
  await until(shows(app, 'Findings · prod /'), 'its findings');
  // t on a page copies it as a page context, with how many findings it has.
  app.stdin.write('1');
  await until(shows(app, 'LCP 2.9 s'), 'the pages');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the copy');
  const { contextIn } = await import('@fleet/kit/family.js');
  assert.deepEqual(contextIn(app.copied[0]), { kind: 'page', data: { url: 'https://shop.example/', env: 'prod', findings: 22 } });
  app.unmount();
});

test('/take of a context Lantern has no use for says whose it is', async () => {
  const app = start();
  await until(shows(app, 'not audited'), 'the pages');
  app.stdin.write('/take family:v1:commit:eyJoYXNoIjoiYWJjIn0');
  await until(shows(app, '/take family:v1:commit'), 'the prompt with it');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "That's commit abc, for Splice or Sonar or Keel"), 'the answer');
  app.unmount();
});
