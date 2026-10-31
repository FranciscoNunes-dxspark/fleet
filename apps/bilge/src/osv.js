// OSV (osv.dev), the open database of advisories GitHub, npm and NuGet's own feed into: which of the
// packages have advisories (one /v1/querybatch per thousand packages), then each advisory's record
// (/v1/vulns/<id>), kept for the session. No account and no key.
import { callSignal } from '@fleet/kit/run.js';

export const OSV_URL = 'https://api.osv.dev';
export const BATCH = 1000;
const PAGES = 5;
const AT_ONCE = 8;

/** fetch, as JSON, saying who answered and how when it fails. */
export async function getJson(fetchImpl, url, { signal, body, what = url } = {}) {
  const call = callSignal(signal);
  try {
    const res = await fetchImpl(url, {
      method: body ? 'POST' : 'GET',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: call.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${what} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    return await res.json();
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') throw Object.assign(new Error('Cancelled'), { cancelled: true });
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(`${e.message} ${e.cause?.code ?? ''}`)) throw new Error(`Couldn't reach ${new URL(url).host}: ${e.cause?.code ?? e.message}`);
    throw e;
  } finally {
    call.done();
  }
}

/** Runs `work(item)` over `items`, `n` at a time, in order of the results. */
export async function eachLimited(items, n, work) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
  return out;
}

export function createOsv({ fetchImpl = globalThis.fetch, base = OSV_URL } = {}) {
  const records = new Map();
  return {
    /** Which advisories each package has: Map key → [id]. `packages` are lockfiles.js's (with `key`). */
    async query(packages, { signal } = {}) {
      const ids = new Map();
      for (let i = 0; i < packages.length; i += BATCH) {
        const batch = packages.slice(i, i + BATCH);
        const queries = batch.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }));
        const answer = await getJson(fetchImpl, `${base}/v1/querybatch`, { signal, body: { queries }, what: 'OSV' });
        const results = answer?.results ?? [];
        for (let j = 0; j < batch.length; j++) {
          const found = (results[j]?.vulns ?? []).map((v) => v.id);
          // A package with very many advisories comes a page at a time.
          let token = results[j]?.next_page_token;
          for (let page = 0; token && page < PAGES; page++) {
            const more = await getJson(fetchImpl, `${base}/v1/querybatch`, { signal, body: { queries: [{ ...queries[j], page_token: token }] }, what: 'OSV' });
            found.push(...(more?.results?.[0]?.vulns ?? []).map((v) => v.id));
            token = more?.results?.[0]?.next_page_token;
          }
          if (found.length) ids.set(batch[j].key, [...new Set(found)]);
        }
      }
      return ids;
    },
    /** The advisories' records: Map id → OSV record, the ones read before not asked for again. */
    async vulns(ids, { signal } = {}) {
      const wanted = [...new Set(ids)].filter((id) => !records.has(id));
      await eachLimited(wanted, AT_ONCE, async (id) => {
        const record = await getJson(fetchImpl, `${base}/v1/vulns/${encodeURIComponent(id)}`, { signal, what: 'OSV' });
        if (record) records.set(id, record);
      });
      return new Map([...new Set(ids)].filter((id) => records.has(id)).map((id) => [id, records.get(id)]));
    },
  };
}
