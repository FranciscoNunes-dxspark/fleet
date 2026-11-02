// OSV (osv.dev), the open database of advisories GitHub, npm and NuGet's own feed into: which of the
// packages have advisories (one /v1/querybatch per thousand packages), then each advisory's record
// (/v1/vulns/<id>), kept for the session, and between runs in a cache (cache.js) when one is given. No
// account and no key.
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
    /**
     * Which advisories each package has: Map key → [id]. `packages` are lockfiles.js's (with `key`).
     * With a `cache`, a package it has an answer for isn't asked about again unless `fresh`, and every
     * answer is kept in it.
     */
    async query(packages, { signal, cache, fresh = false } = {}) {
      const ids = new Map();
      const ask = [];
      for (const p of packages) {
        const kept = fresh ? undefined : cache?.query(p.key);
        if (kept === undefined) ask.push(p);
        else if (kept.length) ids.set(p.key, kept);
      }
      for (let i = 0; i < ask.length; i += BATCH) {
        const batch = ask.slice(i, i + BATCH);
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
          const unique = [...new Set(found)];
          if (unique.length) ids.set(batch[j].key, unique);
          cache?.setQuery(batch[j].key, unique);
        }
      }
      return ids;
    },
    /**
     * The advisories' records: Map id → OSV record, the ones read before (this session, or in the
     * `cache`) not asked for again unless `fresh`.
     */
    async vulns(ids, { signal, cache, fresh = false } = {}) {
      const wanted = [];
      for (const id of new Set(ids)) {
        if (!fresh && records.has(id)) continue;
        const kept = fresh ? undefined : cache?.vuln(id);
        if (kept) records.set(id, kept);
        else wanted.push(id);
      }
      await eachLimited(wanted, AT_ONCE, async (id) => {
        const record = await getJson(fetchImpl, `${base}/v1/vulns/${encodeURIComponent(id)}`, { signal, what: 'OSV' });
        if (!record) return;
        records.set(id, record);
        cache?.setVuln(id, record);
      });
      return new Map([...new Set(ids)].filter((id) => records.has(id)).map((id) => [id, records.get(id)]));
    },
  };
}
