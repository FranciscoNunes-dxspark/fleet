// A GitHub REST and GraphQL client for one identity (a token, or the GitHub CLI's sign-in).
// The same shape as azdo/client.js: retries, paging and a concurrency cap per person.
const RETRYABLE = new Set([500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GithubError extends Error {
  constructor(message, status, detail, code) {
    super(message);
    this.status = status;
    this.detail = detail;
    if (code) this.code = code;
  }
}

export const seg = (s) => encodeURIComponent(s);

/** The API addresses for a GitHub host: github.com, or a GitHub Enterprise Server. */
export function apiBases(host = 'github.com') {
  const h = String(host).toLowerCase();
  return h === 'github.com'
    ? { rest: 'https://api.github.com', graphql: 'https://api.github.com/graphql', web: 'https://github.com' }
    : { rest: `https://${h}/api/v3`, graphql: `https://${h}/api/graphql`, web: `https://${h}` };
}

const rejected = () => new GithubError('GitHub rejected the token: it may have expired, been revoked, or lack the needed scopes.', 401, null, 'token-rejected');

/**
 * `token` is the token itself, or an async function giving it (the GitHub CLI's, see ghcli.js),
 * asked for on every request.
 */
export function createClient({ host = 'github.com', token, maxConcurrency = 6 } = {}) {
  const bases = apiBases(host);
  const auth = typeof token === 'function' ? async () => `Bearer ${await token()}` : async () => `Bearer ${token || ''}`;

  let active = 0;
  const waiting = [];
  function limited(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          active--;
          waiting.shift()?.();
        }
      };
      if (active < maxConcurrency) run();
      else waiting.push(run);
    });
  }

  function buildUrl(path, query = {}) {
    const url = new URL(path.startsWith('http') ? path : `${bases.rest}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    return url;
  }

  /** How long to wait before retrying a rate-limited answer, or null when it isn't one worth waiting for. */
  function rateLimitWait(res) {
    const after = Number(res.headers.get('retry-after'));
    if (Number.isFinite(after) && after > 0) return after * 1000;
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const wait = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      // Only a short wait; an hour's limit is reported instead.
      return wait > 0 && wait < 60_000 ? wait + 500 : null;
    }
    return null;
  }

  // GETs are asked again with the ETag of the last answer: an unchanged one comes back as a 304,
  // which GitHub doesn't count against the rate limit, so polling many repos stays cheap.
  const etags = new Map(); // url -> { etag, data, headers }
  const remember = (key, entry) => {
    etags.delete(key);
    etags.set(key, entry);
    if (etags.size > 1000) etags.delete(etags.keys().next().value);
  };

  /** Low-level request. `path` is relative to the REST API. Returns { data, headers }. */
  function request(path, { method = 'GET', query, body, accept = 'application/vnd.github+json', text = false } = {}) {
    const url = buildUrl(path, query);
    const cacheKey = method === 'GET' && !text ? url.toString() : null;
    return limited(async () => {
      const authHeader = await auth();
      for (let attempt = 0; ; attempt++) {
        const known = cacheKey && etags.get(cacheKey);
        let res;
        try {
          res = await fetch(url, {
            method,
            headers: {
              Authorization: authHeader,
              Accept: accept,
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'keel',
              ...(known ? { 'If-None-Match': known.etag } : {}),
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          if (attempt < 2) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new GithubError(`Network error calling GitHub: ${err.message}`, 502);
        }

        if (attempt < 3 && (RETRYABLE.has(res.status) || res.status === 429 || res.status === 403)) {
          const wait = RETRYABLE.has(res.status) ? 750 * 2 ** attempt : rateLimitWait(res);
          if (wait != null) {
            res.body?.cancel().catch(() => {});
            await sleep(wait);
            continue;
          }
        }
        if (res.status === 304 && known) return { data: known.data, headers: known.headers };
        if (res.status === 401) throw rejected();
        if (!res.ok) {
          let detail = await res.text();
          try {
            detail = JSON.parse(detail).message || detail;
          } catch {
            // keep text
          }
          if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
            const reset = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
            throw new GithubError(`GitHub's rate limit for your token is used up until ${reset.toISOString().slice(11, 16)} UTC.`, 429, detail);
          }
          throw new GithubError(`GitHub ${method} ${url.pathname} failed (${res.status}): ${String(detail).slice(0, 400)}`, res.status, detail);
        }
        if (res.status === 204 || (res.status === 202 && !(res.headers.get('content-type') || '').includes('json'))) {
          res.body?.cancel().catch(() => {});
          return { data: null, headers: res.headers };
        }
        const data = text ? await res.text() : await res.json();
        const etag = res.headers.get('etag');
        if (cacheKey && etag) remember(cacheKey, { etag, data, headers: res.headers });
        return { data, headers: res.headers };
      }
    });
  }

  const api = (path, opts) => request(path, opts).then((r) => r.data);
  const apiText = (path, opts) => request(path, { ...opts, accept: 'application/vnd.github.raw', text: true }).then((r) => r.data);

  /** Follows Link: rel="next" paging. `pick` takes the list out of wrapped answers ({ workflow_runs: [...] }). */
  async function listAll(path, { query = {}, max = 1000, pick = (d) => d, ...opts } = {}) {
    const out = [];
    let next = buildUrl(path, { per_page: 100, ...query }).toString();
    while (next && out.length < max) {
      const { data, headers } = await request(next, opts);
      out.push(...(pick(data) || []));
      next = /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') || '')?.[1] || null;
    }
    return out.slice(0, max);
  }

  /**
   * A GraphQL query or mutation; GitHub's errors become thrown errors (NOT_FOUND as a 404).
   * With `partial`, GitHub's answer comes back as { data, errors } instead: what it could answer, and why not the rest.
   */
  async function graphql(query, variables = {}, { partial = false } = {}) {
    const { data } = await request(bases.graphql, { method: 'POST', body: { query, variables } });
    if (partial) return { data: data?.data || {}, errors: data?.errors || [] };
    if (data?.errors?.length) {
      const e = data.errors[0];
      throw new GithubError(`GitHub: ${e.message}`, e.type === 'NOT_FOUND' ? 404 : e.type === 'FORBIDDEN' ? 403 : 400, data.errors);
    }
    return data?.data;
  }

  /** Images in GitHub descriptions need a browser session, not a token: they open on GitHub instead. */
  function fetchOrgImage() {
    throw new GithubError('Images from GitHub open on GitHub', 400);
  }

  return { bases, request, api, apiText, listAll, graphql, fetchOrgImage };
}
