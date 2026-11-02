// Container images: the tar docker cp writes, os-release, dpkg's and apk's databases, dpkg's versions,
// the provider over a fake docker, and /take of an image over the demo.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { takeLine } from '@fleet/kit/family.js';
import { imageManifest, osvEcosystem, parseApkInstalled, parseDpkgStatus, parseOsRelease, readTar, safeImage, tarText } from '../src/image.js';
import { compareDpkg } from '../src/versions.js';
import { fixedIn } from '../src/audit.js';
import { fixPlan } from '../src/fix.js';
import { purlOf } from '../src/sbom.js';
import { createBilge } from '../src/provider.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
beforeEach(() => {
  cleanup = tempHome();
});
afterEach(() => cleanup());

const shows = (app, text) => () => app.lastFrame().includes(text);

/** A tar stream as docker cp writes one: a ustar header per file, its data padded to 512 bytes. */
function tarOf(files) {
  const blocks = [];
  for (const { name, text = '', type = '0' } of files) {
    const data = Buffer.from(text, 'utf8');
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const STATUS = `Package: libc6
Status: install ok installed
Priority: optional
Source: glibc
Version: 2.36-9+deb12u3
Description: GNU C Library: Shared libraries
 Contains the standard libraries that are used by nearly all programs on
 the system.

Package: libc-bin
Status: install ok installed
Source: glibc
Version: 2.36-9+deb12u3

Package: bash
Status: install ok installed
Source: bash (5.2.15-2)
Version: 5.2.15-2+b2

Package: old-thing
Status: deinstall ok config-files
Version: 1.0-1

Package: never
Status: install ok not-installed
Version: 2.0-1
`;

test('the tar docker cp writes: its files, a long name from a pax header, and past a damaged header to the next', () => {
  const pax = (path) => `${String(path.length + 11).padStart(2, '0')} path=${path}\n`;
  const long = `var/lib/dpkg/status.d/${'x'.repeat(120)}`;
  const tar = tarOf([{ name: 'status.d', type: '5' }, { name: 'PaxHeader', type: 'x', text: pax(long) }, { name: 'short', text: 'Package: a\nVersion: 1\n' }, { name: 'b', text: 'Package: b\nVersion: 2\n' }]);
  const files = readTar(tar);
  assert.deepEqual(files.map((f) => [f.name, f.type]), [['status.d', '5'], [long, '0'], ['b', '0']]);
  assert.equal(tarText(tar), 'Package: a\nVersion: 1\n\n\nPackage: b\nVersion: 2\n');
  // Through the text run() returns, as docker's stdout comes.
  assert.equal(tarText(tar.toString('utf8')), tarText(tar));
  const damaged = Buffer.from(tar);
  damaged[512 * 3 + 10] ^= 0xff;
  assert.deepEqual(readTar(damaged).map((f) => f.name), ['status.d', 'b']);
});

test("os-release names OSV's ecosystem: Debian by its number, Ubuntu's long-term ones marked, Alpine by its branch", () => {
  const os = (text) => osvEcosystem(parseOsRelease(text));
  assert.deepEqual(parseOsRelease('NAME="Debian GNU/Linux"\nID=debian\nVERSION_ID="12"\n# comment\n'), { NAME: 'Debian GNU/Linux', ID: 'debian', VERSION_ID: '12' });
  assert.equal(os('ID=debian\nVERSION_ID="12"'), 'Debian:12');
  assert.equal(os('ID=ubuntu\nVERSION_ID="22.04"\nVERSION="22.04.4 LTS (Jammy Jellyfish)"'), 'Ubuntu:22.04:LTS');
  assert.equal(os('ID=ubuntu\nVERSION_ID="23.10"\nVERSION="23.10 (Mantic Minotaur)"'), 'Ubuntu:23.10');
  assert.equal(os('ID=alpine\nVERSION_ID=3.20.3'), 'Alpine:v3.20');
  assert.equal(os('ID=debian\nPRETTY_NAME="Debian GNU/Linux trixie/sid"'), null);
  assert.equal(os('ID=fedora\nVERSION_ID=40'), null);
});

test("dpkg's status by source package, what isn't installed left out; apk's by origin, with the licence", () => {
  assert.deepEqual(parseDpkgStatus(STATUS), [
    { name: 'glibc', version: '2.36-9+deb12u3', binaries: ['libc6', 'libc-bin'] },
    { name: 'bash', version: '5.2.15-2', binaries: ['bash'] },
  ]);
  const apk = 'C:Q1abc=\nP:libcrypto3\nV:3.3.2-r0\nA:x86_64\no:openssl\nL:Apache-2.0\n\nP:busybox\nV:1.36.1-r29\nL:GPL-2.0-only\n';
  assert.deepEqual(parseApkInstalled(apk), [
    { name: 'openssl', version: '3.3.2-r0', binaries: ['libcrypto3'], license: 'Apache-2.0' },
    { name: 'busybox', version: '1.36.1-r29', binaries: ['busybox'], license: 'GPL-2.0-only' },
  ]);
  const m = imageManifest('debian:12', { db: { kind: 'dpkg', text: STATUS }, osRelease: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID=12\n' });
  assert.deepEqual([m.path, m.kind, m.ecosystem, m.packages.length], ['image debian:12', 'image', 'Debian:12', 2]);
  assert.match(m.note, /Debian GNU\/Linux 12 \(bookworm\), 2 dpkg source packages/);
  assert.equal(m.packages[0].ecosystem, 'Debian:12');
  assert.match(imageManifest('scratch-app', { db: null, osRelease: '' }).note, /no dpkg or apk database/);
});

test("dpkg's versions compared as dpkg does, and a Debian advisory's fix found with them", () => {
  assert.ok(compareDpkg('2.36-9+deb12u4', '2.36-9') > 0);
  assert.ok(compareDpkg('1:1.0', '2.0') > 0, 'the epoch first');
  assert.ok(compareDpkg('1.0~rc1', '1.0') < 0, '~ before the release');
  assert.ok(compareDpkg('3.0.11-1~deb12u1', '3.0.11-1~deb12u2') < 0);
  assert.ok(compareDpkg('1.2.10-r0', '1.2.9-r12') > 0);
  assert.equal(compareDpkg('1.0-1', '1.0-1'), 0);
  const pkg = { ecosystem: 'Debian:12', name: 'glibc', version: '2.36-9+deb12u3' };
  const vuln = { affected: [{ package: { ecosystem: 'Debian:12', name: 'glibc' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.36-9+deb12u4' }] }] }] };
  assert.equal(fixedIn(vuln, pkg), '2.36-9+deb12u4');
  assert.match(fixPlan({ pkg, fixed: '2.36-9+deb12u4' }, { kind: 'image' }).text, /part of the image's operating system/);
  assert.equal(purlOf(pkg), 'pkg:deb/debian/glibc@2.36-9%2Bdeb12u3?distro=debian-12');
});

test("the provider reads an image through docker: create, cp of os-release and the database, rm whatever happens; a name that isn't one runs nothing", async () => {
  const calls = [];
  const fakeRun = (answers) => async (command) => {
    calls.push(command);
    for (const [re, answer] of answers) {
      if (!re.test(command)) continue;
      if (answer instanceof Error) throw answer;
      return { stdout: answer, stderr: '' };
    }
    throw new Error(`no answer for ${command}`);
  };
  const id = 'a'.repeat(64);
  const alpine = createBilge({
    run: fakeRun([
      [/^docker create /, `${id}\n`],
      [/os-release -$/, tarOf([{ name: 'os-release', text: 'ID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\n' }]).toString('utf8')],
      [/dpkg\/status -$/, new Error('Error response from daemon: Could not find the file /var/lib/dpkg/status in container')],
      [/apk\/db\/installed -$/, tarOf([{ name: 'installed', text: 'P:musl\nV:1.2.5-r0\nL:MIT\n' }]).toString('utf8')],
      [/^docker rm -f /, `${id}\n`],
    ]),
  });
  const m = await alpine.image('nginx:1.27-alpine');
  assert.deepEqual([m.ecosystem, m.packages.map((p) => [p.name, p.version, p.license])], ['Alpine:v3.20', [['musl', '1.2.5-r0', 'MIT']]]);
  assert.deepEqual(calls, [
    'docker create nginx:1.27-alpine true',
    `docker cp -L ${id}:/etc/os-release -`,
    `docker cp ${id}:/var/lib/dpkg/status -`,
    `docker cp ${id}:/lib/apk/db/installed -`,
    `docker rm -f ${id}`,
  ]);
  calls.length = 0;
  const broken = createBilge({ run: fakeRun([[/^docker create /, `${id}\n`], [/os-release/, new Error('gone')], [/^docker cp /, Object.assign(new Error('Cancelled'), { cancelled: true })], [/^docker rm -f /, '']]) });
  await assert.rejects(broken.image('debian:12'), /Cancelled/);
  assert.equal(calls.at(-1), `docker rm -f ${id}`, 'removed even so');
  calls.length = 0;
  await assert.rejects(createBilge({ run: fakeRun([]) }).image('debian:12; rm -rf /'), /isn't an image name/);
  assert.deepEqual(calls, []);
  assert.ok(safeImage('registry.example.com:5000/team/api@sha256:' + 'b'.repeat(64)));
  assert.ok(!safeImage('-v'));
});

test("/take of an image from Wharf: its system packages audited with the rest, a manifest of their own, kept through a new scan", async () => {
  const app = start();
  await until(shows(app, 'minimist@1.2.5'), 'the findings');
  app.stdin.write(takeLine('image', { image: 'shop-api:latest' }));
  await until(shows(app, '/take family:v1:image'), 'the prompt with it');
  app.stdin.write(KEYS.enter);
  await until(shows(app, 'openssl@3.0.11-1~deb12u1'), 'the image findings');
  assert.deepEqual(app.provider.state.calls.find((c) => c[0] === 'image'), ['image', 'shop-api:latest']);
  assert.match(app.lastFrame(), /18 packages/);
  app.stdin.write('3');
  await until(shows(app, 'image shop-api:latest'), 'its manifest');
  assert.match(app.lastFrame(), /image shop-api:latest .*image .*4 packages/);
  // /scan reads the folder again: the image stays.
  await type(app.stdin, '/scan');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.filter((c) => c[0] === 'audit').length === 3, 'the audit after the scan');
  await until(shows(app, '18 packages'), 'the count with the image');
  // /outdated asks npm and NuGet about theirs only.
  await type(app.stdin, '/outdated');
  app.stdin.write(KEYS.enter);
  await until(() => app.provider.state.calls.some((c) => c[0] === 'latest'), 'the registries');
  assert.equal(app.provider.state.calls.find((c) => c[0] === 'latest')[1], 8);
  await type(app.stdin, '/fix openssl');
  app.stdin.write(KEYS.enter);
  await until(shows(app, "part of the image's operating system"), 'what to do instead');
  assert.match(app.lastFrame(), /3\.0\.11-1~deb12u2 or later/);
  app.unmount();
});
