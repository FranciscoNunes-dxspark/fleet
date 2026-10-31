// An in-memory project with the provider's interface, for `bilge --demo` and the tests: an npm lock
// file, a NuGet one and a package.json without one, OSV's answers for them, the registries' newest
// versions, and fixes that move a package on. Nothing is read, fetched or run. `state` is the tests'
// handle: what it holds and `calls`, what was asked of it.
import { join } from 'node:path';
import { keyOf, mergePackages } from './lockfiles.js';

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
    },
    {
      path: 'src/Api/packages.lock.json',
      ecosystem: 'NuGet',
      kind: 'lock',
      project: join(root, 'src', 'Api', 'Api.csproj'),
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
const NUGET_LICENCES = { 'newtonsoft.json': 'MIT', 'microsoft.data.sqlclient': 'MIT', serilog: 'Apache-2.0', 'system.text.encodings.web': 'MIT' };

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
    async audit(packages) {
      state.calls.push(['audit', packages.length]);
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
        const id = p.ecosystem === 'NuGet' ? p.name.toLowerCase() : p.name;
        out.set(p.key, { latest: LATEST[id] ?? p.version, ...(p.license ? {} : { license: NUGET_LICENCES[id] ?? null }), ...(p.name === 'ghostscript-js' ? { deprecated: 'No longer maintained' } : {}) });
        onProgress?.(i + 1, packages.length);
      });
      return out;
    },
    /** A fix: npm install name@^v or dotnet add … package Name --version v moves that package on. */
    async run(command, { cwd } = {}) {
      state.calls.push(['run', command, cwd]);
      const m = /^npm install (\S+)@\^?(\S+)/.exec(command) ?? /package (\S+) --version (\S+)/.exec(command);
      if (!m) return { stdout: `(demo) ${command}`, stderr: '' };
      for (const man of state.manifests ?? []) for (const p of man.packages) if (p.name.toLowerCase() === m[1].toLowerCase()) p.version = m[2];
      return { stdout: `(demo) changed ${m[1]} to ${m[2]}`, stderr: '' };
    },
    writeFile(path, text) {
      state.calls.push(['write', path, text.length]);
      state.written = { path, text };
    },
  };
}
