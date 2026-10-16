// Production monitoring, shared by everyone using this Keel server:
// - a health check of each monitor's URL every minute (up/down, status, latency)
// - Application Insights metrics every 5 minutes, when an App ID + API key is set
//   (requests, failure rate, p95 duration, exceptions, top failing operations)
// Monitors and their check history live in the data folder (monitors.json,
// monitor-history.json); API keys are stored encrypted. One server process
// runs the checks (monitor-runner.json) and every process reads the history.
// In demo mode the data is simulated, so nothing is fetched.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { decrypt, encrypt, getKey } from './secrets.js';
import { sharedJson } from './jsonfile.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CHECK_EVERY = MIN;
const AI_EVERY = 5 * MIN;
const KEEP = 24 * HOUR;
const RUNNER_STALE = 3 * MIN;
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
    res.body?.cancel().catch(() => {});
    const ms = Date.now() - started;
    const ok = res.status >= 200 && res.status < 400;
    return { at: new Date().toISOString(), ok, status: res.status, ms, error: ok ? null : `HTTP ${res.status}` };
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

async function aiSnapshot(appId, apiKey) {
  const [series, exceptions, failing] = await Promise.all([
    aiQuery(appId, apiKey, 'requests | where timestamp > ago(24h) | summarize total=count(), failed=countif(success == false), p95=percentile(duration, 95) by bin(timestamp, 30m) | order by timestamp asc'),
    aiQuery(appId, apiKey, 'exceptions | where timestamp > ago(1h) | summarize n=count()'),
    aiQuery(appId, apiKey, 'requests | where timestamp > ago(1h) and success == false | summarize n=count() by name, resultCode | top 5 by n desc'),
  ]);
  const lastHour = series.filter((b) => Date.parse(b.timestamp) > Date.now() - HOUR);
  const total = lastHour.reduce((s, b) => s + (b.total || 0), 0);
  const failed = lastHour.reduce((s, b) => s + (b.failed || 0), 0);
  return {
    at: new Date().toISOString(),
    total,
    failed,
    failRate: total ? failed / total : 0,
    p95: lastHour.length ? Math.max(...lastHour.map((b) => b.p95 || 0)) : null,
    exceptions: exceptions[0]?.n ?? 0,
    topFailures: failing.map((f) => ({ name: f.name, code: f.resultCode, count: f.n })),
    series: series.map((b) => ({ at: b.timestamp, total: b.total, failed: b.failed, p95: b.p95 })),
  };
}

// ------------------------------------------------------------ demo data
function demoMonitors() {
  const id = () => crypto.randomUUID();
  return [
    { id: id(), name: 'Storefront (production)', url: 'https://shop.contoso-demo.com/health', appInsightsAppId: 'demo-app-1', apiKey: null, link: { type: 'release', projectId: 'p-commerce', definitionId: 1, stage: 'Production' }, latencyWarnMs: 1500, demo: 'healthy' },
    { id: id(), name: 'Identity API (production)', url: 'https://id.contoso-demo.com/health', appInsightsAppId: 'demo-app-2', apiKey: null, link: { type: 'release', projectId: 'p-platform', definitionId: 2, stage: 'Production' }, latencyWarnMs: 800, demo: 'errors' },
    { id: id(), name: 'Mobile backend (production)', url: 'https://mobile-api.contoso-demo.com/health', appInsightsAppId: '', apiKey: null, link: null, latencyWarnMs: 1500, demo: 'down' },
  ];
}

function demoCheck(m, at = Date.now()) {
  const wave = Math.sin(at / (17 * MIN)) * 40;
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
    series.push({ at: new Date(t).toISOString(), total, failed: Math.round(total * rate), p95: m.demo === 'errors' ? 900 : 320 });
  }
  const lastHour = series.slice(-2);
  const total = lastHour.reduce((s, b) => s + b.total, 0);
  const failed = lastHour.reduce((s, b) => s + b.failed, 0);
  return {
    at: new Date().toISOString(), total, failed, failRate: total ? failed / total : 0, p95: lastHour.at(-1).p95,
    exceptions: m.demo === 'errors' ? 212 : 3,
    topFailures: m.demo === 'errors' ? [{ name: 'POST /connect/token', code: '500', count: 96 }, { name: 'GET /users/me', code: '502', count: 31 }] : [],
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
  const runnerLock = sharedJson(path.join(dataDir, `monitor-runner${suffix}.json`), () => ({}));
  const instance = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

  let monitors = [];
  const sync = () => {
    monitors = store.get().monitors || [];
    return monitors;
  };
  sync();
  const persist = () => store.save({ monitors });
  const keyOf = (m) => (m.apiKey ? decrypt(getKey(), m.apiKey) : null);
  const EMPTY = { checks: [], ai: null, aiError: null };
  const entry = (all, id) => (all[id] ||= { checks: [], ai: null, aiError: null });

  /**
   * One process runs the checks, so everyone sees the same history and the
   * site isn't checked once per process. The runner refreshes its claim every
   * minute; another process takes over when the claim is 3 minutes old.
   */
  function isRunner() {
    const claim = runnerLock.get();
    if (claim.id && claim.id !== instance && Date.now() - (claim.beat || 0) < RUNNER_STALE) return false;
    runnerLock.save({ id: instance, beat: Date.now() });
    return true;
  }

  /** Results computed first, then merged into a freshly read history file. */
  async function checkAll(list) {
    const results = await Promise.all(list.filter((m) => m.url).map(async (m) => [m.id, mock && m.demo ? demoCheck(m) : await httpCheck(m)]));
    history.update((all) => {
      for (const [id, r] of results) {
        const s = entry(all, id);
        const m = list.find((x) => x.id === id);
        // Demo: back-fill 24h so charts have something to show.
        if (mock && m.demo && !s.checks.length) for (let t = Date.now() - KEEP; t < Date.now(); t += 5 * MIN) s.checks.push(demoCheck(m, t));
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

  const runChecks = () => (isRunner() ? checkAll(sync()) : null);
  const runAi = () => (isRunner() ? aiAll(sync()) : null);
  const guarded = (fn) => () => Promise.resolve(fn()).catch((err) => console.warn(`[monitoring] ${err.message}`));

  guarded(runChecks)();
  guarded(runAi)();
  const t1 = setInterval(guarded(runChecks), CHECK_EVERY);
  const t2 = setInterval(guarded(runAi), AI_EVERY);
  t1.unref?.();
  t2.unref?.();

  /** Monitor definitions without secrets (for Settings). */
  const publicConfig = (m) => ({
    id: m.id, name: m.name, url: m.url || '', appInsightsAppId: m.appInsightsAppId || '', hasApiKey: !!m.apiKey || !!(mock && m.demo && m.appInsightsAppId),
    link: m.link || null, latencyWarnMs: m.latencyWarnMs || 2000,
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
        const link = raw.link && ['release', 'pipeline'].includes(raw.link.type) && raw.link.projectId && raw.link.definitionId
          ? { type: raw.link.type, projectId: String(raw.link.projectId), definitionId: Number(raw.link.definitionId), ...(raw.link.type === 'release' ? { stage: String(raw.link.stage || '') } : {}) }
          : null;
        next.push({
          id: old?.id || crypto.randomUUID(), name, url, appInsightsAppId: appId, apiKey, link,
          latencyWarnMs: Math.min(30_000, Math.max(100, Number(raw.latencyWarnMs) || 2000)),
          ...(old?.demo ? { demo: old.demo } : {}),
        });
      }
      monitors = next;
      persist();
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
        };
      });
    },
  };
}
