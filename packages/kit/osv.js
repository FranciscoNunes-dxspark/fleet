// OSV (osv.dev), the open database of advisories GitHub, npm and NuGet's own feed into: which of
// the packages have advisories (one /v1/querybatch per thousand packages), then each advisory's record
// (/v1/vulns/<id>), kept for the session, and between runs in a cache when one is given; and how bad
// an advisory is. No account and no key. Bilge's audit and Keel's advisory watch both ask through it.
import { callSignal } from './run.js';

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

// How bad an advisory is: GitHub's own word, else its CVSS 3 vector's score. Pure.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'];
export const rank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
};

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
};

// CVSS 3.1's own rounding up to one decimal, which avoids floating point's near misses.
const roundUp = (x) => {
  const n = Math.round(x * 100000);
  return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10;
};

/** A CVSS 3.0 or 3.1 vector's base score (CVSS:3.1/AV:N/AC:L/…), or null when it isn't one. */
export function cvss3Score(vector) {
  const m = Object.fromEntries(
    String(vector ?? '')
      .split('/')
      .map((p) => p.split(':')),
  );
  if (!/^3\.[01]$/.test(m.CVSS ?? '')) return null;
  const changed = m.S === 'C';
  const av = WEIGHTS.AV[m.AV];
  const ac = WEIGHTS.AC[m.AC];
  const ui = WEIGHTS.UI[m.UI];
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const [c, i, a] = [m.C, m.I, m.A].map((x) => WEIGHTS.CIA[x]);
  if ([av, ac, ui, pr, c, i, a].some((x) => x === undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploit) : impact + exploit, 10));
}

/** The severity a score falls in. */
export function severityOfScore(score) {
  if (score == null) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return score > 0 ? 'low' : 'unknown';
}

/**
 * How bad an OSV advisory is: { severity, score? }. GitHub's own word first (database_specific.severity:
 * LOW, MODERATE, HIGH, CRITICAL), then the CVSS 3 vector's score.
 */
export function severityOf(vuln) {
  const vector = (vuln.severity ?? []).find((s) => /^CVSS_V3/.test(s.type))?.score;
  const score = cvss3Score(vector);
  const said = String(vuln.database_specific?.severity ?? '').toLowerCase();
  const word = said === 'moderate' ? 'medium' : said;
  if (SEVERITIES.includes(word) && word !== 'unknown') return { severity: word, ...(score != null ? { score } : {}) };
  return { severity: severityOfScore(score), ...(score != null ? { score } : {}) };
}
