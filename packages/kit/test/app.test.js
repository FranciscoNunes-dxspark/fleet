// configureApp: how the kit knows which app it's in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app, appConfigured, configureApp, versionVariable } from '../app.js';
import { compiled, version } from '../version.js';

test('nothing is configured until the app says who it is, and asking before then says so', () => {
  assert.equal(appConfigured(), false);
  assert.throws(() => app(), /configureApp/);
});

test('names must be lower case words, and a title is needed', () => {
  assert.throws(() => configureApp({ name: 'Splice', title: 'Splice' }), /lower-case name/);
  assert.throws(() => configureApp({ name: 'splice' }), /title/);
  assert.equal(appConfigured(), false);
});

test("the version variable is the name in capitals; a build's version wins over package.json's", () => {
  assert.equal(versionVariable('splice'), 'SPLICE_VERSION');
  assert.equal(versionVariable('keel'), 'KEEL_VERSION');
  const packageUrl = new URL('../package.json', import.meta.url);
  const fromCheckout = configureApp({ name: 'demo', title: 'Demo', packageUrl });
  assert.equal(fromCheckout.VERSION, '1.0.0');
  assert.equal(fromCheckout.COMPILED, false);
  assert.equal(fromCheckout.credentialService, 'Demo');
  assert.equal(version(), '1.0.0');
  assert.equal(compiled(), false);
  const built = configureApp({ name: 'demo', title: 'Demo', version: '2.3.4', packageUrl });
  assert.equal(built.VERSION, '2.3.4');
  assert.equal(built.COMPILED, true);
  assert.equal(app(), built);
  // The environment's variable counts as built in too, as it did before the kit.
  process.env.DEMO_VERSION = '3.0.0';
  try {
    assert.deepEqual([configureApp({ name: 'demo', title: 'Demo', packageUrl }).VERSION, compiled()], ['3.0.0', true]);
  } finally {
    delete process.env.DEMO_VERSION;
  }
});

test('one process is one app', () => {
  assert.throws(() => configureApp({ name: 'other', title: 'Other' }), /can't also be Other/);
});
