// bilge-ignore-file: the HAR files carry made-up credentials on purpose.
// lookout security, ca and env without the screen: a HAR file's findings, the last session's, the
// demo's, the exit codes, SARIF; the CA made in a temporary profile; the proxy lines.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs, runHeadless } from '../src/headless.js';
import { createLookout } from '../src/provider.js';
import { demoExchanges } from '../src/demo.js';
import { toHar } from '../src/har.js';
import { tempHome } from './helpers.js';

let home;
beforeEach(() => {
  home = tempHome();
});
afterEach(() => home());

async function headless(args, opts = {}) {
  let out = '';
  const code = await runHeadless(args, { provider: createLookout(), write: (s) => (out += s), version: '1.2.3', ...opts });
  return { code, out };
}

test('the arguments: --fail-on, --json and --sarif, and what doesn\'t add up', () => {
  assert.deepEqual(parseArgs(['security', 'a.har', '--fail-on', 'medium', '--json']), { command: 'security', file: 'a.har', failOn: 'medium', json: true, sarif: null, port: null, pem: false });
  assert.match(parseArgs(['security', '--fail-on', 'bad']).error, /--fail-on/);
  assert.match(parseArgs(['security', '--json', '--sarif']).error, /both want the output/);
  assert.match(parseArgs(['env', '--sarif', 'x']).error, /for lookout security/);
  assert.match(parseArgs(['env', '--port', '99999']).error, /--port/);
});

test('lookout security <file.har>: the findings, exit 1 on high, the JSON Fleet reads, never a credential', async () => {
  const file = join(home.dir, 'capture.har');
  writeFileSync(file, JSON.stringify(toHar(demoExchanges(), { secrets: true })));
  const text = await headless(['security', file]);
  assert.equal(text.code, 1);
  assert.match(text.out, /HIGH Authorization sent over plain HTTP {2}http:\/\/api\.shop\.test:8080\/v1\/me/);
  assert.match(text.out, /failing on high and above/);
  const json = await headless(['security', file, '--json', '--fail-on', 'none']);
  assert.equal(json.code, 0);
  const report = JSON.parse(json.out);
  assert.equal(report.app, 'lookout');
  assert.equal(report.check, 'traffic');
  assert.equal(report.target, file);
  assert.ok(report.counts.high >= 2);
  assert.ok(report.findings.every((f) => f.rule && f.severity && f.where && !('excerpt' in f)));
  assert.doesNotMatch(json.out, /eyJhbGciOiJIUzI1NiJ9|hunter2|s3ss10n/);
  const sarif = await headless(['security', file, '--sarif', join(home.dir, 'out.sarif')]);
  assert.match(sarif.out, /SARIF in/);
  assert.equal(JSON.parse(readFileSync(join(home.dir, 'out.sarif'), 'utf8')).runs[0].tool.driver.name, 'Lookout');
  const broken = join(home.dir, 'broken.har');
  writeFileSync(broken, '{}');
  assert.equal((await headless(['security', broken])).code, 2);
});

test('lookout security alone: the last session the app kept, or nothing yet; --demo the demo\'s', async () => {
  const none = await headless(['security']);
  assert.equal(none.code, 0);
  assert.match(none.out, /No session kept yet/);
  createLookout().saveFindings({ app: 'lookout', check: 'traffic', target: 'last session', at: '2026-11-03T10:00:00.000Z', requests: 3, findings: [{ rule: 'token-over-http', severity: 'high', title: 'Authorization sent over plain HTTP', where: 'http://a.test/x' }] });
  const kept = await headless(['security', '--json']);
  assert.equal(kept.code, 1);
  assert.equal(JSON.parse(kept.out).findings[0].rule, 'token-over-http');
  const demo = await headless(['security', '--fail-on', 'critical'], { demo: true });
  assert.equal(demo.code, 0);
  assert.match(demo.out, /in the demo session/);
});

test('lookout ca makes the authority once in the profile and says how to trust it; lookout env the proxy lines', async () => {
  const first = await headless(['ca']);
  assert.equal(first.code, 0);
  assert.match(first.out, new RegExp(`^Made ${join(home.dir, 'ca.crt').replace(/[\\.]/g, '\\$&')}`));
  assert.match(first.out, /SHA-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}/);
  assert.match(first.out, /NODE_EXTRA_CA_CERTS=/);
  assert.match((await headless(['ca'])).out, /^Kept /);
  const pem = await headless(['ca', '--pem']);
  assert.match(pem.out, /^-----BEGIN CERTIFICATE-----/);
  assert.doesNotMatch(pem.out, /PRIVATE KEY/);
  const env = await headless(['env', '--port', '9000']);
  assert.match(env.out, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:9000/);
  assert.match(env.out, /"NODE_USE_ENV_PROXY":"1"/);
});
