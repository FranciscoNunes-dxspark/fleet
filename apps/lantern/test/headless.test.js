// lantern audit, security and domains over the demo: text, --json, --sarif and the exit codes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './helpers.js';
import { parseArgs, runHeadless } from '../src/headless.js';
import { demoLantern } from '../src/demo.js';
import { createLantern } from '../src/provider.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

async function headless(args, { provider = demoLantern(), config = {} } = {}) {
  let out = '';
  const code = await runHeadless(args, { provider, config, write: (s) => (out += s), version: '1.2.3' });
  return { code, out, provider };
}

test('the arguments: URLs, a folder, --fail-on checked for each command', () => {
  assert.deepEqual(parseArgs(['audit', 'https://a.example/', '--runs', '2', '--fail-on', 'perf:lcp>2s']).terms, [{ metric: 'lcp', over: 2000, text: 'perf:lcp>2s' }]);
  assert.match(parseArgs(['audit', '--runs', '12']).error, /--runs takes 1 to 9/);
  assert.match(parseArgs(['security', '--fail-on', 'a11y:serious']).error, /--fail-on is one of/);
  assert.match(parseArgs(['audit', 'not a url at all']).error, /neither a URL nor a folder/);
  assert.match(parseArgs(['audit', '--json', '--sarif']).error, /both want the output/);
  assert.equal(parseArgs(['domains', 'shop.example']).targets[0], 'shop.example');
});

test('lantern audit: every page as text, failing on high by default; --fail-on none passes', async () => {
  const { code, out } = await headless(['audit']);
  assert.equal(code, 1);
  assert.match(out, /staging {2}https:\/\/staging\.shop\.example\/\n {2}LCP 1\.8 s · CLS 0\.02 · INP <16 ms · TTFB 410 ms {2}\(lab, median of 3 runs\)/);
  assert.match(out, /CRIT a11y Images must have alternative text {2}#hero/);
  assert.match(out, /Failing --fail-on high:\n {2}https:\/\/staging\.shop\.example\/: 3 findings at high/);
  assert.equal((await headless(['audit', '--fail-on', 'none'])).code, 0);
});

test('lantern audit --fail-on a metric, and --json with the vitals, the samples and what failed', async () => {
  const { code, out } = await headless(['audit', 'https://shop.example/', 'https://staging.shop.example/', '--fail-on', 'perf:lcp>2.5s', '--json']);
  assert.equal(code, 1);
  const j = JSON.parse(out);
  assert.deepEqual(j.pages.map((p) => [p.url, p.vitals.lcp, p.failing]), [['https://shop.example/', 2900, ['LCP 2.9 s > 2.5 s (perf:lcp>2.5s)']], ['https://staging.shop.example/', 1800, []]]);
  assert.deepEqual(j.pages[0].samples.lcp, [2900, 2750, 3100]);
  assert.ok(j.pages[0].findings.every((f) => !('excerpt' in f)));
  assert.equal((await headless(['audit', 'https://staging.shop.example/', '--fail-on', 'perf:lcp>2.5s'])).code, 0);
});

test('lantern audit --sarif writes code scanning results with the URL in each message; ignores count', async () => {
  const { code, out, provider } = await headless(['audit', 'https://staging.shop.example/', '--sarif', 'out.sarif', '--fail-on', 'none'], { config: { ignore: ['image-alt'] } });
  assert.equal(code, 0);
  assert.match(out, /SARIF in .*out\.sarif/);
  const sarif = JSON.parse(Object.values(provider.state.written)[0]);
  const results = sarif.runs[0].results;
  assert.equal(sarif.runs[0].tool.driver.name, 'Lantern');
  assert.ok(!results.some((r) => r.ruleId === 'image-alt'));
  assert.ok(results.some((r) => r.ruleId === 'color-contrast' && /https:\/\/staging\.shop\.example\//.test(r.message.text)));
});

test('lantern security --json is the family\'s security JSON for Fleet', async () => {
  const { code, out } = await headless(['security', 'https://staging.shop.example/', '--json']);
  assert.equal(code, 1);
  const j = JSON.parse(out);
  assert.deepEqual([j.app, j.check, j.target], ['lantern', 'security', 'https://staging.shop.example/']);
  assert.deepEqual(Object.keys(j.counts), ['critical', 'high', 'medium', 'low', 'unknown']);
  assert.ok(j.findings.some((f) => f.rule === 'no-https-redirect' && f.severity === 'high'));
  assert.ok(j.findings.some((f) => f.rule === 'cert-expiring' && f.where === 'staging.shop.example'));
  assert.ok(j.findings.every((f) => f.category === 'security'));
  const text = await headless(['security', 'https://shop.example/', '--fail-on', 'critical']);
  assert.equal(text.code, 0);
  assert.match(text.out, /MED  app\.js's source map is served  https:\/\/shop\.example\//);
});

test('lantern domains: the records, redirects and certificate; --json adds a summary per host', async () => {
  const { code, out } = await headless(['domains', 'staging.shop.example', 'shop.example']);
  assert.equal(code, 1);
  assert.match(out, /staging\.shop\.example\n {2}A +20\.105\.232\.1/);
  assert.match(out, /HTTPS +not enforced/);
  assert.match(out, /MED  The certificate expires in 9 days/);
  const j = JSON.parse((await headless(['domains', 'shop.example', '--json'])).out);
  assert.equal(j.check, 'domains');
  assert.deepEqual(j.domains[0].a, ['20.50.2.10']);
  assert.equal(j.domains[0].https, true);
  assert.equal(j.domains[0].days, 61);
  assert.deepEqual(j.findings.map((f) => f.rule), ['missing-caa']);
});

test('lantern domains and security check several at once and print them in the order asked', async () => {
  const demo = demoLantern();
  let open = 0;
  let most = 0;
  // The first hosts answer last, so the order can't come from who finished first.
  const slow = (fn) => async (x, i) => {
    open++;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 30 - i * 2));
    open--;
    return fn(x);
  };
  const hosts = Array.from({ length: 12 }, (_, i) => `h${i}.shop.example`);
  const provider = { ...demo, domain: (h) => slow(demo.domain)(h, hosts.indexOf(h)), security: (u) => slow(demo.security)(u, 0) };
  const j = JSON.parse((await headless(['domains', ...hosts, '--json'], { provider })).out);
  assert.deepEqual(j.domains.map((d) => d.host), hosts);
  assert.ok(most > 1 && most <= 6, `${most} at once`);
  most = 0;
  const s = JSON.parse((await headless(['security', 'https://shop.example/', 'https://staging.shop.example/', '--json'], { provider })).out);
  assert.ok(s.findings.length);
  assert.equal(most, 2);
});

test('the pages of a folder: lantern.json and the environments, the chosen one\'s by default', async () => {
  const dir = join(process.env.LANTERN_HOME, 'site');
  mkdirSync(join(dir, '.fleet'), { recursive: true });
  writeFileSync(join(dir, 'lantern.json'), JSON.stringify({ pages: ['https://docs.shop.example/'], domains: ['mail.shop.example'] }));
  writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ default: 'staging', environments: { staging: { lantern: { url: 'https://staging.shop.example/' } }, prod: { prod: true, lantern: { urls: ['https://shop.example/', 'https://shop.example/checkout'] } } } }));
  const real = createLantern();
  const pages = real.pages(dir);
  assert.deepEqual(pages.pages.map((p) => [p.env ?? '', p.name, p.url]), [['', '/', 'https://docs.shop.example/'], ['staging', '/', 'https://staging.shop.example/'], ['prod', '/', 'https://shop.example/'], ['prod', '/checkout', 'https://shop.example/checkout']]);
  assert.deepEqual(pages.domains, ['mail.shop.example', 'docs.shop.example', 'staging.shop.example', 'shop.example']);
  // The demo's audits, of the pages the real folder names.
  const provider = { ...demoLantern(), pages: real.pages };
  const audited = async (args) => JSON.parse((await headless(['audit', dir, '--json', '--fail-on', 'none', ...args], { provider })).out).pages.map((p) => p.url);
  assert.deepEqual(await audited([]), ['https://docs.shop.example/', 'https://staging.shop.example/']);
  assert.deepEqual(await audited(['--env', 'prod']), ['https://docs.shop.example/', 'https://shop.example/', 'https://shop.example/checkout']);
  assert.equal((await audited(['--all'])).length, 4);
  writeFileSync(join(dir, 'lantern.json'), '{ broken');
  assert.match(real.pages(dir).errors[0], /lantern\.json can't be read/);
  const empty = join(process.env.LANTERN_HOME, 'empty');
  mkdirSync(empty);
  const none = await headless(['audit', empty], { provider: { ...demoLantern(), pages: real.pages } });
  assert.equal(none.code, 2);
  assert.match(none.out, /No pages/);
});
