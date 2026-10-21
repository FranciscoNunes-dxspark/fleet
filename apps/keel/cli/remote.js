// Keel in the terminal through your team's Keel (a server in sign-in mode, AUTH_MODE=login):
// `keel login` signs in through the browser (server/terminals.js), then everything goes through
// that server's /api as you, with your role and your own Azure DevOps token, and live updates
// come from the same event stream the web app listens to (server/watcher.js). Nothing here
// touches Azure DevOps or the data folder directly.
import os from 'node:os';

export const DEFAULT_SERVER = 'https://keel.example.com';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * A Keel address from what someone typed ("keel.example.com", "https://keel.example.com/inbox",
 * "localhost:4280"), as its origin. Plain http only to this computer: the token mustn't cross
 * the network unencrypted. Null when it can't be one.
 */
export function serverUrlFrom(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s) ? 'http' : 'https'}://${s}`);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (!LOOPBACK.includes(u.hostname) && !u.hostname.includes('.')) return null;
  if (u.protocol === 'http:' && !LOOPBACK.includes(u.hostname)) return null;
  return u.origin;
}

/** How this terminal is named where you allow it, and later in Settings: "ana on LAPTOP-7 (Windows)". */
export function terminalName() {
  const system = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] ?? process.platform;
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    // No user name to be had (some containers).
  }
  return `${user ? `${user} on ` : ''}${os.hostname()} (${system})`;
}

/** The sentence for an answer the server refused, by its code when it has one. */
function refusal(server, status, data) {
  if (data?.code === 'signin-required') return `Your Keel sign-in has ended (signed out on the web, or not used for 90 days). Run keel login to sign in again.`;
  if (data?.code === 'token-required' || data?.code === 'token-rejected') return `Keel has no working Azure DevOps token for you. Open ${server} in your browser and connect it there.`;
  return data?.error || `Keel answered ${status}.`;
}

/** Calls to a Keel server's /api, as the holder of `token` (none before signing in). */
export function keelClient(server, token, { fetch: fetchFn = globalThis.fetch } = {}) {
  const headers = (extra = {}) => ({ 'x-keel': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
  async function call(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetchFn(`${server}/api${path}`, {
        method,
        headers: headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw Object.assign(new Error(`Couldn't reach Keel at ${server}: ${e.cause?.message || e.message}`), { offline: true });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(refusal(server, res.status, data)), { status: res.status, code: data?.code });
    return data;
  }
  return { server, token, call, headers, fetch: fetchFn };
}

/**
 * Signs this terminal in: asks the server for a code, shows it, opens the page to type it in,
 * and waits for you to allow it there. Resolves with `{ token, user }`.
 */
export async function deviceLogin({ server, output = process.stdout, openUrl, fetch: fetchFn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), name = terminalName() }) {
  const client = keelClient(server, null, { fetch: fetchFn });
  const status = await client.call('/auth/status');
  if (status?.mode !== 'login') throw new Error(`The Keel at ${server} doesn't have accounts (it runs for one person, in local mode), so there's nothing to sign in to. Run keel on that computer instead.`);
  const login = await client.call('/auth/device', { method: 'POST', body: { name } });
  output.write(`\nTo sign in, open \x1b[1m${login.verifyUrl}\x1b[22m and type this code:\n\n    \x1b[1m${login.userCode}\x1b[22m\n\n`);
  openUrl?.(login.verifyUrl);
  output.write(`\x1b[2m${openUrl ? 'It opens in your browser. ' : ''}Waiting for you to allow it there… (ctrl+c stops)\x1b[22m\n`);
  const end = Date.now() + login.expiresIn * 1000;
  while (Date.now() < end) {
    await sleep(login.interval * 1000);
    let r;
    try {
      r = await client.call('/auth/device/token', { method: 'POST', body: { deviceCode: login.deviceCode } });
    } catch (e) {
      // The network dropped for a moment: ask again on the next round.
      if (e.offline) continue;
      throw e;
    }
    if (r.status === 'approved') return { token: r.token, user: r.user };
    if (r.status === 'denied') throw new Error('The sign-in was refused in the browser.');
    if (r.status === 'expired') break;
  }
  throw new Error('The code expired before it was allowed. Run keel login again.');
}

/**
 * A Server-Sent Events stream as { event, data } objects. Comments (the server's pings) are
 * skipped, and data lines are joined as the standard says.
 */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i);
        const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

/** The service the terminal app uses (the same methods as server/service.js), over the server's /api. */
export function remoteService({ call }) {
  const e = encodeURIComponent;
  const pr = (projectId, repoId, id) => `/prs/${e(projectId)}/${e(repoId)}/${id}`;
  return {
    meta: () => call('/meta'),
    attention: () => call('/attention'),
    snooze: (key, days) => call('/attention/snooze', { method: 'POST', body: { key, days } }),
    clearSnoozes: () => call('/attention/clear-snoozes', { method: 'POST', body: {} }),
    pullRequests: () => call('/prs'),
    pullRequest: (projectId, repoId, id) => call(pr(projectId, repoId, id)),
    prAction: (projectId, repoId, id, body) => call(`${pr(projectId, repoId, id)}/actions`, { method: 'POST', body }),
    pipelines: () => call('/pipelines'),
    pipelineRuns: (projectId, definitionId) => call(`/pipelines/${e(projectId)}/${e(definitionId)}/runs`),
    queueBuild: (projectId, definitionId, branch) => call('/pipelines/queue', { method: 'POST', body: { projectId, definitionId, branch } }),
    cancelBuild: (projectId, buildId) => call('/pipelines/cancel', { method: 'POST', body: { projectId, buildId } }),
    workItems: () => call('/workitems'),
    workItem: (id, org) => call(`/workitems/${id}${org ? `?org=${e(org)}` : ''}`),
    workItemAction: (id, action, org) => call(`/workitems/${id}/actions${org ? `?org=${e(org)}` : ''}`, { method: 'POST', body: action }),
    newWorkItemOptions: () => call('/workitems/new/options'),
    createWorkItem: (body) => call('/workitems', { method: 'POST', body }),
    production: () => call('/production'),
    undeployed: () => call('/deploys/pending'),
    approvals: () => call('/approvals'),
    decideApproval: (kind, id, body, org) => call(`/approvals/${e(kind)}/${e(id)}${org ? `?org=${e(org)}` : ''}`, { method: 'POST', body }),
    settingsView: () => call('/settings'),
    projectOptions: (projectId) => call(`/settings/projects/${e(projectId)}`),
    saveSettings: (patch) => call('/settings', { method: 'PUT', body: patch }),
  };
}

/**
 * Live updates from the server: it checks Azure DevOps while someone listens (this terminal
 * counts) and says what changed. `check` asks it to look now; what it finds arrives as `notify`.
 */
export function remoteLive(client, { retryMs = 5000 } = {}) {
  return {
    baseline: async () => {},
    check: async () => {
      await client.call('/refresh', { method: 'POST', body: {} });
      return [];
    },
    stream({ changed, notify, status }) {
      const controller = new AbortController();
      const wait = (ms) => new Promise((r) => {
        const t = setTimeout(r, ms);
        controller.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      (async () => {
        while (!controller.signal.aborted) {
          try {
            const res = await client.fetch(`${client.server}/api/events`, { headers: client.headers({ accept: 'text/event-stream' }), signal: controller.signal });
            if (!res.ok) {
              const data = await res.json().catch(() => null);
              status({ ok: false, error: refusal(client.server, res.status, data) });
            } else {
              for await (const ev of sseEvents(res.body)) {
                let data;
                try {
                  data = JSON.parse(ev.data);
                } catch {
                  continue;
                }
                if (ev.event === 'changed') changed(data);
                else if (ev.event === 'notify') notify(data.items ?? []);
                else if (ev.event === 'status') status(data);
              }
            }
          } catch (e) {
            if (controller.signal.aborted) return;
            status({ ok: false, error: `Couldn't reach Keel at ${client.server}: ${e.cause?.message || e.message}` });
          }
          await wait(retryMs);
        }
      })();
      return () => controller.abort();
    },
  };
}

/**
 * `{ service, orgs, signIn: 'keel', account, server, live, orgAdmin, logout }` for the App, once the
 * server says this token is signed in with a working Azure DevOps connection. Throws a sentence
 * otherwise (code 'signin-required' when the token no longer works).
 */
export async function connectKeel({ server, token, fetch: fetchFn }) {
  const client = keelClient(server, token, { fetch: fetchFn });
  const status = await client.call('/auth/status');
  if (status?.mode !== 'login') throw new Error(`The Keel at ${server} runs in local mode, without accounts. Run keel on that computer instead, or remove KEEL_SERVER.`);
  if (!status.signedIn) throw Object.assign(new Error(refusal(server, 401, { code: 'signin-required' })), { code: 'signin-required' });
  if (status.needsToken) throw Object.assign(new Error(refusal(server, 409, { code: 'token-required' })), { code: 'token-required' });
  const orgs = await client.call('/orgs');
  return {
    service: remoteService(client),
    orgs,
    signIn: 'keel',
    account: status.user,
    server,
    live: remoteLive(client),
    // Organizations are the server's, for everyone: only Admins may change them, and the server says so.
    orgAdmin: {
      add: (org) => client.call('/orgs', { method: 'POST', body: org }),
      remove: (key) => client.call(`/orgs/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    },
    logout: () => client.call('/auth/logout', { method: 'POST', body: {} }),
  };
}
