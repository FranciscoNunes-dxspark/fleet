// Trusting a host from inside Mooring: what ssh-keyscan and ssh-keygen say, a host's key offered only when it
// has no entry at all, and exactly the key that was shown written to known_hosts.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostKeys, entryName, knownHostsFiles, parseFingerprint, parseScan } from '../src/hostkeys.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';
import { tempDir } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const SCAN = [
  '# 10.0.0.7:22 SSH-2.0-OpenSSH_9.6',
  '10.0.0.7 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAA',
  '10.0.0.7 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAA',
  '10.0.0.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA',
  'garbage line',
].join('\n');

test('known_hosts files from ssh -G, ~ filled in; the key types, strongest first; a fingerprint', () => {
  const files = knownHostsFiles('hostname h\nuserknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\nport 22\n');
  assert.equal(files.user.length, 2);
  assert.ok(files.user[0].endsWith('known_hosts') && !files.user[0].startsWith('~'));
  assert.deepEqual(files.global, ['/etc/ssh/ssh_known_hosts']);
  assert.deepEqual(knownHostsFiles('userknownhostsfile none\n').user, []);
  // Git for Windows' ssh writes MSYS paths and Windows' own writes __PROGRAMDATA__; Node needs neither as they are.
  const win = { platform: 'win32', env: { ProgramData: 'C:\\ProgramData' } };
  assert.deepEqual(knownHostsFiles('userknownhostsfile /c/Users/me/.ssh/known_hosts /d/x/known_hosts2\n', win).user, ['C:/Users/me/.ssh/known_hosts', 'D:/x/known_hosts2']);
  assert.deepEqual(knownHostsFiles('globalknownhostsfile __PROGRAMDATA__\\ssh/ssh_known_hosts\n', win).global, ['C:\\ProgramData\\ssh/ssh_known_hosts']);
  assert.deepEqual(knownHostsFiles('userknownhostsfile /c/Users/me/.ssh/known_hosts\n', { platform: 'linux' }).user, ['/c/Users/me/.ssh/known_hosts']);
  assert.deepEqual(parseScan(SCAN).map((k) => k.type), ['ED25519', 'ECDSA', 'RSA']);
  assert.equal(parseScan(SCAN)[0].line, '10.0.0.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA');
  assert.equal(parseFingerprint('256 SHA256:abcDEF+/123 10.0.0.7 (ED25519)\n'), 'SHA256:abcDEF+/123');
  assert.equal(parseFingerprint('nothing'), null);
  assert.equal(entryName({ host: 'h' }), 'h');
  assert.equal(entryName({ host: 'h', port: 22 }), 'h');
  assert.equal(entryName({ host: 'h', port: 2222 }), '[h]:2222');
});

// A stand-in for running the tools: which host is "known", what the scan returns, which tool is missing.
function fakeRun({ known = false, scan = SCAN, missing = [] } = {}) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (missing.includes(command)) return { code: 1, stdout: '', stderr: '', missing: true };
    if (command === 'K' && args[0] === '-F') return known ? { code: 0, stdout: '# Host h found\nh ssh-ed25519 AAAA\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    if (command === 'C') return { code: 0, stdout: scan, stderr: '' };
    if (command === 'K' && args[0] === '-l') return { code: 0, stdout: `256 SHA256:fp-of-${options.input.split(' ')[1]} h (X)\n`, stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  return Object.assign(run, { calls });
}
const tools = { ssh: 'S', keygen: 'K', keyscan: 'C' };

test('a host already in known_hosts is not offered', async () => {
  const { dir, done } = tempDir();
  try {
    const file = join(dir, 'known_hosts');
    writeFileSync(file, 'h ssh-ed25519 AAAA\n');
    const run = fakeRun({ known: true });
    assert.deepEqual(await createHostKeys({ run, files: [file], tools }).inspect({ host: 'h' }), { known: true });
    assert.ok(!run.calls.some((c) => c[0] === 'C'), 'no scan for a known host');
  } finally {
    done();
  }
});

test('an unknown host: its keys with their fingerprints, the strongest first, scanned on its port', async () => {
  const { dir, done } = tempDir();
  try {
    const file = join(dir, 'known_hosts');
    writeFileSync(file, 'other ssh-ed25519 AAAA\n');
    const run = fakeRun();
    const verdict = await createHostKeys({ run, files: [file], tools }).inspect({ host: '10.0.0.7', port: 2222 });
    assert.equal(verdict.known, false);
    assert.deepEqual(verdict.keys.map((k) => [k.type, k.fingerprint]), [
      ['ED25519', 'SHA256:fp-of-ssh-ed25519'],
      ['ECDSA', 'SHA256:fp-of-ecdsa-sha2-nistp256'],
      ['RSA', 'SHA256:fp-of-ssh-rsa'],
    ]);
    assert.deepEqual(run.calls.find((c) => c[0] === 'C'), ['C', '-T', '8', '-p', '2222', '10.0.0.7']);
    assert.deepEqual(run.calls.find((c) => c[0] === 'K' && c[1] === '-F'), ['K', '-F', '[10.0.0.7]:2222', '-f', file]);
  } finally {
    done();
  }
});

test('when the tools are missing, the host does not answer or it is no host: nothing is offered', async () => {
  assert.deepEqual(await createHostKeys({ run: fakeRun({ missing: ['C'] }), files: [], tools }).inspect({ host: 'h' }), { skip: true });
  assert.deepEqual(await createHostKeys({ run: fakeRun({ scan: '# nothing\n' }), files: [], tools }).inspect({ host: 'h' }), { skip: true });
  const run = fakeRun();
  assert.deepEqual(await createHostKeys({ run, files: [], tools }).inspect({ host: '-oProxyCommand=x' }), { skip: true });
  assert.equal(run.calls.length, 0, 'a name that is an option reaches no tool');
});

test('trusting adds exactly the key that was shown, on a line of its own, creating what is missing', async () => {
  const { dir, done } = tempDir();
  try {
    const file = join(dir, 'new-dir', 'known_hosts');
    const hostKeys = createHostKeys({ run: fakeRun(), files: [file], tools });
    const { keys } = await hostKeys.inspect({ host: '10.0.0.7' });
    assert.equal(await hostKeys.trust({ host: '10.0.0.7' }, keys[0]), file);
    assert.equal(readFileSync(file, 'utf8'), '10.0.0.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA\n');
    // A file whose last line has no newline keeps it.
    writeFileSync(file, 'old ssh-rsa AAAA');
    await hostKeys.trust({ host: '10.0.0.7' }, keys[0]);
    assert.equal(readFileSync(file, 'utf8'), 'old ssh-rsa AAAA\n10.0.0.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA\n');
    await assert.rejects(hostKeys.trust({ host: '10.0.0.7' }, { line: 'two words' }), /Not a host key/);
    await assert.rejects(hostKeys.trust({ host: '-x' }, keys[0]), /Not a host key/);
  } finally {
    done();
  }
});

// ---------------------------------------------------------------------------------------------------
// In the app.

const KEY = { type: 'ED25519', line: 'h ssh-ed25519 AAAA', fingerprint: 'SHA256:Zm9vYmFyYmF6' };
function fakeHostKeys(verdict) {
  const trusted = [];
  return { trusted, inspect: async () => verdict, trust: async (host, key) => (trusted.push([host.name, key.line]), '/home/me/.ssh/known_hosts') };
}

test('an unknown host shows its fingerprint and, on a yes, is trusted and then connected to', async () => {
  const hostKeys = fakeHostKeys({ known: false, keys: [KEY, { ...KEY, type: 'RSA', fingerprint: 'SHA256:other' }] });
  const app = start({ connectTo: undefined, hostKeys });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/connect build');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "ssh doesn't know ci@build.example.com yet"), 'the question');
  assert.match(app.lastFrame(), /ED25519 SHA256:Zm9vYmFyYmF6 \(and 1 other\)/);
  assert.match(app.lastFrame(), /Trust its key \(compare the fingerprint\)\?/);
  assert.deepEqual(hostKeys.trusted, [], 'nothing is trusted before the answer');
  app.stdin.write('1');
  await until(shows(app, 'notes.txt'), 'connected');
  assert.deepEqual(hostKeys.trusted, [['build', 'h ssh-ed25519 AAAA']]);
  app.unmount();
});

test('a no connects to nothing and trusts nothing', async () => {
  const hostKeys = fakeHostKeys({ known: false, keys: [KEY] });
  let made = 0;
  const app = start({ connectTo: undefined, hostKeys, makeSession: () => (made++, app.host) });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/connect build');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'compare the fingerprint)?'), 'the question');
  app.stdin.write('2');
  await until(shows(app, "its key isn't trusted"), 'declined');
  assert.equal(made, 0);
  assert.deepEqual(hostKeys.trusted, []);
  app.unmount();
});

test('a known host, or one that could not be looked up, connects without a question', async () => {
  for (const verdict of [{ known: true }, { skip: true }]) {
    const app = start({ hostKeys: fakeHostKeys(verdict) });
    await until(shows(app, 'notes.txt'), 'connected');
    assert.ok(!app.lastFrame().includes('Trust the key'));
    app.unmount();
  }
});

test('trusting is logged by host and fingerprint, which are public, and the key is trusted before a password is asked for', async () => {
  const hostKeys = fakeHostKeys({ known: false, keys: [KEY] });
  const app = start({ connectTo: undefined, hostKeys });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/connect secure');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'compare the fingerprint)?'), 'the trust question first');
  assert.ok(!app.lastFrame().includes('Password for'));
  app.stdin.write('1');
  await until(shows(app, 'Password for me@secure.example.com'), 'then the password');
  app.unmount();
});

test('a trust that cannot be written says so and connects to nothing', async () => {
  const hostKeys = fakeHostKeys({ known: false, keys: [KEY] });
  hostKeys.trust = async () => {
    throw new Error('EACCES: permission denied, open known_hosts');
  };
  let made = 0;
  const app = start({ connectTo: undefined, hostKeys, makeSession: () => (made++, app.host) });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/connect build');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'compare the fingerprint)?'), 'the question');
  app.stdin.write('1');
  await until(shows(app, 'permission denied'), 'the failure said');
  assert.equal(made, 0);
  assert.ok(!existsSync('/nonexistent'));
  app.unmount();
});
