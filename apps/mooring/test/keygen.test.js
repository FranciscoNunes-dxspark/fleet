// Making a key from inside Mooring: ssh-keygen's arguments (no passphrase in an argument), names that are safe,
// and a key that is already there never replaced.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKeygen, validKeyName } from '../src/keygen.js';
import { KEYS, shows, start, tempDir, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const fakeRun = (calls, { missing = false, code = 0 } = {}) => async (command, args) => {
  calls.push({ command, args });
  if (missing) return { code: 1, stdout: '', stderr: '', missing: true };
  if (args.includes('-l')) return { code: 0, stdout: '256 SHA256:abc123 mooring k (ED25519)\n', stderr: '', missing: false };
  if (code) return { code, stdout: '', stderr: 'boom\n', missing: false };
  writeFileSync(args[args.indexOf('-f') + 1], 'PRIVATE');
  writeFileSync(`${args[args.indexOf('-f') + 1]}.pub`, 'ssh-ed25519 AAAAC3 mooring k\n');
  return { code: 0, stdout: '', stderr: '', missing: false };
};

test('names: letters, digits, dot, dash and underscore, never a slash or a leading dash', () => {
  for (const ok of ['id_ed25519_mooring', 'web.key', 'a-b']) assert.ok(validKeyName(ok), ok);
  for (const bad of ['', '-oProxyCommand=x', 'a/b', '..\\x', 'a b', undefined]) assert.ok(!validKeyName(bad), String(bad));
});

test('a key is made with ssh-keygen: ed25519, an empty passphrase, its path and fingerprint back', async () => {
  const { dir, done } = tempDir();
  try {
    const calls = [];
    const keys = createKeygen({ run: fakeRun(calls), dir: join(dir, '.ssh') });
    const made = await keys.generate('k');
    assert.equal(made.path, join(dir, '.ssh', 'k'));
    assert.equal(made.publicKey, 'ssh-ed25519 AAAAC3 mooring k');
    assert.equal(made.fingerprint, 'SHA256:abc123');
    assert.deepEqual(calls[0].args.slice(0, 5), ['-q', '-t', 'ed25519', '-N', '']);
    assert.ok(existsSync(made.path));
  } finally {
    done();
  }
});

test('a key that is there is never replaced; a bad name, a missing tool and a failure say so', async () => {
  const { dir, done } = tempDir();
  try {
    const calls = [];
    const keys = createKeygen({ run: fakeRun(calls), dir });
    writeFileSync(join(dir, 'old'), 'x');
    await assert.rejects(keys.generate('old'), /there already/);
    await assert.rejects(keys.generate('-x'), /key name/);
    assert.equal(calls.length, 0, 'neither reached ssh-keygen');
    await assert.rejects(createKeygen({ run: fakeRun([], { missing: true }), dir }).generate('n'), /isn't installed/);
    await assert.rejects(createKeygen({ run: fakeRun([], { code: 1 }), dir }).generate('m'), /boom/);
  } finally {
    done();
  }
});

test('in the app: /keygen asks first, makes the key, and a host named after it signs in with it', async () => {
  const made = [];
  const keygen = { path: (n) => `/home/me/.ssh/${n}`, generate: async (n) => (made.push(n), { path: `/home/me/.ssh/${n}`, publicKey: 'ssh-ed25519 AAAAC3 mooring k', fingerprint: 'SHA256:abc' }) };
  const copied = [];
  const app = start({ connectTo: undefined, keygen, copy: (t) => copied.push(t) });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/keygen mykey build');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Make a new ssh key, /home/me/.ssh/mykey?'), 'the question');
  assert.deepEqual(made, [], 'nothing is made before the answer');
  app.stdin.write('1');
  await until(shows(app, 'Public key'), 'the key shown');
  assert.deepEqual(made, ['mykey']);
  assert.deepEqual(copied, ['ssh-ed25519 AAAAC3 mooring k']);
  assert.match(app.lastFrame(), /build now uses this key/);
});
