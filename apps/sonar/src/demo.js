// An Azure in memory, with the provider's interface (see azure/arm.js), for `sonar --demo` and the tests:
// two subscriptions of web and function apps with slots and settings, two Application Insights
// components, and a few days of telemetry. Restarts, stops, swaps and saved settings change it until
// the app closes. Its query engine understands the queries Sonar itself sends, and plain
// `table | where cloud_RoleName == 'x' | where success == false | take n` (or `| count`) ones; anything
// else gets an error saying so.

import { metricInterval } from './metrics.js';
import { functionUrl, invocation, isHttp } from './functions.js';
import { storageRoleNeeded } from './blobs.js';

const HOUR = 60 * 60 * 1000;

function seeded(seed) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

const conn = (key) => `InstrumentationKey=${key};IngestionEndpoint=https://westeurope-5.in.applicationinsights.azure.com/`;

// Connection strings (ARM's, not app settings): contoso-api signs in to the production database with a
// SQL login, contoso-web reaches the reporting one with its managed identity.
const CONNECTION_STRINGS = {
  'contoso-api': { DefaultConnection: 'Server=tcp:contoso-sql-prod.database.windows.net,1433;Initial Catalog=contoso;Persist Security Info=False;User ID=contoso_app;Password=demo-Sql-Pa55;Encrypt=True;' },
  'contoso-web': { Reporting: 'Data Source=contoso-sql-prod.database.windows.net;Database=contoso-reporting;Authentication=Active Directory Managed Identity;' },
};

// The function apps' functions: an HTTP one, one on a Service Bus queue, timers.
const FUNCTIONS = {
  'contoso-orders': [
    { name: 'NightlyCleanup', trigger: 'timerTrigger', source: '0 0 2 * * *' },
    { name: 'PlaceOrder', trigger: 'httpTrigger', methods: ['POST'], authLevel: 'function', route: 'orders' },
    { name: 'ProcessPayment', trigger: 'serviceBusTrigger', source: 'payments' },
  ],
  'contoso-jobs-dev': [
    { name: 'Health', trigger: 'httpTrigger', methods: ['GET'], authLevel: 'anonymous', route: 'health' },
    { name: 'SendDigest', trigger: 'timerTrigger', source: '0 0 7 * * 1-5' },
  ],
};

// The other kinds of resource: a container app, storage accounts, SQL servers with their databases.
function otherResources() {
  const rg = (sub, group) => `/subscriptions/${sub}/resourceGroups/${group}`;
  const containers = [
    { sub: 'sub-prod', type: 'container', id: `${rg('sub-prod', 'contoso-prod')}/providers/Microsoft.App/containerApps/contoso-worker`, name: 'contoso-worker', resourceGroup: 'contoso-prod', location: 'westeurope', state: 'Running', host: 'contoso-worker.happyfield-1a2b3c.westeurope.azurecontainerapps.io', latestRevision: 'contoso-worker--r7', readyRevision: 'contoso-worker--r7', environmentId: `${rg('sub-prod', 'contoso-prod')}/providers/Microsoft.App/managedEnvironments/contoso-env`, image: 'contosocr.azurecr.io/worker:2.14.0', restarts: 0 },
  ];
  const storage = [
    { sub: 'sub-prod', type: 'storage', id: `${rg('sub-prod', 'contoso-prod')}/providers/Microsoft.Storage/storageAccounts/contosoprodstore`, name: 'contosoprodstore', resourceGroup: 'contoso-prod', location: 'westeurope', state: 'Available', kind: 'StorageV2', sku: 'Standard_RAGRS', tier: 'Hot', host: 'contosoprodstore.blob.core.windows.net' },
    { sub: 'sub-dev', type: 'storage', id: `${rg('sub-dev', 'contoso-dev')}/providers/Microsoft.Storage/storageAccounts/contosodevstore`, name: 'contosodevstore', resourceGroup: 'contoso-dev', location: 'westeurope', state: 'Available', kind: 'StorageV2', sku: 'Standard_LRS', tier: 'Hot', host: 'contosodevstore.blob.core.windows.net' },
  ];
  const server = (sub, group, name, { admin = null, rules = [], databases = [] }) => {
    const id = `${rg(sub, group)}/providers/Microsoft.Sql/servers/${name}`;
    const fqdn = `${name}.database.windows.net`;
    return {
      sub, type: 'sqlserver', id, name, resourceGroup: group, location: 'westeurope', state: 'Ready', fqdn, host: fqdn, version: '12.0', publicAccess: 'Enabled', admin, rules,
      databases: ['master', ...databases.map((d) => d[0])].map((d, i) => ({ type: 'sqldb', id: `${id}/databases/${d}`, name: d, server: name, serverId: id, fqdn, host: fqdn, resourceGroup: group, location: 'westeurope', state: 'Online', sku: i ? databases[i - 1][1] : 'System', tier: i ? databases[i - 1][2] : 'System' })),
    };
  };
  const azure = { name: 'AllowAllWindowsAzureIps', start: '0.0.0.0', end: '0.0.0.0' };
  const sqlServers = [
    server('sub-prod', 'contoso-prod', 'contoso-sql-prod', { admin: { login: 'SQL Admins', type: 'Group', only: false }, rules: [azure, { name: 'office', start: '203.0.113.0', end: '203.0.113.255' }], databases: [['contoso', 'GP_S_Gen5_2', 'GeneralPurpose'], ['contoso-reporting', 'S1', 'Standard']] }),
    server('sub-prod', 'contoso-qa', 'contoso-sql-qa', { rules: [azure], databases: [['contoso-qa', 'Basic', 'Basic']] }),
    server('sub-dev', 'contoso-dev', 'contoso-sql-dev', { admin: { login: 'ana@contoso.com', type: 'User', only: true }, rules: [{ name: 'home', start: '198.51.100.0', end: '198.51.100.255' }], databases: [['contoso', 'Basic', 'Basic']] }),
  ];
  // A Service Bus namespace: orders come in on a queue, payments fail into its dead letters, events fan out.
  const nsId = `${rg('sub-prod', 'contoso-prod')}/providers/Microsoft.ServiceBus/namespaces/contoso-bus`;
  const dead = (seq, body, reason, description, ago, extra = {}) => ({
    id: `m-${seq}`, sequence: seq, enqueued: new Date(Date.now() - ago).toISOString(), deliveryCount: 10, label: extra.label ?? '', correlationId: extra.correlationId ?? '', sessionId: '', contentType: 'application/json',
    reason, description, source: '', properties: { DeadLetterReason: reason, DeadLetterErrorDescription: description, ...(extra.properties ?? {}) }, body, broker: { MessageId: `m-${seq}`, SequenceNumber: seq, ...(extra.label ? { Label: extra.label } : {}) },
  });
  const timeout = 'Message could not be consumed after 10 delivery attempts.';
  const serviceBus = [
    {
      sub: 'sub-prod', type: 'servicebus', id: nsId, name: 'contoso-bus', resourceGroup: 'contoso-prod', location: 'westeurope', state: 'Active', sku: 'Standard', host: 'contoso-bus.servicebus.windows.net',
      entities: [
        { kind: 'queue', name: 'orders', path: 'orders', topic: null, active: 3, deadLetter: 0, scheduled: 0, transfer: 0, status: 'Active', maxDelivery: 10, subscriptions: null, dead: [] },
        {
          kind: 'queue', name: 'payments', path: 'payments', topic: null, active: 12, scheduled: 2, transfer: 0, status: 'Active', maxDelivery: 10, subscriptions: null,
          dead: [
            dead(4711, '{"orderId":"o-10211","amount":49.9,"currency":"EUR"}', 'MaxDeliveryCountExceeded', timeout, 3 * HOUR, { label: 'charge', properties: { Attempt: '10' } }),
            dead(4712, '{"orderId":"o-10214","amount":12.5,"currency":"EUR"}', 'MaxDeliveryCountExceeded', timeout, 2 * HOUR, { label: 'charge' }),
            dead(4719, '{"orderId":"o-10220","amount":230,"currency":"EUR","card":{"token":"tok_live_9f8e7d6c5b4a"}}', 'MaxDeliveryCountExceeded', timeout, HOUR, { label: 'charge' }),
            dead(4720, 'not json at all', 'DeserializationFailed', 'Unexpected character encountered while parsing value: n.', 30 * 60 * 1000),
          ],
        },
        { kind: 'topic', name: 'events', path: 'events', topic: null, active: 0, deadLetter: 0, scheduled: 0, transfer: 0, status: 'Active', maxDelivery: null, subscriptions: 2, dead: [] },
        { kind: 'subscription', name: 'events/audit', path: 'events/subscriptions/audit', topic: 'events', active: 1, scheduled: 0, transfer: 0, status: 'Active', maxDelivery: 10, subscriptions: null, dead: [dead(88, '{"event":"OrderPlaced","orderId":"o-10199"}', 'TTLExpiredException', 'The message expired and was dead lettered.', 26 * HOUR)] },
        { kind: 'subscription', name: 'events/search', path: 'events/subscriptions/search', topic: 'events', active: 0, scheduled: 0, transfer: 0, status: 'Active', maxDelivery: 10, subscriptions: null, dead: [] },
      ],
    },
  ];
  // The production account's blobs (the dev one's can't be read: no data role there).
  const day = 24 * HOUR;
  const file = (name, content, { type = 'text/plain', ago = day, tier = 'Hot', size } = {}) => ({ name, content, size: size ?? Buffer.byteLength(content ?? ''), type, tier, modified: new Date(Date.now() - ago).toISOString(), kind: 'BlockBlob' });
  const csv = (d) => `orderId,placedAt,total\no-${d}01,2026-10-${d}T09:12:00Z,49.90\no-${d}02,2026-10-${d}T11:40:00Z,12.50\n`;
  const blobs = {
    contosoprodstore: {
      exports: [
        file('orders/2026-10-23.csv', csv(23), { type: 'text/csv', ago: day }),
        file('orders/2026-10-24.csv', csv(24), { type: 'text/csv', ago: HOUR }),
        file('orders/archive/2026-09.zip', null, { type: 'application/zip', ago: 30 * day, tier: 'Cool', size: 5 * 1024 * 1024 }),
        file('readme.txt', 'Nightly exports of the orders, one CSV a day.\n', { ago: 90 * day }),
      ],
      invoices: [file('2026/10/inv-1001.json', JSON.stringify({ invoice: 'inv-1001', orderId: 'o-10211', total: 49.9, currency: 'EUR' }), { type: 'application/json', ago: 2 * day })],
    },
  };
  // A Cosmos DB account (NoSQL): a shop database sharing autoscale throughput, telemetry with its own per container.
  const cosmos = [
    {
      sub: 'sub-prod', type: 'cosmos', id: `${rg('sub-prod', 'contoso-prod')}/providers/Microsoft.DocumentDB/databaseAccounts/contoso-cosmos`, name: 'contoso-cosmos', resourceGroup: 'contoso-prod', location: 'westeurope', state: 'Online', api: 'NoSQL',
      endpoint: 'https://contoso-cosmos.documents.azure.com:443/', host: 'contoso-cosmos.documents.azure.com', consistency: 'Session', regions: ['West Europe', 'North Europe'], serverless: false, freeTier: false, localAuth: 'keys and Entra',
      tree: [
        { name: 'shop', throughput: { autoscale: 4000 }, containers: [{ name: 'carts', partitionKey: '/userId', hierarchical: false, ttl: 86400, throughput: null }, { name: 'orders', partitionKey: '/customerId', hierarchical: false, ttl: null, throughput: { manual: 400 } }] },
        { name: 'telemetry', throughput: null, containers: [{ name: 'events', partitionKey: '/deviceId, /day', hierarchical: true, ttl: 2592000, throughput: { autoscale: 1000 } }] },
      ],
    },
  ];
  // The workspace the container apps' environment (and production's Application Insights) writes to.
  const workspaces = [{ sub: 'sub-prod', type: 'workspace', id: `${rg('sub-prod', 'contoso-prod')}/providers/Microsoft.OperationalInsights/workspaces/contoso-logs`, name: 'contoso-logs', resourceGroup: 'contoso-prod', location: 'westeurope', state: 'Ready', workspaceId: 'ws-prod', retention: 30, sku: 'PerGB2018' }];
  return { containers, storage, sqlServers, serviceBus, blobs, cosmos, workspaces };
}

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
    // contoso-api takes two secrets from Key Vault: one resolves, the other its identity may not read.
    if (a.name === 'contoso-api') Object.assign(base, { Payments__ApiKey: '@Microsoft.KeyVault(SecretUri=https://contoso-kv.vault.azure.net/secrets/payments-key/)', Smtp__Password: '@Microsoft.KeyVault(VaultName=contoso-kv;SecretName=smtp-password)' });
    // contoso-jobs-dev's digest is turned off, as the portal does it.
    if (a.name === 'contoso-jobs-dev') base['AzureWebJobs.SendDigest.Disabled'] = 'true';
    const host = `${a.name}.azurewebsites.net`;
    const site = { id, sub: a.sub, name: a.name, connectionStrings: CONNECTION_STRINGS[a.name] ?? {}, slot: null, kind: a.kind, resourceGroup: a.resourceGroup, location: 'westeurope', state: 'Running', host, hostNames: a.domain ? [host, a.domain] : [host], modified: new Date(now - 3 * 24 * HOUR).toISOString(), plan: `${a.resourceGroup}-plan`, planId: `/subscriptions/${a.sub}/resourceGroups/${a.resourceGroup}/providers/Microsoft.Web/serverfarms/${a.resourceGroup}-plan`, runtime: a.runtime, settings: base };
    sites.push(site);
    for (const slot of a.slots) {
      sites.push({ ...site, connectionStrings: {}, id: `${id}/slots/${slot}`, slot, host: `${a.name}-${slot}.azurewebsites.net`, hostNames: [`${a.name}-${slot}.azurewebsites.net`], settings: { ...base, APP_VERSION: '2.15.0-rc.1', FeatureFlags__NewCheckout: 'true', ASPNETCORE_ENVIRONMENT: 'Staging' } });
    }
  }
  const components = [
    { id: '/subscriptions/sub-prod/resourceGroups/contoso-prod/providers/Microsoft.Insights/components/contoso-prod-ai', name: 'contoso-prod-ai', appId: 'app-prod', key: 'k-prod', resourceGroup: 'contoso-prod', sub: 'sub-prod' },
    { id: '/subscriptions/sub-dev/resourceGroups/contoso-dev/providers/Microsoft.Insights/components/contoso-dev-ai', name: 'contoso-dev-ai', appId: 'app-dev', key: 'k-dev', resourceGroup: 'contoso-dev', sub: 'sub-dev' },
  ];
  const prodRg = '/subscriptions/sub-prod/resourceGroups/contoso-prod';
  const alerts = [
    { sub: 'sub-prod', name: 'contoso-web 5xx over 20', severity: 'Sev1', signal: 'Metric', service: 'Platform', target: 'contoso-web', targetId: `${prodRg}/providers/Microsoft.Web/sites/contoso-web`, targetType: 'microsoft.web/sites', ago: 20 * 60 * 1000, description: 'More than 20 server errors in 5 minutes' },
    { sub: 'sub-prod', name: 'Checkout availability below 95%', severity: 'Sev2', signal: 'Metric', service: 'Application Insights', target: 'contoso-prod-ai', targetId: `${prodRg}/providers/microsoft.insights/components/contoso-prod-ai`, targetType: 'microsoft.insights/components', ago: 3 * HOUR, description: 'The checkout availability test failed from 2 of 3 locations' },
    { sub: 'sub-prod', name: 'Payments timeouts in traces', severity: 'Sev3', signal: 'Log', service: 'Log Analytics', target: 'contoso-prod-ai', targetId: `${prodRg}/providers/microsoft.insights/components/contoso-prod-ai`, targetType: 'microsoft.insights/components', ago: 30 * HOUR, description: '' },
  ].map((a, i) => ({ id: `/subscriptions/${a.sub}/providers/Microsoft.AlertsManagement/alerts/demo-${i}`, state: 'New', condition: 'Fired', resourceGroup: 'contoso-prod', rule: `${prodRg}/providers/microsoft.insights/metricalerts/${a.name.replace(/\W+/g, '-')}`, fired: new Date(now - a.ago).toISOString(), changed: new Date(now - a.ago).toISOString(), ...a }));
  // The demo's vault: the secrets in it, and the ones the apps' identities may not read.
  const vault = { name: 'contoso-kv', secrets: ['payments-key', 'smtp-password'], denied: ['smtp-password'] };
  // The plans the apps run on (one per resource group), and the production one's autoscale.
  const plans = [...new Set(sites.map((x) => x.planId))].map((id) => {
    const prod = /contoso-prod/.test(id);
    return { id, name: id.split('/').pop(), resourceGroup: /resourceGroups\/([^/]+)/.exec(id)[1], location: 'westeurope', kind: 'linux', sku: prod ? { name: 'P1v3', tier: 'PremiumV3', capacity: 2 } : { name: 'B1', tier: 'Basic', capacity: 1 }, maxWorkers: prod ? 30 : 3, elasticMax: null, sites: sites.filter((x) => x.planId === id && !x.slot).length, status: 'Ready' };
  });
  const autoscale = [
    { sub: 'sub-prod', id: `${prodRg}/providers/microsoft.insights/autoscalesettings/contoso-prod-plan-autoscale`, name: 'contoso-prod-plan-autoscale', enabled: true, target: plans.find((x) => /contoso-prod/.test(x.id)).id, profiles: [{ name: 'Default', min: 2, max: 5, default: 2, fixed: false, recurring: false, rules: [{ metric: 'CpuPercentage', operator: 'GreaterThan', threshold: 70, direction: 'Increase', change: 1, type: 'ChangeCount' }, { metric: 'CpuPercentage', operator: 'LessThan', threshold: 30, direction: 'Decrease', change: 1, type: 'ChangeCount' }] }] },
  ];
  // contoso-web sends a tenth of its traffic to staging.
  const web = sites.find((x) => x.name === 'contoso-web' && !x.slot);
  const routing = { [web.id]: [{ slot: 'staging', host: 'contoso-web-staging.azurewebsites.net', percent: 10 }] };
  return { sites, components, alerts, vault, invocations: [], plans, autoscale, routing, ...otherResources(), ip: '198.51.100.7', telemetry: telemetry(now, sites) };
}

// A few days of what the apps did: requests (some failing), the exceptions behind the failures, traces.
function telemetry(now, sites) {
  const rand = seeded(42);
  const items = [];
  // Each with the stack App Insights parses (`details`), as a build on GitHub's runners would leave it.
  const built = (path) => `/home/runner/work/contoso/contoso/${path}`;
  const PROBLEMS = [
    { type: 'System.TimeoutException', message: 'The operation has timed out talking to the payments provider', method: 'PaymentsClient.ChargeAsync', weight: 6, stack: [['Contoso.Api.Payments.PaymentsClient.ChargeAsync', 'src/Contoso.Api/Payments/PaymentsClient.cs', 58], ['Contoso.Api.Orders.OrderService.PlaceAsync', 'src/Contoso.Api/Orders/OrderService.cs', 31]] },
    { type: 'Microsoft.Data.SqlClient.SqlException', message: 'Transaction (Process ID 61) was deadlocked on lock resources', method: 'OrderRepository.SaveAsync', weight: 3, stack: [['Contoso.Api.Orders.OrderRepository.SaveAsync', 'src/Contoso.Api/Orders/OrderRepository.cs', 42], ['Contoso.Api.Orders.OrderService.PlaceAsync', 'src/Contoso.Api/Orders/OrderService.cs', 35]] },
    { type: 'TypeError', message: "Cannot read properties of undefined (reading 'items')", method: 'CartView.render', weight: 2, stack: [['CartView.render', 'web/src/views/CartView.js', 17]] },
  ];
  const details = (p) => [{ id: '0', outerId: '0', type: p.type, message: p.message, parsedStack: p.stack.map(([method, file, line], level) => ({ level, method, assembly: p.type === 'TypeError' ? '' : 'Contoso.Api', fileName: built(file), line })) }];
  // The latest deployment (demo deployments' d3) brought the new cart: TypeError only happens after it.
  const deployed = now - 3 * 24 * HOUR;
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
        let p = PROBLEMS.find((x) => (pick -= x.weight) < 0) ?? PROBLEMS[0];
        if (p.type === 'TypeError' && at < deployed) p = PROBLEMS[0];
        // A deadlock fails on the database, the others waiting on the payments provider.
        if (p.type.endsWith('SqlException')) items.push({ itemType: 'dependency', component, timestamp: new Date(at + 5).toISOString(), name: 'contoso-sql-prod.database.windows.net | contoso', target: 'contoso-sql-prod.database.windows.net | contoso', type: 'SQL', data: 'UPDATE Orders SET Status = @status, UpdatedAt = SYSUTCDATETIME() WHERE Id = @id', resultCode: '1205', success: false, duration: 4200, operation_Id, cloud_RoleName: role });
        else items.push({ itemType: 'dependency', component, timestamp: new Date(at + 5).toISOString(), name: 'POST /charges', target: 'payments.example.com', type: 'HTTP', resultCode: '504', success: false, duration: 30000, operation_Id, cloud_RoleName: role });
        items.push({ itemType: 'exception', component, timestamp: new Date(at + 30000).toISOString(), problemId: `${p.type} at ${p.method}`, type: p.type, outerMessage: p.message, innermostMessage: p.message, method: p.method, details: details(p), severityLevel: 3, operation_Id, operation_Name: `GET ${path}`, cloud_RoleName: role, user_Id: `u${Math.floor(rand() * 30)}` });
      }
    }
  }
  // The functions' runs, each logged as a request named for the function; ProcessPayment fails now and then.
  const frand = seeded(99);
  for (const s of sites.filter((x) => x.kind === 'function' && !x.slot)) {
    const component = s.name.endsWith('-dev') ? 'app-dev' : 'app-prod';
    for (const fn of FUNCTIONS[s.name] ?? []) {
      for (let i = 0; i < 40; i++) {
        const at = now - 60 * 1000 - Math.floor(frand() * 7 * 24 * HOUR * (i < 15 ? 0.05 : 1));
        const fails = frand() < (fn.name === 'ProcessPayment' ? 0.2 : 0.02);
        items.push({ itemType: 'request', component, timestamp: new Date(at).toISOString(), name: fn.name, url: fn.route ? `https://${s.host}/api/${fn.route}` : undefined, resultCode: fails ? '0' : '200', success: !fails, duration: Math.round(15 + frand() * (fails ? 9000 : 600)), operation_Id: `op-${fn.name}-${i}`, operation_Name: fn.name, cloud_RoleName: s.name });
      }
    }
  }
  // Two availability tests on production, every 15 minutes from three places; the checkout one fails now and then.
  for (const [test, flaky] of [['shop.contoso.com home page', 0], ['shop.contoso.com checkout', 0.12]]) {
    for (let t = now - 60 * 1000; t > now - 7 * 24 * HOUR; t -= 15 * 60 * 1000) {
      for (const location of ['West Europe', 'North Europe', 'East US']) {
        const fails = rand() < flaky;
        items.push({ itemType: 'availability', component: 'app-prod', timestamp: new Date(t - Math.floor(rand() * 60000)).toISOString(), name: test, location, success: !fails, duration: Math.round(fails ? 30000 : 150 + rand() * 300), message: fails ? 'Request timed out after 30 s' : 'Passed', cloud_RoleName: '' });
      }
    }
  }
  return items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

const TABLES = { requests: 'request', exceptions: 'exception', traces: 'trace', dependencies: 'dependency', availabilityResults: 'availability' };
const COLUMNS = {
  request: ['timestamp', 'name', 'url', 'resultCode', 'success', 'duration', 'operation_Id', 'operation_Name', 'cloud_RoleName'],
  exception: ['timestamp', 'problemId', 'type', 'outerMessage', 'method', 'severityLevel', 'operation_Id', 'operation_Name', 'cloud_RoleName', 'user_Id'],
  trace: ['timestamp', 'message', 'severityLevel', 'operation_Id', 'operation_Name', 'cloud_RoleName'],
  dependency: ['timestamp', 'name', 'target', 'type', 'resultCode', 'success', 'duration', 'operation_Id', 'cloud_RoleName'],
  availability: ['timestamp', 'name', 'location', 'success', 'duration', 'message'],
};
const TYPES = { runs: 'long', p50: 'real', Count: 'long', p95: 'real', details: 'dynamic', timestamp: 'datetime', first: 'datetime', last: 'datetime', bucket: 'datetime', lastFailure: 'datetime', total: 'long', failed: 'long', locations: 'long', success: 'bool', duration: 'real', count: 'long', users: 'long', n: 'long', severityLevel: 'int' };
const table = (names, rows) => ({ columns: names.map((name) => ({ name, type: TYPES[name] ?? 'string' })), rows: rows.map((r) => names.map((n) => r[n] ?? null)) });

/** The demo's answer to `kql` over `items` (one component's, within the time span). */
export function demoQuery(kql, items) {
  // `| render …` says how to draw it, which the query API leaves to the caller.
  const q = kql.replace(/\s+/g, ' ').trim().replace(/\s*\|\s*render\s+\w+.*$/i, '');
  const role = /cloud_RoleName == '([^']*)'/.exec(q)?.[1];
  const mine = role ? items.filter((i) => i.cloud_RoleName === role) : items;
  const op = /operation_Id == '([^']*)'/.exec(q)?.[1];
  const exceptions = mine.filter((i) => i.itemType === 'exception');
  const windowed = /^(\w+)\b.*where timestamp between \(datetime\(([^)]+)\) \.\. datetime\(([^)]+)\)\) \| extend window = iff\(timestamp < datetime\(([^)]+)\).*\| summarize .* by (\w+), window$/.exec(q);
  if (windowed) return windowedAnswer(windowed, mine);
  const problem = /problemId == '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
  if (/^exceptions\b.*take 1 \| project .*details/.test(q)) {
    const latest = exceptions.filter((e) => e.problemId === problem).at(-1);
    return table(['timestamp', 'type', 'outerMessage', 'method', 'details', 'operation_Id', 'cloud_RoleName'], latest ? [latest] : []);
  }
  if (/^let ops = exceptions\b.*dependencies\b.*summarize/.test(q)) {
    const ops = new Set(exceptions.filter((e) => e.problemId === problem).map((e) => e.operation_Id));
    const groups = new Map();
    for (const d of mine.filter((i) => i.itemType === 'dependency' && ops.has(i.operation_Id) && /sql/i.test(i.type) && !i.success)) {
      const k = `${d.target}\n${d.data}`;
      const g = groups.get(k) ?? { target: d.target, data: d.data, count: 0, last: d.timestamp, resultCode: d.resultCode };
      g.count++;
      if (d.timestamp > g.last) g.last = d.timestamp;
      groups.set(k, g);
    }
    return table(['target', 'data', 'count', 'last', 'resultCode'], [...groups.values()].sort((a, b) => b.count - a.count));
  }
  if (op) {
    const rows = mine
      .filter((i) => i.operation_Id === op)
      .map((i) => ({ ...i, name: i.name ?? i.type ?? i.message, detail: i.resultCode ?? i.outerMessage ?? i.message ?? i.target, kind: i.type }));
    return table(['timestamp', 'itemType', 'name', 'detail', 'duration', 'success', 'cloud_RoleName', 'url', 'target', 'data', 'kind'], rows);
  }
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
  // A function app's runs, by function (functions.js functionRunsQuery).
  if (/^requests\b.*summarize runs = count\(\).* by name/.test(q)) {
    const groups = new Map();
    for (const r of mine.filter((i) => i.itemType === 'request')) {
      const g = groups.get(r.name) ?? { name: r.name, runs: 0, failed: 0, last: r.timestamp, lastFailure: null, durations: [] };
      g.runs++;
      g.durations.push(r.duration);
      if (r.timestamp > g.last) g.last = r.timestamp;
      if (!r.success) {
        g.failed++;
        if (!g.lastFailure || r.timestamp > g.lastFailure) g.lastFailure = r.timestamp;
      }
      groups.set(r.name, g);
    }
    const rows = [...groups.values()].map((g) => ({ ...g, p50: g.durations.sort((a, b) => a - b)[Math.floor(g.durations.length / 2)] })).sort((a, b) => a.name.localeCompare(b.name));
    return table(['name', 'runs', 'failed', 'last', 'lastFailure', 'p50'], rows);
  }
  if (/^availabilityResults\b.*summarize/.test(q)) {
    const groups = new Map();
    for (const r of items.filter((i) => i.itemType === 'availability')) {
      const g = groups.get(r.name) ?? { name: r.name, total: 0, failed: 0, last: r.timestamp, lastFailure: null, locations: new Set(), message: null };
      g.total++;
      g.locations.add(r.location);
      if (r.timestamp > g.last) g.last = r.timestamp;
      if (!r.success) {
        g.failed++;
        if (!g.lastFailure || r.timestamp > g.lastFailure) Object.assign(g, { lastFailure: r.timestamp, message: r.message });
      }
      groups.set(r.name, g);
    }
    const rows = [...groups.values()].map((g) => ({ ...g, locations: g.locations.size })).sort((a, b) => b.failed - a.failed || a.name.localeCompare(b.name));
    return table(['name', 'total', 'failed', 'last', 'lastFailure', 'locations', 'message'], rows);
  }
  // `summarize count() by …`, by bins of time and by columns, as a chart's query asks.
  const counted = /^(\w+)((?: \| where [^|]+)*) \| summarize (?:(\w+) = )?count\(\) by ([^|]+?)(?: \| (?:order|sort) by [^|]+)?(?: \| (?:take|limit) (\d+))?$/.exec(q);
  if (counted && TABLES[counted[1]]) return countedAnswer(counted, mine, /\|\s*where success == false\b/.test(q));
  const name = /^(\w+)/.exec(q)?.[1];
  const kind = TABLES[name];
  if (!kind) throw new Error(`Querying the demo: it answers requests, exceptions, traces, dependencies and availabilityResults (with where cloud_RoleName == '…' and take), not "${name ?? q}"`);
  const take = Number(/\|\s*(?:take|limit) (\d+)/.exec(q)?.[1] ?? 1000);
  const failing = /\|\s*where success == false\b/.test(q);
  const named = /\|\s*where name == '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1');
  const rows = mine.filter((i) => i.itemType === kind && (!failing || i.success === false) && (named == null || i.name === named)).reverse().slice(0, take);
  // `| count`, as a watch's query ends.
  if (/\|\s*count\s*$/.test(q)) return table(['Count'], [{ Count: rows.length }]);
  return table(COLUMNS[kind], rows);
}

const BIN = { m: 60 * 1000, h: HOUR, d: 24 * HOUR };

// `table | where … | summarize [n =] count() by bin(timestamp, 1h)[, column…]`: the rows counted by those keys.
function countedAnswer([, name, , alias, by, take], mine, failing) {
  const keys = by.split(/,\s*(?![^()]*\))/).map((k) => {
    const bin = /^(?:(\w+) = )?bin\((\w+), (\d+)([mhd])\)$/.exec(k.trim());
    if (bin) return { name: bin[1] ?? bin[2], field: bin[2], size: Number(bin[3]) * BIN[bin[4]] };
    const plain = /^(?:(\w+) = )?(\w+)$/.exec(k.trim());
    if (!plain) throw new Error(`Querying the demo: it counts by bin(timestamp, …) and columns, not "${k}"`);
    return { name: plain[1] ?? plain[2], field: plain[2] };
  });
  const groups = new Map();
  for (const i of mine.filter((x) => x.itemType === TABLES[name] && (!failing || x.success === false))) {
    const vals = keys.map((k) => (k.size ? new Date(Math.floor(Date.parse(i[k.field]) / k.size) * k.size).toISOString() : i[k.field] ?? null));
    const id = JSON.stringify(vals);
    const g = groups.get(id) ?? { vals, n: 0 };
    g.n++;
    groups.set(id, g);
  }
  const binned = keys.findIndex((k) => k.size);
  const rows = [...groups.values()].sort((a, b) => (binned >= 0 ? String(a.vals[binned]).localeCompare(String(b.vals[binned])) : b.n - a.n)).slice(0, take ? Number(take) : undefined);
  return {
    columns: [...keys.map((k) => ({ name: k.name, type: k.size ? 'datetime' : TYPES[k.field] ?? 'string' })), { name: alias ?? 'count_', type: 'long' }],
    rows: rows.map((g) => [...g.vals, g.n]),
  };
}

// /compare-window's queries: the table's rows between two times, summarised by a key and which side of the point they fell.
function windowedAnswer([, name, from, to, point, key], mine) {
  const kind = TABLES[name];
  const groups = new Map();
  for (const i of mine.filter((x) => x.itemType === kind && x.timestamp >= from && x.timestamp <= to)) {
    const window = i.timestamp < point ? 'before' : 'after';
    const k = `${i[key]}\n${window}`;
    const g = groups.get(k) ?? { [key]: i[key], window, n: 0, failed: 0, message: i.outerMessage, durations: [] };
    g.n++;
    if (Number(i.resultCode) >= 500) g.failed++;
    g.durations.push(i.duration);
    groups.set(k, g);
  }
  const rows = [...groups.values()].map((g) => {
    const d = g.durations.sort((a, b) => a - b);
    return { ...g, p95: d[Math.max(0, Math.ceil(d.length * 0.95) - 1)] };
  });
  const columns = { exceptions: ['type', 'window', 'n', 'message'], dependencies: ['target', 'window', 'p95', 'n'], requests: ['name', 'window', 'n', 'failed'] }[name];
  return table(columns, rows);
}

// The demo workspace's tables: the container app's console log, and production's telemetry as
// workspace-based Application Insights writes it (AppRequests, AppExceptions, AppTraces).
export const WORKSPACE_TABLES = {
  AppExceptions: ['TimeGenerated', 'ProblemId', 'ExceptionType', 'OuterMessage', 'OperationId', 'AppRoleName'],
  AppRequests: ['TimeGenerated', 'Name', 'Url', 'ResultCode', 'Success', 'DurationMs', 'OperationId', 'AppRoleName'],
  AppTraces: ['TimeGenerated', 'Message', 'SeverityLevel', 'OperationId', 'AppRoleName'],
  ContainerAppConsoleLogs_CL: ['TimeGenerated', 'ContainerAppName_s', 'RevisionName_s', 'Log_s'],
};
const WORKSPACE_TYPES = { TimeGenerated: 'datetime', Success: 'bool', DurationMs: 'real', SeverityLevel: 'int', rows: 'long', Count: 'long' };

/** The rows of a workspace table, from `items` (telemetry) and the made-up console log. */
function workspaceRows(name, items, now, hours) {
  const of = (kind) => items.filter((i) => i.itemType === kind).reverse();
  if (name === 'AppRequests') return of('request').map((i) => ({ TimeGenerated: i.timestamp, Name: i.name, Url: i.url ?? null, ResultCode: i.resultCode, Success: i.success, DurationMs: i.duration, OperationId: i.operation_Id, AppRoleName: i.cloud_RoleName }));
  if (name === 'AppExceptions') return of('exception').map((i) => ({ TimeGenerated: i.timestamp, ProblemId: i.problemId, ExceptionType: i.type, OuterMessage: i.outerMessage, OperationId: i.operation_Id, AppRoleName: i.cloud_RoleName }));
  if (name === 'AppTraces') return of('trace').map((i) => ({ TimeGenerated: i.timestamp, Message: i.message, SeverityLevel: i.severityLevel, OperationId: i.operation_Id, AppRoleName: i.cloud_RoleName }));
  if (name === 'ContainerAppConsoleLogs_CL') {
    const rand = seeded(7);
    const rows = [];
    for (let i = 0; i < hours * 12; i++) {
      const r = rand();
      rows.push({ TimeGenerated: new Date(now - 60 * 1000 - i * 5 * 60 * 1000).toISOString(), ContainerAppName_s: 'contoso-worker', RevisionName_s: 'contoso-worker--r7', Log_s: r < 0.1 ? 'ERROR Message 4711 went to the dead-letter queue: payments timed out' : `INFO Processed ${Math.round(5 + rand() * 40)} order messages` });
    }
    return rows;
  }
  return null;
}

/**
 * The demo's Log Analytics workspace: its tables (WORKSPACE_TABLES) with `| where Column == 'x'`,
 * `take` and `| count`, and which tables have rows (`search * | summarize … by $table`, or `distinct $table`).
 */
export function workspaceQuery(kql, now, hours = 24, items = []) {
  const q = kql.replace(/\s+/g, ' ').trim();
  const wtable = (names, rows) => ({ columns: names.map((name) => ({ name, type: WORKSPACE_TYPES[name] ?? 'string' })), rows: rows.map((r) => names.map((n) => r[n] ?? null)) });
  if (/^search \* \| (summarize|distinct)\b.*\$table/.test(q)) {
    const counts = Object.keys(WORKSPACE_TABLES).map((t) => ({ $table: t, rows: workspaceRows(t, items, now, hours).length })).filter((t) => t.rows);
    if (/distinct/.test(q)) return wtable(['$table'], counts);
    return wtable(['$table', 'rows'], counts.sort((a, b) => b.rows - a.rows));
  }
  const name = /^(\w+)/.exec(q)?.[1];
  let rows = workspaceRows(name, items, now, hours);
  if (!rows) throw new Error(`Querying the demo workspace: it answers ${Object.keys(WORKSPACE_TABLES).join(', ')} (with where Column == '…', take and count), not "${name ?? q}"`);
  for (const [, col, val] of q.matchAll(/\| where (\w+) == '([^']*)'/g)) rows = rows.filter((r) => String(r[col]) === val);
  const take = Number(/\|\s*(?:take|limit) (\d+)/.exec(q)?.[1] ?? 1000);
  if (/\|\s*count\s*$/.test(q)) return wtable(['Count'], [{ Count: rows.length }]);
  return wtable(WORKSPACE_TABLES[name], rows.slice(0, take));
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
  const view = ({ settings, connectionStrings, sub, ...s }) => ({ ...s });
  // An account's blobs, or Storage's 403 in words, as the real one says it.
  const blobsOf = (account, what) => {
    const b = state.blobs[account.name];
    if (!b) throw Object.assign(new Error(storageRoleNeeded(account, what)), { status: 403 });
    return b;
  };
  // A container app's: a steady trickle of requests, a fraction of a core, two replicas that go to three when busy.
  const containerMetrics = (target, span) => {
    const c = state.containers.find((x) => x.id === target.id);
    if (!c) throw new Error(`${target.name}: not found`);
    const rand = seeded(c.id.length * 3 + span.hours);
    const step = { PT5M: 5 * 60 * 1000, PT1H: HOUR, PT6H: 6 * HOUR, P1D: 24 * HOUR }[metricInterval(span)];
    const n = Math.round((span.hours * HOUR) / step);
    const at = (i) => new Date(now - (n - i) * step).toISOString();
    const series = (name, unit, value) => ({ name, unit, points: Array.from({ length: n }, (_, i) => ({ at: at(i), value: value(i) })) });
    return [
      series('Requests', 'Count', () => Math.round((step / 60000) * (3 + rand() * 9))),
      series('UsageNanoCores', 'NanoCores', () => Math.round((0.12 + rand() * 0.3) * 1e9)),
      series('WorkingSetBytes', 'Bytes', () => Math.round((210 + rand() * 90) * 1024 ** 2)),
      series('Replicas', 'Count', () => (rand() < 0.2 ? 3 : 2)),
    ];
  };
  const busOf = (ns) => {
    const n = state.serviceBus.find((x) => x.id === ns.id);
    if (!n) throw new Error(`${ns.name}: not found`);
    return n;
  };
  const entityOf = (ns, entity) => {
    const e = busOf(ns).entities.find((x) => x.path === entity.path);
    if (!e) throw new Error(`${entity.name}: not found in ${ns.name}`);
    return e;
  };
  const sqlServer = (server) => {
    const s = state.sqlServers.find((x) => x.id === server.id);
    if (!s) throw new Error(`${server.name}: not found`);
    return s;
  };
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
    async appsWithSlots(sub, { signal } = {}) {
      await wait(signal);
      return new Set(state.sites.filter((s) => s.sub === sub && s.slot).map((s) => s.id.replace(/\/slots\/[^/]+$/, '').toLowerCase()));
    },
    async slots(app, { signal } = {}) {
      await wait(signal);
      return state.sites.filter((s) => s.slot && s.id.startsWith(`${app.id}/slots/`)).map(view);
    },
    async settings(target, { signal } = {}) {
      await wait(signal);
      return { ...site(target).settings };
    },
    // What App Service would say of each @Microsoft.KeyVault(…) setting, from the demo's vault.
    async keyVaultReferences(target, { signal } = {}) {
      await wait(signal);
      return Object.entries(site(target).settings)
        .filter(([, v]) => /^@Microsoft\.KeyVault\(/i.test(v))
        .map(([name, v]) => {
          const secret = /secrets\/([^/)]+)/i.exec(v)?.[1] ?? /SecretName=([^;)]+)/i.exec(v)?.[1] ?? '';
          const status = !state.vault.secrets.includes(secret) ? 'SecretNotFound' : state.vault.denied.includes(secret) ? 'AccessToKeyVaultDenied' : 'Resolved';
          return { name, status, details: status === 'AccessToKeyVaultDenied' ? 'Forbidden: the identity has no get permission on secrets' : '', vault: state.vault.name, secret, identity: 'SystemAssigned', reference: v };
        });
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
      if (component.workspaceId) return workspaceQuery(kql, now, hours, state.telemetry.filter((i) => i.component === 'app-prod' && i.timestamp >= new Date(now - hours * HOUR).toISOString()));
      // A span, or an interval between two times (start/end), as /compare-window asks.
      const since = String(timespan).includes('/') ? String(timespan).split('/')[0] : new Date(now - hours * HOUR).toISOString();
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
    async functions(target, { signal } = {}) {
      await wait(signal);
      const s = site(target);
      return (FUNCTIONS[s.name] ?? []).map((f) => ({ id: `${s.id}/functions/${f.name}`, name: f.name, trigger: f.trigger, methods: f.methods ?? null, authLevel: f.authLevel ?? null, route: f.route ?? null, source: f.source ?? null, url: isHttp(f) ? `https://${s.host}/api/${f.route}` : null, disabled: false, language: 'dotnet-isolated' }));
    },
    // What the functions answer: PlaceOrder wants an order in its body, Health says so, the rest are queued.
    async invokeFunction(target, fn, { input = '', signal } = {}) {
      await wait(signal);
      const s = site(target);
      const send = invocation(fn, input);
      state.invocations.push({ target: s.slot ? `${s.name}/${s.slot}` : s.name, name: fn.name, input });
      const url = send.admin ? `https://${s.host}/admin/functions/${fn.name}` : functionUrl(fn, s.host);
      const answer = (status, type, body) => ({ status, type, body, url, method: send.method });
      if (send.admin) return answer(202, '', '');
      if (fn.name === 'PlaceOrder') return input.trim() ? answer(201, 'application/json; charset=utf-8', JSON.stringify({ orderId: 'o-10234', status: 'placed' })) : answer(400, 'application/json; charset=utf-8', JSON.stringify({ error: 'An order is needed in the body' }));
      return answer(200, 'text/plain', 'Healthy');
    },
    async routing(app, { signal } = {}) {
      await wait(signal);
      return (state.routing[site(app).id] ?? []).map((r) => ({ ...r }));
    },
    async setRouting(app, rules, { signal } = {}) {
      await wait(signal);
      state.routing[site(app).id] = rules.map((r) => ({ ...r }));
    },
    async cosmosAccounts(sub, { signal } = {}) {
      await wait(signal);
      return state.cosmos.filter((a) => a.sub === sub).map(({ sub: _, tree: __, ...a }) => ({ ...a }));
    },
    async cosmosTree(account, { signal } = {}) {
      await wait(signal);
      return structuredClone(state.cosmos.find((a) => a.id === account.id)?.tree ?? []);
    },
    async containers(account, { signal } = {}) {
      await wait(signal);
      const b = blobsOf(account, `Listing ${account.name}'s containers`);
      return Object.keys(b).map((name) => ({ name, modified: new Date(now - 90 * 24 * HOUR).toISOString(), access: 'private' }));
    },
    async blobs(account, container, prefix = '', { signal } = {}) {
      await wait(signal);
      const list = blobsOf(account, `Listing ${container}/${prefix}`)[container];
      if (!list) throw new Error(`Listing ${container}: not found`);
      const under = list.filter((x) => x.name.startsWith(prefix));
      const prefixes = [...new Set(under.map((x) => x.name.slice(prefix.length)).filter((n) => n.includes('/')).map((n) => `${prefix}${n.split('/')[0]}/`))].sort();
      const files = under.filter((x) => !x.name.slice(prefix.length).includes('/')).map(({ content: _, ...x }) => ({ ...x }));
      return { prefixes, blobs: files, more: false };
    },
    async readBlob(account, container, name, { signal } = {}) {
      await wait(signal);
      const b = (blobsOf(account, `Reading ${container}/${name}`)[container] ?? []).find((x) => x.name === name);
      if (!b) throw new Error(`Reading ${container}/${name}: not found`);
      return { text: b.content ?? '', type: b.type, partial: false };
    },
    async serviceBusNamespaces(sub, { signal } = {}) {
      await wait(signal);
      return state.serviceBus.filter((n) => n.sub === sub).map(({ sub: _, entities: __, ...n }) => ({ ...n }));
    },
    async serviceBusEntities(ns, { signal } = {}) {
      await wait(signal);
      return busOf(ns).entities.map(({ dead, ...e }) => ({ ...e, deadLetter: dead.length }));
    },
    async peekDeadLetters(ns, entity, { max = 20, signal } = {}) {
      await wait(signal);
      return entityOf(ns, entity).dead.slice(0, max).map((m) => structuredClone(m));
    },
    // A resubmitted dead letter goes back to its queue (a subscription's to its topic, which gives it to every subscription).
    async resubmitDeadLetters(ns, entity, sequences, { signal } = {}) {
      await wait(signal);
      const e = entityOf(ns, entity);
      const want = new Set(sequences.map(String));
      const moving = e.dead.filter((m) => want.has(String(m.sequence)));
      e.dead = e.dead.filter((m) => !want.has(String(m.sequence)));
      const to = entity.kind === 'subscription' ? busOf(ns).entities.filter((x) => x.topic === entity.topic) : [e];
      for (const x of to) x.active += moving.length;
      for (const m of moving) want.delete(String(m.sequence));
      return { moved: moving.length, missing: [...want] };
    },
    async purgeDeadLetters(ns, entity, { signal } = {}) {
      await wait(signal);
      const e = entityOf(ns, entity);
      const n = e.dead.length;
      e.dead = [];
      return n;
    },
    async plan(planId, { signal } = {}) {
      await wait(signal);
      const p = state.plans.find((x) => x.id.toLowerCase() === String(planId).toLowerCase());
      if (!p) throw new Error(`Reading the plan ${String(planId).split('/').pop()}: not found`);
      return structuredClone(p);
    },
    async scalePlan(plan, sku, { signal } = {}) {
      await wait(signal);
      const p = state.plans.find((x) => x.id === plan.id);
      p.sku = { name: sku.name, tier: sku.tier, capacity: sku.capacity };
      return structuredClone(p);
    },
    async autoscaleSettings(sub, { signal } = {}) {
      await wait(signal);
      return state.autoscale.filter((a) => a.sub === sub).map(({ sub: _, ...a }) => structuredClone(a));
    },
    async connectionStrings(target, { signal } = {}) {
      await wait(signal);
      return { ...site(target).connectionStrings };
    },
    async logWorkspaces(sub, { signal } = {}) {
      await wait(signal);
      return state.workspaces.filter((w) => w.sub === sub).map(({ sub: _, ...w }) => ({ ...w }));
    },
    async workspaceTables(ws, { signal } = {}) {
      await wait(signal);
      return structuredClone(WORKSPACE_TABLES);
    },
    async containerApps(sub, { signal } = {}) {
      await wait(signal);
      return state.containers.filter((c) => c.sub === sub).map(({ sub: _, restarts: __, ...c }) => c);
    },
    async restartRevision(app, { signal } = {}) {
      await wait(signal);
      state.containers.find((c) => c.id === app.id).restarts++;
    },
    async containerAppWorkspace(app, { signal } = {}) {
      await wait(signal);
      return { id: 'workspace:ws-prod', workspaceId: 'ws-prod', name: 'contoso-env logs', resourceGroup: app.resourceGroup };
    },
    async storageAccounts(sub, { signal } = {}) {
      await wait(signal);
      return state.storage.filter((a) => a.sub === sub).map(({ sub: _, ...a }) => a);
    },
    async sqlServers(sub, { signal } = {}) {
      await wait(signal);
      return state.sqlServers.filter((x) => x.sub === sub).map(({ sub: _, rules: __, databases: ___, admin: ____, ...x }) => ({ ...x, admin: null, databases: [] }));
    },
    async sqlDatabases(server, { signal } = {}) {
      await wait(signal);
      return sqlServer(server).databases.filter((d) => d.name !== 'master').map((d) => ({ ...d }));
    },
    async sqlAdmin(server, { signal } = {}) {
      await wait(signal);
      return sqlServer(server).admin;
    },
    async firewallRules(server, { signal } = {}) {
      await wait(signal);
      return sqlServer(server).rules.map((r) => ({ ...r }));
    },
    async addFirewallRule(server, { name, start, end }, { signal } = {}) {
      await wait(signal);
      const s = sqlServer(server);
      s.rules = [...s.rules.filter((r) => r.name !== name), { name, start, end: end ?? start }];
    },
    async publicIp() {
      return state.ip;
    },
    async alerts(sub, { span, signal } = {}) {
      await wait(signal);
      const since = new Date(now - span.hours * HOUR).toISOString();
      return state.alerts.filter((a) => a.sub === sub && a.condition === 'Fired' && a.fired >= since).map(({ sub: _, ago: __, ...a }) => a);
    },
    // A few deployments each, the latest active; the one before it failed on the main slots of production.
    async deployments(target, { signal } = {}) {
      await wait(signal);
      const s = site(target);
      const day = 24 * HOUR;
      const list = [
        { name: 'd3', status: 'succeeded', author: 'Ana Silva', deployer: 'GitHub Actions', ago: 3 * day, message: 'Release 2.14.0: the new checkout behind a flag\n\nCommit 9b1c7e2d4f60a8c3e1f2b7d9a5c4e3f2a1b0c9d8', active: true },
        { name: 'd2', status: s.sub === 'sub-prod' && !s.slot ? 'failed' : 'succeeded', author: 'Rui Costa', deployer: 'GitHub Actions', ago: 5 * day, message: 'Release 2.13.1: payments retries' },
        { name: 'd1', status: 'succeeded', author: 'Ana Silva', deployer: 'ZipDeploy', ago: 12 * day, message: 'Release 2.13.0' },
      ];
      return list.map((d) => ({ id: `${s.id}/deployments/${d.name}`, name: d.name, status: d.status, author: d.author, deployer: d.deployer, start: new Date(now - d.ago).toISOString(), end: new Date(now - d.ago + 95_000).toISOString(), message: d.message, active: Boolean(d.active) }));
    },
    async deploymentLog(deployment, { signal } = {}) {
      await wait(signal);
      const failed = deployment.name === 'd2' && /sub-prod/.test(deployment.id) && !/\/slots\//.test(deployment.id);
      const t0 = now - 5 * 24 * HOUR;
      const lines = ['Fetching changes.', 'Updating submodules.', 'Preparing deployment for commit id \'4f2a9c1\'.', 'Running build: npm ci && npm run build', failed ? 'npm ERR! code ELIFECYCLE: the build exited with 1 (tsc found 2 errors)' : 'Build succeeded.', failed ? 'Deployment Failed.' : 'Deployment successful.'];
      return lines.map((message, i) => ({ at: new Date(t0 + i * 15_000).toISOString(), message }));
    },
    // Made-up metrics, the same for the same app and span: busier in production, a few 5xx now and then.
    async metrics(target, { span, signal } = {}) {
      await wait(signal);
      if (target.type === 'container') return containerMetrics(target, span);
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
    // This month's cost: the plans carry most of it, the apps a little (their storage, say), and the
    // databases, container app and storage accounts their own. The dev subscription can't be read.
    async costs(sub, { signal } = {}) {
      await wait(signal);
      if (sub === 'sub-dev') throw new Error("Reading the costs: you don't have access (Cost Management reader)");
      const byId = {};
      const add = (id, cost) => (byId[id.toLowerCase()] = (byId[id.toLowerCase()] ?? 0) + cost);
      for (const s of state.sites.filter((x) => x.sub === sub && !x.slot)) {
        add(s.id, s.kind === 'function' ? 3.12 : 0.41);
        add(s.planId, s.kind === 'function' ? 0 : 61.2);
      }
      for (const x of state.sqlServers.filter((y) => y.sub === sub)) for (const d of x.databases.filter((y) => y.name !== 'master')) add(d.id, d.tier === 'Basic' ? 3.65 : 87.5);
      for (const c of state.containers.filter((y) => y.sub === sub)) add(c.id, 18.04);
      for (const a of state.storage.filter((y) => y.sub === sub)) add(a.id, 4.9);
      return { currency: 'EUR', byId };
    },
    portalUrl: (target) => `https://portal.azure.com/#resource${target.id}`,
  };
}
