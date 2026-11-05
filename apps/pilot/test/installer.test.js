// The installers: the setup program's script names the files the build makes, the install scripts
// parse (PowerShell's on Windows, sh elsewhere), and install.sh installs from a stand-in for GitHub's
// API (a local server), checking the checksum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetName, buildTargets } from '@fleet/kit/update.js';
import { autoUpdate } from '../src/web/server.js';

const dir = fileURLToPath(new URL('../installer/', import.meta.url));
const read = (f) => readFileSync(join(dir, f), 'utf8');
const windows = process.platform === 'win32';

test('the setup program: the files it packs are the ones the build makes', () => {
  const iss = read('Pilot.iss');
  assert.match(iss, new RegExp(`Source: "\\.\\.\\\\dist\\\\${assetName('win32', 'x64').replace('.', '\\.')}"; DestDir: "\\{app\\}"; DestName: "pilot\\.exe"`));
  assert.match(iss, /OutputBaseFilename=pilot-windows-x64-setup/);
  assert.ok(existsSync(fileURLToPath(new URL('../assets/logo.ico', import.meta.url))));
  // Per user, on the user's PATH, never needing an administrator.
  assert.match(iss, /PrivilegesRequired=lowest/);
  assert.match(iss, /ChangesEnvironment=yes/);
  // Interrupted updates leave .pilot-update-* folders, which uninstalling removes.
  assert.match(iss, /\{app\}\\\.pilot-update-\*/);
  assert.match(read('build.ps1'), /Pilot\.iss/);
});

test('the install scripts name the release files the build makes', () => {
  const files = Object.values(buildTargets('pilot'));
  for (const [os, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['macos', 'x64'], ['macos', 'arm64']]) assert.ok(files.includes(`pilot-${os}-${arch}`));
  assert.match(read('install.ps1'), new RegExp(`\\$File = '${assetName('win32', 'x64').replace('.', '\\.')}'`));
});

test('the PowerShell scripts avoid what Windows PowerShell misreads, on every system', () => {
  for (const f of ['install.ps1', 'build.ps1']) {
    const text = read(f);
    // Without a BOM, Windows PowerShell 5.1 reads a script as the ANSI code page: UTF-8's dashes and
    // quotes turn into quote characters there.
    assert.ok(!/[^\x00-\x7f]/.test(text), `${f} is ASCII only`);
    // "$exe: ..." is a scope or drive prefix (like $env:) to PowerShell, and a syntax error: "${exe}: ...".
    for (const m of text.matchAll(/\$([A-Za-z_]\w*):(?![A-Za-z_])/g)) assert.fail(`${f}: $${m[1]}: needs braces`);
  }
});

test('the PowerShell scripts parse', { skip: !windows && 'PowerShell is checked on Windows' }, () => {
  for (const f of ['install.ps1', 'build.ps1']) {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${join(dir, f)}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8' });
    assert.equal(out.trim(), '0', `${f} has syntax errors`);
  }
});

test('install.sh installs the newest release, checked, and refuses a bad checksum', { skip: windows && 'sh is checked on Linux and macOS' }, async () => {
  assert.equal(spawnSync('sh', ['-n', join(dir, 'install.sh')]).status, 0);
  const os = process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = ['arm64', 'aarch64'].includes(process.arch) ? 'arm64' : 'x64';
  const file = `pilot-${os}-${arch}`;
  const binary = '#!/bin/sh\necho 9.9.9\n';
  let checksum = createHash('sha256').update(binary).digest('hex');
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const release = (tag) => ({ tag_name: tag, draft: false, prerelease: false, assets: [{ url: `${base}/repos/r/releases/assets/1`, id: 1, name: file }, { url: `${base}/repos/r/releases/assets/2`, id: 2, name: 'SHA256SUMS.txt' }] });
    if (req.headers.authorization !== 'Bearer t') return res.writeHead(401).end('{}');
    if (req.url.includes('/releases?')) return res.end(JSON.stringify([{ tag_name: 'splice-v2.0.0', assets: [] }, release('pilot-v9.9.9'), release('pilot-v9.9.8')], null, 2));
    if (req.url.endsWith('/releases/tags/pilot-v9.9.9')) return res.end(JSON.stringify(release('pilot-v9.9.9'), null, 2));
    if (req.url.endsWith('/assets/1')) return res.end(binary);
    if (req.url.endsWith('/assets/2')) return res.end(`${checksum}  ${file}\n${'0'.repeat(64)}  other\n`);
    res.writeHead(404).end('{}');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const home = mkdtempSync(join(tmpdir(), 'pilot-install-'));
  const env = { ...process.env, HOME: home, PILOT_INSTALL_API: `http://127.0.0.1:${server.address().port}`, PILOT_INSTALL_VIA: 'token', GITHUB_TOKEN: 't', PILOT_INSTALL_DIR: join(home, 'bin') };
  try {
    const r = await sh([join(dir, 'install.sh')], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Downloading pilot-\w+-\w+ from pilot-v9\.9\.9/);
    assert.equal(readFileSync(join(home, 'bin', 'pilot'), 'utf8'), binary);
    // A download that doesn't match its checksum is never installed.
    checksum = '1'.repeat(64);
    rmSync(join(home, 'bin', 'pilot'));
    const bad = await sh([join(dir, 'install.sh')], env);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /doesn't match its checksum/);
    assert.ok(!existsSync(join(home, 'bin', 'pilot')), 'nothing installed');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

/** sh with `args`, without blocking (the stand-in server runs in this process): { status, stdout, stderr }. */
function sh(args, env) {
  return new Promise((ok) => {
    const child = spawn('sh', args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => ok({ status, stdout, stderr }));
  });
}

test('a checkout never updates itself', async () => {
  const said = [];
  await autoUpdate((s) => said.push(s));
  assert.deepEqual(said, []);
});
