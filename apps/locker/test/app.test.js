// End to end: App over the demo Azure and folder, typing keys and reading the frame. Nothing reaches
// Azure, the clipboard or a real file; and no value reaches the activity log or the moods.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeContext, readActivity, readMoods } from '@fleet/kit/family.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const VALUES = ['Pr0d-db-S3cret!', 'sk_live_demo_4242', 'dev-password', 'sk_test_local_4242', 'Local#123', 'local-redis', 'hunter2-rotated'];
/** Everything the family's folder holds, as text: activity and moods. */
const familyText = () => {
  let text = JSON.stringify(readActivity({ limit: 1000 }));
  for (const app of ['splice', 'sonar']) text += JSON.stringify(readMoods(app));
  return text;
};
const noValues = () => {
  const text = familyText();
  for (const v of VALUES) assert.ok(!text.includes(v), `${v} reached the family's folder`);
};

/** Moves the drift view's cursor onto the row of `key`. */
async function onRow(app, key) {
  for (let i = 0; i < 30 && !app.lastFrame().split('\n').some((l) => l.includes('❯') && l.includes(key)); i++) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(app.lastFrame().split('\n').some((l) => l.includes('❯') && l.includes(key)), `the cursor on ${key}`);
}

test('the drift view compares the folder, the app named as the folder, and its vault, without a value', async () => {
  const app = start();
  await until(shows(app, 'shop-api · kv-shop'), 'the app and vault picked');
  await until(shows(app, '✗ broken'), 'the references checked');
  const frame = app.lastFrame();
  assert.match(frame, /Smtp__Password/);
  assert.match(frame, /→ vault/);
  assert.match(frame, /= A/);
  assert.match(frame, /3 expiring/);
  for (const v of VALUES) assert.ok(!frame.includes(v), v);
  app.unmount();
});

test('d shows only what differs or is broken, m only what is missing, again all', async () => {
  const app = start();
  await until(shows(app, '✗ broken'), 'the matrix');
  app.stdin.write('d');
  await until(shows(app, 'only what differs'), 'the filter');
  assert.doesNotMatch(app.lastFrame(), /Redis__Password/);
  assert.match(app.lastFrame(), /Api__BaseUrl/);
  app.stdin.write('d');
  await until(shows(app, 'Redis__Password'), 'every key again');
  app.stdin.write('m');
  await until(shows(app, 'only what is missing'), 'the missing filter');
  app.unmount();
});

test('↵ says where a key is; v shows its values, the vault read now, until esc', async () => {
  const app = start();
  await until(shows(app, '✗ broken'), 'the matrix');
  await onRow(app, 'Db__Password');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'the secret db-password'), 'where it is');
  assert.match(app.lastFrame(), /→ kv-shop\/db-password/);
  assert.ok(!app.lastFrame().includes('Pr0d-db-S3cret!'));
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('the secret db-password'), 'closed');
  app.stdin.write('v');
  await until(shows(app, 'Pr0d-db-S3cret!'), 'the vault value');
  assert.match(app.lastFrame(), /dev-password/);
  assert.deepEqual(app.provider.state.calls, [['secretValue', 'kv-shop', 'db-password']]);
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Pr0d-db-S3cret!'), 'the values gone');
  // /last never has them.
  await type(app.stdin, '/last');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'values shown until esc'), '/last');
  assert.ok(!app.lastFrame().includes('Pr0d-db-S3cret!'));
  noValues();
  app.unmount();
});

test('y asks, then copies the value through the guard; the activity log says what, never the value', async () => {
  const app = start();
  await until(shows(app, '✗ broken'), 'the matrix');
  await onRow(app, 'Db__Password');
  app.stdin.write('y');
  await until(shows(app, "Copy Db__Password's value from"), 'the list of sources');
  // .env, user secrets and the vault have one: pick the vault (the last; alt+g).
  app.stdin.write('\x1bg');
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write(KEYS.enter);
  await until(shows(app, "Copy Db__Password's value from kv-shop to the clipboard?"), 'the question');
  assert.match(app.lastFrame(), /cleared from the clipboard after 30 s/);
  app.stdin.write(KEYS.enter);
  await until(() => app.secrets.length === 1, 'the copy');
  assert.equal(app.secrets[0], 'Pr0d-db-S3cret!');
  assert.deepEqual(app.copied, []);
  await until(() => readActivity().some((e) => e.app === 'locker'), 'the activity');
  const entry = readActivity().find((e) => e.app === 'locker');
  assert.deepEqual([entry.kind, entry.text], ['secret', "Copied Db__Password's value from kv-shop to the clipboard"]);
  noValues();
  app.unmount();
});

test('a adds a missing key to .env with the value from another source, after asking', async () => {
  const app = start();
  await until(shows(app, '✗ broken'), 'the matrix');
  await onRow(app, 'Stripe__ApiKey');
  app.stdin.write('a');
  await until(shows(app, 'Add Stripe__ApiKey to .env from'), 'the list of sources');
  // The user secrets' value, the first.
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Add Stripe__ApiKey to .env, with the value from user secrets (Shop.Api)?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.local.state.calls.length === 1, 'the write');
  assert.match(app.local.state.files['.env'], /\nStripe__ApiKey=sk_test_local_4242\n$/);
  await until(() => readActivity().some((e) => e.app === 'locker'), 'the activity');
  assert.equal(readActivity()[0].text, 'Added Stripe__ApiKey to .env (the value from user secrets (Shop.Api))');
  noValues();
  // Read again: .env has it now.
  await until(() => !app.lastFrame().split('\n').find((l) => l.includes('Stripe__ApiKey'))?.match(/^\W*Stripe__ApiKey\s+· missing/), '.env read again');
  app.unmount();
});

test('the Vault view: e sets a new version, typed hidden and asked about; x disables after asking', async () => {
  const app = start();
  await until(shows(app, 'shop-api · kv-shop'), 'the vault');
  app.stdin.write('2');
  await until(shows(app, 'Vault kv-shop'), 'the Vault view');
  await until(shows(app, 'Stripe--ApiKey'), 'its secrets');
  assert.match(app.lastFrame(), /expires in 5 days/);
  assert.match(app.lastFrame(), /Certificates 2/);
  for (let i = 0; i < 6 && !app.lastFrame().split('\n').some((l) => l.includes('❯') && l.includes('Stripe--ApiKey')); i++) {
    app.stdin.write('j');
    await new Promise((r) => setTimeout(r, 30));
  }
  app.stdin.write('e');
  await until(shows(app, 'A new value for Stripe--ApiKey in kv-shop'), 'the hidden field');
  await type(app.stdin, 'hunter2-rotated');
  assert.ok(!app.lastFrame().includes('hunter2-rotated'));
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Set a new version of Stripe--ApiKey in kv-shop?'), 'the question');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([op]) => op === 'setSecret'), 'the set');
  assert.equal(app.provider.state.values.get('kv-shop/Stripe--ApiKey'), 'hunter2-rotated');
  await until(() => readActivity().some((e) => /new version/.test(e.text)), 'the activity');
  assert.equal(readActivity()[0].text, 'Set a new version of the secret Stripe--ApiKey in kv-shop');
  // Read again: it no longer expires.
  await until(() => !app.lastFrame().includes('expires in 5 days'), 'the vault read again');
  app.stdin.write('x');
  await until(shows(app, 'Disable Stripe--ApiKey in kv-shop?'), 'the question');
  assert.match(app.lastFrame(), /Stripe__ApiKey refers to it/);
  app.stdin.write('2');
  await until(() => !app.lastFrame().includes('Disable Stripe--ApiKey'), 'answered no');
  assert.ok(!app.provider.state.calls.some(([op]) => op === 'disableSecret'));
  app.stdin.write('x');
  await until(shows(app, 'Disable Stripe--ApiKey in kv-shop?'), 'asked again');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some(([op]) => op === 'disableSecret'), 'the disable');
  await until(shows(app, 'disabled'), 'shown disabled');
  noValues();
  app.unmount();
});

test('what expires is listed soonest first, said once on start, and worries Hush', async () => {
  const app = start();
  await until(() => app.notified.length === 1, 'the notification');
  assert.equal(app.notified[0].title, 'Locker');
  assert.match(app.notified[0].body, /^3 secrets and certificates in kv-shop have expired or expire within 30 days: old-token expired 3 days ago, Stripe--ApiKey in 5 days, shop-tls in 2\d days$/);
  app.stdin.write('3');
  await until(shows(app, 'within 30 days · soonest first'), 'the Expiry view');
  const frame = app.lastFrame();
  assert.ok(frame.indexOf('old-token') < frame.indexOf('Stripe--ApiKey') && frame.indexOf('Stripe--ApiKey') < frame.indexOf('shop-tls'));
  assert.doesNotMatch(frame, /api-client/);
  await until(() => readMoods('splice').some((m) => m.app === 'locker'), 'the mood');
  const mood = readMoods('splice').find((m) => m.app === 'locker');
  assert.equal(mood.mood, 'worried');
  assert.match(mood.reason, /expire soon|expired/);
  app.unmount();
});

test("/take of an app from Sonar compares that app's settings; t hands the app to Sonar", async () => {
  const app = start();
  await until(shows(app, 'shop-api · kv-shop'), 'loaded');
  await type(app.stdin, `/take ${encodeContext('site', { name: 'shop-api', slot: 'staging', resourceGroup: 'shop' })}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'shop-api/staging · kv-shop'), 'the slot picked');
  await until(shows(app, "Comparing shop-api/staging's settings"), 'said');
  app.stdin.write('t');
  await until(() => app.copied.length === 1, 'the line for Sonar');
  assert.equal(app.copied[0], '/appsettings shop-api/staging');
  await until(shows(app, "Copied for Sonar: paste it into Sonar's prompt."), 'the note');
  await type(app.stdin, `/take ${encodeContext('logline', { process: 'api', text: 'boom' })}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, "That's api: boom, for Sonar or Hail or Bosun or Wharf"), 'not mine');
  await type(app.stdin, `/take ${encodeContext('site', { name: 'nowhere' })}`);
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'No app nowhere in Contoso (demo)'), 'not found');
  app.unmount();
});

test('/app and /vault pick from a list; c hides a column, remembered', async () => {
  const app = start();
  await until(shows(app, 'shop-api · kv-shop'), 'loaded');
  await type(app.stdin, '/app');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'App Service apps in Contoso (demo)'), 'the list');
  app.stdin.write('\x1bg');
  await new Promise((r) => setTimeout(r, 100));
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'shop-functions · kv-shop'), 'the function app picked');
  await type(app.stdin, '/vault kv-sh');
  await until(shows(app, 'kv-shared'), 'the completion');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'shop-functions · kv-shared'), 'the vault picked');
  const saved = JSON.parse(readFileSync(join(process.env.LOCKER_HOME, 'config.json'), 'utf8'));
  assert.equal(saved.vault, 'kv-shared');
  assert.equal(saved.target.label, 'shop-functions');
  app.stdin.write('1');
  app.stdin.write('c');
  await until(shows(app, 'Columns of the drift view'), 'the columns');
  app.stdin.write(KEYS.enter);
  await until(shows(app, '[ ] .env '), '.env off');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Columns of the drift view'), 'closed');
  assert.ok(!app.lastFrame().split('\n')[3]?.includes('.env '));
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.LOCKER_HOME, 'config.json'), 'utf8')).columns, { 'env:.env': false });
  app.unmount();
});

test('ctrl+p opens the palette; your own commands run; ? opens the help on the view', async () => {
  const app = start({ config: { history: [], commands: { prod: '/app shop-api' } } });
  await until(shows(app, 'shop-api · kv-shop'), 'loaded');
  app.stdin.write(KEYS.ctrlP);
  await until(shows(app, 'Command palette'), 'the palette');
  await type(app.stdin, 'clear-after');
  await until(shows(app, '/clear-after'), 'filtered');
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('/clear-after'), 'closed');
  await type(app.stdin, '/prod');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "Comparing shop-api's settings"), 'your command ran');
  app.stdin.write('?');
  await until(shows(app, 'Keyboard shortcuts'), 'the help');
  app.unmount();
});

test('without Azure the folder is still compared, and the header says why', async () => {
  const provider = {
    kind: 'azure',
    currentSubscription: async () => Promise.reject(new Error("ERROR: Please run 'az login' to setup account.")),
    subscriptions: async () => Promise.reject(new Error("ERROR: Please run 'az login' to setup account.")),
  };
  const app = start({ provider });
  await until(shows(app, 'The Azure CLI is not signed in'), 'the problem');
  assert.match(app.lastFrame(), /no app · no vault/);
  assert.match(app.lastFrame(), /Api__BaseUrl/);
  app.stdin.write('2');
  await until(shows(app, 'run az login'), 'the vault view says so');
  app.unmount();
});

test('/move reads another folder: a picker of the ones beside it, then its settings in this one\'s place', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createLocal } = await import('../src/local.js');
  const root = mkdtempSync(join(tmpdir(), 'locker-move-'));
  for (const [name, env] of [['shop', 'SHOP_ONLY=1\n'], ['blog', 'BLOG_ONLY=1\n'], ['empty', null]]) {
    mkdirSync(join(root, name));
    if (env) writeFileSync(join(root, name, '.env'), env);
  }
  const app = start({ local: createLocal({ dir: join(root, 'shop') }), makeLocal: (dir) => createLocal({ dir }) });
  const has = (t) => app.lastFrame().includes(t);
  await until(() => has('SHOP_ONLY'), 'the first folder');
  await type(app.stdin, '/move');
  app.stdin.write(KEYS.enter);
  await until(() => has('Move to') && has('blog') && has('(no settings found)'), 'the picker');
  // blog comes before empty: by name, after the folders read lately (only this one so far).
  app.stdin.write(KEYS.enter);
  await until(() => has('BLOG_ONLY') && !has('SHOP_ONLY'), 'the other folder read');
  assert.ok(app.lastFrame().split('\n')[0].includes('blog'), 'the header names the folder');
  await type(app.stdin, '/move nope');
  app.stdin.write(KEYS.enter);
  await until(() => has("There's no folder nope"), 'the missing folder');
  await type(app.stdin, '/move shop');
  app.stdin.write(KEYS.enter);
  await until(() => has('SHOP_ONLY'), 'back again');
  const { loadConfig } = await import('../src/config.js');
  await until(() => (loadConfig().projects ?? [])[0]?.endsWith('shop'), 'remembered');
  app.unmount();
});
