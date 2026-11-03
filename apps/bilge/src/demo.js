// An in-memory project with the provider's interface, for `bilge --demo` and the tests: an npm lock
// file, a NuGet one and a package.json without one, OSV's answers for them, the registries' newest
// versions and what each needs (a framework the project's .NET doesn't run, a Node newer than it says),
// and fixes that move a package on. Nothing is read, fetched or run. `state` is the tests'
// handle: what it holds and `calls`, what was asked of it.
// bilge-ignore-file: its made-up code findings are there to be found in the demo, not in Bilge.
import { join } from 'node:path';
import { keyOf, mergePackages } from './lockfiles.js';
import { testPlan } from './upgrade.js';
import { imageManifest } from './image.js';
import { dockerFindings, fileFindings, gitignored, scanText, sortFindings } from './codescan.js';

const npm = (name, version, extra = {}) => ({ ecosystem: 'npm', name, version, direct: false, dev: false, ...extra });
const nuget = (name, version, extra = {}) => ({ ecosystem: 'NuGet', name, version, direct: false, dev: false, ...extra });

function demoManifests(root) {
  return [
    {
      path: 'package-lock.json',
      ecosystem: 'npm',
      kind: 'lock',
      packages: [
        npm('express', '4.17.1', { direct: true, license: 'MIT', line: 12 }),
        npm('lodash', '4.17.20', { direct: true, license: 'MIT', line: 40 }),
        npm('jsonwebtoken', '8.5.1', { direct: true, license: 'MIT', line: 31 }),
        npm('react', '18.2.0', { direct: true, license: 'MIT', line: 55 }),
        npm('typescript', '5.4.5', { direct: true, dev: true, license: 'Apache-2.0', line: 70 }),
        npm('minimist', '1.2.5', { license: 'MIT', line: 48 }),
        npm('debug', '2.6.9', { license: 'MIT', line: 22 }),
        npm('ms', '2.0.0', { license: 'MIT', line: 50 }),
        npm('ghostscript-js', '1.0.4', { license: 'AGPL-3.0-only', line: 27 }),
        npm('mariadb', '3.2.0', { license: 'LGPL-2.1-or-later', line: 44 }),
      ],
      node: { range: '>=16', from: 'engines.node in package.json' },
    },
    {
      path: 'src/Api/packages.lock.json',
      ecosystem: 'NuGet',
      kind: 'lock',
      project: join(root, 'src', 'Api', 'Api.csproj'),
      frameworks: ['net6.0'],
      packages: [
        nuget('Newtonsoft.Json', '12.0.1', { direct: true, line: 5 }),
        nuget('Microsoft.Data.SqlClient', '5.1.1', { direct: true, line: 11 }),
        nuget('Serilog', '3.1.1', { direct: true, line: 23 }),
        nuget('System.Text.Encodings.Web', '4.5.0', { line: 40 }),
      ],
    },
    { path: 'tools/legacy/package.json', ecosystem: 'npm', kind: 'manifest', packages: [], note: 'no package-lock.json: npm install makes one' },
  ].map((m) => ({ ...m, file: join(root, ...m.path.split('/')), dir: join(root, ...m.path.split('/').slice(0, -1)) }));
}

const vuln = (id, name, ecosystem, severity, fixed, summary, { aliases = [], vector } = {}) => ({
  id,
  aliases,
  summary,
  published: '2024-01-15T00:00:00Z',
  database_specific: { severity },
  ...(vector ? { severity: [{ type: 'CVSS_V3', score: vector }] } : {}),
  affected: [{ package: { name, ecosystem }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed }] }] }],
  references: [{ type: 'ADVISORY', url: `https://github.com/advisories/${id}` }],
});

export const DEMO_VULNS = [
  vuln('GHSA-xvch-5gv4-984h', 'minimist', 'npm', 'CRITICAL', '1.2.6', 'Prototype pollution in minimist', { aliases: ['CVE-2021-44906'], vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }),
  vuln('GHSA-ghhp-997w-qr28', 'System.Text.Encodings.Web', 'NuGet', 'CRITICAL', '4.5.1', 'Remote code execution in System.Text.Encodings.Web', { aliases: ['CVE-2021-26701'] }),
  vuln('GHSA-35jh-r3h4-6jhm', 'lodash', 'npm', 'HIGH', '4.17.21', 'Command injection in lodash', { aliases: ['CVE-2021-23337'], vector: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }),
  vuln('GHSA-29mw-wpgm-hmr9', 'lodash', 'npm', 'MODERATE', '4.17.21', 'Regular expression denial of service in lodash', { aliases: ['CVE-2020-28500'] }),
  vuln('GHSA-5crp-9r3c-p9vr', 'Newtonsoft.Json', 'NuGet', 'HIGH', '13.0.1', 'Improper handling of exceptional conditions in Newtonsoft.Json', { aliases: ['CVE-2024-21907'] }),
  vuln('GHSA-98g6-xh36-x2p7', 'Microsoft.Data.SqlClient', 'NuGet', 'HIGH', '5.1.3', 'Security feature bypass in Microsoft.Data.SqlClient', { aliases: ['CVE-2024-0056'] }),
  vuln('GHSA-8cf7-32gw-wr33', 'jsonwebtoken', 'npm', 'MODERATE', '9.0.0', 'jsonwebtoken unrestricted key type could lead to legacy keys usage', { aliases: ['CVE-2022-23539'] }),
  vuln('GHSA-rv95-896h-c2vc', 'express', 'npm', 'MODERATE', '4.19.2', 'Express.js open redirect in malformed URLs', { aliases: ['CVE-2024-29041'] }),
  vuln('GHSA-qwcr-r2fm-qrc7', 'express', 'npm', 'HIGH', '4.20.0', 'body-parser vulnerable to denial of service when url encoding is enabled', { aliases: ['CVE-2024-45590'] }),
];

// An image Wharf could hand over: Debian 12's system packages, two of them with advisories.
const DEMO_OS_RELEASE = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_ID="12"\nVERSION="12 (bookworm)"\n';
const DEMO_DPKG = [
  ['libc6', '2.36-9+deb12u3', 'glibc'],
  ['libc-bin', '2.36-9+deb12u3', 'glibc'],
  ['libssl3', '3.0.11-1~deb12u1', 'openssl'],
  ['openssl', '3.0.11-1~deb12u1'],
  ['zlib1g', '1:1.2.13.dfsg-1', 'zlib'],
  ['bash', '5.2.15-2+b2', 'bash (5.2.15-2)'],
]
  .map(([pkg, version, source]) => `Package: ${pkg}\nStatus: install ok installed\n${source ? `Source: ${source}\n` : ''}Version: ${version}\nArchitecture: amd64\n`)
  .join('\n');
DEMO_VULNS.push(
  vuln('DSA-5585-1', 'openssl', 'Debian:12', 'HIGH', '3.0.11-1~deb12u2', 'openssl: denial of service through excessive time checking DH keys', { aliases: ['CVE-2023-5678'] }),
  vuln('DLA-3912-1', 'zlib', 'Debian:12', 'MODERATE', '1:1.2.13.dfsg-1+deb12u1', 'zlib: heap overflow in MiniZip zipOpenNewFileInZip4_64', { aliases: ['CVE-2023-45853'] }),
);

const LATEST = {
  express: '5.1.0',
  lodash: '4.17.21',
  jsonwebtoken: '9.0.2',
  react: '19.1.0',
  typescript: '5.9.3',
  minimist: '1.2.8',
  debug: '4.4.3',
  ms: '2.1.3',
  'ghostscript-js': '1.0.4',
  mariadb: '3.4.5',
  'newtonsoft.json': '13.0.4',
  'microsoft.data.sqlclient': '6.1.1',
  serilog: '4.3.0',
  'system.text.encodings.web': '9.0.9',
};
// What the versions the demo offers need: Express 5 wants Node 18, SqlClient 6 dropped .NET 6.
const NEEDS = {
  'express@5.1.0': { node: '>= 18' },
  'express@4.21.2': { node: '>= 0.10.0' },
  'express@4.20.0': { node: '>= 0.10.0' },
  'typescript@5.9.3': { node: '>=14.17' },
  'microsoft.data.sqlclient@6.1.1': { frameworks: ['net462', 'net8.0', 'net9.0'] },
  'microsoft.data.sqlclient@6.0.2': { frameworks: ['net462', 'net8.0', 'net9.0'] },
  'microsoft.data.sqlclient@5.2.3': { frameworks: ['net462', 'net6.0', 'net8.0', 'netstandard2.0'] },
  'microsoft.data.sqlclient@5.1.3': { frameworks: ['net462', 'net6.0', 'netstandard2.0'] },
  'serilog@4.3.0': { frameworks: ['net462', 'net471', 'net6.0', 'net8.0', 'netstandard2.0'] },
  'system.text.encodings.web@9.0.9': { frameworks: ['net462', 'net8.0', 'net9.0', 'netstandard2.0'] },
};
// The older versions the demo knows, newest first, for the newest that fits.
const OLDER = { express: ['4.21.2'], 'microsoft.data.sqlclient': ['6.0.2', '5.2.3'] };

const NUGET_LICENCES = { 'newtonsoft.json': 'MIT', 'microsoft.data.sqlclient': 'MIT', serilog: 'Apache-2.0', 'system.text.encodings.web': 'MIT' };

const DEMO_USAGES = {
  express: [
    { path: 'src/server.js', line: 1, text: "const express = require('express');" },
    { path: 'src/routes/orders.js', line: 2, text: "const { Router } = require('express');" },
  ],
  'newtonsoft.json': [{ path: 'src/Api/Program.cs', line: 3, text: 'using Newtonsoft.Json;' }],
};

// The demo's own files, for the Code view: a key left in a config, SQL put together from a request,
// a Dockerfile that never leaves root, a .env git would commit. The fake keys are made up here so that
// no file of this repository holds one whole.
const FAKE_AWS = ['AKIA', 'Z7QX3PLM2RTW5KDN'].join('');
const DEMO_FILES = {
  '.gitignore': 'node_modules\ndist\n',
  'src/config.js': `export const s3 = { accessKeyId: '${FAKE_AWS}', region: 'eu-west-1' };\nexport const db = 'postgres://shop:Tr0ub4dor-3@db.internal:5432/shop';\n`,
  'src/routes/orders.js': "router.get('/orders/:id', async (req, res) => {\n  const rows = await db.query(`SELECT * FROM orders WHERE id = ${req.params.id}`);\n  res.json(rows);\n});\n",
  'src/server.js': "const https = require('https');\nconst agent = new https.Agent({ rejectUnauthorized: false });\n",
  'src/Api/Program.cs': 'var hash = MD5.Create().ComputeHash(bytes);\n',
  'Dockerfile': 'FROM node:latest\nCOPY . /app\nCMD ["node", "src/server.js"]\n',
  '.env': 'STRIPE_KEY=sk_test_51demo\n',
};

/** What codescan.js finds in DEMO_FILES, as the provider's `code` would on the disk. */
export function demoCode(root) {
  const ignored = gitignored(DEMO_FILES['.gitignore']);
  const findings = Object.entries(DEMO_FILES).flatMap(([path, text]) => [...fileFindings(path, { ignored }), ...scanText(path, text), ...dockerFindings(path, text)]);
  return { root, files: Object.keys(DEMO_FILES).length, findings: sortFindings(findings), truncated: false, at: Date.now() };
}

const idOf = (p) => (p.ecosystem === 'NuGet' ? p.name.toLowerCase() : p.name);

export function demoBilge() {
  const state = { manifests: null, calls: [], vulns: DEMO_VULNS };
  const affects = (v, p) => v.affected.some((a) => a.package.ecosystem === p.ecosystem && a.package.name.toLowerCase() === p.name.toLowerCase());
  const fixedBy = (v) => v.affected[0].ranges[0].events.find((e) => e.fixed).fixed;
  const newer = (a, b) => a.localeCompare(b, undefined, { numeric: true }) >= 0;
  return {
    name: 'demo',
    state,
    async scan(dir) {
      state.calls.push(['scan', dir]);
      state.manifests ??= demoManifests(dir);
      const manifests = state.manifests.map((m) => ({ ...m, packages: m.packages.map((p) => ({ ...p })) }));
      return { root: dir, manifests, packages: mergePackages(manifests) };
    },
    async audit(packages, { fresh = false } = {}) {
      state.calls.push(['audit', packages.length, ...(fresh ? ['fresh'] : [])]);
      const ids = new Map();
      const details = new Map();
      for (const p of packages) {
        const hit = state.vulns.filter((v) => affects(v, p) && !newer(p.version, fixedBy(v)));
        if (!hit.length) continue;
        ids.set(p.key ?? keyOf(p), hit.map((v) => v.id));
        for (const v of hit) details.set(v.id, v);
      }
      return { ids, details };
    },
    async latest(packages, { onProgress } = {}) {
      state.calls.push(['latest', packages.length]);
      const out = new Map();
      packages.forEach((p, i) => {
        const id = idOf(p);
        const latest = LATEST[id] ?? p.version;
        const needs = NEEDS[`${id}@${latest}`];
        out.set(p.key, { latest, ...(p.license ? {} : { license: NUGET_LICENCES[id] ?? null }), ...(p.name === 'ghostscript-js' ? { deprecated: 'No longer maintained' } : {}), ...(needs ? { needs } : {}), ...(id === 'express' ? { repository: 'https://github.com/expressjs/express' } : {}) });
        onProgress?.(i + 1, packages.length);
      });
      return out;
    },
    async needs(p, version) {
      state.calls.push(['needs', p.name, version]);
      return NEEDS[`${idOf(p)}@${version}`] ?? {};
    },
    async fitting(p, fits) {
      state.calls.push(['fitting', p.name]);
      const id = idOf(p);
      for (const version of OLDER[id] ?? []) {
        const needs = NEEDS[`${id}@${version}`] ?? {};
        if (fits(version, needs)) return { version, needs };
      }
      return null;
    },
    /** A fix: npm install (yarn add, pnpm add) name@^v or dotnet add … package Name --version v moves that package on. */
    async run(command, { cwd } = {}) {
      state.calls.push(['run', command, cwd]);
      if (/^(npm ls|yarn why|pnpm why|dotnet restore)\b/.test(command)) return { stdout: `(demo) ${command}: all fits`, stderr: '' };
      // /upgrade's git and tests: a clean tree unless `state.dirty` says what's changed, a failing step where `state.failing` names it.
      if (state.failing && command.startsWith(state.failing)) throw Object.assign(new Error(`(demo) ${command} failed: 1 test of 12 failed`), { code: 1 });
      if (command === 'git status --porcelain') return { stdout: state.dirty ?? '', stderr: '' };
      const branch = /^git checkout -b (\S+)$/.exec(command);
      if (branch) {
        state.branches ??= [];
        if (state.branches.includes(branch[1])) throw new Error(`fatal: a branch named '${branch[1]}' already exists`);
        state.branches.push(branch[1]);
        return { stdout: '', stderr: `Switched to a new branch '${branch[1]}'` };
      }
      const commit = /^git commit -m "([^"]*)"$/.exec(command);
      if (commit) (state.commits ??= []).push(commit[1]);
      if (/^(git|npm test|yarn test|pnpm test|dotnet test)\b/.test(command)) return { stdout: `(demo) ${command}`, stderr: '' };
      const m = /^(?:npm install|yarn add|pnpm add) (\S+)@\^?(\S+)/.exec(command) ?? /package (\S+) --version (\S+)/.exec(command);
      if (!m) return { stdout: `(demo) ${command}`, stderr: '' };
      for (const man of state.manifests ?? []) for (const p of man.packages) if (p.name.toLowerCase() === m[1].toLowerCase()) p.version = m[2];
      return { stdout: `(demo) changed ${m[1]} to ${m[2]}`, stderr: '' };
    },
    /** An image's system packages: Debian 12's, whatever it's called, as image.js reads them out of one. */
    async image(ref) {
      state.calls.push(['image', ref]);
      return imageManifest(ref, { db: { kind: 'dpkg', text: DEMO_DPKG }, osRelease: DEMO_OS_RELEASE });
    },
    /** The demo's own files, read for secrets and risky code (codescan.js's rules, on DEMO_FILES). */
    async code(root) {
      state.calls.push(['code', root]);
      return demoCode(root);
    },
    /** Where the demo's code imports a package: express in the server, Newtonsoft.Json in the API. */
    async usages(root, p) {
      state.calls.push(['usages', p.name]);
      return DEMO_USAGES[idOf(p)] ?? [];
    },
    /** Claude, made up: what it was asked is kept in `state.asked`. */
    async claude(prompt, { input = '' } = {}) {
      state.calls.push(['claude']);
      state.asked = { prompt, input };
      const m = /package (\S+) at (\S+)\. Its newest version is (\S+),/.exec(prompt);
      return `(demo) Moving ${m?.[1]} from ${m?.[2]} to ${m?.[3]} is a small job here: two places to change.\n\n- src/server.js:14 uses app.del(), which ${m?.[3]} removes: use app.delete().\n- src/routes/orders.js:3 passes a string to res.send(status): use res.sendStatus().`;
    },
    /** The demo's tests: the npm project's test script, and dotnet test on the API's project. */
    async tests(manifests, root) {
      state.calls.push(['tests', manifests.map((m) => m.path)]);
      return testPlan(manifests, root, { readJson: () => ({ scripts: { test: 'node --test' } }), list: () => [] });
    },
    writeFile(path, text) {
      state.calls.push(['write', path, text.length]);
      state.written = { path, text };
    },
  };
}
