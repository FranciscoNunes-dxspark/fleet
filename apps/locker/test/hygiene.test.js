// bilge-ignore-file: the fake secrets below are made from pieces, to be found by the hygiene check.
// The hygiene check: the judges (with a fixed clock), a run over the demo, `locker security`'s text
// and JSON, and /hygiene end to end; and that no value reaches any of it.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readActivity } from '@fleet/kit/family.js';
import { envOfSite, envOfSource, hygieneFindings, isLiteral, isSecretSetting, jsonKeyLine, jsonKeyLines, localFindings, normEnv, plainSecret, secretShape, settingFindings, sharedSecretFindings, thumbprintHex, vaultItemFindings, vaultPostureFindings, vaultUse } from '../src/hygiene.js';
import { readHygiene, relPath } from '../src/security.js';
import { parseSecurityArgs, runSecurity } from '../src/headless.js';
import { fingerprint } from '../src/drift.js';
import { demoAzure, demoLocal } from '../src/demo.js';
import { loadSubscription } from '../src/load.js';
import { vaultFrom } from '../src/azure/arm.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocal } from '../src/local.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const at = (days) => new Date(NOW + days * DAY).toISOString();

// Values that must never be shown: the demo's, and the fakes made here.
const PASSWORD = ['Hu', 'nter', '2-', 'pr0d'].join('');
const GITHUB = ['gh', 'p_', 'aB3d'.repeat(9)].join('');
const DEMO_VALUES = ['Pr0d-db-S3cret!', 'sk_live_demo_4242', 'dev-password', 'sk_test_local_4242', 'Local#123', 'local-redis', 'ZGVtby1rZXk=', 'jwt-signing-key-demo', 'legacy-0ld-t0ken', 'SG.demo-key', 'demo-salt'];
const noValueIn = (text, values = DEMO_VALUES) => {
  for (const v of values) assert.ok(!String(text).includes(v), `${v} appeared`);
};

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const secret = (name, o = {}) => ({ kind: 'secret', name, enabled: true, created: at(-30), updated: at(-30), expires: null, ...o });
const cert = (name, o = {}) => ({ kind: 'certificate', name, enabled: true, created: at(-30), updated: at(-30), expires: at(300), thumbprint: '', ...o });
const KV = { name: 'kv' };
const site = (name, slot = null, kind = 'app') => ({ id: `/x/${name}/${slot ?? ''}`, name, slot, kind, resourceGroup: 'rg' });
const rules = (list) => list.map((f) => `${f.severity} ${f.rule} ${f.where}`);

test('a vault item: expired, expiring within 7 and 30 days, no expiry, not rotated in 180 and 365 days', () => {
  const found = vaultItemFindings(
    {
      vault: KV,
      secrets: [
        secret('gone', { expires: at(-2) }),
        secret('week', { expires: at(5) }),
        secret('month', { expires: at(20) }),
        secret('later', { expires: at(90) }),
        secret('forever'),
        secret('stale', { expires: at(200), updated: at(-400) }),
        secret('aging', { expires: at(200), updated: at(-200) }),
        secret('fresh', { expires: at(200), updated: at(-179) }),
        secret('behind-cert', { managed: true, expires: at(-5) }),
      ],
    },
    { now: NOW },
  );
  assert.deepEqual(rules(found).sort(), [
    'high kv-expired kv/gone',
    'high kv-expires-7d kv/week',
    'low kv-no-expiry kv/forever',
    'low kv-stale-180d kv/aging',
    'medium kv-expires-30d kv/month',
    'medium kv-stale-365d kv/stale',
  ]);
  const gone = found.find((f) => f.name === 'gone');
  assert.match(gone.why, /expired 2 days ago/);
  assert.match(gone.fix, /\/rotate gone/);
  assert.match(found.find((f) => f.name === 'forever').fix, /az keyvault secret set-attributes --vault-name kv --name forever --expires 2027-11-03T00:00:00Z/);
  // The clock decides: a day later the 7-day one is closer, a month earlier the month one isn't yet.
  assert.equal(vaultItemFindings({ vault: KV, secrets: [secret('month', { expires: at(20) })] }, { now: NOW - 15 * DAY }).length, 0);
});

test('an expired certificate in use is critical; disabled and still referred to is high, unreferenced nothing', () => {
  const hex = 'AB'.repeat(20);
  const x5t = Buffer.from(hex, 'hex').toString('base64url');
  assert.equal(thumbprintHex(x5t), hex);
  assert.equal(thumbprintHex(hex.toLowerCase()), hex);
  assert.equal(thumbprintHex('q1w2e3'), '');
  const sites = [{ site: site('web'), settings: { WEBSITE_LOAD_CERTIFICATES: hex, Api__Key: '@Microsoft.KeyVault(VaultName=kv;SecretName=Api--Key)', Tls__Cert: '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/ref-tls/)' } }];
  const use = vaultUse(sites);
  assert.deepEqual([...use.secrets].sort(), ['kv/api--key', 'kv/ref-tls']);
  assert.deepEqual(use.by.get('kv/api--key'), ['web/Api__Key']);
  const found = vaultItemFindings(
    {
      vault: KV,
      secrets: [secret('Api--Key', { enabled: false }), secret('Old--Key', { enabled: false, expires: at(-100) })],
      certificates: [cert('loaded', { expires: at(-1), thumbprint: x5t }), cert('ref-tls', { expires: at(-1) }), cert('spare', { expires: at(-1) })],
    },
    { use, now: NOW },
  );
  assert.deepEqual(rules(found).sort(), ['critical kv-expired kv/loaded', 'critical kv-expired kv/ref-tls', 'high kv-disabled-referenced kv/Api--Key', 'high kv-expired kv/spare']);
  assert.match(found.find((f) => f.name === 'Api--Key').why, /web\/Api__Key reads it/);
  assert.match(found.find((f) => f.name === 'loaded').fix, /az keyvault certificate create --vault-name kv -n loaded/);
  // WEBSITE_LOAD_CERTIFICATES=* loads them all.
  const star = vaultItemFindings({ vault: KV, certificates: [cert('spare', { expires: at(-1) })] }, { use: vaultUse([{ site: site('w'), settings: { WEBSITE_LOAD_CERTIFICATES: '*' } }]), now: NOW });
  assert.equal(star[0].severity, 'critical');
});

test("the vault itself: purge protection off, open to every network; what ARM didn't say is nothing", () => {
  const open = { name: 'kv', posture: { purgeProtection: false, publicNetworkAccess: 'Enabled', defaultAction: 'Allow', rules: 0 } };
  assert.deepEqual(rules(vaultPostureFindings(open)), ['medium kv-purge-protection-off kv', 'low kv-public-network kv']);
  assert.deepEqual(vaultPostureFindings({ name: 'kv', posture: { purgeProtection: true, publicNetworkAccess: 'Enabled', defaultAction: 'Allow', rules: 2 } }), []);
  assert.deepEqual(vaultPostureFindings({ name: 'kv', posture: { purgeProtection: true, publicNetworkAccess: 'Disabled', defaultAction: 'Allow', rules: 0 } }), []);
  assert.deepEqual(vaultPostureFindings({ name: 'kv' }), []);
  // ARM's listing, read into a posture (enablePurgeProtection left out when off).
  const v = vaultFrom({ id: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv', name: 'kv', properties: { tenantId: 't', enableSoftDelete: true, networkAcls: { defaultAction: 'Deny', ipRules: [{ value: '1.2.3.4' }] } } });
  assert.deepEqual(v.posture, { purgeProtection: false, publicNetworkAccess: 'Enabled', defaultAction: 'Deny', rules: 1 });
  assert.equal(vaultFrom({ id: 'x', name: 'v', properties: {} }).posture, undefined);
});

test('a secret in a setting: Key Vault references, placeholders and non-secrets pass; plain secrets by name or shape do not, redacted', () => {
  assert.ok(isSecretSetting('Db__Password'));
  assert.ok(isSecretSetting('ConnectionStrings:ApiToken'));
  assert.ok(isSecretSetting('Jwt:SigningKey'));
  assert.ok(isSecretSetting('Stripe--ApiKey'));
  assert.ok(!isSecretSetting('APPINSIGHTS_INSTRUMENTATIONKEY'));
  assert.ok(!isSecretSetting('Storage:PartitionKey'));
  assert.ok(!isSecretSetting('Features__Search'));
  assert.ok(!isSecretSetting('WEBSITE_LOAD_CERTIFICATES'));
  assert.equal(plainSecret('Db__Password', '@Microsoft.KeyVault(SecretUri=https://kv.vault.azure.net/secrets/db/)'), null);
  assert.equal(plainSecret('Db__Password', ' @microsoft.keyvault(VaultName=kv;SecretName=db)'), null);
  for (const v of ['', '${DB_PASSWORD}', '#{DbPassword}#', 'changeme', 'true', '30', '<your password>', 'https://login.example/token']) assert.equal(plainSecret('Db__Password', v), null, v);
  assert.equal(plainSecret('Features__Search', 'enabled-everywhere'), null);
  assert.equal(plainSecret('ConnectionStrings:Default', 'Server=tcp:x.database.windows.net;Database=d;Authentication=Active Directory Default'), null);
  assert.ok(!isLiteral('${X}') && isLiteral(PASSWORD));

  const named = plainSecret('Db__Password', PASSWORD);
  assert.equal(named.shape, null);
  assert.ok(!named.excerpt.includes(PASSWORD));
  assert.match(named.excerpt, /^Db__Password=Hunt•+$/);
  const shaped = plainSecret('Deploy', `token ${GITHUB}`);
  assert.equal(shaped.shape.id, 'github-token');
  assert.ok(!shaped.excerpt.includes(GITHUB));
  const conn = plainSecret('ConnectionStrings:Default', `Server=sql;Database=shop;User Id=sa;Password=${PASSWORD}`);
  assert.equal(conn.shape.id, 'connection-password');
  assert.ok(!conn.excerpt.includes(PASSWORD));
  assert.equal(secretShape('nothing to see'), null);
});

test("an app's settings: plain secrets are high with the az fix; a slot's reference against another's plain value is medium", () => {
  const app = site('shop-api');
  const staging = site('shop-api', 'staging');
  const fn = site('shop-fn', null, 'function');
  const found = settingFindings(
    [
      { site: app, settings: { Redis__Password: PASSWORD, Smtp__Password: '@Microsoft.KeyVault(VaultName=kv-shop;SecretName=Smtp--Password)' }, strings: { Default: { value: `Server=s;Database=d;User Id=u;Password=${PASSWORD}`, type: 'SQLAzure' } } },
      { site: staging, settings: { Redis__Password: '@Microsoft.KeyVault(VaultName=kv-shop;SecretName=Redis--Password)', Smtp__Password: 'smtp-plain-value' } },
      { site: fn, settings: { Api__Token: GITHUB } },
    ],
    { vault: 'kv-shop' },
  );
  assert.deepEqual(rules(found).sort(), [
    'high plain-secret-setting shop-api/ConnectionStrings:Default',
    'high plain-secret-setting shop-api/Redis__Password',
    'high plain-secret-setting shop-api/staging/Smtp__Password',
    'high plain-secret-setting shop-fn/Api__Token',
    'medium slot-reference-mismatch shop-api/Redis__Password',
    'medium slot-reference-mismatch shop-api/staging/Smtp__Password',
  ]);
  const by = (rule, where) => found.find((f) => f.rule === rule && f.where === where);
  assert.match(by('plain-secret-setting', 'shop-api/Redis__Password').fix, /az keyvault secret set --vault-name kv-shop --name Redis--Password --file <a file holding it>.*az webapp config appsettings set -g rg -n shop-api --settings "Redis__Password=@Microsoft\.KeyVault\(VaultName=kv-shop;SecretName=Redis--Password\)"/);
  assert.match(by('plain-secret-setting', 'shop-api/staging/Smtp__Password').fix, / --slot staging /);
  assert.match(by('plain-secret-setting', 'shop-fn/Api__Token').fix, /az functionapp config appsettings set -g rg -n shop-fn/);
  assert.match(by('plain-secret-setting', 'shop-fn/Api__Token').title, /GitHub token/);
  assert.match(by('plain-secret-setting', 'shop-api/ConnectionStrings:Default').fix, /az webapp config connection-string set -g rg -n shop-api --connection-string-type SQLAzure --settings "Default=@Microsoft\.KeyVault\(VaultName=kv-shop;SecretName=ConnectionStrings--Default\)"/);
  assert.match(by('slot-reference-mismatch', 'shop-api/Redis__Password').why, /shop-api\/staging reads Redis__Password from Key Vault/);
  noValueIn(JSON.stringify(found), [PASSWORD, GITHUB, 'smtp-plain-value']);
});

test('the folder: a secret in a file git tracks is high, with its line; ignored files, examples and user secrets are fine', () => {
  const sources = [
    { id: 'env:.env', kind: 'env', label: '.env', file: '/p/.env', entries: [{ key: 'Db__Password', value: PASSWORD, line: 2 }] },
    { id: 'env:.env.production', kind: 'env', label: '.env.production', file: '/p/.env.production', entries: [{ key: 'Api__Token', value: GITHUB, line: 1 }, { key: 'Api__BaseUrl', value: 'https://x', line: 2 }] },
    { id: 'env:.env.example', kind: 'env', label: '.env.example', file: '/p/.env.example', example: true, entries: [{ key: 'Db__Password', value: 'real-looking-value', line: 1 }] },
    { id: 'json:appsettings.json', kind: 'appsettings', label: 'appsettings.json', file: '/p/appsettings.json', entries: [{ key: 'ConnectionStrings:Default', value: `Server=s;Database=d;User Id=u;Password=${PASSWORD}`, line: 3 }] },
    { id: 'secrets:x', kind: 'usersecrets', label: 'user secrets (Api)', file: '/home/u/.microsoft/usersecrets/x/secrets.json', entries: [{ key: 'Db:Password', value: PASSWORD }] },
  ];
  const tracked = new Set(['.env.production', '.env.example', 'appsettings.json']);
  const found = localFindings(sources, { tracked: (s) => tracked.has(relPath('/p', s.file)), rel: (f) => relPath('/p', f) });
  assert.deepEqual(found.map((f) => `${f.rule} ${f.where}:${f.line}`).sort(), ['secret-in-git .env.production:1', 'secret-in-git appsettings.json:3']);
  assert.match(found.find((f) => f.where === '.env.production').fix, /git rm --cached \.env\.production/);
  assert.match(found.find((f) => f.where === 'appsettings.json').fix, /dotnet user-secrets set "ConnectionStrings:Default"/);
  // Not knowing what git tracks is no finding.
  assert.deepEqual(localFindings(sources, { tracked: null }), []);
  noValueIn(JSON.stringify(found), [PASSWORD, GITHUB]);
  assert.equal(relPath('C:\\p', 'C:\\p\\sub\\.env'), 'sub/.env');
  assert.equal(jsonKeyLine('{\n  "Logging": { "Default": "x" },\n  "Db": {\n    "Password": "p"\n  }\n}', 'Db:Password'), 4);
  assert.equal(jsonKeyLine('{}', 'Nope'), null);
});

test('jsonKeyLines finds what jsonKeyLine does, in any case, past an earlier mention, and fast over a big appsettings file', () => {
  const text = '{\n  "Db": { "Host": "x" },\n  "Api": {\n    "db": "y",\n    "Key": "k", "Other": 1\n  },\n  "\u00c9t\u00e9": { "Key": 2 }\n}';
  const lineOf = jsonKeyLines(text);
  for (const key of ['Db', 'db:host', 'Api:Db', 'API:key', 'Api:Other', 'Api:Nope', 'Db:Key', '0:Api', 'Été:Key', 'Key', 'a"b']) assert.equal(lineOf(key), jsonKeyLine(text, key), key);
  assert.equal(lineOf('Api:db'), 4);
  assert.equal(lineOf('Db:Key'), 5);
  // Thousands of keys: each was a search of the whole file, read again (seconds); now it is indexed once.
  const big = {};
  for (let i = 0; i < 8000; i++) (big[`Section${i % 50}`] ??= {})[`Key${i}`] = `v${i}`;
  const bigText = JSON.stringify(big, null, 2);
  const lines = bigText.split('\n');
  const started = Date.now();
  const find = jsonKeyLines(bigText);
  for (let i = 0; i < 8000; i++) assert.equal(lines[find(`Section${i % 50}:Key${i}`) - 1].trim().startsWith(`"Key${i}"`), true);
  assert.ok(Date.now() - started < 1000, `${Date.now() - started} ms`);
});

test('the same secret in two environments, found by its keyed hash: prod and dev medium, two others low, one environment nothing', () => {
  assert.equal(normEnv('Prod'), 'production');
  assert.equal(normEnv('local'), 'development');
  assert.equal(normEnv('UAT'), 'staging');
  assert.equal(normEnv('qa'), 'test');
  assert.equal(envOfSource({ kind: 'env', label: '.env' }), 'development');
  assert.equal(envOfSource({ kind: 'env', label: '.env.production' }), 'production');
  assert.equal(envOfSource({ kind: 'appsettings', label: 'appsettings.json' }), null);
  assert.equal(envOfSource({ kind: 'appsettings', label: 'appsettings.Staging.json' }), 'staging');
  assert.equal(envOfSource({ kind: 'usersecrets', label: 'user secrets (Api)' }), 'development');
  assert.equal(envOfSource({ kind: 'http', label: 'http-client:prod' }), 'production');
  assert.equal(envOfSite({ name: 'a', slot: null }), 'production');
  assert.equal(envOfSite({ name: 'a', slot: 'staging' }), 'staging');

  const h = (v) => fingerprint(v);
  const holders = [
    { env: 'development', where: '.env', line: 3, key: 'Redis__Password', hash: h(PASSWORD), scope: 'file' },
    { env: 'production', where: 'shop-api/Redis__Password', key: 'Redis__Password', hash: h(PASSWORD), scope: 'app' },
    { env: 'development', where: '.env', line: 4, key: 'Db__Password', hash: h('dev-only-1'), scope: 'file' },
    { env: 'development', where: 'user secrets', key: 'Db:Password', hash: h('dev-only-1'), scope: 'local' },
    { env: 'staging', where: 'shop-api/staging/Api__Token', key: 'Api__Token', hash: h(GITHUB), scope: 'app' },
    { env: 'test', where: '.env.test', line: 1, key: 'Api__Token', hash: h(GITHUB), scope: 'file' },
  ];
  const found = sharedSecretFindings(holders);
  assert.deepEqual(rules(found), ['medium shared-across-environments shop-api/Redis__Password', 'low shared-across-environments shop-api/staging/Api__Token']);
  assert.equal(found[0].title, 'The same secret in development and production');
  assert.match(found[0].why, /\.env:3 \(Redis__Password\) \(development\)/);
  noValueIn(JSON.stringify(found), [PASSWORD, GITHUB, 'dev-only-1']);
});

test('over the demo: everything planted is found, from listings and shapes, without reading a vault value', async () => {
  const provider = demoAzure({ now: NOW });
  const local = demoLocal();
  const azure = await loadSubscription(provider);
  const target = azure.sites.find((s) => s.name === 'shop-api' && !s.slot);
  const vault = azure.vaults.find((v) => v.name === 'kv-shop');
  const read = await readHygiene({ provider, local, azure, target, vault });
  assert.deepEqual(read.scope.sites, ['shop-api', 'shop-api/staging']);
  assert.deepEqual(read.scope.vaults, ['kv-shop']);
  const found = hygieneFindings(read, { now: NOW });
  assert.deepEqual(rules(found), [
    'high secret-in-git appsettings.json',
    'high kv-expired kv-shop/old-token',
    'high kv-expires-7d kv-shop/Stripe--ApiKey',
    'high plain-secret-setting shop-api/Redis__Password',
    'medium kv-purge-protection-off kv-shop',
    'medium kv-stale-365d kv-shop/old-token',
    'medium kv-expires-30d kv-shop/shop-tls',
    'medium slot-reference-mismatch shop-api/Redis__Password',
    'medium shared-across-environments shop-api/Redis__Password',
    'low kv-public-network kv-shop',
    'low kv-no-expiry kv-shop/Redis--Password',
    'low kv-stale-180d kv-shop/Stripe--ApiKey',
  ]);
  assert.equal(found[0].line, 14);
  // .env holds the same Redis password, but git ignores it: shared, not committed.
  assert.ok(!found.some((f) => f.rule === 'secret-in-git' && f.where === '.env'));
  const all = hygieneFindings(await readHygiene({ provider, local, azure, target, vault, all: true }), { now: NOW });
  assert.ok(all.some((f) => f.rule === 'kv-expires-7d' && f.where === 'kv-shared/partner-tls'));
  assert.ok(all.some((f) => f.rule === 'kv-stale-365d' && f.where === 'kv-shared/Shared--Salt'));
  assert.ok(!provider.state.calls.some(([op]) => op === 'secretValue'), 'a vault value was read');
  noValueIn(JSON.stringify(found));
  noValueIn(JSON.stringify(all));
});

test('every vault is listed a few at a time, in its order, and one that fails is a problem', async () => {
  const provider = demoAzure({ now: NOW });
  const local = demoLocal();
  for (let i = 0; i < 10; i++) provider.state.vaults.push({ ...provider.state.vaults[0], id: `${provider.state.vaults[0].id}-${i}`, name: `kv-more-${i}` });
  let open = 0;
  let most = 0;
  const secrets = provider.secrets;
  provider.secrets = async (v, opts) => {
    open++;
    most = Math.max(most, open);
    await new Promise((r) => setTimeout(r, 20));
    open--;
    if (v.name === 'kv-more-3') throw new Error('Forbidden\nmore');
    return secrets(v, opts);
  };
  const azure = await loadSubscription(provider);
  const read = await readHygiene({ provider, local, azure, all: true });
  assert.deepEqual(read.scope.vaults, azure.vaults.map((v) => v.name).filter((n) => n !== 'kv-more-3'));
  assert.ok(read.problems.includes('kv-more-3: Forbidden'));
  assert.ok(most > 1 && most <= 4, `${most} at once`);
});

test('locker security: text, JSON and SARIF over the demo, the exit code by --fail-on, never a value', async () => {
  assert.deepEqual(parseSecurityArgs(['proj', '--json', '--fail-on', 'MEDIUM', '--app', 'shop-api/staging']), { dir: 'proj', json: true, sarif: false, failOn: 'medium', app: 'shop-api/staging', vault: null, all: false });
  assert.match(parseSecurityArgs(['--fail-on', 'bad']).error, /--fail-on/);
  assert.match(parseSecurityArgs(['--json', '--sarif']).error, /not both/);
  const run = async (args) => {
    let out = '';
    const code = await runSecurity(args, { provider: demoAzure({ now: NOW }), local: demoLocal(), config: {}, write: (s) => (out += s), now: NOW });
    return { code, out };
  };
  const text = await run([]);
  assert.equal(text.code, 1);
  assert.match(text.out, /^Secret hygiene in .*shop-api, shop-api\/staging, kv-shop\n/);
  assert.match(text.out, /HIGH Secret in a plain setting {2}shop-api\/Redis__Password/);
  assert.match(text.out, /4 high · 5 medium · 3 low · failing on high and above/);
  noValueIn(text.out);

  const json = await run(['--json', '--fail-on', 'none']);
  assert.equal(json.code, 0);
  const doc = JSON.parse(json.out);
  assert.equal(doc.app, 'locker');
  assert.equal(doc.check, 'hygiene');
  assert.equal(doc.site, 'shop-api');
  assert.deepEqual(doc.vaults, ['kv-shop']);
  assert.deepEqual(doc.counts, { critical: 0, high: 4, medium: 5, low: 3, unknown: 0 });
  assert.equal(doc.at, new Date(NOW).toISOString());
  assert.ok(doc.findings.every((f) => !('excerpt' in f)), 'an excerpt in the JSON');
  assert.deepEqual(doc.findings[0], { ...doc.findings[0], rule: 'secret-in-git', where: 'appsettings.json', line: 14, severity: 'high' });
  noValueIn(json.out);

  const crit = await run(['--fail-on', 'critical']);
  assert.equal(crit.code, 0);
  const sarif = JSON.parse((await run(['--sarif'])).out);
  const results = sarif.runs[0].results;
  assert.equal(results.find((r) => r.ruleId === 'secret-in-git').locations[0].physicalLocation.artifactLocation.uri, 'appsettings.json');
  assert.equal(results.find((r) => r.ruleId === 'kv-expired').locations[0].physicalLocation.artifactLocation.uri, '.');
  noValueIn(JSON.stringify(sarif));

  assert.equal((await run(['--app', 'nope'])).code, 2);
  assert.equal((await run(['--wat'])).code, 2);
  // Without Azure, the folder alone, and it says so.
  let out = '';
  const offline = { ...demoAzure(), subscriptions: async () => Promise.reject(new Error("Please run 'az login' to setup account.")), currentSubscription: async () => null };
  const code = await runSecurity([], { provider: offline, local: demoLocal(), write: (s) => (out += s), now: NOW });
  assert.equal(code, 1);
  assert.match(out, /appsettings\.json:14/);
  assert.match(out, /Not read: Azure wasn't read: The Azure CLI is not signed in/);
});

test('/hygiene lists the findings worst first; ↵ shows one without its value, y copies its name, s shows it in the Vault view', async () => {
  const app = start();
  await until(shows(app, '✗ broken'), 'the matrix');
  await type(app.stdin, '/hygiene');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Secret hygiene: shop-api · shop-api, shop-api/staging · kv-shop'), 'the list');
  const list = app.lastFrame();
  assert.match(list, /❯ HIGH Password in a connection string in a file git.* +appsettings\.json:14/);
  assert.match(list, /MED +Purge protection off/);
  assert.match(list, /4 high · 5 medium · 3 low/);
  noValueIn(list);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'secret-in-git'), 'the details');
  const detail = app.lastFrame();
  assert.match(detail, /appsettings\.json:14/);
  assert.match(detail, /dotnet user-secrets set/);
  assert.match(detail, /Password=Loca•+/);
  noValueIn(detail);
  app.stdin.write('y');
  await until(() => app.copied.length === 1, 'the name copied');
  assert.equal(app.copied[0], 'ConnectionStrings:Default');
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'MED  Purge protection off'), 'back to the list');
  // One row at a time, each move seen drawn before the next, so the cursor never runs past it.
  const cursorLine = () => app.lastFrame().split('\n').find((l) => l.includes('❯')) ?? '';
  for (let i = 0; i < 12 && !cursorLine().includes('Purge protection off'); i++) {
    const was = cursorLine();
    app.stdin.write('j');
    await until(() => cursorLine() !== was, 'the cursor moved');
  }
  assert.match(cursorLine(), /Purge protection off/);
  app.stdin.write('f');
  await until(() => app.copied.length === 2, 'the fix copied');
  assert.equal(app.copied[1], "az keyvault update --name kv-shop --enable-purge-protection true (it can't be turned off again).");
  app.stdin.write('s');
  await until(shows(app, 'Vault kv-shop'), 'the Vault view');
  assert.ok(!app.provider.state.calls.some(([op]) => op === 'secretValue'), 'a vault value was read');
  assert.deepEqual(app.secrets, []);
  noValueIn(app.lastFrame());
  noValueIn(JSON.stringify(readActivity({ limit: 1000 })));
  app.unmount();
});

test("a real folder: the files git tracks are found, a .env git ignores isn't, and outside a checkout nothing is said", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locker-hygiene-'));
  try {
    const local = createLocal({ dir });
    assert.equal(await local.tracked(), null);
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    writeFileSync(join(dir, '.env'), `Db__Password=${PASSWORD}\n`);
    writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ Db: { Password: PASSWORD } }, null, 2));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    assert.deepEqual((await local.tracked()).sort(), ['.gitignore', 'appsettings.json']);
    const read = await readHygiene({ local });
    const found = hygieneFindings(read, { now: NOW });
    assert.deepEqual(found.map((f) => `${f.rule} ${f.where}:${f.line}`), ['secret-in-git appsettings.json:3']);
    noValueIn(JSON.stringify(found), [PASSWORD]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
