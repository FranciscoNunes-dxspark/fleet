// Locker in the family (family.js): its names, the app it takes from Sonar and hands back, Hush's mood
// and its word on the siblings', and /family and /wiring over a project folder. No value in any of them.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_NAMES, FAMILY, PET_NAMES, ROLES, TAKEN_BY, decodeContext, describeContext, encodeContext, notMine, writeMood } from '@fleet/kit/family.js';
import { familyChoices, siteData, siteIn, siteNamed, sonarLine } from '../src/share.js';
import { familyMood, reactionTo } from '../src/moods.js';
import { FACES, moodFor, moodLine, petPixels, troubles } from '../src/pet.js';
import { createLocal } from '../src/local.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const DAY = 86_400_000;
const sites = [
  { id: '/s/rg/a/shop-api', name: 'shop-api', slot: null, resourceGroup: 'shop' },
  { id: '/s/rg/a/shop-api/slots/staging', name: 'shop-api', slot: 'staging', resourceGroup: 'shop' },
  { id: '/s/other/a/shop-api', name: 'shop-api', slot: null, resourceGroup: 'other' },
];

test('Locker is in the family, takes an app, and has its names', () => {
  assert.ok(FAMILY.includes('locker'));
  assert.deepEqual([APP_NAMES.locker, PET_NAMES.locker, ROLES.locker, TAKEN_BY.site], ['Locker', 'Hush', 'VAULT', ['locker']]);
  const line = encodeContext('site', siteData(sites[1], 's1'));
  assert.deepEqual(decodeContext(line), { kind: 'site', data: { name: 'shop-api', slot: 'staging', resourceGroup: 'shop', subscription: 's1', id: '/s/rg/a/shop-api/slots/staging' } });
  assert.equal(describeContext(decodeContext(line)), 'app shop-api/staging');
  assert.match(notMine('sonar', decodeContext(line)), /for Locker/);
});

test('an app is found by its id, else its name, slot and group; and handed to Sonar by name', () => {
  assert.equal(siteIn(sites, { id: '/S/RG/A/SHOP-API/SLOTS/STAGING' }), sites[1]);
  assert.equal(siteIn(sites, { name: 'Shop-Api', slot: 'staging' }), sites[1]);
  assert.equal(siteIn(sites, { name: 'shop-api', resourceGroup: 'other' }), sites[2]);
  assert.equal(siteIn(sites, { name: 'shop-api' }), sites[0]);
  assert.equal(siteIn(sites, { name: 'nope' }), null);
  assert.equal(siteNamed(sites, 'shop-api/stag'), sites[1]);
  assert.equal(siteNamed(sites, 'shop'), null);
  assert.equal(sonarLine(sites[1]), '/appsettings shop-api/staging');
  const choices = familyChoices({ dir: '/p', repo: '/p', crew: false, httpFiles: [], databases: [] }, { target: sites[0] });
  assert.deepEqual(choices.map((c) => [c.app, c.line]), [['splice', '/open /p'], ['sonar', '/appsettings shop-api']]);
});

test("Hush's mood: something about to run out or a broken reference worries it, drift too; never a value", () => {
  const now = Date.now();
  const soon = { name: 'Stripe--ApiKey', enabled: true, expires: new Date(now + 5 * DAY).toISOString() };
  const t = troubles({ vaultData: { secrets: [soon, { name: 'later', expires: new Date(now + 90 * DAY).toISOString() }], certificates: [] }, matrix: { rows: [] }, days: 30, now });
  assert.deepEqual(t.expiring, [soon]);
  assert.deepEqual(familyMood({ mood: 'worried', trouble: t, now }), { mood: 'worried', reason: 'Stripe--ApiKey expires in 5 days' });
  const broken = { expiring: [], broken: [{ key: 'Smtp__Password' }], drift: [] };
  assert.deepEqual(familyMood({ mood: 'worried', trouble: broken }), { mood: 'worried', reason: 'Smtp__Password: Key Vault reference broken' });
  assert.deepEqual(familyMood({ mood: 'worried', trouble: { expiring: [], broken: [], drift: [{}, {}] } }), { mood: 'worried', reason: '2 settings differ between the sources' });
  assert.equal(familyMood({ mood: 'look', busy: { label: 'Saving' }, trouble: { expiring: [], broken: [], drift: [] } }).mood, 'busy');
  assert.equal(familyMood({ mood: 'wave', trouble: { expiring: [], broken: [], drift: [] } }).mood, 'happy');
  assert.equal(moodFor({ loaded: true, trouble: t }), 'worried');
  assert.equal(moodFor({ loaded: true, trouble: { expiring: [], broken: [], drift: [] } }), 'wave');
  assert.match(moodLine('worried', { loaded: true, trouble: t }), /Stripe--ApiKey runs out soon/);
  const said = reactionTo([{ app: 'sonar', mood: 'worried', reason: '12 new exceptions', at: 5 }]);
  assert.match(said.text, /^Hush pulls its arms in: Sonar is worried \(12 new exceptions\)\.$/);
  assert.equal(reactionTo([{ app: 'sonar', mood: 'worried', at: 5 }], new Set(['sonar:5'])), null);
  for (const mood of Object.keys(FACES)) assert.ok(petPixels(mood).every((row) => row.length === 16), mood);
});

test("a sibling's worried mood is remarked on by Hush, once, until esc", async () => {
  writeMood('sonar', { mood: 'worried', reason: '12 new exceptions' });
  const app = start({ moodEvery: 60_000 });
  await until(shows(app, 'Sonar is worried (12 new exceptions)'), "Hush's remark");
  app.stdin.write(KEYS.esc);
  await until(() => !app.lastFrame().includes('Sonar is worried'), 'the remark put away');
  app.unmount();
});

test('/family offers the folder and the app to the siblings; /wiring says what it points at, masked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locker-family-'));
  try {
    writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://app:hunter2@db:5432/shop\n');
    writeFileSync(join(dir, 'api.http'), 'GET https://x\n');
    const app = start({ local: createLocal({ dir }), cwd: dir, config: { history: [], target: { label: 'shop-api' } } });
    await until(shows(app, 'shop-api'), 'loaded');
    await type(app.stdin, '/family');
    app.stdin.write(KEYS.enter);
    await until(shows(app, 'What '), 'the choices');
    const frame = app.lastFrame();
    assert.match(frame, /Hail/);
    assert.match(frame, /Trawl/);
    assert.match(frame, /\/appsettings shop-api/);
    assert.ok(!frame.includes('hunter2'));
    app.stdin.write(KEYS.esc);
    await until(() => !app.lastFrame().includes('/appsettings shop-api'), 'closed');
    await type(app.stdin, '/wiring');
    app.stdin.write(KEYS.enter);
    await until(shows(app, 'DATABASE_URL'), 'the wiring');
    assert.match(app.lastFrame(), /postgres:\/\/app:••••@db:5432\/shop/);
    app.unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
