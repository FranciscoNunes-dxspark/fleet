// The registries' word on a package: its newest version, its licence where the lock file doesn't say
// (NuGet's never do), and what a version needs to run (`needs`: npm's engines.node and required
// peerDependencies, the frameworks a NuGet package is built for). npm's registry answers
// /<name>/latest and /<name>/<version>, and every version at once in its short form; NuGet's flat
// container lists every version and keeps each one's .nuspec, whose <license> is the licence and whose
// dependency groups name the frameworks.
import { eachLimited, getJson } from './osv.js';
import { compareVersions, isPrerelease, newest, parseVersion } from './versions.js';
import { nuspecFrameworks } from './frameworks.js';
import { requiredPeers } from './lockfiles.js';
import { callSignal } from '@fleet/kit/run.js';

export const NPM_URL = 'https://registry.npmjs.org';
export const NUGET_URL = 'https://api.nuget.org/v3-flatcontainer';
const AT_ONCE = 8;

/** npm's address for a package: a scope's slash escaped. */
export const npmPath = (name) => name.replace('/', '%2f');

/** Where a person reads about a package. */
export const packageUrl = (p) => (p.ecosystem === 'npm' ? `https://www.npmjs.com/package/${p.name}/v/${p.version}` : `https://www.nuget.org/packages/${p.name}/${p.version}`);

/** A .nuspec's licence: the SPDX expression, else the file or address it points at; null when it has none. */
export function nuspecLicence(xml) {
  const s = String(xml ?? '');
  const m = /<license\b([^>]*)>\s*([^<]+?)\s*<\/license>/i.exec(s);
  if (m) return /type\s*=\s*"file"/i.test(m[1]) ? `SEE LICENSE IN ${m[2]}` : m[2];
  const url = /<licenseUrl>\s*([^<]+?)\s*<\/licenseUrl>/i.exec(s)?.[1];
  if (!url || /aka\.ms\/deprecateLicenseUrl/i.test(url)) return null;
  // The old way named a page; the common ones say which licence.
  const known = [
    [/opensource\.org\/licenses\/MIT|\/MIT(\.txt)?$/i, 'MIT'],
    [/apache\.org\/licenses\/LICENSE-2\.0/i, 'Apache-2.0'],
    [/opensource\.org\/licenses\/BSD-3/i, 'BSD-3-Clause'],
  ].find(([re]) => re.test(url));
  return known ? known[1] : url;
}

/**
 * A repository's address as a person opens it: npm's `git+https://…/x.git`, `git://…` or
 * `github:owner/repo` as https. Null when it isn't one.
 */
export function repositoryUrl(text) {
  const s = String(text ?? '').trim();
  const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(s);
  if (short) return `https://github.com/${short[1].replace(/\.git$/, '')}`;
  const url = s.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/\.git$/, '');
  return /^https?:\/\/\S+$/.test(url) ? url : null;
}

/** A .nuspec's repository (its <repository url>, else its <projectUrl>), or null. */
export function nuspecRepository(xml) {
  const s = String(xml ?? '');
  return repositoryUrl(/<repository\b[^>]*\burl\s*=\s*"([^"]+)"/i.exec(s)?.[1] ?? /<projectUrl>\s*([^<]+?)\s*<\/projectUrl>/i.exec(s)?.[1]);
}

/** What an npm version's document says it needs: { node?, peers? }. */
export function npmNeeds(doc) {
  const node = typeof doc?.engines?.node === 'string' ? doc.engines.node : null;
  const peers = requiredPeers(doc?.peerDependencies, doc?.peerDependenciesMeta);
  return { ...(node ? { node } : {}), ...(peers ? { peers } : {}) };
}

/** What a NuGet version's .nuspec says it needs: { frameworks? }. */
export function nugetNeeds(xml) {
  const frameworks = nuspecFrameworks(xml);
  return frameworks ? { frameworks } : {};
}

// How many of a NuGet package's major versions are asked about, newest first, for one that fits.
const MAJORS = 6;
// npm's short form of a package's document: every version, with its engines and peerDependencies.
const ABBREVIATED = 'application/vnd.npm.install-v1+json';

async function getText(fetchImpl, url, { signal, accept } = {}) {
  const call = callSignal(signal);
  try {
    const res = await fetchImpl(url, { signal: call.signal, ...(accept ? { headers: { accept } } : {}) });
    return res.ok ? await res.text() : null;
  } finally {
    call.done();
  }
}

export function createRegistry({ fetchImpl = globalThis.fetch, npm = NPM_URL, nuget = NUGET_URL } = {}) {
  const nuspecOf = (p, version, signal) => {
    const id = p.name.toLowerCase();
    return getText(fetchImpl, `${nuget}/${id}/${version.toLowerCase()}/${id}.nuspec`, { signal }).catch((e) => {
      if (e.cancelled || signal?.aborted) throw e;
      return null;
    });
  };
  const one = async (p, signal) => {
    if (p.ecosystem === 'npm') {
      const doc = await getJson(fetchImpl, `${npm}/${npmPath(p.name)}/latest`, { signal, what: 'npm' });
      if (!doc) return { latest: null };
      const licence = typeof doc.license === 'string' ? doc.license : doc.license?.type;
      const needs = npmNeeds(doc);
      const repository = repositoryUrl(typeof doc.repository === 'string' ? doc.repository : doc.repository?.url);
      return { latest: doc.version ?? null, ...(doc.deprecated ? { deprecated: String(doc.deprecated) } : {}), ...(licence && !p.license ? { license: licence } : {}), ...(Object.keys(needs).length ? { needs } : {}), ...(repository ? { repository } : {}) };
    }
    const id = p.name.toLowerCase();
    const index = await getJson(fetchImpl, `${nuget}/${id}/index.json`, { signal, what: 'NuGet' });
    const latest = newest(index?.versions ?? []);
    const newer = latest && compareVersions(latest, p.version) > 0;
    const [own, next] = await Promise.all([p.license ? null : nuspecOf(p, p.version, signal), newer ? nuspecOf(p, latest, signal) : null]);
    const licence = p.license ? null : nuspecLicence(own);
    const needs = next ? nugetNeeds(next) : {};
    const repository = nuspecRepository(next ?? own);
    return { latest, ...(licence ? { license: licence } : {}), ...(Object.keys(needs).length ? { needs } : {}), ...(repository ? { repository } : {}) };
  };
  return {
    /**
     * The newest version (and licence, where it wasn't known) of each of `packages`: Map key →
     * { latest, license?, deprecated? }, or { error } for one the registry couldn't answer for.
     */
    async latest(packages, { signal, onProgress } = {}) {
      const out = new Map();
      let done = 0;
      await eachLimited(packages, AT_ONCE, async (p) => {
        try {
          out.set(p.key, await one(p, signal));
        } catch (e) {
          if (e.cancelled || signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          out.set(p.key, { error: String(e.message).split('\n')[0] });
        }
        onProgress?.(++done, packages.length);
      });
      return out;
    },

    /** What `version` of `p` needs ({ node?, peers? } or { frameworks? }), or null when the registry hasn't it. */
    async needs(p, version, { signal } = {}) {
      if (p.ecosystem === 'npm') {
        const doc = await getJson(fetchImpl, `${npm}/${npmPath(p.name)}/${encodeURIComponent(version)}`, { signal, what: 'npm' });
        return doc ? npmNeeds(doc) : null;
      }
      const xml = await nuspecOf(p, version, signal);
      return xml ? nugetNeeds(xml) : null;
    },

    /**
     * The newest version of `p` newer than the installed one that `fits(version, needs)` says will do:
     * { version, needs }, or null when none does. npm's are all in one document; NuGet's are tried the
     * newest of each major version down, a few at most.
     */
    async fitting(p, fits, { signal } = {}) {
      if (p.ecosystem === 'npm') {
        const text = await getText(fetchImpl, `${npm}/${npmPath(p.name)}`, { signal, accept: ABBREVIATED });
        const doc = text ? JSON.parse(text) : null;
        const versions = Object.values(doc?.versions ?? {}).filter((d) => d?.version && !d.deprecated && !isPrerelease(d.version) && compareVersions(d.version, p.version) > 0);
        for (const d of versions.sort((a, b) => compareVersions(b.version, a.version))) {
          const needs = npmNeeds(d);
          if (fits(d.version, needs)) return { version: d.version, needs };
        }
        return null;
      }
      const index = await getJson(fetchImpl, `${nuget}/${p.name.toLowerCase()}/index.json`, { signal, what: 'NuGet' });
      const byMajor = new Map();
      for (const v of index?.versions ?? []) {
        if (isPrerelease(v) || compareVersions(v, p.version) <= 0) continue;
        const major = parseVersion(v).parts[0];
        if (!byMajor.has(major) || compareVersions(v, byMajor.get(major)) > 0) byMajor.set(major, v);
      }
      for (const v of [...byMajor.values()].sort((a, b) => compareVersions(b, a)).slice(0, MAJORS)) {
        const xml = await nuspecOf(p, v, signal);
        const needs = xml ? nugetNeeds(xml) : {};
        if (fits(v, needs)) return { version: v, needs };
      }
      return null;
    },
  };
}
