// An in-memory Azure and project folder with the interfaces of azure/arm.js's provider and local.js's
// createLocal, for --demo and the tests: a shop's .env, appsettings and user secrets, an App Service app
// with a slot whose settings have drifted from them, Key Vault references (one to a secret that isn't
// there, one to a secret that has expired), and two vaults with a secret about to expire. A new
// operation in either needs one here too. `state.calls` records what was asked, never a value.
import { addToDotenv, flatten, isExample, parseDotenv } from './local.js';

const DAY = 24 * 60 * 60 * 1000;
const SUB = { id: '00000000-0000-4000-8000-00000000c0de', name: 'Contoso (demo)' };
const RG = `/subscriptions/${SUB.id}/resourceGroups`;

export const DEMO_DIR = process.platform === 'win32' ? 'C:\\src\\shop-api' : '/home/you/src/shop-api';

/** The demo project's files, by name. */
export function demoFiles() {
  return {
    '.env': ['# Local development', 'ASPNETCORE_ENVIRONMENT=Development', 'Api__BaseUrl=http://localhost:5000', 'Db__Password=dev-password', 'Redis__Password=local-redis', 'Features__Search=true', ''].join('\n'),
    '.env.example': ['ASPNETCORE_ENVIRONMENT=Development', 'Api__BaseUrl=', 'Db__Password=', 'Stripe__ApiKey=', 'Redis__Password=', 'Smtp__Password=', ''].join('\n'),
    'appsettings.json': JSON.stringify(
      {
        Logging: { LogLevel: { Default: 'Information' } },
        Api: { BaseUrl: 'https://api.shop.example' },
        Features: { Search: true },
        ConnectionStrings: { Default: 'Server=localhost;Database=shop;User Id=sa;Password=Local#123' },
      },
      null,
      2,
    ),
    'appsettings.Development.json': JSON.stringify({ Logging: { LogLevel: { Default: 'Debug' } }, Api: { BaseUrl: 'http://localhost:5000' } }, null, 2),
    'http-client.env.json': JSON.stringify({ dev: { baseUrl: 'http://localhost:5000' }, prod: { baseUrl: 'https://api.shop.example' } }, null, 2),
  };
}

const USER_SECRETS = { 'Stripe:ApiKey': 'sk_test_local_4242', 'Db:Password': 'dev-password' };

/** The demo project folder: its sources as readLocal makes them, from demoFiles(); adding to .env changes the file in memory. */
export function demoLocal({ dir = DEMO_DIR } = {}) {
  const files = demoFiles();
  const state = { files, calls: [] };
  const join = (f) => `${dir}${dir.includes('\\') ? '\\' : '/'}${f}`;
  return {
    kind: 'demo',
    dir,
    state,
    async sources() {
      const out = [];
      for (const f of Object.keys(files).filter((n) => n.startsWith('.env')).sort()) out.push({ id: `env:${f}`, kind: 'env', label: f, file: join(f), entries: parseDotenv(files[f]), writable: !isExample(f), ...(isExample(f) ? { example: true } : {}) });
      for (const f of ['appsettings.json', 'appsettings.Development.json']) out.push({ id: `json:${f}`, kind: 'appsettings', label: f, file: join(f), entries: flatten(JSON.parse(files[f])), writable: false });
      out.push({ id: 'secrets:shop-api-7d3c', kind: 'usersecrets', label: 'user secrets (Shop.Api)', file: '~/.microsoft/usersecrets/shop-api-7d3c/secrets.json', entries: flatten(USER_SECRETS), writable: false });
      for (const [env, vars] of Object.entries(JSON.parse(files['http-client.env.json']))) {
        out.push({ id: `http:http-client.env.json:${env}`, kind: 'http', label: `http-client:${env}`, file: join('http-client.env.json'), entries: Object.entries(vars).map(([key, value]) => ({ key, value: String(value) })), writable: false });
      }
      return out;
    },
    async addToEnv(file, key, value) {
      const name = String(file).split(/[\\/]/).pop();
      if (!name.startsWith('.env')) throw new Error(`${name} isn't a .env file.`);
      state.calls.push(['addToEnv', name, key]);
      files[name] = addToDotenv(files[name] ?? '', key, value);
    },
  };
}

const site = (name, kind = 'app', slot = null) => ({
  id: `${RG}/shop/providers/Microsoft.Web/sites/${name}${slot ? `/slots/${slot}` : ''}`,
  name,
  slot,
  kind,
  resourceGroup: 'shop',
  location: 'westeurope',
  state: 'Running',
});

const vault = (name, rg = 'shop') => ({ id: `${RG}/${rg}/providers/Microsoft.KeyVault/vaults/${name}`, name, uri: `https://${name}.vault.azure.net/`, resourceGroup: rg, location: 'westeurope' });

const ref = (v, s) => `@Microsoft.KeyVault(SecretUri=https://${v}.vault.azure.net/secrets/${s}/)`;

/** `state` is exposed for the tests: { sites, slots, settings, strings, statuses, vaults, secrets, values, calls }. */
export function demoAzure({ now = Date.now() } = {}) {
  const at = (days) => new Date(now + days * DAY).toISOString();
  const api = site('shop-api');
  const staging = site('shop-api', 'app', 'staging');
  const fn = site('shop-functions', 'function');
  const kvShop = vault('kv-shop');
  const kvShared = vault('kv-shared', 'shared');
  const secret = (name, { expires = null, enabled = true, contentType = '', updated = -40 } = {}) => ({ kind: 'secret', name, enabled, contentType, created: at(-200), updated: at(updated), expires, notBefore: null, managed: false });
  const state = {
    sites: [api, fn],
    slots: { [api.id]: [staging], [fn.id]: [] },
    settings: {
      [api.id]: {
        ASPNETCORE_ENVIRONMENT: 'Production',
        Api__BaseUrl: 'https://api.shop.example',
        Features__Search: 'true',
        Logging__LogLevel__Default: 'Warning',
        Db__Password: ref('kv-shop', 'db-password'),
        Stripe__ApiKey: '@Microsoft.KeyVault(VaultName=kv-shop;SecretName=Stripe--ApiKey)',
        Smtp__Password: ref('kv-shop', 'smtp-password'),
        Legacy__Token: ref('kv-shop', 'old-token'),
        APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=11111111-2222-3333-4444-555555555555;IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/',
      },
      [staging.id]: {
        ASPNETCORE_ENVIRONMENT: 'Staging',
        Api__BaseUrl: 'https://staging.api.shop.example',
        Features__Search: 'false',
        Db__Password: ref('kv-shop', 'db-password'),
        Stripe__ApiKey: ref('kv-shop', 'Stripe--ApiKey'),
      },
      [fn.id]: { FUNCTIONS_WORKER_RUNTIME: 'dotnet-isolated', AzureWebJobsStorage: 'DefaultEndpointsProtocol=https;AccountName=shopfn;AccountKey=ZGVtby1rZXk=;EndpointSuffix=core.windows.net', Db__Password: ref('kv-shop', 'db-password') },
    },
    strings: {
      [api.id]: { Default: { value: 'Server=tcp:shop-sql.database.windows.net;Database=shop;Authentication=Active Directory Default', type: 'SQLAzure' } },
      [staging.id]: { Default: { value: 'Server=tcp:shop-sql.database.windows.net;Database=shop-staging;Authentication=Active Directory Default', type: 'SQLAzure' } },
      [fn.id]: {},
    },
    // What App Service says of each reference: it hasn't noticed old-token ran out.
    statuses: {
      [api.id]: [
        { name: 'Db__Password', status: 'Resolved', details: '', vault: 'kv-shop', secret: 'db-password' },
        { name: 'Stripe__ApiKey', status: 'Resolved', details: '', vault: 'kv-shop', secret: 'Stripe--ApiKey' },
        { name: 'Smtp__Password', status: 'SecretNotFound', details: 'Secret smtp-password not found in kv-shop', vault: 'kv-shop', secret: 'smtp-password' },
        { name: 'Legacy__Token', status: 'Resolved', details: '', vault: 'kv-shop', secret: 'old-token' },
      ],
    },
    vaults: [kvShared, kvShop],
    secrets: {
      'kv-shop': [
        secret('db-password', { expires: at(200), updated: -60 }),
        secret('Jwt--SigningKey', { enabled: false, updated: -90 }),
        secret('old-token', { expires: at(-3), updated: -400 }),
        secret('Redis--Password', { updated: -10 }),
        secret('Stripe--ApiKey', { expires: at(5), contentType: 'text/plain', updated: -360 }),
      ],
      'kv-shared': [secret('Sendgrid--ApiKey', { expires: at(90) }), secret('Shared--Salt')],
    },
    certificates: {
      'kv-shop': [
        { kind: 'certificate', name: 'shop-tls', enabled: true, contentType: 'certificate', created: at(-345), updated: at(-345), expires: at(20), notBefore: at(-345), thumbprint: 'q1w2e3' },
        { kind: 'certificate', name: 'api-client', enabled: true, contentType: 'certificate', created: at(-30), updated: at(-30), expires: at(335), notBefore: at(-30), thumbprint: 'r4t5y6' },
      ],
      'kv-shared': [],
    },
    values: new Map([
      ['kv-shop/db-password', 'Pr0d-db-S3cret!'],
      ['kv-shop/Jwt--SigningKey', 'jwt-signing-key-demo'],
      ['kv-shop/old-token', 'legacy-0ld-t0ken'],
      ['kv-shop/Redis--Password', 'local-redis'],
      ['kv-shop/Stripe--ApiKey', 'sk_live_demo_4242'],
      ['kv-shared/Sendgrid--ApiKey', 'SG.demo-key'],
      ['kv-shared/Shared--Salt', 'demo-salt'],
    ]),
    calls: [],
  };
  const find = (v, name) => state.secrets[v.name]?.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
  const later = (value) => new Promise((r) => setTimeout(() => r(value), 5));
  return {
    kind: 'demo',
    state,
    currentSubscription: async () => SUB,
    subscriptions: async () => [SUB],
    sites: async () => later(state.sites.map((s) => ({ ...s }))),
    slots: async (s) => later((state.slots[s.id] ?? []).map((x) => ({ ...x }))),
    settings: async (t) => later({ ...(state.settings[t.id] ?? {}) }),
    connectionStrings: async (t) => later({ ...(state.strings[t.id] ?? {}) }),
    references: async (t) => later((state.statuses[t.id] ?? []).map((r) => ({ ...r }))),
    vaults: async () => later(state.vaults.map((v) => ({ ...v })).sort((a, b) => a.name.localeCompare(b.name))),
    secrets: async (v) => later((state.secrets[v.name] ?? []).map((s) => ({ ...s }))),
    certificates: async (v) => later((state.certificates[v.name] ?? []).map((c) => ({ ...c }))),
    async secretValue(v, name) {
      state.calls.push(['secretValue', v.name, name]);
      const s = find(v, name);
      if (!s) throw Object.assign(new Error(`Reading ${name} in ${v.name}: not found (A secret with (name/id) ${name} was not found in this key vault.)`), { status: 404 });
      if (!s.enabled) throw Object.assign(new Error(`Reading ${name} in ${v.name}: you don't have access (Operation get is not allowed on a disabled secret.)`), { status: 403 });
      return later(state.values.get(`${v.name}/${s.name}`) ?? '');
    },
    async setSecret(v, name, value, { contentType } = {}) {
      state.calls.push(['setSecret', v.name, name]);
      const s = find(v, name);
      const stamp = new Date(now).toISOString();
      if (s) Object.assign(s, { updated: stamp, enabled: true, expires: null, ...(contentType ? { contentType } : {}) });
      else state.secrets[v.name] = [...(state.secrets[v.name] ?? []), { kind: 'secret', name, enabled: true, contentType: contentType ?? '', created: stamp, updated: stamp, expires: null, notBefore: null, managed: false }].sort((a, b) => a.name.localeCompare(b.name));
      state.values.set(`${v.name}/${s?.name ?? name}`, String(value));
      return later();
    },
    async enableSecret(v, name, enabled) {
      state.calls.push([enabled ? 'enableSecret' : 'disableSecret', v.name, name]);
      const s = find(v, name);
      if (!s) throw new Error(`${name} isn't in ${v.name}.`);
      s.enabled = Boolean(enabled);
      return later();
    },
    portalUrl: (resource) => `https://portal.azure.com/#@/resource${resource.id}`,
  };
}
