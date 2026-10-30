// A software bill of materials in CycloneDX 1.5 JSON: every package found, with its purl, licence and
// whether it's only for development, and the advisories against them. Pure (the time and serial
// number are given).
import { SEVERITIES } from './audit.js';

/** A package's purl: pkg:npm/%40scope/name@1.2.3, pkg:nuget/Name@1.2.3. */
export function purlOf(p) {
  if (p.ecosystem === 'npm') {
    const [scope, name] = p.name.startsWith('@') ? p.name.split('/') : [null, p.name];
    return `pkg:npm/${scope ? `${encodeURIComponent(scope)}/` : ''}${encodeURIComponent(name)}@${encodeURIComponent(p.version)}`;
  }
  return `pkg:nuget/${encodeURIComponent(p.name)}@${encodeURIComponent(p.version)}`;
}

const SPDX_ID = /^[A-Za-z0-9.+-]+$/;

function licencesOf(licence) {
  if (!licence || /^SEE LICEN[CS]E|^UNLICENSED$|^https?:/i.test(licence)) return undefined;
  return SPDX_ID.test(licence) ? [{ license: { id: licence } }] : [{ expression: licence }];
}

/**
 * The bill: `scan` is lockfiles.js's { root, packages }, `found` audit.js's findings (or none),
 * `licences` what the registries said (key → { license }), `tool` { name, version }.
 */
export function cyclonedx({ name, packages, found = [], licences = new Map(), tool, now = new Date(), serial }) {
  const components = packages.map((p) => {
    const licenses = licencesOf(p.license ?? licences.get(p.key)?.license);
    return {
      type: 'library',
      'bom-ref': purlOf(p),
      name: p.name,
      version: p.version,
      purl: purlOf(p),
      scope: p.dev ? 'optional' : 'required',
      ...(licenses ? { licenses } : {}),
    };
  });
  const vulns = new Map();
  for (const f of found) {
    for (const a of f.advisories) {
      const had = vulns.get(a.id);
      if (had) {
        had.affects.push({ ref: purlOf(f.pkg) });
        continue;
      }
      vulns.set(a.id, {
        id: a.id,
        source: { name: 'OSV', url: a.url },
        ...(SEVERITIES.includes(a.severity) ? { ratings: [{ severity: a.severity,...(a.score != null ? { score: a.score, method: 'CVSSv31' } : {}) }] } : {}),
        description: a.summary,
        ...(a.fixed ? { recommendation: `Upgrade ${f.pkg.name} to ${a.fixed} or later` } : {}),
        affects: [{ ref: purlOf(f.pkg) }],
      });
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp: now.toISOString(),
      tools: { components: [{ type: 'application', name: tool.name, version: tool.version }] },
      component: { type: 'application', name, 'bom-ref': `app:${name}` },
    },
    components,
    ...(vulns.size ? { vulnerabilities: [...vulns.values()] } : {}),
  };
}
