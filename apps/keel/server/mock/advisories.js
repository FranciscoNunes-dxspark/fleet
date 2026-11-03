// Demo lock files and a fake OSV, so the advisory watch works in demo mode and in tests without
// the network: a storefront pinned to lodash 4.17.20 and minimist 1.2.5, a checkout API pinned to
// Newtonsoft.Json 12.0.1, and the real advisories those versions have (trimmed to what Keel reads).

const npmLock = (name, packages) => JSON.stringify({
  name,
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name, version: '1.0.0', dependencies: Object.fromEntries(packages.filter((p) => p.direct).map((p) => [p.name, `^${p.version}`])) },
    ...Object.fromEntries(packages.map((p) => [`node_modules/${p.name}`, { version: p.version, resolved: `https://registry.npmjs.org/${p.name}/-/${p.name}-${p.version}.tgz`, ...(p.dev ? { dev: true } : {}) }])),
  },
}, null, 2);

const nugetLock = (packages) => JSON.stringify({
  version: 1,
  dependencies: {
    'net8.0': Object.fromEntries(packages.map((p) => [p.name, { type: p.direct ? 'Direct' : 'Transitive', ...(p.direct ? { requested: `[${p.version}, )` } : {}), resolved: p.version }])),
  },
}, null, 2);

/** Demo repositories' files on their default branch, by repo name: path → text (lock files) or '' (the rest). */
export const DEMO_FILES = {
  'storefront-web': {
    '/README.md': '',
    '/package.json': '',
    '/package-lock.json': npmLock('storefront-web', [
      { name: 'react', version: '18.3.1', direct: true },
      { name: 'react-dom', version: '18.3.1', direct: true },
      { name: 'lodash', version: '4.17.20', direct: true },
      { name: 'minimist', version: '1.2.5' },
      { name: 'vite', version: '5.4.10', direct: true, dev: true },
    ]),
    '/src/main.tsx': '',
    // Installed packages carry their own lock files sometimes; the watch never reads those.
    '/node_modules/left-pad/package-lock.json': '{}',
  },
  'checkout-api': {
    '/README.md': '',
    '/src/Checkout.Api/Checkout.Api.csproj': '',
    '/src/Checkout.Api/packages.lock.json': nugetLock([
      { name: 'Newtonsoft.Json', version: '12.0.1', direct: true },
      { name: 'Serilog', version: '3.1.1', direct: true },
      { name: 'Microsoft.Extensions.Logging.Abstractions', version: '8.0.0' },
    ]),
  },
  'notifications-service': {
    '/package.json': '',
    '/package-lock.json': npmLock('notifications-service', [
      { name: 'express', version: '4.21.2', direct: true },
      { name: 'zod', version: '3.23.8', direct: true },
    ]),
  },
};

// GitHub's demo owner (mock/github.js): its web app pins the same lodash.
export const DEMO_GITHUB_FILES = {
  'web-app': {
    'package.json': '',
    'package-lock.json': npmLock('web-app', [
      { name: 'lodash', version: '4.17.20', direct: true },
      { name: 'react', version: '18.3.1', direct: true },
    ]),
  },
};

const RECORDS = [
  {
    id: 'GHSA-35jh-r3h4-6jhm',
    aliases: ['CVE-2021-23337'],
    summary: 'Command Injection in lodash',
    database_specific: { severity: 'HIGH' },
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
  },
  {
    id: 'GHSA-xvch-5gv4-984h',
    aliases: ['CVE-2021-44906'],
    summary: 'Prototype Pollution in minimist',
    database_specific: { severity: 'CRITICAL' },
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    affected: [{ package: { ecosystem: 'npm', name: 'minimist' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '0.2.4' }, { introduced: '1.0.0' }, { fixed: '1.2.6' }] }] }],
  },
  {
    id: 'GHSA-5crp-9r3c-p9vr',
    aliases: ['CVE-2024-21907'],
    summary: 'Improper Handling of Exceptional Conditions in Newtonsoft.Json',
    database_specific: { severity: 'HIGH' },
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' }],
    affected: [{ package: { ecosystem: 'NuGet', name: 'Newtonsoft.Json' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '13.0.1' }] }] }],
  },
];

// Which record applies to a package version, as OSV's query decides it (here: below the fix).
const AFFECTS = {
  'npm:lodash': (v) => cmp(v, '4.17.21') < 0 && ['GHSA-35jh-r3h4-6jhm'],
  'npm:minimist': (v) => cmp(v, '1.2.6') < 0 && ['GHSA-xvch-5gv4-984h'],
  'NuGet:newtonsoft.json': (v) => cmp(v, '13.0.1') < 0 && ['GHSA-5crp-9r3c-p9vr'],
};
const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

/**
 * A fetch that answers OSV's /v1/querybatch and /v1/vulns/<id> from the records above. `calls`
 * keeps each request's URL and body, so tests can see what left the server.
 */
export function createMockOsvFetch({ records = RECORDS, calls = [] } = {}) {
  const json = (status, body) => ({ ok: status < 400, status, statusText: '', json: async () => body });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ url: u.href, body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === '/v1/querybatch') {
      const { queries } = JSON.parse(init.body);
      return json(200, {
        results: queries.map((q) => {
          const name = q.package.ecosystem === 'NuGet' ? q.package.name.toLowerCase() : q.package.name;
          const ids = (AFFECTS[`${q.package.ecosystem}:${name}`]?.(q.version) || []).filter((id) => records.some((r) => r.id === id));
          return ids.length ? { vulns: ids.map((id) => ({ id, modified: '2024-01-01T00:00:00Z' })) } : {};
        }),
      });
    }
    const id = /^\/v1\/vulns\/(.+)$/.exec(u.pathname)?.[1];
    const record = id && records.find((r) => r.id === decodeURIComponent(id));
    return record ? json(200, structuredClone(record)) : json(404, {});
  };
  fetch.calls = calls;
  return fetch;
}

export { RECORDS as DEMO_RECORDS };
