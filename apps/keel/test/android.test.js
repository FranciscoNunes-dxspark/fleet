import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assetLinks, normalizeFingerprint } from '../server/android.js';
import { twaManifest } from '../scripts/twa.js';

const SHA = 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99';
const SHA_UPPER = SHA.toUpperCase();

test('fingerprints come out upper-case with colons, whatever form they were pasted in', () => {
  assert.equal(normalizeFingerprint(SHA), SHA_UPPER);
  assert.equal(normalizeFingerprint(SHA.replace(/:/g, '')), SHA_UPPER);
  assert.equal(normalizeFingerprint(' AA BB '), null);
  assert.equal(normalizeFingerprint(''), null);
});

test('assetlinks.json lists every certificate, and nothing without one', () => {
  const other = SHA_UPPER.replace(/^AA/, '12');
  const [statement] = assetLinks({ packageId: 'com.example.keel', fingerprints: `${SHA}, ${other}, ${SHA_UPPER}, junk` });
  assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
  assert.deepEqual(statement.target, { namespace: 'android_app', package_name: 'com.example.keel', sha256_cert_fingerprints: [SHA_UPPER, other] });
  assert.equal(assetLinks({ packageId: 'com.example.keel', fingerprints: '' }), null);
  assert.equal(assetLinks({ packageId: 'com.example.keel', fingerprints: 'junk' }), null);
});

test('the Android app takes its name, colours, icons and shortcuts from the web manifest', () => {
  const webManifest = JSON.parse(readFileSync(new URL('../client/public/manifest.webmanifest', import.meta.url), 'utf8'));
  const m = twaManifest({ host: 'keel.example.com', packageId: 'com.example.keel', versionCode: 7, versionName: '7', webManifest, keystore: { path: '/k/keel.keystore', alias: 'keel' } });
  assert.equal(m.host, 'keel.example.com');
  assert.equal(m.packageId, 'com.example.keel');
  assert.equal(m.name, 'Keel');
  assert.equal(m.themeColor, webManifest.theme_color);
  assert.equal(m.iconUrl, 'https://keel.example.com/icons/icon-512.png');
  assert.equal(m.maskableIconUrl, 'https://keel.example.com/icons/maskable-512.png');
  assert.equal(m.enableNotifications, true);
  assert.deepEqual([m.appVersionCode, m.appVersion], [7, '7']);
  assert.deepEqual(m.signingKey, { path: '/k/keel.keystore', alias: 'keel' });
  assert.deepEqual(m.shortcuts.map((s) => s.url), ['https://keel.example.com/inbox', 'https://keel.example.com/production', 'https://keel.example.com/prs']);
  assert.ok(m.shortcuts.length <= 4, 'Android allows at most four shortcuts');
});
