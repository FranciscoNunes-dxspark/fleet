// The drift matrix and what it is made of (keys.js, drift.js, expiry.js, load.js): keys that are one
// setting however a source spells them, Key Vault references, values compared without being shown, and
// what runs out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReference, isVaultName, normKey, parseReference, referenceText, vaultName } from '../src/keys.js';
import { cellMark, checkReference, driftCounts, driftMatrix, filterRows, fingerprint } from '../src/drift.js';
import { expiring, expiryNotice, expiryTone, expiryWords, isExpired, shortExpiry } from '../src/expiry.js';
import { appEntries, driftColumns, isShown, pickTarget, referencedVaults } from '../src/load.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-27T12:00:00Z');
const at = (days) => new Date(NOW + days * DAY).toISOString();

test('a key is one setting however a source spells it', () => {
  assert.equal(normKey('ConnectionStrings:Default'), 'connectionstrings:default');
  assert.equal(normKey('ConnectionStrings__Default'), 'connectionstrings:default');
  assert.equal(normKey('ConnectionStrings--Default'), 'connectionstrings:default');
  assert.equal(vaultName('Db:Password'), 'Db--Password');
  assert.equal(vaultName('Db__Password'), 'Db--Password');
  assert.equal(vaultName('my_key.x'), 'my-key-x');
  assert.ok(isVaultName('Stripe--ApiKey'));
  assert.ok(!isVaultName('a_b') && !isVaultName('') && !isVaultName('x'.repeat(128)));
});

test('Key Vault references are read in both forms, and a wrong one says why', () => {
  assert.ok(isReference(' @Microsoft.KeyVault(VaultName=v;SecretName=s)'));
  assert.ok(!isReference('plain'));
  assert.deepEqual(parseReference('@Microsoft.KeyVault(SecretUri=https://kv-shop.vault.azure.net/secrets/db-password/)'), { vault: 'kv-shop', secret: 'db-password', version: null });
  assert.deepEqual(parseReference('@Microsoft.KeyVault(SecretUri=https://KV.vault.azure.net/secrets/a/0123456789abcdef)'), { vault: 'kv', secret: 'a', version: '0123456789abcdef' });
  assert.deepEqual(parseReference('@Microsoft.KeyVault(VaultName=KV;SecretName=a;SecretVersion=v1)'), { vault: 'kv', secret: 'a', version: 'v1' });
  assert.match(parseReference('@Microsoft.KeyVault(SecretUri=https://example.com/x)').problem, /not a Key Vault/);
  assert.match(parseReference('@Microsoft.KeyVault(nothing)').problem, /neither/);
  assert.equal(parseReference('value'), null);
  assert.equal(referenceText({ vault: 'kv', secret: 'a', version: '0123456789' }), 'kv/a@01234567');
});

test('a reference resolves when its secret is there, enabled and current', () => {
  const vaults = new Map([['kv', [{ name: 'ok', enabled: true, expires: at(10) }, { name: 'off', enabled: false }, { name: 'old', enabled: true, expires: at(-1) }]]]);
  const check = (secret, opts) => checkReference({ vault: 'kv', secret }, vaults, { now: NOW, ...opts });
  assert.equal(check('OK').ok, true);
  assert.deepEqual(check('gone'), { ok: false, why: 'no secret gone in kv' });
  assert.match(check('off').why, /disabled/);
  assert.match(check('old').why, /expired/);
  assert.match(check('ok', { status: 'AccessToKeyVaultDenied' }).why, /App Service says access to key vault denied/);
  assert.match(checkReference({ vault: 'elsewhere', secret: 'x' }, vaults).why, /not checked/);
  assert.equal(checkReference({ vault: 'elsewhere', secret: 'x' }, vaults, { status: 'SecretNotFound' }).ok, false);
  assert.equal(checkReference({ problem: 'bad' }, vaults).ok, false);
});

const columns = () => [
  { id: 'env:.env', label: '.env', kind: 'local', entries: [{ key: 'Api__BaseUrl', value: 'http://localhost' }, { key: 'Db__Password', value: 'dev-secret' }, { key: 'Same', value: 'x' }] },
  { id: 'env:.env.example', label: '.env.example', kind: 'local', presence: true, entries: [{ key: 'Api__BaseUrl', value: '' }, { key: 'Stripe__ApiKey', value: '' }] },
  { id: 'json:appsettings.json', label: 'appsettings.json', kind: 'local', entries: [{ key: 'Api:BaseUrl', value: 'https://api' }, { key: 'Same', value: 'x' }] },
  {
    id: 'app',
    label: 'shop-api',
    kind: 'app',
    entries: [
      { key: 'Api__BaseUrl', value: 'https://api' },
      { key: 'Db__Password', value: '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db-password/)', status: 'Resolved' },
      { key: 'Smtp__Password', value: '@Microsoft.KeyVault(VaultName=kv;SecretName=smtp)' },
      { key: 'Same', value: 'x' },
    ],
  },
  { id: 'vault', label: 'kv', vault: 'kv', kind: 'vault', entries: [{ name: 'db-password', enabled: true, expires: at(100) }, { name: 'Stripe--ApiKey', enabled: true, expires: at(3) }, { name: 'Old', enabled: false }] },
];
const vaults = () => new Map([['kv', columns()[4].entries]]);

test('the matrix: a row per key, values grouped by letter, references checked, vault secrets in their rows', () => {
  const m = driftMatrix(columns(), { vaults: vaults(), now: NOW });
  const row = (norm) => m.rows.find((r) => r.norm === norm);
  assert.deepEqual(m.rows.map((r) => r.norm), ['api:baseurl', 'db:password', 'old', 'same', 'smtp:password', 'stripe:apikey']);
  const api = row('api:baseurl');
  assert.deepEqual(api.cells.map((c) => c.state), ['value', 'present', 'value', 'value', 'missing']);
  assert.deepEqual(api.cells.map((c) => c.group), ['A', undefined, 'B', 'B', undefined]);
  assert.equal(api.differs, true);
  assert.equal(api.key, 'Api__BaseUrl');
  // The referenced secret sits in the referring setting's row, not a row of its own.
  const db = row('db:password');
  assert.deepEqual(db.cells.map((c) => c.state), ['value', 'missing', 'missing', 'ref', 'present']);
  assert.equal(db.cells[3].ref, 'kv/db-password');
  assert.equal(db.cells[4].key, 'db-password');
  assert.equal(db.differs, false);
  assert.equal(db.missing, true);
  const smtp = row('smtp:password');
  assert.equal(smtp.broken, true);
  assert.match(smtp.cells[3].why, /no secret smtp in kv/);
  assert.deepEqual(row('same').cells.map((c) => c.group ?? c.state), ['A', 'missing', 'A', 'A', 'missing']);
  assert.equal(row('same').differs, false);
  // A vault lacking a setting doesn't make it missing: the vault holds secrets, not every setting.
  assert.equal(driftMatrix([columns()[0], columns()[4]], { now: NOW }).rows.find((r) => r.norm === 'same').missing, false);
  assert.equal(row('old').broken, true);
  assert.equal(row('stripe:apikey').cells[4].state, 'present');
  assert.deepEqual(driftCounts(m.rows), { differs: 1, broken: 2, missing: 5 });
  assert.deepEqual(filterRows(m.rows, 'diff').map((r) => r.norm), ['api:baseurl', 'old', 'smtp:password']);
  assert.equal(filterRows(m.rows, 'missing').length, 5);
  assert.equal(filterRows(m.rows, 'all').length, 6);
});

test('the matrix never holds a value, and a hash means nothing outside this run', () => {
  const m = driftMatrix(columns(), { vaults: vaults(), now: NOW });
  const text = JSON.stringify(m.rows);
  for (const secret of ['dev-secret', 'http://localhost', 'https://api']) assert.ok(!text.includes(secret), secret);
  assert.ok(!text.includes(fingerprint('dev-secret')));
  assert.equal(fingerprint('a'), fingerprint('a'));
  assert.notEqual(fingerprint('a'), fingerprint('b'));
  assert.doesNotMatch(fingerprint('dev-secret'), /dev/);
  assert.deepEqual(cellMark({ state: 'value', group: 'A' }, { differs: false }), { text: '= A', tone: 'add' });
  assert.equal(cellMark({ state: 'value', group: 'B' }, { differs: true }).tone, 'warn');
  assert.equal(cellMark({ state: 'broken' }).tone, 'del');
});

test('the columns: the shown local sources, the app with its connection strings, the vault', () => {
  const local = [
    { id: 'env:.env', label: '.env', kind: 'env', entries: [] },
    { id: 'http:x:dev', label: 'http-client:dev', kind: 'http', entries: [] },
    { id: 'env:.env.example', label: '.env.example', kind: 'env', example: true, entries: [] },
  ];
  const app = { settings: { A: '1', B: '@Microsoft.KeyVault(VaultName=KV2;SecretName=s)' }, strings: { Default: { value: 'Server=x', type: 'SQLAzure' }, Other: { value: '@Microsoft.KeyVault(SecretUri=https://kv3.vault.azure.net/secrets/c)' } }, references: [{ name: 'B', status: 'Resolved' }] };
  const cols = driftColumns({ local, target: { name: 'shop-api', slot: 'staging' }, app, vault: { name: 'kv' }, vaultData: { secrets: [] } });
  assert.deepEqual(cols.map((c) => c.label), ['.env', '.env.example', 'shop-api/staging', 'kv']);
  assert.equal(cols[1].presence, true);
  assert.deepEqual(appEntries(app).map((e) => [e.key, e.status ?? null]), [['A', null], ['B', 'Resolved'], ['ConnectionStrings:Default', null], ['ConnectionStrings:Other', null]]);
  assert.deepEqual(referencedVaults(app), ['kv2', 'kv3']);
  assert.deepEqual(driftColumns({ local, choices: { 'env:.env': false, 'http:x:dev': true } }).map((c) => c.label), ['http-client:dev', '.env.example']);
  assert.ok(!isShown({ id: 'app' }, { app: false }));
});

test('the app to compare: the saved one, the only one, or the one named as the folder', () => {
  const sites = [{ id: '1', name: 'shop-api', slot: null }, { id: '2', name: 'shop-api', slot: 'staging' }, { id: '3', name: 'other', slot: null }];
  assert.equal(pickTarget(sites, { saved: { id: '2' } }).id, '2');
  assert.equal(pickTarget(sites, { saved: { id: 'gone', label: 'other' } }).id, '3');
  assert.equal(pickTarget(sites, { dir: '/src/shop-api' }).id, '1');
  assert.equal(pickTarget(sites, { dir: 'C:\\src\\Other' }).id, '3');
  assert.equal(pickTarget(sites, { dir: '/src/elsewhere' }), null);
  assert.equal(pickTarget(sites.slice(0, 2), {}).id, '1');
});

test('what runs out: soonest first, in words', () => {
  const items = [
    { name: 'later', expires: at(20) },
    { name: 'never', expires: null },
    { name: 'gone', expires: at(-3) },
    { name: 'soon', expires: at(5) },
    { name: 'far', expires: at(90) },
  ];
  assert.deepEqual(expiring(items, { days: 30, now: NOW }).map((i) => i.name), ['gone', 'soon', 'later']);
  assert.equal(expiryWords(at(-3), NOW), 'expired 3 days ago');
  assert.equal(expiryWords(at(-0.2), NOW), 'expired today');
  assert.equal(expiryWords(at(0.5), NOW), 'expires today');
  assert.equal(expiryWords(at(1), NOW), 'expires in 1 day');
  assert.equal(expiryWords(at(4.5), NOW), 'expires in 5 days');
  assert.equal(expiryWords(null, NOW), 'never expires');
  assert.equal(shortExpiry(at(4.5), NOW), '5d');
  assert.equal(shortExpiry(at(-2), NOW), '-2d');
  assert.equal(expiryTone(at(3), 30, NOW), 'del');
  assert.equal(expiryTone(at(20), 30, NOW), 'warn');
  assert.equal(expiryTone(at(60), 30, NOW), 'dim');
  assert.ok(isExpired({ expires: at(-1) }, NOW) && !isExpired({ expires: null }, NOW));
  assert.equal(expiryNotice(expiring(items, { days: 30, now: NOW }), { vault: 'kv', days: 30, now: NOW }), '3 secrets and certificates in kv have expired or expire within 30 days: gone expired 3 days ago, soon in 5 days, later in 20 days');
  assert.equal(expiryNotice([{ name: 'soon', expires: at(5) }], { days: 30, now: NOW }), '1 secret or certificate expires within 30 days: soon in 5 days');
  assert.equal(expiryNotice([], {}), null);
});
