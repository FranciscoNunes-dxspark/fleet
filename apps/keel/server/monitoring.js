// Production monitoring, run once for everyone using this Keel server:
// - a health check of each monitor's URL every minute (up/down, status, latency)
// - Application Insights metrics every 5 minutes, when an App ID + API key is set
//   (requests, failure rate, p95 duration, exceptions, top failing operations)
// Monitors and their check history live in the data folder (monitors.json,
// monitor-history.json); API keys are stored encrypted. One server process
// runs the checks (monitor-runner.json) and every process reads the history.
// Each monitor can belong to a project (the one that deploys it, or one picked
// in Settings); people see the monitors of the projects they track, plus those
// that belong to no project in particular.
// In demo mode the data is simulated, so nothing is fetched.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { decrypt, encrypt, getKey } from './secrets.js';
import { runnerLock, sharedJson } from './jsonfile.js';
import {
  TOTALS_EVERY_HOURS, TOTALS_SEASONS, TOTALS_TIMEOUT_MS, asEnvelope, demoHealth, demoTotals, failingText, historyPoint,
  isDemoPlatform, platformInfo, readTotals,
} from './platform.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CHECK_EVERY = MIN;
const AI_EVERY = 5 * MIN;
const KEEP = 24 * HOUR;
const RUNNER_STALE = 3 * MIN;
const TOTALS_TICK = 5 * MIN;
const TOTALS_HISTORY = 300; // snapshots kept per site (a year of daily fetches)
const TOTALS_AGAIN = 10 * MIN; // a site isn't fetched on request again sooner than this
const QUEUE_STALE = HOUR; // a site queued by "Fetch all" longer than this (the process stopped) is no longer waiting
const AI_HOST = 'https://api.applicationinsights.io';

// ------------------------------------------------------------ URL safety
const PRIVATE_V4 = [
  ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['100.64.0.0', 10], ['0.0.0.0', 8],
];
const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/**
 * Only public http(s) URLs: the server makes these requests, so internal
 * addresses (localhost, private networks, cloud metadata) are refused unless
 * MONITOR_ALLOW_PRIVATE=1 says monitoring internal endpoints is intended.
 */
export async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error('Enter a full URL, like https://myapp.example.com/health'), { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol)) throw Object.assign(new Error('Only http and https URLs can be monitored'), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error("Don't put credentials in the URL"), { status: 400 });
  if (/^(1|true)$/i.test(process.env.MONITOR_ALLOW_PRIVATE || '')) return url;
  const addrs = net.isIP(url.hostname) ? [{ address: url.hostname }] : await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error(`Couldn't resolve ${url.hostname}`), { status: 400 });
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error(`${url.hostname} is a private or internal address. Set MONITOR_ALLOW_PRIVATE=1 on the server to allow it.`), { status: 400 });
  }
  return url;
}

// ------------------------------------------------------------ checks
async function httpCheck(m) {
  const started = Date.now();
  try {
    await assertPublicUrl(m.url); // re-checked every time: DNS can change
    const res = await fetch(m.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': 'Keel-Monitor/1.0', Accept: '*/*' },
      signal: AbortSignal.timeout(10_000),
    });
    // ISM sites answer an "platform/v1" envelope; anything else is judged on the HTTP status alone.
    let platform = null;
    if (/json/i.test(res.headers.get('content-type') || '')) {
      const env = asEnvelope(await res.json().catch(() => null));
      if (env) platform = platformInfo(env);
    } else {
      res.body?.cancel().catch(() => {});
    }
    const ms = Date.now() - started;
    const httpOk = res.status >= 200 && res.status < 400;
    const ok = httpOk && platform?.status !== 'down';
    const error = ok ? null : platform ? failingText(platform, `HTTP ${res.status}`) : `HTTP ${res.status}`;
    return { at: new Date().toISOString(), ok, status: res.status, ms, error, ...(platform ? { platform } : {}) };
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return { at: new Date().toISOString(), ok: false, status: null, ms: Date.now() - started, error: timeout ? 'No response within 10s' : err.message };
  }
}

async function aiQuery(appId, apiKey, kql) {
  const res = await fetch(`${AI_HOST}/v1/apps/${encodeURIComponent(appId)}/query?query=${encodeURIComponent(kql)}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(res.status === 403 || res.status === 401 ? `Application Insights refused the API key (${msg})` : `Application Insights: ${msg}`);
  }
  const t = body.tables?.[0] || { columns: [], rows: [] };
  return t.rows.map((row) => Object.fromEntries(t.columns.map((c, i) => [c.name, row[i]])));
}

// Failures are server errors (5xx). Application Insights also marks 4xx responses as failed, but a
// 404 is mostly bots and stale links asking for pages that don't exist: those are counted apart.
const SERVER_ERROR = 'toint(resultCode) >= 500';
const NOT_FOUND = 'resultCode == "404"';

async function aiSnapshot(appId, apiKey) {
  const [series, exceptions, failing, missing] = await Promise.all([
    aiQuery(appId, apiKey, `requests | where timestamp > ago(24h) | summarize total=count(), failed=countif(${SERVER_ERROR}), notFound=countif(${NOT_FOUND}), p95=percentile(duration, 95) by bin(timestamp, 30m) | order by timestamp asc`),
    aiQuery(appId, apiKey, 'exceptions | where timestamp > ago(1h) | summarize n=count()'),
    aiQuery(appId, apiKey, `requests | where timestamp > ago(1h) and ${SERVER_ERROR} | summarize n=count() by name, resultCode | top 5 by n desc`),
    aiQuery(appId, apiKey, `requests | where timestamp > ago(1h) and ${NOT_FOUND} | summarize n=count() by name | top 5 by n desc`),
  ]);
  const lastHour = series.filter((b) => Date.parse(b.timestamp) > Date.now() - HOUR);
  const sum = (k) => lastHour.reduce((s, b) => s + (b[k] || 0), 0);
  const total = sum('total');
  const failed = sum('failed');
  return {
    at: new Date().toISOString(),
    total,
    failed,
    failRate: total ? failed / total : 0,
    notFound: sum('notFound'),
    p95: lastHour.length ? Math.max(...lastHour.map((b) => b.p95 || 0)) : null,
    exceptions: exceptions[0]?.n ?? 0,
    topFailures: failing.map((f) => ({ name: f.name, code: f.resultCode, count: f.n })),
    topNotFound: missing.map((f) => ({ name: f.name, count: f.n })),
    series: series.map((b) => ({ at: b.timestamp, total: b.total, failed: b.failed, notFound: b.notFound || 0, p95: b.p95 })),
  };
}

// ------------------------------------------------------------ demo data
function demoMonitors() {
  const id = () => crypto.randomUUID();
  return [
    { id: id(), name: 'Storefront (production)', url: 'https://shop.contoso-demo.com/health', appInsightsAppId: 'demo-app-1', apiKey: null, link: { type: 'release', projectId: 'p-commerce', definitionId: 1, stage: 'Production' }, latencyWarnMs: 1500, demo: 'healthy' },
    { id: id(), name: 'Identity API (production)', url: 'https://id.contoso-demo.com/health', appInsightsAppId: 'demo-app-2', apiKey: null, link: { type: 'release', projectId: 'p-platform', definitionId: 2, stage: 'Production' }, latencyWarnMs: 800, demo: 'errors' },
    { id: id(), name: 'Storefront canary', url: 'https://canary.shop.contoso-demo.com/health', appInsightsAppId: '', apiKey: null, link: { type: 'pipeline', projectId: 'p-commerce', definitionId: 100 }, latencyWarnMs: 1500, demo: 'down' },
    { id: id(), name: 'Mobile backend (production)', url: 'https://mobile-api.contoso-demo.com/health', appInsightsAppId: '', apiKey: null, link: null, projectId: 'p-mobile', latencyWarnMs: 1500, demo: 'down' },
    { id: id(), name: 'SC Berlin (WebShopSite)', url: 'https://shopeusite.contoso-demo.com/health', appInsightsAppId: '', apiKey: null, link: null, latencyWarnMs: 1500, demo: 'platform-a', totalsEvery: 24, totalsSeason: 'current' },
    { id: id(), name: 'QA RV (WebShopSite)', url: 'https://shopqasite.contoso-demo.com/health', appInsightsAppId: '', apiKey: null, link: null, latencyWarnMs: 1500, demo: 'platform-qa', totalsEvery: 6, totalsSeason: 'current' },
    { id: id(), name: 'Sydney FC (MarketSite)', url: 'https://marketussite.contoso-demo.com/health', appInsightsAppId: '', apiKey: null, link: null, latencyWarnMs: 1500, demo: 'platform-c', totalsEvery: 24, totalsSeason: 'current' },
  ];
}

function demoCheck(m, at = Date.now()) {
  const wave = Math.sin(at / (17 * MIN)) * 40;
  if (isDemoPlatform(m.demo)) {
    const platform = platformInfo(demoHealth(m.demo, at));
    const down = platform.status === 'down';
    return { at: new Date(at).toISOString(), ok: !down, status: down ? 503 : 200, ms: Math.round((down ? 3010 : 160) + wave), error: down ? failingText(platform, 'HTTP 503') : null, platform };
  }
  if (m.demo === 'down') {
    const down = Math.floor(at / (6 * MIN)) % 3 === 0; // down a third of the time
    return { at: new Date(at).toISOString(), ok: !down, status: down ? 503 : 200, ms: down ? 10_000 : 220 + wave, error: down ? 'HTTP 503' : null };
  }
  const ms = (m.demo === 'errors' ? 640 : 140) + wave + Math.random() * 60;
  return { at: new Date(at).toISOString(), ok: true, status: 200, ms: Math.round(ms), error: null };
}

function demoAi(m) {
  const now = Date.now();
  const series = [];
  for (let t = now - 24 * HOUR; t <= now; t += 30 * MIN) {
    const total = Math.round(900 + Math.sin(t / (3 * HOUR)) * 300);
    // The "errors" demo app degrades over the last few hours (after a deploy).
    const rate = m.demo === 'errors' && t > now - 4 * HOUR ? 0.07 : 0.004;
    series.push({ at: new Date(t).toISOString(), total, failed: Math.round(total * rate), notFound: Math.round(total * 0.01), p95: m.demo === 'errors' ? 900 : 320 });
  }
  const lastHour = series.slice(-2);
  const total = lastHour.reduce((s, b) => s + b.total, 0);
  const failed = lastHour.reduce((s, b) => s + b.failed, 0);
  return {
    at: new Date().toISOString(), total, failed, failRate: total ? failed / total : 0, p95: lastHour.at(-1).p95,
    exceptions: m.demo === 'errors' ? 212 : 3,
    topFailures: m.demo === 'errors' ? [{ name: 'POST /connect/token', code: '500', count: 96 }, { name: 'GET /users/me', code: '502', count: 31 }] : [],
    notFound: lastHour.reduce((s, b) => s + b.notFound, 0),
    topNotFound: [{ name: 'GET /wp-login.php', count: 14 }, { name: 'GET /.env', count: 6 }, { name: 'GET admin/functions', count: 2 }],
    series,
  };
}

// ------------------------------------------------------------ the runner
export function createMonitoring({ dataDir = config.dataDir, mock = config.mock } = {}) {
  const suffix = mock ? '.mock' : '';
  // Definitions, history and the runner lock are files in the data folder,
  // shared with any other server process and kept across restarts and deploys.
  const store = sharedJson(path.join(dataDir, `monitors${suffix}.json`), () => ({ monitors: mock ? demoMonitors() : [] }));
  const history = sharedJson(path.join(dataDir, `monitor-history${suffix}.json`), () => ({})); // id -> { checks, ai, aiError }
  // Platform totals per monitor: { lastAttemptAt, lastError, fetchingSince, latest, history: [{ at, seasonId, values }] }.
  const totalsStore = sharedJson(path.join(dataDir, `monitor-totals${suffix}.json`), () => ({}));
  const runner = runnerLock(path.join(dataDir, `monitor-runner${suffix}.json`), RUNNER_STALE, `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`);

  let monitors = [];
  const sync = () => {
    monitors = store.get().monitors || [];
    return monitors;
  };
  sync();
  const persist = () => store.save({ monitors });
  const keyOf = (m) => (m.apiKey ? decrypt(getKey(), m.apiKey) : null);
  const totalsKeyOf = (m) => (m.totalsKey ? decrypt(getKey(), m.totalsKey) : null);
  const hasTotals = (m) => !!m.url && (!!m.totalsKey || (mock && isDemoPlatform(m.demo)));
  const EMPTY = { checks: [], ai: null, aiError: null };
  const entry = (all, id) => (all[id] ||= { checks: [], ai: null, aiError: null });

  /**
   * One process runs the checks, so everyone sees the same history and the
   * site isn't checked once per process. The runner refreshes its claim every
   * minute; another process takes over when the claim is 3 minutes old.
   */
  const isRunner = () => runner.isRunner();

  /** Results computed first, then merged into a freshly read history file. */
  async function checkAll(list) {
    const results = await Promise.all(list.filter((m) => m.url).map(async (m) => [m.id, mock && m.demo ? demoCheck(m) : await httpCheck(m)]));
    history.update((all) => {
      for (const [id, r] of results) {
        const s = entry(all, id);
        const m = list.find((x) => x.id === id);
        // Demo: back-fill 24h so charts have something to show.
        if (mock && m.demo && !s.checks.length) for (let t = Date.now() - KEEP; t < Date.now(); t += 5 * MIN) s.checks.push(demoCheck(m, t));
        if (r.platform) {
          const { failing, status, ...meta } = r.platform;
          s.platform = { ...meta, at: r.at };
          r.platform = { status, ...(failing.length ? { failing } : {}) };
        }
        s.checks.push(r);
        while (s.checks.length && Date.parse(s.checks[0].at) < Date.now() - KEEP) s.checks.shift();
      }
      for (const id of Object.keys(all)) if (!monitors.some((m) => m.id === id)) delete all[id];
    });
  }

  async function aiAll(list) {
    const results = await Promise.all(list.filter((m) => m.appInsightsAppId && (m.apiKey || (mock && m.demo))).map(async (m) => {
      try {
        return [m.id, mock && m.demo ? demoAi(m) : await aiSnapshot(m.appInsightsAppId, keyOf(m)), null];
      } catch (err) {
        return [m.id, null, err.message];
      }
    }));
    if (!results.length) return;
    history.update((all) => {
      for (const [id, ai, aiError] of results) {
        const s = entry(all, id);
        if (ai) s.ai = ai;
        s.aiError = aiError;
      }
    });
  }

  // ---------------------------------------------------------- platform totals
  const fetching = new Set(); // monitor ids this process is fetching now

  async function requestTotals(m) {
    if (mock && isDemoPlatform(m.demo)) return readTotals(200, demoTotals(m.demo));
    const base = new URL(m.url);
    const url = new URL(`/totals?season=${encodeURIComponent(m.totalsSeason || 'current')}`, base.origin);
    await assertPublicUrl(url.href);
    let res;
    try {
      res = await fetch(url, {
        // No redirects: the key must only ever go to the site itself.
        redirect: 'manual',
        headers: { 'X-Totals-Key': totalsKeyOf(m), Accept: 'application/json', 'User-Agent': 'Keel-Monitor/1.0' },
        signal: AbortSignal.timeout(TOTALS_TIMEOUT_MS),
      });
    } catch (err) {
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      return { error: timeout ? 'The totals took longer than 5 minutes; the site may be busy.' : err.message };
    }
    if (res.status >= 300 && res.status < 400) return { error: `The site redirected /totals (HTTP ${res.status}); use the address it redirects to.` };
    return readTotals(res.status, await res.json().catch(() => null));
  }

  async function fetchTotals(m) {
    if (fetching.has(m.id)) return;
    fetching.add(m.id);
    totalsStore.update((all) => {
      all[m.id] = { history: [], ...all[m.id], fetchingSince: Date.now(), queuedAt: null };
    });
    let result;
    try {
      result = await requestTotals(m);
    } catch (err) {
      result = { error: err.message };
    } finally {
      fetching.delete(m.id);
    }
    totalsStore.update((all) => {
      const e = { history: [], ...all[m.id], fetchingSince: null, lastAttemptAt: Date.now() };
      if (result.snapshot) {
        e.latest = result.snapshot;
        e.lastError = null;
        e.history = [...e.history, historyPoint(result.snapshot)].slice(-TOTALS_HISTORY);
      } else {
        e.lastError = result.error;
      }
      all[m.id] = e;
    });
  }

  const isFetching = (id, e, now = Date.now()) => fetching.has(id) || !!(e?.fetchingSince && now - e.fetchingSince < TOTALS_TIMEOUT_MS + MIN);
  const isQueued = (e, now = Date.now()) => !!(e?.queuedAt && now - e.queuedAt < QUEUE_STALE);

  const totalsDue = (m, e, now = Date.now()) => {
    if (!hasTotals(m)) return false;
    if (isFetching(m.id, e, now) || isQueued(e, now)) return false;
    if (!e?.lastAttemptAt) return true;
    const every = (m.totalsEvery || 24) * HOUR;
    // After a failure, try again within the hour rather than waiting a whole day.
    return now - e.lastAttemptAt >= (e.lastError ? Math.min(every, HOUR) : every);
  };

  // Demo: back-fill a month of daily snapshots so trends have something to show.
  function demoBackfill(list) {
    totalsStore.update((all) => {
      for (const m of list.filter((x) => isDemoPlatform(x.demo) && !all[x.id]?.history?.length)) {
        const history = [];
        for (let d = 30; d >= 1; d--) {
          const at = Date.now() - d * 24 * HOUR;
          const snap = readTotals(200, demoTotals(m.demo, at), new Date(at).toISOString()).snapshot;
          if (snap) history.push(historyPoint(snap));
        }
        all[m.id] = { ...all[m.id], history, lastAttemptAt: null, lastError: null, fetchingSince: null };
      }
    });
  }

  let totalsBusy = false;
  async function runTotals() {
    if (totalsBusy || !isRunner()) return;
    totalsBusy = true;
    try {
      const list = sync();
      if (mock) demoBackfill(list);
      // One site at a time: each request can keep a club's database busy for minutes.
      for (const m of list) {
        if (totalsDue(m, totalsStore.get()[m.id])) await fetchTotals(m);
      }
    } finally {
      totalsBusy = false;
    }
  }

  const runChecks = () => (isRunner() ? checkAll(sync()) : null);
  const runAi = () => (isRunner() ? aiAll(sync()) : null);
  const guarded = (fn) => () => Promise.resolve(fn()).catch((err) => console.warn(`[monitoring] ${err.message}`));

  guarded(runChecks)();
  guarded(runAi)();
  const t1 = setInterval(guarded(runChecks), CHECK_EVERY);
  const t2 = setInterval(guarded(runAi), AI_EVERY);
  const t3 = setInterval(guarded(runTotals), TOTALS_TICK);
  guarded(runTotals)();
  t1.unref?.();
  t2.unref?.();
  t3.unref?.();

  /** Monitor definitions without secrets (for Settings). */
  const publicConfig = (m) => ({
    id: m.id, name: m.name, url: m.url || '', appInsightsAppId: m.appInsightsAppId || '', hasApiKey: !!m.apiKey || !!(mock && m.demo && m.appInsightsAppId),
    link: m.link || null, projectId: m.link?.projectId || m.projectId || null, latencyWarnMs: m.latencyWarnMs || 2000,
    hasTotalsKey: !!m.totalsKey || !!(mock && isDemoPlatform(m.demo)), totalsEvery: m.totalsEvery || 24, totalsSeason: m.totalsSeason || 'current',
  });

  const totalsHead = (m, e) => ({
    id: m.id, name: m.name, url: m.url, enabled: hasTotals(m), every: m.totalsEvery || 24, season: m.totalsSeason || 'current',
    lastAttemptAt: e.lastAttemptAt ? new Date(e.lastAttemptAt).toISOString() : null,
    lastError: e.lastError || null,
    fetching: isFetching(m.id, e),
    queued: !isFetching(m.id, e) && isQueued(e),
    nextAt: hasTotals(m) && e.lastAttemptAt ? new Date(e.lastAttemptAt + (e.lastError ? Math.min((m.totalsEvery || 24) * HOUR, HOUR) : (m.totalsEvery || 24) * HOUR)).toISOString() : null,
  });

  return {
    list: () => sync().map(publicConfig),

    /**
     * Replace the monitor list. apiKey: a string sets a new key, null/'' clears
     * it, undefined keeps the stored one (the UI never receives keys back).
     */
    async save(list) {
      if (!Array.isArray(list) || list.length > 50) throw Object.assign(new Error('Send a list of up to 50 monitors'), { status: 400 });
      sync();
      const next = [];
      for (const raw of list) {
        const name = String(raw.name || '').trim().slice(0, 80);
        const url = String(raw.url || '').trim();
        const appId = String(raw.appInsightsAppId || '').trim();
        if (!name) throw Object.assign(new Error('Every monitor needs a name'), { status: 400 });
        if (!url && !appId) throw Object.assign(new Error(`"${name}" needs a URL or an Application Insights App ID`), { status: 400 });
        const old = monitors.find((m) => m.id === raw.id);
        // Demo monitors use made-up domains; everything else must be a public address.
        if (url && !(mock && old?.demo && url === old.url)) await assertPublicUrl(url);
        if (appId && !/^[0-9a-f-]{36}$/i.test(appId) && !(mock && appId.startsWith('demo'))) {
          throw Object.assign(new Error(`"${name}": the Application ID is a GUID like 0f1e2d3c-…, from the Application Insights "API Access" page`), { status: 400 });
        }
        let apiKey = old?.apiKey || null;
        if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) apiKey = encrypt(getKey(), raw.apiKey.trim());
        if (raw.apiKey === null || raw.apiKey === '') apiKey = null;
        let totalsKey = old?.totalsKey || null;
        if (typeof raw.totalsKey === 'string' && raw.totalsKey.trim()) totalsKey = encrypt(getKey(), raw.totalsKey.trim());
        if (raw.totalsKey === null || raw.totalsKey === '') totalsKey = null;
        if (totalsKey && !url) throw Object.assign(new Error(`"${name}": platform totals need the site's URL`), { status: 400 });
        const totalsEvery = TOTALS_EVERY_HOURS.includes(Number(raw.totalsEvery)) ? Number(raw.totalsEvery) : 24;
        const totalsSeason = TOTALS_SEASONS.includes(raw.totalsSeason) ? raw.totalsSeason : 'current';
        // The branch production deploys from, when Keel's guess is wrong (Waiting to ship compares it with what's live).
        const branch = typeof raw.link?.branch === 'string' ? raw.link.branch.trim().replace(/^refs\/heads\//, '') : '';
        if (branch && (branch.length > 250 || /[\s~^:?*[\\]|\.\.|@\{|^\/|\/$/.test(branch))) {
          throw Object.assign(new Error(`"${name}": "${branch}" isn't a valid branch name`), { status: 400 });
        }
        const link = raw.link && ['release', 'pipeline'].includes(raw.link.type) && raw.link.projectId && raw.link.definitionId
          ? {
            type: raw.link.type, projectId: String(raw.link.projectId), definitionId: Number(raw.link.definitionId),
            ...(raw.link.type === 'release' ? { stage: String(raw.link.stage || '') } : {}),
            ...(branch ? { branch } : {}),
          }
          : null;
        // The project it belongs to: the one that deploys it, else the one picked; none means everyone's.
        const projectId = link?.projectId || (typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim().slice(0, 64) : null);
        next.push({
          id: old?.id || crypto.randomUUID(), name, url, appInsightsAppId: appId, apiKey, link, projectId, totalsKey, totalsEvery, totalsSeason,
          latencyWarnMs: Math.min(30_000, Math.max(100, Number(raw.latencyWarnMs) || 2000)),
          ...(old?.demo ? { demo: old.demo } : {}),
        });
      }
      // A new or changed key, URL or season fetches again soon; removed monitors drop their totals.
      const changed = new Set(next.filter((n) => {
        const o = monitors.find((m) => m.id === n.id);
        return !o || o.totalsKey !== n.totalsKey || o.url !== n.url || (o.totalsSeason || 'current') !== n.totalsSeason;
      }).map((n) => n.id));
      monitors = next;
      persist();
      totalsStore.update((all) => {
        for (const id of Object.keys(all)) {
          if (!monitors.some((m) => m.id === id)) delete all[id];
          else if (changed.has(id)) all[id] = { ...all[id], lastAttemptAt: null, lastError: null };
        }
      });
      // New monitors get their first check now, from whichever process saved them.
      const fresh = monitors.filter((m) => !history.get()[m.id]);
      if (fresh.length) await Promise.all([checkAll(fresh), aiAll(fresh)]).catch(() => {});
      return monitors.map(publicConfig);
    },

    /** Try a URL (and Application Insights credentials) without saving. */
    async test({ url, appInsightsAppId, apiKey, id }) {
      const out = {};
      if (url) out.http = mock ? demoCheck({ demo: 'healthy' }) : await httpCheck({ url: (await assertPublicUrl(url)).href });
      if (appInsightsAppId) {
        const key = apiKey?.trim() || keyOf(sync().find((m) => m.id === id) || {}) || null;
        if (mock) out.ai = { ok: true, total: 1800 };
        else if (!key) out.ai = { ok: false, error: 'Enter the API key to test Application Insights' };
        else {
          try {
            const snap = await aiSnapshot(appInsightsAppId.trim(), key);
            out.ai = { ok: true, total: snap.total };
          } catch (err) {
            out.ai = { ok: false, error: err.message };
          }
        }
      }
      return out;
    },

    /** Platform totals for every site that has them: the latest figures and the previous fetch, for deltas. */
    totals() {
      const all = totalsStore.get();
      return sync().filter((m) => hasTotals(m) || all[m.id]?.latest).map((m) => {
        const e = all[m.id] || {};
        const latest = e.latest || null;
        const seasonId = latest ? (latest.season.scope === 'all' ? 'all' : latest.season.id) : null;
        const sameSeason = (e.history || []).filter((p) => p.seasonId === seasonId);
        return {
          ...totalsHead(m, e),
          latest, // with each figure's months, for the month picker (a few KB per site)
          previous: sameSeason.length > 1 ? sameSeason.at(-2) : null,
        };
      });
    },

    /** One site's totals: the latest figures with months, and their history this season. */
    totalsFor(id) {
      const m = sync().find((x) => x.id === id);
      const e = totalsStore.get()[id];
      if (!m) throw Object.assign(new Error('No such monitor.'), { status: 404 });
      const latest = e?.latest || null;
      const seasonId = latest ? (latest.season.scope === 'all' ? 'all' : latest.season.id) : null;
      return { ...totalsHead(m, e || {}), latest, history: (e?.history || []).filter((p) => p.seasonId === seasonId) };
    },

    /** Fetch one site's totals now, in the background (it can take minutes). */
    fetchTotalsNow(id) {
      const m = sync().find((x) => x.id === id);
      if (!m) throw Object.assign(new Error('No such monitor.'), { status: 404 });
      if (!hasTotals(m)) throw Object.assign(new Error('Add the site\'s totals key first.'), { status: 400 });
      const e = totalsStore.get()[id];
      if (isFetching(id, e)) {
        throw Object.assign(new Error('The totals are already being fetched.'), { status: 409 });
      }
      if (e?.lastAttemptAt && Date.now() - e.lastAttemptAt < TOTALS_AGAIN) {
        throw Object.assign(new Error('The totals were fetched less than 10 minutes ago. Each fetch keeps the club database busy, so wait a little.'), { status: 429 });
      }
      fetchTotals(m).catch((err) => console.warn(`[monitoring] totals: ${err.message}`));
      return { started: true };
    },

    /**
     * Fetch every site's totals now (of `ids`, when given), one after another in
     * the background like the schedule does. Sites being fetched, already
     * queued, or fetched in the last 10 minutes are left out.
     */
    fetchAllTotalsNow(ids = null) {
      const now = Date.now();
      const sites = sync().filter((m) => hasTotals(m) && (!ids || ids.includes(m.id)));
      if (!sites.length) throw Object.assign(new Error('No site has a totals key yet.'), { status: 400 });
      const all = totalsStore.get();
      const due = sites.filter((m) => {
        const e = all[m.id];
        return !isFetching(m.id, e, now) && !isQueued(e, now) && !(e?.lastAttemptAt && now - e.lastAttemptAt < TOTALS_AGAIN);
      });
      if (!due.length) {
        throw Object.assign(new Error('Every site is being fetched or was fetched less than 10 minutes ago. Each fetch keeps the club database busy, so wait a little.'), { status: 429 });
      }
      totalsStore.update((store) => {
        for (const m of due) store[m.id] = { history: [], ...store[m.id], queuedAt: now };
      });
      (async () => {
        for (const { id } of due) {
          const m = sync().find((x) => x.id === id);
          const e = totalsStore.get()[id];
          // Removed or changed since, or fetched meanwhile (its own Fetch now, or the schedule elsewhere): not now.
          if (!m || !hasTotals(m) || isFetching(id, e) || (e?.lastAttemptAt && Date.now() - e.lastAttemptAt < TOTALS_AGAIN)) {
            totalsStore.update((store) => {
              if (store[id]) store[id].queuedAt = null;
            });
            continue;
          }
          await fetchTotals(m).catch((err) => console.warn(`[monitoring] totals: ${err.message}`));
        }
      })();
      return { started: due.length, skipped: sites.length - due.length };
    },

    /** Current status of every monitor (no secrets). */
    status() {
      const all = history.get();
      return sync().map((m) => {
        const s = all[m.id] || EMPTY;
        const checks = s.checks;
        const last = checks.at(-1) || null;
        const okCount = checks.filter((c) => c.ok).length;
        const times = checks.filter((c) => c.ok).map((c) => c.ms).sort((a, b) => a - b);
        return {
          ...publicConfig(m),
          last,
          downSince: last && !last.ok ? (checks.slice().reverse().find((c) => c.ok)?.at || checks[0].at) : null,
          consecutiveFailures: (() => {
            let n = 0;
            for (let i = checks.length - 1; i >= 0 && !checks[i].ok; i--) n++;
            return n;
          })(),
          uptime24h: checks.length ? okCount / checks.length : null,
          p95ms: times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : null,
          // Downsampled to ~96 points for sparklines.
          history: checks.filter((_, i) => i % Math.max(1, Math.ceil(checks.length / 96)) === 0 || i === checks.length - 1)
            .map((c) => ({ at: c.at, ok: c.ok, ms: c.ms })),
          ai: s.ai,
          aiError: s.aiError,
          platform: s.platform || null,
          totalsError: hasTotals(m) ? totalsStore.get()[m.id]?.lastError || null : null,
        };
      });
    },
  };
}
