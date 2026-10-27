// The Azure client (azure/arm.js, azure/az.js) against a fake fetch and a fake az: the calls it makes,
// what it makes of the answers, and that a value never reaches an error. And the clipboard's guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARM, VAULT, azureError, certificateFrom, createAzure, label, secretFrom, siteFrom, vaultFrom } from '../src/azure/arm.js';
import { azProblem, currentSubscription, forgetTokens, token } from '../src/azure/az.js';
import { loadSubscription, loadTarget, loadVault } from '../src/load.js';
import { clipGuard } from '../src/clipguard.js';

/** A fetch that answers from `routes` ([method, url part, body or (req) => body, status?]) and records the calls. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    const r = routes.find(([m, part]) => m === method && url.includes(part));
    if (!r) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 'NotFound', message: `no route for ${method} ${url}` } }), headers: { get: () => null } };
    const [, , answer, status = 200] = r;
    const body = typeof answer === 'function' ? answer({ url, init }) : answer;
    return { ok: status < 300, status, text: async () => (body == null ? '' : JSON.stringify(body)), headers: { get: () => null } };
  };
  return { fetch, calls };
}

const SITE = '/subscriptions/s1/resourceGroups/rg/providers/Microsoft.Web/sites/shop-api';
const KV = { name: 'kv', uri: 'https://kv.vault.azure.net/' };
const tokens = async (resource) => `token-for-${resource}`;

test('apps, slots, vaults and settings come from ARM, with the ARM token', async () => {
  const { fetch, calls } = fakeFetch([
    ['GET', '/subscriptions?api', { value: [{ subscriptionId: 's1', displayName: 'Dev', state: 'Enabled' }, { subscriptionId: 's2', displayName: 'Old', state: 'Disabled' }] }],
    ['GET', 'Microsoft.Web/sites?api', { value: [{ id: SITE, name: 'shop-api', kind: 'app,linux', location: 'westeurope', properties: { state: 'Running' } }] }],
    ['GET', '/slots?api', { value: [{ id: `${SITE}/slots/staging`, name: 'shop-api/staging', kind: 'app', properties: {} }] }],
    ['GET', 'Microsoft.KeyVault/vaults?api', { value: [{ id: '/subscriptions/s1/resourceGroups/sec/providers/Microsoft.KeyVault/vaults/kv', name: 'kv', properties: { vaultUri: 'https://kv.vault.azure.net' } }] }],
    ['POST', '/config/appsettings/list', { properties: { A: '1' } }],
    ['POST', '/config/connectionstrings/list', { properties: { Default: { value: 'Server=x', type: 'SQLAzure' } } }],
    ['GET', '/configreferences/appsettings', { value: [{ name: 'B', properties: { status: 'SecretNotFound', vaultName: 'kv', secretName: 'b' } }] }],
    ['GET', '/configreferences/connectionstrings', { value: [] }],
  ]);
  const azure = { ...createAzure({ fetch, token: tokens }), currentSubscription: async () => ({ id: 's1', name: 'Dev' }) };
  const sub = await loadSubscription(azure, {});
  assert.deepEqual(sub.subscriptions, [{ id: 's1', name: 'Dev' }]);
  assert.deepEqual(sub.sites.map(label), ['shop-api', 'shop-api/staging']);
  assert.equal(sub.sites[1].slot, 'staging');
  assert.equal(sub.sites[0].resourceGroup, 'rg');
  assert.deepEqual(sub.vaults, [{ id: '/subscriptions/s1/resourceGroups/sec/providers/Microsoft.KeyVault/vaults/kv', name: 'kv', uri: 'https://kv.vault.azure.net/', resourceGroup: 'sec', location: undefined }]);
  const app = await loadTarget(azure, sub.sites[0]);
  assert.deepEqual(app.settings, { A: '1' });
  assert.deepEqual(app.strings, { Default: { value: 'Server=x', type: 'SQLAzure' } });
  assert.deepEqual(app.references, [{ name: 'B', status: 'SecretNotFound', details: '', vault: 'kv', secret: 'b' }]);
  assert.ok(calls.every((c) => c.url.startsWith(ARM) && c.auth === `Bearer token-for-${ARM}/`));
});

test("a vault's secrets are listed page by page without their values, those behind certificates left out", async () => {
  const { fetch, calls } = fakeFetch([
    ['GET', 'secrets?maxresults=25', { value: [{ id: 'https://kv.vault.azure.net/secrets/b', attributes: { enabled: true, exp: 1893456000, updated: 1700000000 }, contentType: 'text/plain' }], nextLink: 'https://kv.vault.azure.net/secrets?$skiptoken=2&api-version=7.4' }],
    ['GET', 'skiptoken=2', { value: [{ id: 'https://kv.vault.azure.net/secrets/a', attributes: { enabled: false } }, { id: 'https://kv.vault.azure.net/secrets/tls', managed: true, attributes: {} }] }],
    ['GET', 'certificates?maxresults=25', { value: [{ id: 'https://kv.vault.azure.net/certificates/tls', x5t: 'abc', attributes: { enabled: true, exp: 1893456000 } }] }],
  ]);
  const azure = createAzure({ fetch, token: tokens });
  const { secrets, certificates } = await loadVault(azure, KV);
  assert.deepEqual(secrets.map((s) => [s.name, s.enabled]), [['a', false], ['b', true]]);
  assert.equal(secrets[1].expires, '2030-01-01T00:00:00.000Z');
  assert.equal(secrets[1].contentType, 'text/plain');
  assert.deepEqual(certificates.map((c) => [c.kind, c.name, c.thumbprint]), [['certificate', 'tls', 'abc']]);
  assert.ok(calls.every((c) => c.auth === `Bearer token-for-${VAULT}`));
  assert.match(calls[0].url, /^https:\/\/kv\.vault\.azure\.net\/secrets\?maxresults=25&api-version=7\.4$/);
});

test('a value is read, set and turned off only by name, and never reaches an error', async () => {
  const { fetch, calls } = fakeFetch([
    ['GET', '/secrets/db-password?', { value: 's3cr3t', id: 'https://kv.vault.azure.net/secrets/db-password/v1' }],
    ['PUT', '/secrets/new-one?', ({ init }) => ({ value: JSON.parse(init.body).value, id: 'x' })],
    ['PATCH', '/secrets/db-password/?', { id: 'x', attributes: { enabled: false } }],
    ['PUT', '/secrets/denied?', { error: { code: 'Forbidden', message: 'The user does not have secrets set permission' } }, 403],
  ]);
  const azure = createAzure({ fetch, token: tokens });
  assert.equal(await azure.secretValue(KV, 'db-password'), 's3cr3t');
  assert.equal(await azure.setSecret(KV, 'new-one', 'hunter2', { contentType: 'text/plain' }), undefined);
  assert.deepEqual(calls[1].body, { value: 'hunter2', contentType: 'text/plain' });
  await azure.enableSecret(KV, 'db-password', false);
  assert.deepEqual([calls[2].method, calls[2].body], ['PATCH', { attributes: { enabled: false } }]);
  await assert.rejects(azure.setSecret(KV, 'denied', 'hunter2'), (e) => e.status === 403 && /Setting denied in kv: you don't have access/.test(e.message) && !e.message.includes('hunter2'));
  // Nothing but a secret's name reaches its address.
  await assert.rejects(azure.secretValue(KV, '../keys/x'), /isn't a Key Vault secret name/);
  await assert.rejects(azure.setSecret(KV, 'a?b=c', 'v'), /isn't a Key Vault secret name/);
  assert.equal(calls.length, 4);
});

test("ARM's shapes, and its errors in words", () => {
  assert.equal(siteFrom({ id: SITE, name: 'f', kind: 'functionapp,linux', properties: {} }).kind, 'function');
  assert.equal(vaultFrom({ id: 'x', name: 'v', properties: {} }).uri, 'https://v.vault.azure.net/');
  assert.equal(secretFrom({ id: 'https://kv.vault.azure.net/secrets/x', attributes: {} }).expires, null);
  assert.equal(certificateFrom({ id: 'https://kv.vault.azure.net/certificates/c/v1', attributes: { exp: 0 } }).name, 'c');
  assert.equal(azureError(401, { error: { message: 'expired' } }, 'Listing'), 'Listing: the sign-in was refused (expired). Try az login.');
  assert.equal(azureError(500, null, 'Listing'), 'Listing: Azure answered 500');
});

test('tokens come from az, kept until near their end; sign-in trouble says az login', async () => {
  forgetTokens();
  const ran = [];
  const runner = async (cmd) => {
    ran.push(cmd);
    if (cmd.includes('account show')) return { stdout: JSON.stringify({ id: 's1', name: 'Dev' }) };
    return { stdout: JSON.stringify({ token: 'tok', expires: String(Math.floor(Date.now() / 1000) + 3600) }) };
  };
  assert.equal(await token('https://vault.azure.net', { runner }), 'tok');
  assert.equal(await token('https://vault.azure.net', { runner }), 'tok');
  assert.equal(ran.length, 1);
  assert.match(ran[0], /get-access-token --resource "https:\/\/vault\.azure\.net"/);
  assert.deepEqual(await currentSubscription({ runner }), { id: 's1', name: 'Dev' });
  forgetTokens();
  const failing = async () => Promise.reject(Object.assign(new Error('failed'), { stderr: "ERROR: Please run 'az login' to setup account." }));
  await assert.rejects(token('https://management.azure.com/', { runner: failing }), /run az login/);
  assert.match(azProblem('/bin/sh: 1: az: not found'), /not installed/);
  assert.equal(azProblem('something else'), null);
  forgetTokens();
});

test('a copied value is cleared from the clipboard after a while, unless something else was copied since', async () => {
  let board = '';
  const timers = [];
  const guard = clipGuard({ copy: async (t) => (board = t), read: async () => board, after: () => 30, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => {} });
  await guard.put('s3cr3t');
  assert.equal(board, 's3cr3t');
  assert.equal(timers[0].ms, 30_000);
  assert.ok(guard.pending());
  await timers[0].fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(board, '');
  await guard.put('again');
  board = 'yours now';
  await guard.flush();
  assert.equal(board, 'yours now');
  assert.ok(!guard.pending());
  // Over SSH the clipboard can't be read back: it is cleared anyway.
  const blind = clipGuard({ copy: async (t) => (board = t), read: async () => '', after: () => 5, setTimer: () => 1, clearTimer: () => {} });
  await blind.put('x');
  await blind.flush();
  assert.equal(board, '');
  // 0 leaves it there.
  const keep = clipGuard({ copy: async (t) => (board = t), after: () => 0 });
  await keep.put('kept');
  assert.ok(!keep.pending());
  assert.equal(board, 'kept');
});
