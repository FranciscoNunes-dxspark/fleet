// An Azure in memory, with the provider's interface (see azure/arm.js), for `sonar --demo` and the tests:
// two subscriptions of web and function apps with slots and settings, two Application Insights
// components, and a few days of telemetry. Restarts, stops, swaps and saved settings change it until
// the app closes. Its query engine understands the queries Sonar itself sends, and plain
// `table | where cloud_RoleName == 'x' | take n` ones; anything else gets an error saying so.

import { metricInterval } from './metrics.js';

const HOUR = 60 * 60 * 1000;

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const conn = (key) => `InstrumentationKey=${key};IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/`;

function initialState(now) {
  const apps = [
    { sub: 'sub-prod', name: 'contoso-web', kind: 'app', resourceGroup: 'contoso-prod', runtime: 'NODE|22-lts', key: 'k-prod', slots: ['staging'], domain: 'shop.contoso.com' },
    { sub: 'sub-prod', name: 'contoso-api', kind: 'app', resourceGroup: 'contoso-prod', runtime: 'DOTNETCORE|8.0', key: 'k-prod', slots: ['staging'] },
    { sub: 'sub-prod', name: 'contoso-orders', kind: 'function', resourceGroup: 'contoso-prod', runtime: 'DOTNET-ISOLATED|8.0', key: 'k-prod', slots: [] },
    { sub: 'sub-dev', name: 'contoso-web-dev', kind: 'app', resourceGroup: 'contoso-dev', runtime: 'NODE|22-lts', key: 'k-dev', slots: [] },
    { sub: 'sub-dev', name: 'contoso-jobs-dev', kind: 'function', resourceGroup: 'contoso-dev', runtime: 'NODE|22', key: 'k-dev', slots: [] },
  ];
  const sites = [];
  for (const a of apps) {
    const id = `/subscriptions/${a.sub}/resourceGroups/${a.resourceGroup}/providers/Microsoft.Web/sites/${a.name}`;
    const base = {
      APPLICATIONINSIGHTS_CONNECTION_STRING: conn(a.key),
      APP_VERSION: '2.14.0',
      ASPNETCORE_ENVIRONMENT: a.sub === 'sub-prod' ? 'Production' : 'Development',
      Db__ConnectionString: `Server=tcp:${a.resourceGroup}.database.windows.net;Database=contoso;Password=demo-Pa55w0rd;`,
      FeatureFlags__NewCheckout: 'false',
    };
    const host = `${a.name}.azurewebsites.net`;
    const site = { id, sub: a.sub, name: a.name, slot: null, kind: a.kind, resourceGroup: a.resourceGroup, location: 'westeurope', state: 'Running', host, hostNames: a.domain ? [host, a.domain] : [host], modified: new Date(now - 3 * 24 * HOUR).toISOString(), plan: `${a.resourceGroup}-plan`, runtime: a.runtime, settings: base };
    sites.push(site);
    for (const slot of a.slots) {
      sites.push({ ...site, id: `${id}/slots/${slot}`, slot, host: `${a.name}-${slot}.azurewebsites.net`, hostNames: [`${a.name}-${slot}.azurewebsites.net`], settings: { ...base, APP_VERSION: '2.15.0-rc.1', FeatureFlags__NewCheckout: 'true', ASPNETCORE_ENVIRONMENT: 'Staging' } });
    }
  }
  const components = [
    { id: '/subscriptions/sub-prod/resourceGroups/contoso-prod/providers/Microsoft.Insights/components/contoso-prod-ai', name: 'contoso-prod-ai', appId: 'app-prod', key: 'k-prod', resourceGroup: 'contoso-prod', sub: 'sub-prod' },
    { id: '/subscriptions/sub-dev/resourceGroups/contoso-dev/providers/Microsoft.Insights/components/contoso-dev-ai', name: 'contoso-dev-ai', appId: 'app-dev', key: 'k-dev', resourceGroup: 'contoso-dev', sub: 'sub-dev' },
  ];
  return { sites, components, telemetry: telemetry(now, sites) };
}

// A few days of what the apps did: requests (some failing), the exceptions behind the failures, traces.
function telemetry(now, sites) {
  const rand = seeded(42);
  const items = [];
  const PROBLEMS = [
    { type: 'System.TimeoutException', message: 'The operation has timed out talking to the payments provider', method: 'PaymentsClient.ChargeAsync', weight: 6 },
    { type: 'Microsoft.Data.SqlClient.SqlException', message: 'Transaction (Process ID 61) was deadlocked on lock resources', method: 'OrderRepository.SaveAsync', weight: 3 },
    { type: 'TypeError', message: "Cannot read properties of undefined (reading 'items')", method: 'CartView.render', weight: 2 },
  ];
  const roles = sites.filter((s) => !s.slot).map((s) => s.name);
  let op = 0;
  for (const role of roles) {
    const component = role.endsWith('-dev') ? 'app-dev' : 'app-prod';
    for (let i = 0; i < 120; i++) {
      // A third in the last few hours, so the short spans have something too; none in the last minute.
      const at = now - 60 * 1000 - Math.floor(rand() * 7 * 24 * HOUR * (i < 40 ? 0.05 : 1));
      const operation_Id = `op-${role}-${op++}`;
      const fails = rand() < 0.15;
      const path = ['/api/orders', '/api/cart', '/checkout', '/api/users/me', '/'][Math.floor(rand() * 5)];
      items.push({ itemType: 'request', component, timestamp: new Date(at).toISOString(), name: `GET ${path}`, url: `https://${role}.azurewebsites.net${path}`, resultCode: fails ? '500' : '200', success: !fails, duration: Math.round(20 + rand() * (fails ? 30000 : 400)), operation_Id, operation_Name: `GET ${path}`, cloud_RoleName: role });
      items.push({ itemType: 'trace', component, timestamp: new Date(at + 2).toISOString(), message: `Handling ${path}`, severityLevel: 1, operation_Id, operation_Name: `GET ${path}`, cloud_RoleName: role });
      if (fails) {
        let pick = rand() * 11;
        const p = PROBLEMS.find((x) => (pick -= x.weight) < 0) ?? PROBLEMS[0];
        items.push({ itemType: 'dependency', component, timestamp: new Date(at + 5).toISOString(), name: 'POST /charges', target: 'payments.example.com', type: 'HTTP', resultCode: '504', success: false, duration: 30000, operation_Id, cloud_RoleName: role });
        items.push({ itemType: 'exception', component, timestamp: new Date(at + 30000).toISOString(), problemId: `${p.type} at ${p.method}`, type: p.type, outerMessage: p.message, innermostMessage: p.message, method: p.method, severityLevel: 3, operation_Id, operation_Name: `GET ${path}`, cloud_RoleName: role, user_Id: `u${Math.floor(rand() * 30)}` });
      }
    }
  }
  return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

const TABLES = { requests: 'request', exceptions: 'exception', traces: 'trace', dependencies: 'dependency' };
const COLUMNS = {
  request: ['timestamp', 'name', 'url', 'resultCode', 'success', 'duration', 'operation_Id', 'operation_Name', 'cloud_RoleName'],
  exception: ['timestamp', 'problemId', 'type', 'outerMessage', 'method', 'severityLevel', 'operation_Id', 'operation_Name', 'cloud_RoleName', 'user_Id'],
  trace: ['timestamp', 'message', 'severityLevel', 'operation_Id', 'operation_Name', 'cloud_RoleName'],
  dependency: ['timestamp', 'name', 'target', 'type', 'resultCode', 'success', 'duration', 'operation_Id', 'cloud_RoleName'],
};
const TYPES = { timestamp: 'datetime', first: 'datetime', last: 'datetime', bucket: 'datetime', success: 'bool', duration: 'real', count: 'long', users: 'long', n: 'long', severityLevel: 'int' };
const table = (names, rows) => ({ columns: names.map((name) => ({ name, type: TYPES[name] ?? 'string' })), rows: rows.map((r) => names.map((n) => r[n] ?? null)) });

/** The demo's answer to `kql` over `items` (one component's, within the time span). */
export function demoQuery(kql, items) {
  const q = kql.replace(/\s+/g, ' ').trim();
  const role = /cloud_RoleName == '([^']*)'/.exec(q)?.[1];
  const mine = role ? items.filter((i) => i.cloud_RoleName === role) : items;
  const op = /operation_Id == '([^']*)'/.exec(q)?.[1];
  if (op) {
    const rows = mine
      .filter((i) => i.operation_Id === op)
      .map((i) => ({ ...i, name: i.name ?? i.type ?? i.message, detail: i.resultCode ?? i.outerMessage ?? i.message ?? i.target }));
    return table(['timestamp', 'itemType', 'name', 'detail', 'duration', 'success', 'cloud_RoleName'], rows);
  }
  const exceptions = mine.filter((i) => i.itemType === 'exception');
  if (/^exceptions\b.*summarize.*by problemId, bucket = bin\(timestamp, (\w+)\)/.test(q)) {
    const size = { '5m': 5 * 60 * 1000, '1h': HOUR, '1d': 24 * HOUR }[/bin\(timestamp, (\w+)\)/.exec(q)[1]];
    const counts = new Map();
    for (const e of exceptions) {
      const bucket = new Date(Math.floor(Date.parse(e.timestamp) / size) * size).toISOString();
      const k = `${e.problemId}\n${bucket}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const rows = [...counts].map(([k, n]) => ({ problemId: k.split('\n')[0], bucket: k.split('\n')[1], n })).sort((a, b) => a.bucket.localeCompare(b.bucket));
    return table(['problemId', 'bucket', 'n'], rows);
  }
  if (/^exceptions\b.*summarize.*by problemId, type/.test(q)) {
    const groups = new Map();
    for (const e of exceptions) {
      const g = groups.get(e.problemId) ?? { problemId: e.problemId, type: e.type, count: 0, users: new Set(), first: e.timestamp, last: e.timestamp, message: e.outerMessage, role: e.cloud_RoleName, operation: e.operation_Id };
      g.count++;
      g.users.add(e.user_Id);
      if (e.timestamp > g.last) Object.assign(g, { last: e.timestamp, operation: e.operation_Id });
      groups.set(e.problemId, g);
    }
    const rows = [...groups.values()].map((g) => ({ ...g, users: g.users.size })).sort((a, b) => b.count - a.count);
    return table(['problemId', 'type', 'count', 'users', 'first', 'last', 'message', 'role', 'operation'], rows);
  }
  const name = /^(\w+)/.exec(q)?.[1];
  const kind = TABLES[name];
  if (!kind) throw new Error(`Querying the demo: it answers requests, exceptions, traces and dependencies (with where cloud_RoleName == '…' and take), not "${name ?? q}"`);
  const take = Number(/\|\s*(?:take|limit) (\d+)/.exec(q)?.[1] ?? 1000);
  const rows = mine.filter((i) => i.itemType === kind).reverse().slice(0, take);
  return table(COLUMNS[kind], rows);
}

/** The demo provider. `now` fixes the clock and `delay` (ms) makes every call that slow, for trying the spinner. */
export function demoAzure({ now = Date.now(), delay = 0 } = {}) {
  const state = initialState(now);
  const wait = async (signal) => {
    if (delay) await new Promise((r, reject) => {
      const t = setTimeout(r, delay);
      signal?.addEventListener('abort', () => (clearTimeout(t), reject(Object.assign(new Error('Cancelled'), { cancelled: true }))), { once: true });
    });
  };
  const site = (target) => {
    const s = state.sites.find((x) => x.id === target.id);
    if (!s) throw new Error(`${target.name}: not found`);
    return s;
  };
  const view = ({ settings, sub, ...s }) => ({ ...s });
  return {
    kind: 'demo',
    state,
    async currentSubscription() {
      return { id: 'sub-prod', name: 'Contoso Production' };
    },
    async subscriptions({ signal } = {}) {
      await wait(signal);
      return [
        { id: 'sub-dev', name: 'Contoso Dev' },
        { id: 'sub-prod', name: 'Contoso Production' },
      ];
    },
    async apps(sub, { signal } = {}) {
      await wait(signal);
      return state.sites.filter((s) => s.sub === sub && !s.slot).map(view);
    },
    async slots(app, { signal } = {}) {
      await wait(signal);
      return state.sites.filter((s) => s.slot && s.id.startsWith(`${app.id}/slots/`)).map(view);
    },
    async settings(target, { signal } = {}) {
      await wait(signal);
      return { ...site(target).settings };
    },
    async saveSettings(target, settings, { signal } = {}) {
      await wait(signal);
      site(target).settings = { ...settings };
    },
    async restart(target, { signal } = {}) {
      await wait(signal);
      site(target).modified = new Date().toISOString();
    },
    async stop(target, { signal } = {}) {
      await wait(signal);
      site(target).state = 'Stopped';
    },
    async start(target, { signal } = {}) {
      await wait(signal);
      site(target).state = 'Running';
    },
    // What a swap moves: everything but the settings Azure keeps with a slot (here, the environment's name).
    async swap(slot, { signal } = {}) {
      await wait(signal);
      const s = site(slot);
      const prod = state.sites.find((x) => x.id === slot.id.replace(/\/slots\/[^/]+$/, ''));
      const sticky = ['ASPNETCORE_ENVIRONMENT'];
      const move = (from, to) => ({ ...Object.fromEntries(Object.entries(from).filter(([k]) => !sticky.includes(k))), ...Object.fromEntries(sticky.filter((k) => k in to).map((k) => [k, to[k]])) });
      [s.settings, prod.settings] = [move(prod.settings, s.settings), move(s.settings, prod.settings)];
    },
    async components(sub, { signal } = {}) {
      await wait(signal);
      return state.components.filter((c) => c.sub === sub).map(({ sub: _, ...c }) => c);
    },
    async query(component, kql, { timespan = 'P1D', signal } = {}) {
      await wait(signal);
      const hours = { PT1H: 1, P1D: 24, P7D: 168, P30D: 720 }[timespan] ?? 24;
      const since = new Date(now - hours * HOUR).toISOString();
      return demoQuery(kql, state.telemetry.filter((i) => i.component === component.appId && i.timestamp >= since));
    },
    // A made-up log: a line every `every` ms, as an app's would come, until the stream is stopped.
    async logStream(target, { signal, onLine, every = 300 }) {
      const s = site(target);
      const rand = seeded(s.name.length);
      const paths = ['/api/orders', '/api/cart', '/checkout', '/api/users/me', '/'];
      onLine(`${new Date(now).toISOString()}  Connected! Streaming the log of ${s.name}${s.slot ? `/${s.slot}` : ''}`);
      let n = 0;
      await new Promise((resolve) => {
        const t = setInterval(() => {
          const at = new Date(Date.now()).toISOString();
          const path = paths[Math.floor(rand() * paths.length)];
          const r = rand();
          onLine(r < 0.08 ? `${at} [ERR] Unhandled exception on GET ${path}: The operation has timed out talking to the payments provider` : r < 0.2 ? `${at} [WRN] Slow request GET ${path} took ${Math.round(1000 + rand() * 3000)} ms` : `${at} [INF] GET ${path} ${200} in ${Math.round(5 + rand() * 200)} ms`);
          n++;
        }, every);
        signal?.addEventListener('abort', () => (clearInterval(t), resolve()), { once: true });
      });
      return n;
    },
    // Made-up metrics, the same for the same app and span: busier in production, a few 5xx now and then.
    async metrics(target, { span, signal } = {}) {
      await wait(signal);
      const s = site(target);
      const rand = seeded(s.id.length * 7 + span.hours);
      const step = { PT5M: 5 * 60 * 1000, PT1H: HOUR, PT6H: 6 * HOUR, P1D: 24 * HOUR }[metricInterval(span)];
      const n = Math.round((span.hours * HOUR) / step);
      const busy = s.sub === 'sub-prod' ? 1 : 0.2;
      const at = (i) => new Date(now - (n - i) * step).toISOString();
      const series = (name, unit, value) => ({ name, unit, points: Array.from({ length: n }, (_, i) => ({ at: at(i), value: s.state === 'Stopped' ? 0 : value(i) })) });
      return [
        series('CpuTime', 'Seconds', () => Math.round(busy * (step / 60000) * (2 + rand() * 6))),
        series('MemoryWorkingSet', 'Bytes', () => Math.round((180 + busy * 220 + rand() * 60) * 1024 ** 2)),
        series('Http5xx', 'Count', () => (rand() < 0.25 ? Math.round(busy * rand() * 12) : 0)),
        series('HttpResponseTime', 'Seconds', () => busy * (0.08 + rand() * 0.3)),
      ];
    },
    portalUrl: (target) => `https://portal.azure.com/#resource${target.id}`,
  };
}
