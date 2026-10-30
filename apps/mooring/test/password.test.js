// Signing in with a password: asked for on every connect, given to ssh only through the environment of the
// ssh Mooring starts (a helper script prints it), never saved, shown, logged or put on a command line.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as realSpawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { askpassEnv, ensureHelper, helperScript, PASSWORD_VARIABLE } from '../src/askpass.js';
import { parseAdd } from '../src/hosts.js';
import { createSession } from '../src/session.js';
import { problemFrom, sftpServerArgs, sshArgs } from '../src/sftp.js';
import { readActivity, readMoods } from '@fleet/kit/family.js';
import { KEYS, shows, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

// Everything a password could be mistaken for or break: shell and cmd metacharacters, quotes, percent signs.
const NASTY = `p&ss %PATH% ^w"o'r$d!;|<>\`x`;

test('ssh arguments with a password: BatchMode off, a password only, once; without, as before', () => {
  const host = { host: 'h', user: 'u' };
  for (const args of [sftpServerArgs(host, { password: true }), sshArgs(host, 'ls', { password: true })]) {
    assert.ok(args.includes('BatchMode=no'));
    assert.ok(!args.includes('BatchMode=yes'));
    assert.ok(args.includes('PreferredAuthentications=password,keyboard-interactive'));
    assert.ok(args.includes('NumberOfPasswordPrompts=1'));
    // An unknown host is refused at once: ssh's "continue connecting?" would go to the helper, which answers with the
    // password, and the connection would sit there until the timeout.
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
  }
  for (const args of [sftpServerArgs(host), sshArgs(host, 'ls'), sftpServerArgs(host, { password: false })]) {
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(!args.some((a) => /Preferred|NumberOfPassword/.test(a)));
  }
});

test('a refused password says so, with the way out; a refused key keeps its own advice', () => {
  assert.match(problemFrom('me@h: Permission denied (password).', { password: true }), /refused the password.*use a key/s);
  assert.match(problemFrom('me@h: Permission denied (publickey).'), /ssh-add/);
});

test('an unknown host says what to run, for this host', () => {
  const said = 'No ED25519 host key is known for [h]:2222 and you have requested strict checking.\nHost key verification failed.';
  assert.match(problemFrom(said, { host: { host: 'h', user: 'me', port: 2222 } }), /plain ssh yourself \(ssh -p 2222 me@h\), compare the fingerprint/);
  assert.match(problemFrom(said, { host: { host: 'h' } }), /\(ssh h\)/);
  assert.match(problemFrom(said), /plain ssh yourself, compare/);
});

test('/add takes `password` as a word, in any order, and saves only that it is asked for', () => {
  assert.deepEqual(parseAdd('web me@web password folder=/var/www'), { name: 'web', host: 'web', user: 'me', password: true, folder: '/var/www' });
  assert.deepEqual(parseAdd('web me@web'), { name: 'web', host: 'web', user: 'me' });
  assert.match(parseAdd('web me@web passwd').error, /password/);
});

test('the helper: a script that prints the variable, and nothing else, as the platform runs it', () => {
  const unix = helperScript('linux');
  assert.match(unix.body, /^#!\/bin\/sh\n/);
  assert.ok(unix.body.includes(`"$${PASSWORD_VARIABLE}"`));
  const win = helperScript('win32');
  assert.equal(win.name, 'askpass.cmd');
  assert.ok(win.body.includes(`$env:${PASSWORD_VARIABLE}`));
  // No password in either script's text, and the Windows one never expands an argument into a command line.
  assert.ok(!win.body.includes('%1') && !win.body.includes('%*'));
});

test('the real helper prints a password with every kind of special character exactly, and only that', () => {
  const path = ensureHelper();
  assert.ok(existsSync(path));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0, 'only its owner can use it');
  // ssh passes the prompt as the one argument; the helper takes no notice of it. (cmd needs a shell to run a .cmd, which
  // would read the prompt's & as its own, so there it is run with none: ssh starts it without a shell.)
  const win = process.platform === 'win32';
  const r = spawnSync(win ? `"${path}"` : path, win ? [] : ['Are you sure & (yes/no)? %1'], { env: { ...process.env, [PASSWORD_VARIABLE]: NASTY }, shell: win, encoding: 'utf8' });
  assert.equal(r.stdout.replace(/\r?\n$/, ''), NASTY);
  assert.equal(r.stderr, '');
  assert.ok(!readFileSync(path, 'utf8').includes('p&ss'), 'the password is not in the script');
});

test('askpassEnv: the helper, force, a DISPLAY if there is none, and the password', () => {
  const env = askpassEnv('s3cret', {}, '/tmp/helper');
  assert.deepEqual(env, { SSH_ASKPASS: '/tmp/helper', SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'mooring:0', [PASSWORD_VARIABLE]: 's3cret' });
  assert.equal(askpassEnv('s3cret', { DISPLAY: ':0' }, '/tmp/helper').DISPLAY, undefined);
});

test('a session with a password gives it to every ssh it starts through the environment, never an argument; close lets go of it', async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    // Not a real server: the process ends at once, which fails the call.
    return realSpawn(process.execPath, ['-e', 'process.exit(255)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  };
  const s = createSession({ host: 'h', user: 'me' }, { password: NASTY, spawn });
  await assert.rejects(s.home());
  await assert.rejects(s.exec('ls'));
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.env[PASSWORD_VARIABLE], NASTY);
    assert.equal(c.env.SSH_ASKPASS_REQUIRE, 'force');
    assert.ok(existsSync(c.env.SSH_ASKPASS));
    assert.ok(!c.args.some((a) => a.includes('p&ss')), 'the password is on no command line');
    assert.ok(c.args.includes('BatchMode=no'));
  }
  s.close();
  await assert.rejects(s.home());
  assert.equal(calls[2].env?.[PASSWORD_VARIABLE], undefined, 'after close, no password');
  assert.ok(calls[2].args.includes('BatchMode=yes'));
});

test('a host with a password asks for it masked, hands it to the session and keeps it from everything else', async () => {
  let given;
  const app = start({
    connectTo: undefined,
    makeSession: (host, options) => {
      given = options;
      return app.host;
    },
  });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/connect secure');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Password for me@secure.example.com'), 'the question');
  await type(app.stdin, NASTY);
  // Masked as it is typed.
  assert.ok(!app.lastFrame().includes(NASTY));
  assert.ok(!app.lastFrame().includes('p&ss'));
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'notes.txt'), 'connected');
  assert.equal(given.password, NASTY);
  // Not on screen, in the history, the activity log or the mood afterwards.
  assert.ok(!app.lastFrame().includes('p&ss'));
  await until(() => readActivity({ limit: 10 }).length >= 0, 'the family folder');
  const everything = JSON.stringify([readActivity({ limit: 100 }), readMoods('trawl'), readFileSyncIf(process.env.MOORING_HOME)]);
  assert.ok(!everything.includes('p&ss'), 'the password reached a file');
  app.unmount();
});

test('esc at the password question connects to nothing', async () => {
  let made = 0;
  const app = start({
    connectTo: undefined,
    makeSession: () => {
      made++;
      return app.host;
    },
  });
  await until(shows(app, 'Documents'), 'this machine');
  await type(app.stdin, '/connect secure');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'Password for'), 'the question');
  app.stdin.write(KEYS.esc);
  await until(shows(app, 'no password given'), 'declined');
  assert.equal(made, 0);
  assert.match(app.lastFrame(), /Not connected/);
  app.unmount();
});

function readFileSyncIf(dir) {
  try {
    return readFileSync(`${dir}/config.json`, 'utf8');
  } catch {
    return '';
  }
}
