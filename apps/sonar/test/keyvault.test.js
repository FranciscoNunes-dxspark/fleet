// Key Vault references: their status in words, beside the settings, flagged in Resources and told in an incident.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isReference, referenceWords, referencesSummary, resolved, unresolved } from '../src/keyvault.js';
import { incidentMarkdown } from '../src/incident.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('references: which settings are ones, their status in words, the ones that failed', () => {
  assert.ok(isReference('@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/x/)'));
  assert.ok(!isReference('plain'));
  const refs = [
    { name: 'A', status: 'Resolved' },
    { name: 'B', status: 'AccessToKeyVaultDenied', details: 'Forbidden\nmore' },
    { name: 'C', status: 'SomethingNew' },
  ];
  assert.ok(resolved(refs[0]));
  assert.deepEqual(unresolved(refs).map((r) => r.name), ['B', 'C']);
  assert.equal(referenceWords(refs[1]), "the app's identity may not read the vault (Forbidden)");
  assert.equal(referenceWords(refs[2]), 'something new');
  assert.equal(referenceWords({ status: 'MSINotEnabled' }), 'the app has no managed identity');
  assert.equal(referencesSummary(refs), "3: 1 resolved; B: the app's identity may not read the vault (Forbidden); C: something new");
  assert.equal(referencesSummary([]), null);
  const md = incidentMarkdown({ problem: { type: 'T', message: 'm', role: 'app', first: '2026-10-20T10:00:00Z', last: '2026-10-20T11:00:00Z', count: 1, users: 1, problemId: 'T' }, span: { label: '24h' }, deploys: { within: [], latest: null }, rows: [], frames: [], sql: [], refs, repo: null });
  assert.match(md, /## Key Vault references \(now\)\n\n- ✓ A: resolved\n- ✗ B: the app's identity may not read the vault \(Forbidden\)/);
});

test('Resources flags an app whose reference fails, its details and settings say which and why, and so does its incident', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /contoso-api {2,}⚠/.test(frame()), 'the flag beside contoso-api');
    assert.doesNotMatch(frame(), /contoso-web {2,}⚠/);
    app.stdin.write('/');
    await type(app.stdin, 'find contoso-api');
    app.stdin.write(KEYS.enter);
    // Room for the details: the welcome box goes.
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('key vault 2 references, 1 resolved'), 'its details');
    assert.match(frame(), /⚠ Smtp__Password: the app's identity may not read/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Settings of contoso-api'), 'its settings');
    assert.match(frame(), /Payments__ApiKey\s+✓ /);
    assert.match(frame(), /Smtp__Password\s+✗ the app's identity may not read the vault/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Settings of contoso-api'), 'the settings closed');
    app.stdin.write('p');
    await until(() => frame().includes('╭─ Problems') && frame().includes('TimeoutException'), 'its problems');
    app.stdin.write('/');
    await type(app.stdin, 'incident Timeout');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Key Vault references (now)'), 'the incident');
    assert.match(frame(), /✗ Smtp__Password/);
  } finally {
    app.unmount();
  }
});
