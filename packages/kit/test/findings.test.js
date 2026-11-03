// findings.js: the shape every app's security checks share, the counts, --fail-on, the JSON and SARIF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countFindings, failingFindings, findingsLine, findingsText, looksLikeFile, parseFailOn, securityJson, sortFindings, toSarif, withoutIgnoredFindings } from '../findings.js';

const list = [
  { rule: 'weak-hash', severity: 'low', title: 'MD5', where: 'src/a.js', line: 3, fix: 'SHA-256' },
  { rule: 'nsg-open-ssh', severity: 'high', title: 'SSH open to the internet', where: '/subscriptions/x/nsg/web', fix: 'Close it' },
  { rule: 'tls-off', severity: 'critical', title: 'TLS off', where: 'src/b.js', line: 9, excerpt: 'rejectUnauthorized: false' },
];

test('counts, order, ignores and --fail-on', () => {
  assert.deepEqual(countFindings(list), { critical: 1, high: 1, medium: 0, low: 1, unknown: 0 });
  assert.equal(findingsLine(countFindings(list)), '1 critical · 1 high · 1 low');
  assert.deepEqual(sortFindings(list).map((f) => f.rule), ['tls-off', 'nsg-open-ssh', 'weak-hash']);
  assert.deepEqual(withoutIgnoredFindings(list, ['weak-hash', 'tls-off:src/b.js']).map((f) => f.rule), ['nsg-open-ssh']);
  assert.equal(parseFailOn('HIGH'), 'high');
  assert.equal(parseFailOn('none'), 'none');
  assert.equal(parseFailOn('bad'), null);
  assert.equal(failingFindings(list, 'high').length, 2);
  assert.equal(failingFindings(list, 'none').length, 0);
});

test('the JSON leaves excerpts out unless asked; the text ends with the counts', () => {
  const j = securityJson({ app: 'bilge', check: 'code', target: '/x', findings: list, now: new Date(0) });
  assert.equal(j.at, '1970-01-01T00:00:00.000Z');
  assert.equal(j.counts.critical, 1);
  assert.ok(j.findings.every((f) => !('excerpt' in f)));
  assert.equal(securityJson({ app: 'a', check: 'c', target: 't', findings: list, excerpts: true }).findings[0].excerpt, 'rejectUnauthorized: false');
  const text = findingsText(list, { failOn: 'high' });
  assert.match(text, /^CRIT TLS off {2}src\/b\.js:9$/m);
  assert.match(text, /1 critical · 1 high · 1 low · failing on high and above\n$/);
  assert.equal(findingsText([]), 'Nothing found.\n');
});

test('SARIF: a rule each, files with their lines, anything else at the root with where in the message', () => {
  assert.equal(looksLikeFile({ where: 'Dockerfile' }), true);
  assert.equal(looksLikeFile({ where: 'https://shop.example.com/.git/' }), false);
  assert.equal(looksLikeFile({ where: '/subscriptions/x' }), false);
  const sarif = toSarif({ tool: 'Bilge', version: '1.2.3', findings: list });
  const run = sarif.runs[0];
  assert.equal(sarif.version, '2.1.0');
  assert.deepEqual(run.tool.driver.rules.map((r) => r.id), ['weak-hash', 'nsg-open-ssh', 'tls-off']);
  assert.equal(run.tool.driver.rules[2].properties['security-severity'], '9.5');
  const [first, second] = run.results;
  assert.equal(first.ruleId, 'tls-off');
  assert.equal(first.level, 'error');
  assert.deepEqual(first.locations[0].physicalLocation, { artifactLocation: { uri: 'src/b.js' }, region: { startLine: 9 } });
  assert.equal(second.locations[0].physicalLocation.artifactLocation.uri, '.');
  assert.match(second.message.text, /\/subscriptions\/x\/nsg\/web/);
});
