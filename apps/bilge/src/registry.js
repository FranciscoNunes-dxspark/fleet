// The registries' word on a package: its newest version, and its licence where the lock file doesn't
// say (NuGet's never do). npm's registry answers /<name>/latest; NuGet's flat container lists every
// version and keeps each one's .nuspec, whose <license> is the licence.
import { eachLimited, getJson } from './osv.js';
import { newest } from './versions.js';
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

async function getText(fetchImpl, url, { signal } = {}) {
  const call = callSignal(signal);
  try {
    const res = await fetchImpl(url, { signal: call.signal });
    return res.ok ? await res.text() : null;
  } finally {
    call.done();
  }
}

export function createRegistry({ fetchImpl = globalThis.fetch, npm = NPM_URL, nuget = NUGET_URL } = {}) {
  const one = async (p, signal) => {
    if (p.ecosystem === 'npm') {
      const doc = await getJson(fetchImpl, `${npm}/${npmPath(p.name)}/latest`, { signal, what: 'npm' });
      if (!doc) return { latest: null };
      const licence = typeof doc.license === 'string' ? doc.license : doc.license?.type;
      return { latest: doc.version ?? null, ...(doc.deprecated ? { deprecated: String(doc.deprecated) } : {}), ...(licence && !p.license ? { license: licence } : {}) };
    }
    const id = p.name.toLowerCase();
    const index = await getJson(fetchImpl, `${nuget}/${id}/index.json`, { signal, what: 'NuGet' });
    const latest = newest(index?.versions ?? []);
    if (p.license) return { latest };
    const nuspec = await getText(fetchImpl, `${nuget}/${id}/${p.version.toLowerCase()}/${id}.nuspec`, { signal }).catch(() => null);
    const licence = nuspecLicence(nuspec);
    return { latest, ...(licence ? { license: licence } : {}) };
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
  };
}
