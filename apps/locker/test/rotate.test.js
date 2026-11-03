// /rotate: the pure parts (the new value, which settings refer to a secret, the health address and the
// wait), and the whole checklist end to end over the demo Azure: nothing reaches Azure, and the new value
// reaches neither the screen nor the family's folder.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActivity, readMoods } from '@fleet/kit/family.js';
import { healthUrl, newValue, referencesTo, waitHealthy } from '../src/rotate.js';
import { DB_VERSION, demoLocal } from '../src/demo.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const familyText = () => JSON.stringify(readActivity({ limit: 1000 })) + JSON.stringify(readMoods('splice'));

test('a new value is 32 random bytes in base64url', () => {
  const a = newValue();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, 'base64url').length, 32);
  assert.notEqual(a, newValue());
});

test("the settings and connection strings that refer to a secret, latest or pinned to a version", () => {
  const settings = {
    A: '@Microsoft.KeyVault(SecretUri=https://kv-shop.vault.azure.net/secrets/db-password/)',
    B: '@Microsoft.KeyVault(VaultName=KV-Shop;SecretName=DB-PASSWORD;SecretVersion=abc123)',
    C: '@Microsoft.KeyVault(SecretUri=https://kv-other.vault.azure.net/secrets/db-password/)',
    D: 'db-password',
  };
  const strings = { Default: { value: '@Microsoft.KeyVault(SecretUri=https://kv-shop.vault.azure.net/secrets/db-password/def456)' } };
  assert.deepEqual(referencesTo({ settings, strings }, 'kv-shop', 'db-password'), [
    { key: 'A', version: null },
    { key: 'B', version: 'abc123' },
    { key: 'ConnectionStrings:Default', version: 'def456' },
  ]);
  assert.deepEqual(referencesTo({}, 'kv-shop', 'db-password'), []);
});

test("an app's health address, and the wait until it answers 2xx or the time is up", async () => {
  assert.equal(healthUrl({ hostName: 'a.azurewebsites.net' }), 'https://a.azurewebsites.net/');
  assert.equal(healthUrl({ hostName: 'a.azurewebsites.net' }, 'healthz'), 'https://a.azurewebsites.net/healthz');
  assert.equal(healthUrl({ hostName: null }, '/'), null);
  const answers = [{ status: 503 }, { status: 0, error: 'ECONNRESET' }, { status: 204 }];
  const heard = [];
  const ok = await waitHealthy(async () => answers.shift(), 'https://a/', { every: 1, timeout: 1000, onTry: (a, n) => heard.push([a.status, n]) });
  assert.deepEqual(ok, { ok: true, status: 204, tries: 3 });
  assert.deepEqual(heard, [[503, 1], [0, 2], [204, 3]]);
  let t = 0;
  const late = await waitHealthy(async () => ({ status: 502 }), 'https://a/', { every: 1, timeout: 10, now: () => (t += 4) });
  assert.equal(late.ok, false);
  assert.equal(late.status, 502);
  const stop = new AbortController();
  const waiting = waitHealthy(async () => ({ status: 503 }), 'https://a/', { every: 10_000, timeout: 60_000, signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(waiting, (e) => e.cancelled);
});

/** Waits for the question and answers it with ↵ (its first option). */
async function answer(app, title) {
  await until(shows(app, title), title);
  app.stdin.write(KEYS.enter);
  await until(() => !app.lastFrame().includes(title), `${title} answered`);
}

test('/rotate sets a generated value, restarts what reads the latest version, checks it, hands Sonar the pinned one and disables the old version', async () => {
  const app = start();
  await until(shows(app, 'shop-api · kv-shop'), 'loaded');
  await until(() => app.lastFrame().includes('✗ broken'), 'the vault read');
  await type(app.stdin, '/rotate db-password');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Rotating db-password in kv-shop'), 'the checklist');
  await answer(app, 'A new value for db-password in kv-shop');
  await answer(app, 'Set a new version of db-password in kv-shop?');
  await until(shows(app, 'Restart shop-api, shop-api/staging so they read the new version now?'), 'the restart question');
  assert.match(app.lastFrame(), /shop-functions: Db__Password pinned to 0a1b2c3d/);
  app.stdin.write(KEYS.enter);
  await until(shows(app, `Disable db-password's previous version (${DB_VERSION.slice(0, 8)}) in kv-shop?`), 'the last question');
  assert.match(app.lastFrame(), /shop-functions's Db__Password still reads it/);
  assert.match(app.lastFrame(), /shop-api answered 200 at https:\/\/shop-api\.azurewebsites\.net\//);
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([op]) => op === 'disableVersion'), 'the old version disabled');
  await until(() => app.copied.length === 1, 'the line for Sonar');
  assert.equal(app.copied[0], '/appsettings shop-functions');
  const calls = app.provider.state.calls.filter(([op]) => op !== 'secretValue');
  assert.deepEqual(calls, [
    ['setSecret', 'kv-shop', 'db-password'],
    ['restart', 'shop-api'],
    ['restart', 'shop-api/staging'],
    ['probe', 'https://shop-api.azurewebsites.net/'],
    ['probe', 'https://shop-api-staging.azurewebsites.net/'],
    ['disableVersion', 'kv-shop', 'db-password', DB_VERSION],
  ]);
  const value = app.provider.state.values.get('kv-shop/db-password');
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  await until(() => readActivity().filter((e) => e.app === 'locker').length >= 6, 'every step logged');
  const said = readActivity().filter((e) => e.app === 'locker').map((e) => e.text).reverse();
  assert.deepEqual(said.slice(0, 6), [
    'Rotation of db-password in kv-shop: set a new version',
    'Rotation of db-password in kv-shop: restarted shop-api',
    'Rotation of db-password in kv-shop: restarted shop-api/staging',
    'Rotation of db-password in kv-shop: shop-api answered 200 after its restart',
    'Rotation of db-password in kv-shop: shop-api/staging answered 200 after its restart',
    `Rotation of db-password in kv-shop: disabled the previous version ${DB_VERSION.slice(0, 8)}`,
  ]);
  assert.ok(!familyText().includes(value), "the new value reached the family's folder");
  assert.ok(!app.lastFrame().includes(value), 'the new value was shown');
  await until(shows(app, "Copied for Sonar: paste it into Sonar's prompt."), 'the hand-off');
  app.unmount();
});

test("/rotate takes a pasted value, checks the environment's health path, and esc stops it while it waits", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locker-project-'));
  try {
    mkdirSync(join(dir, '.fleet'));
    writeFileSync(join(dir, '.fleet', 'project.json'), JSON.stringify({ environments: { dev: { locker: { vault: 'kv-shop', app: 'shop-api', healthPath: '/healthz' } } } }));
    const app = start({ local: demoLocal({ dir }), cwd: dir });
    // The app keeps failing its check, so the rotation waits there.
    app.provider.state.health['shop-api.azurewebsites.net'] = Array(100).fill(503);
    await until(shows(app, 'shop-api · kv-shop'), 'loaded');
    await until(() => app.lastFrame().includes('✗ broken'), 'the vault read');
    app.stdin.write('2');
    await until(shows(app, 'Redis--Password'), 'the Vault view');
    for (let i = 0; i < 8 && !app.lastFrame().split('\n').some((l) => l.includes('❯') && l.includes('db-password')); i++) {
      app.stdin.write('j');
      await new Promise((r) => setTimeout(r, 30));
    }
    app.stdin.write('r');
    await until(shows(app, 'A new value for db-password in kv-shop'), 'the first question');
    app.stdin.write('2');
    await until(shows(app, 'The new value of db-password in kv-shop'), 'the hidden field');
    await type(app.stdin, 'pasted-n3w-value');
    assert.ok(!app.lastFrame().includes('pasted-n3w-value'));
    app.stdin.write(KEYS.enter);
    await answer(app, 'Set a new version of db-password in kv-shop?');
    await answer(app, 'Restart shop-api, shop-api/staging');
    await until(shows(app, '503 at https://shop-api.azurewebsites.net/healthz'), 'the check waiting');
    app.stdin.write(KEYS.esc);
    await until(() => readActivity().some((e) => /stopped after the new version was set/.test(e.text)), 'the stop logged');
    assert.equal(app.provider.state.values.get('kv-shop/db-password'), 'pasted-n3w-value');
    assert.ok(!app.provider.state.calls.some(([op]) => op === 'disableVersion'), 'the old version kept');
    assert.ok(!familyText().includes('pasted-n3w-value'));
    app.unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/rotate stops before anything changes when the first question is answered no', async () => {
  const app = start();
  await until(() => app.lastFrame().includes('✗ broken'), 'the vault read');
  await type(app.stdin, '/rotate Redis--Password');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'A new value for Redis--Password in kv-shop'), 'the first question');
  app.stdin.write('3');
  await until(shows(app, 'stopped, nothing was changed'), 'stopped');
  assert.ok(!app.provider.state.calls.some(([op]) => op === 'setSecret'));
  // The checklist stays to be read until esc.
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('╭─ Rotating Redis--Password'), 'the checklist closed');
  await type(app.stdin, '/rotate nope');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No secret nope in kv-shop.'), 'an unknown secret');
  app.unmount();
});
