import { config } from '../config.js';

export class AzdoError extends Error {
  constructor(message, status, detail, code) {
    super(message);
    this.status = status;
    this.detail = detail;
    if (code) this.code = code;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const seg = (s) => encodeURIComponent(s);

/**
 * An Azure DevOps REST client for one identity (one PAT). Each signed-in user
 * gets their own, with its own concurrency limit: Azure DevOps throttles per
 * user, so one busy user can't slow everyone else down.
 */
export function createClient({ orgUrl = config.orgUrl, pat, maxConcurrency = config.maxConcurrency, apiVersion: defaultVersion = config.apiVersion } = {}) {
  const authHeader = 'Basic ' + Buffer.from(':' + (pat || '')).toString('base64');

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

  function buildUrl(path, query = {}, apiVersion = defaultVersion) {
    const url = new URL(path.startsWith('http') ? path : `${orgUrl}/${path.replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    if (!url.searchParams.has('api-version')) url.searchParams.set('api-version', apiVersion);
    return url;
  }

  /** Low-level request. `path` is relative to the organization URL. Returns { data, headers }. */
  function request(path, { method = 'GET', query, body, contentType = 'application/json', apiVersion } = {}) {
    const url = buildUrl(path, query, apiVersion);
    return limited(async () => {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          res = await fetch(url, {
            method,
            headers: {
              Authorization: authHeader,
              Accept: 'application/json',
              ...(body !== undefined ? { 'Content-Type': contentType } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
          });
        } catch (err) {
          if (attempt < 2) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          throw new AzdoError(`Network error calling Azure DevOps: ${err.message}`, 502);
        }

        if (RETRYABLE.has(res.status) && attempt < 3) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 750 * 2 ** attempt);
          continue;
        }

        const type = res.headers.get('content-type') || '';
        // A bad/expired PAT often yields 203 + an HTML sign-in page rather than 401.
        if (res.status === 401 || res.status === 203 || (res.ok && res.status !== 204 && !type.includes('json'))) {
          throw new AzdoError('Azure DevOps rejected the token: it may have expired, been revoked, or lack the needed scopes.', 401, null, 'token-rejected');
        }
        if (!res.ok) {
          let detail = await res.text();
          try {
            detail = JSON.parse(detail).message || detail;
          } catch {
            // keep text
          }
          throw new AzdoError(`Azure DevOps ${method} ${url.pathname} failed (${res.status}): ${String(detail).slice(0, 400)}`, res.status, detail);
        }
        const data = res.status === 204 ? null : await res.json();
        return { data, headers: res.headers };
      }
    });
  }

  const api = (path, opts) => request(path, opts).then((r) => r.data);

  /** Follows x-ms-continuationtoken paging and concatenates `value` arrays. */
  async function listAll(path, { query = {}, ...opts } = {}) {
    const out = [];
    let token;
    do {
      const { data, headers } = await request(path, { ...opts, query: { ...query, continuationToken: token } });
      out.push(...(data?.value ?? []));
      token = headers.get('x-ms-continuationtoken');
    } while (token);
    return out;
  }

  /** $top/$skip paging (used by the pull request search API). */
  async function listSkip(path, { query = {}, pageSize = 200, max = 2000, ...opts } = {}) {
    const out = [];
    for (let skip = 0; skip < max; skip += pageSize) {
      const data = await api(path, { ...opts, query: { ...query, $top: pageSize, $skip: skip } });
      const page = data?.value ?? [];
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  /**
   * Fetches an image (e.g. a screenshot pasted into a PR description) with the
   * PAT. Only URLs inside the organization are allowed, and only image
   * responses are returned, so this can't be used as an open proxy.
   */
  function fetchOrgImage(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AzdoError('Invalid image URL', 400);
    }
    const org = new URL(orgUrl);
    const orgPath = org.pathname.replace(/\/?$/, '/');
    if (url.origin !== org.origin || !url.pathname.toLowerCase().startsWith(orgPath.toLowerCase()) || url.username || url.password) {
      throw new AzdoError('Only images from your Azure DevOps organization can be loaded', 400);
    }
    return limited(async () => {
      let res = await fetch(url, { headers: { Authorization: authHeader, Accept: 'image/*' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      // Attachments can redirect to signed blob storage: follow once, without the PAT.
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), url);
        if (next.protocol !== 'https:') throw new AzdoError('Refusing non-HTTPS image redirect', 502);
        const sameOrigin = next.origin === url.origin;
        res = await fetch(next, { headers: { Accept: 'image/*', ...(sameOrigin ? { Authorization: authHeader } : {}) }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      }
      const type = res.headers.get('content-type') || '';
      if (!res.ok) throw new AzdoError(`Image request failed (${res.status})`, res.status === 404 ? 404 : 502);
      if (!type.startsWith('image/') || type.includes('svg')) throw new AzdoError('Not an image', 415);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new AzdoError('Image too large', 413);
      return { type, body: buf };
    });
  }

  /** A plain-text response, such as a build log. Same auth and token checks as request(). */
  function apiText(path, { query, apiVersion } = {}) {
    const url = buildUrl(path, query, apiVersion);
    return limited(async () => {
      const res = await fetch(url, { headers: { Authorization: authHeader, Accept: 'text/plain' }, signal: AbortSignal.timeout(30_000) });
      const type = res.headers.get('content-type') || '';
      // A bad or expired PAT answers with an HTML sign-in page rather than 401.
      if (res.status === 401 || res.status === 203 || type.includes('text/html')) {
        throw new AzdoError('Azure DevOps rejected the token: it may have expired, been revoked, or lack the needed scopes.', 401, null, 'token-rejected');
      }
      if (!res.ok) throw new AzdoError(`Azure DevOps GET ${url.pathname} failed (${res.status})`, res.status);
      return res.text();
    });
  }

  return { request, api, apiText, listAll, listSkip, fetchOrgImage };
}
