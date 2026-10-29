// Running .NET Framework and IIS projects day to day: web.config's databases (webconfig.js), host
// names and /hosts (hosts.js), an application pool's settings and /iis, the warm-up after a start or a
// recycle, Failed Request Tracing, Windows services (service.js) and crash dumps (dumps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { connectionStrings, crewFolders, innerConnection, webConfigDatabases } from '../src/webconfig.js';
import { crewHosts, hostNamesToCheck, hostsNames, hostsPath, resolves, withHosts } from '../src/hosts.js';
import { frebJson, parseFreb, parsePoolSettings, poolRows, parseSiteConfig, iisSpec } from '../src/iis.js';
import { parseScConfig, parseScQuery, scProblem, serviceEventsScript, serviceSpec } from '../src/service.js';
import { dumpEnv, dumpNote, dumpSize, isDumpOf, procdumpArgs, procdumpSays } from '../src/dumps.js';
import { readSpec, specFor } from '../src/crew.js';
import { Supervisor } from '../src/supervisor.js';
import { checkHosts, checkLine, checkServices, gatherFacts, gatherServices, runChecks, toolsOf } from '../src/preflight.js';
import { hosts, iis, whyPrompt } from '../src/actions.js';
import { afterStatus } from '../src/ui/CrewView.jsx';
import { parseStructured } from '../src/structured.js';

const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const temp = () => mkdtempSync(join(tmpdir(), 'bosun-ops-'));
const said = (p) => p.lines.map((l) => l.text).join('\n');
const LONG = 'node -e "setTimeout(() => {}, 60000)"';

test("web.config's connection strings: the databases pre-flight checks and /family hands to Trawl", async () => {
  const xml = `<configuration><connectionStrings>
    <add name="Shop" connectionString="Data Source=db.local,1433;Initial Catalog=Shop;User ID=app;Password=secret" providerName="System.Data.SqlClient" />
    <add name="ShopEntities" connectionString="metadata=res://*/Shop.csdl;provider=System.Data.SqlClient;provider connection string=&quot;data source=.\\SQLEXPRESS;initial catalog=ShopEf;integrated security=True&quot;" providerName="System.Data.EntityClient" />
    <add name="Broken" />
  </connectionStrings></configuration>`;
  assert.deepEqual(connectionStrings(xml).map((c) => c.name), ['Shop', 'ShopEntities']);
  assert.equal(innerConnection(connectionStrings(xml)[1].connectionString), 'data source=.\\SQLEXPRESS;initial catalog=ShopEf;integrated security=True');
  assert.deepEqual(connectionStrings('<configuration />'), []);

  const dir = temp();
  mkdirSync(join(dir, 'Shop.Web'));
  writeFileSync(join(dir, 'Shop.Web', 'Web.config'), xml);
  writeFileSync(join(dir, 'App.config'), '<configuration><connectionStrings><add name="Jobs" connectionString="Server=jobs.local;Database=Jobs;Trusted_Connection=True" /></connectionStrings></configuration>');
  const crew = { procs: [{ name: 'shop', cwd: 'Shop.Web' }, { name: 'jobs', cwd: '.' }] };
  assert.deepEqual(crewFolders(crew), ['.', 'Shop.Web', '.']);
  const dbs = webConfigDatabases(dir, crewFolders(crew));
  assert.deepEqual(dbs.map((d) => [d.name, d.source.toLowerCase(), d.server, d.port ?? null, d.database]), [
    ['Jobs', 'app.config', 'jobs.local', null, 'Jobs'],
    ['Shop', 'shop.web/web.config', 'db.local', 1433, 'Shop'],
    ['ShopEntities', 'shop.web/web.config', '.\\SQLEXPRESS', null, 'ShopEf'],
  ]);

  const facts = await gatherFacts(dir, crew, { part: 'rest', tcp: async (host) => host === 'db.local', run: async () => ({ stdout: '' }), resolveHost: async () => true });
  assert.deepEqual(facts.databases.map((d) => [d.name, d.reachable]), [['Jobs', false], ['Shop', true], ['ShopEntities', null]]);
});

test('host names: the hosts file read and added to, the crew\'s names, the check and /hosts', async () => {
  assert.equal(hostsPath('win32', { SystemRoot: 'C:\\Windows' }), join('C:\\Windows', 'System32', 'drivers', 'etc', 'hosts'));
  assert.equal(hostsPath('linux'), '/etc/hosts');
  assert.deepEqual([...hostsNames('127.0.0.1 localhost\n# 10.0.0.1 old.local\n127.0.0.1\tShop.local www.shop.local # mine\n')], ['localhost', 'shop.local', 'www.shop.local']);
  assert.deepEqual(hostNamesToCheck(['shop.local', 'localhost', 'api.localhost', '127.0.0.1', '::1', 'Shop.Local', null]), ['shop.local']);
  assert.equal(withHosts('127.0.0.1 localhost\r\n', ['shop.local', 'admin.local']), '127.0.0.1 localhost\r\n\r\n# Added by Bosun for this project\'s crew\r\n127.0.0.1\tshop.local\r\n127.0.0.1\tadmin.local\r\n');
  assert.equal(withHosts('', ['a.local']), "\n# Added by Bosun for this project's crew\n127.0.0.1\ta.local\n");
  const procs = [{ name: 'web', host: 'shop.local' }, { name: 'shop', iis: { site: 'Shop' } }, { name: 'api', host: 'localhost' }];
  assert.deepEqual(crewHosts(procs, (p) => (p.name === 'shop' ? [{ host: 'SHOP.local' }, { host: 'admin.local' }, { host: null }] : [])), [{ proc: 'web', host: 'shop.local' }, { proc: 'shop', host: 'admin.local' }]);
  assert.equal(await resolves('x', { find: async () => ({}) }), true);
  assert.equal(await resolves('x', { find: async () => Promise.reject(new Error('ENOTFOUND')) }), false);
  assert.equal(await resolves('x', { find: () => new Promise(() => {}), timeout: 20 }), false);
  assert.deepEqual(checkHosts([{ proc: 'web', host: 'shop.local', found: false }]).map(checkLine), ["✗ shop.local isn't found, and web answers to it — /hosts adds it to the hosts file (as an administrator)"]);

  const facts = await gatherFacts(temp(), { procs: [{ name: 'web', run: 'x', host: 'shop.local' }, { name: 'api', run: 'y', host: 'api.local' }] }, { part: 'hosts', resolveHost: async (h) => h === 'api.local' });
  assert.deepEqual(facts, { hosts: [{ proc: 'web', host: 'shop.local', found: false }, { proc: 'api', host: 'api.local', found: true }] });

  // /hosts: asks, then adds what's missing; a hosts file it can't write says what to do.
  const notes = [];
  let file = '127.0.0.1 localhost\n';
  let asked = null;
  const ctx = {
    data: {},
    task: async (title, job) => ({ ok: true, ...(await job()) }),
    gatherFacts: async (opts) => (assert.equal(opts.part, 'hosts'), facts),
    hostsFile: { path: '/etc/hosts', read: () => file, write: (f, t) => (file = t) },
    confirm: async (q) => ((asked = q.title), true),
    note: (t, k) => notes.push([t, k]),
  };
  await hosts(ctx);
  assert.equal(asked, 'Add shop.local to /etc/hosts, as 127.0.0.1?');
  assert.match(file, /127\.0\.0\.1\tshop\.local\n$/);
  assert.deepEqual(notes.at(-1), ['Added shop.local to /etc/hosts.', 'ok']);
  // Listed now, though this machine still doesn't find it: nothing to add.
  await hosts(ctx);
  assert.match(notes.at(-1)[0], /^This machine finds every host name/);
  ctx.hostsFile = {
    path: '/etc/hosts',
    read: () => '',
    write: () => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    },
  };
  await hosts(ctx);
  assert.match(notes.at(-1)[0], /^Writing \/etc\/hosts takes an administrator: .* 127\.0\.0\.1 shop\.local$/);
});

const POOL_TEXT = `APPPOOL
  APPPOOL.NAME:"Shop"
  state:"Started"
  [add]
    name:"Shop"
    enable32BitAppOnWin64:"false"
    managedRuntimeVersion:"v4.0"
    managedPipelineMode:"Integrated"
    startMode:"OnDemand"
    [processModel]
      identityType:"ApplicationPoolIdentity"
      idleTimeout:"00:20:00"
      maxProcesses:"1"
    [recycling]
      disallowOverlappingRotation:"false"
      [periodicRestart]
        time:"1.05:00:00"
        [schedule]
    [failure]
      rapidFailProtection:"true"
`;

test("/iis: an application pool's settings, each set for development with ↵", async () => {
  const s = parsePoolSettings(POOL_TEXT);
  assert.equal(s['processModel.idleTimeout'], '00:20:00');
  assert.equal(s['recycling.periodicRestart.time'], '1.05:00:00');
  assert.equal(s['failure.rapidFailProtection'], 'true');
  assert.equal(s.startMode, 'OnDemand');
  assert.equal(s['recycling.disallowOverlappingRotation'], 'false');
  const rows = poolRows(s);
  assert.deepEqual(rows.map((r) => [r.label, r.value, r.next ?? null]), [
    ['Idle timeout', '00:20:00', '00:00:00'],
    ['Start mode', 'OnDemand', 'AlwaysRunning'],
    ['Recycle every', '1.05:00:00', '00:00:00'],
    ['Rapid-fail protection', 'true', 'false'],
    ['32-bit', 'false', 'true'],
    ['.NET CLR', 'v4.0', null],
    ['Pipeline', 'Integrated', null],
    ['Identity', 'ApplicationPoolIdentity', null],
    ['Workers', '1', null],
  ]);
  assert.equal(poolRows({ ...s, 'processModel.idleTimeout': '00:00:00' })[0].next, '00:20:00');

  const sets = [];
  const control = { poolOf: async () => 'Shop', poolSettings: async () => s, setPool: async (pool, key, value) => sets.push([pool, key, value]) };
  const pickers = [];
  const notes = [];
  const shop = { name: 'shop', spec: { iis: { site: 'Shop', pool: null } } };
  const ctx = { crew: { list: () => [shop, { name: 'web', spec: {} }], iisControl: () => control }, showPicker: (p) => pickers.push(p), note: (t, k) => notes.push([t, k]) };
  await iis(ctx, '');
  const items = await pickers[0].load();
  assert.equal(pickers[0].title, "Shop's application pool");
  assert.equal(items.length, 9);
  await pickers[0].onPick(items[0]);
  assert.deepEqual(sets, [['Shop', 'processModel.idleTimeout', '00:00:00']]);
  assert.deepEqual(notes.at(-1), ["Shop's idle timeout is 00:00:00 now.", 'ok']);
  assert.equal(pickers.length, 2, 'shown again, with the new value');
  await pickers[0].onPick(items[5]);
  assert.match(notes.at(-1)[0], /^\.NET CLR is only shown here/);
  await iis(ctx, 'web');
  assert.match(notes.at(-1)[0], /^web isn't one of the crew's IIS sites: shop\./);
  await iis({ crew: { list: () => [] }, note: (t) => notes.push([t]) });
  assert.match(notes.at(-1)[0], /^The crew has no IIS site/);
});

/** A fake IIS with one site on `port`, its pool's worker changing on a recycle. */
function fakeIis({ port, freb = null, siteState = 'Stopped' } = {}) {
  const calls = [];
  const state = { site: siteState, pool: siteState, workers: siteState === 'Started' ? [11] : [] };
  return {
    calls,
    state,
    control: {
      site: async () => ({ name: 'Shop', id: 3, state: state.site, bindings: [{ scheme: 'http', ip: null, port, host: null }], physicalPath: null, logDir: null, freb }),
      pool: async () => ({ name: 'Shop', state: state.pool, runtime: 'v4.0' }),
      poolOf: async () => 'Shop',
      shared: async () => false,
      workers: async () => state.workers,
      startPool: async () => ((state.pool = 'Started'), (state.workers = [11])),
      startSite: async () => (state.site = 'Started'),
      stopSite: async () => (calls.push('stop site'), (state.site = 'Stopped')),
      stopPool: async () => ((state.pool = 'Stopped'), (state.workers = [])),
      recycle: async () => (calls.push('recycle'), (state.workers = [12])),
      failedRequests: async (site, on) => calls.push(`trace ${site} ${on}`),
      failedRequestsOffNow: (site) => calls.push(`trace off now ${site}`),
      stopNow: () => calls.push('stop now'),
    },
  };
}

test('a site is asked for as soon as it starts or recycles, and says how long it took; much slower is marked', async () => {
  let answers = [503, 503, 200];
  const server = createServer((req, res) => {
    res.statusCode = answers.length > 1 ? answers.shift() : answers[0];
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const fake = fakeIis({ port });
  const sup = new Supervisor(readSpec({ procs: { shop: { iis: 'Shop', health: '/health' } } }).procs, { dir: temp(), iis: fake.control, iisTimes: { every: 20 } });
  const p = sup.get('shop');
  sup.start('shop');
  await until(() => /── ready [\d.]+s after it started \(\/health 200\)/.test(said(p)), 'the warm-up');
  assert.equal(p.warmups.length, 1);
  // Its usual is a tenth of a second: a recycle that takes over a second more is slow.
  p.warmups = [100, 100, 100];
  answers = [503, 503, 503, 503, 503, 503, 200];
  const realFetch = sup.fetchImpl;
  sup.fetchImpl = async (url, opts) => {
    await new Promise((r) => setTimeout(r, 200));
    return realFetch(url, opts);
  };
  await sup.restart('shop');
  await until(() => /── ready [\d.]+s after it recycled \(\/health 200\): slower than its usual 0\.1s/.test(said(p)), 'the slow warm-up');
  assert.equal(p.warm.slow, true);
  assert.match(afterStatus(p).text, /slow [\d.]+s$/);
  sup.killAllNow();
  sup.dispose();
  server.close();
});

const FREB = `<?xml version="1.0" encoding="UTF-8"?>
<failedRequest url="http://localhost:80/orders?id=3" siteId="3" appPoolId="Shop" processId="4120" verb="GET" remoteUserName="" userName="" tokenUserName="IIS APPPOOL\\Shop" authenticationType="anonymous" activityId="{8000}" failureReason="STATUS_CODE" statusCode="500.19" triggerStatusCode="500" timeTaken="16" xmlns:freb="http://schemas.microsoft.com/win/2006/06/iis/freb">
 <Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System><Provider Name="WWW Server"/><EventID>0</EventID><Level>4</Level><TimeCreated SystemTime="2026-10-29T14:03:07.120Z"/></System>
  <EventData><Data Name="ContextId">{8000}</Data></EventData>
  <RenderingInfo Culture="en-US"><Opcode>GENERAL_REQUEST_START</Opcode></RenderingInfo>
 </Event>
 <Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System><Provider Name="WWW Server"/><Level>3</Level><TimeCreated SystemTime="2026-10-29T14:03:07.130Z"/></System>
  <EventData><Data Name="ErrorMessage">Cannot read configuration file due to insufficient permissions</Data></EventData>
  <RenderingInfo Culture="en-US"><Opcode>CONFIG_CHANGE_NOTIFICATION_ERROR</Opcode></RenderingInfo>
 </Event>
 <Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event">
  <System><Provider Name="WWW Server"/><Level>3</Level><TimeCreated SystemTime="2026-10-29T14:03:07.136Z"/></System>
  <EventData><Data Name="ModuleName">IIS Web Core</Data><Data Name="Notification">1</Data><Data Name="HttpStatus">500</Data><Data Name="HttpReason">Internal Server Error</Data><Data Name="HttpSubStatus">19</Data><Data Name="ErrorCode">2147942405</Data></EventData>
  <RenderingInfo Culture="en-US"><Opcode>MODULE_SET_RESPONSE_ERROR_STATUS</Opcode><freb:Description Data="Notification">BEGIN_REQUEST</freb:Description><freb:Description Data="ErrorCode">Access is denied.&#x0D;
 (0x80070005)</freb:Description></RenderingInfo>
 </Event>
</failedRequest>`;

test('Failed Request Tracing: turned on for the site, each trace read into its log, turned off again', async () => {
  const f = parseFreb(FREB);
  assert.deepEqual(f, { time: Date.parse('2026-10-29T14:03:07.120Z'), url: 'http://localhost:80/orders?id=3', path: '/orders?id=3', verb: 'GET', status: '500.19', ms: 16, module: 'IIS Web Core', notification: 'BEGIN_REQUEST', reason: 'Internal Server Error', error: 'Access is denied. (0x80070005)', warnings: ['CONFIG_CHANGE_NOTIFICATION_ERROR: Cannot read configuration file due to insufficient permissions'] });
  assert.equal(parseFreb(FREB.replace('</failedRequest>', '')), null, 'one still being written');
  const line = parseStructured(frebJson(f, 'fr000001.xml'));
  assert.equal(line.level, 'error');
  assert.equal(line.message, 'failed request GET /orders?id=3 500.19 in 16ms: IIS Web Core (BEGIN_REQUEST) Internal Server Error');
  assert.deepEqual(parseSiteConfig('<site name="Shop" id="3"><traceFailedRequestsLogging enabled="true" directory="D:\\freb" /></site>').freb, { enabled: true, directory: 'D:\\freb' });
  assert.deepEqual(iisSpec({ site: 'Shop', failedRequests: true }).failedRequests, true);
  assert.equal(iisSpec({ site: 'Shop', failedRequests: 'yes' }), null);
  assert.deepEqual(specFor({ procs: readSpec({ procs: { shop: { iis: { site: 'Shop', failedRequests: true } } } }).procs, profiles: {} }).procs.shop, { iis: { site: 'Shop', failedRequests: true } });

  const frebDir = temp();
  mkdirSync(join(frebDir, 'W3SVC3'));
  writeFileSync(join(frebDir, 'W3SVC3', 'fr000001.xml'), FREB.replace('/orders', '/old'));
  const fake = fakeIis({ freb: { enabled: false, directory: frebDir } });
  const sup = new Supervisor(readSpec({ procs: { shop: { iis: { site: 'Shop', failedRequests: true } } } }).procs, { dir: temp(), iis: fake.control, iisTimes: { every: 20 } });
  const p = sup.get('shop');
  sup.start('shop');
  await until(() => p.status === 'running' && /Failed Request Tracing is on/.test(said(p)), 'tracing on');
  assert.deepEqual(fake.calls, ['trace Shop true']);
  writeFileSync(join(frebDir, 'W3SVC3', 'fr000002.xml'), FREB);
  await until(() => /failed request GET \/orders\?id=3 500\.19/.test(said(p)), 'the trace');
  assert.doesNotMatch(said(p), /\/old/, 'traces there before it started are left');
  await sup.stop('shop');
  assert.deepEqual(fake.calls, ['trace Shop true', 'trace Shop false', 'stop site']);
  sup.dispose();

  // Already on before Bosun: left on.
  const on = fakeIis({ freb: { enabled: true, directory: frebDir } });
  const b = new Supervisor(readSpec({ procs: { shop: { iis: { site: 'Shop', failedRequests: true } } } }).procs, { dir: temp(), iis: on.control, iisTimes: { every: 20 } });
  b.start('shop');
  await until(() => b.get('shop').status === 'running', 'the site');
  b.killAllNow();
  assert.deepEqual(on.calls, ['trace Shop true', 'stop now']);
  b.dispose();
});

const QUERY = (state, pid = 0, exit = 0) => `
SERVICE_NAME: MSSQL$SQLEXPRESS
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : ${state === 'RUNNING' ? 4 : state === 'STOPPED' ? 1 : 2}  ${state}
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
        WIN32_EXIT_CODE    : ${exit}  (0x0)
        SERVICE_EXIT_CODE  : 0  (0x0)
        CHECKPOINT         : 0x0
        WAIT_HINT          : 0x0
        PID                : ${pid}
        FLAGS              :
`;

test('Windows services: sc read, the events script, bosun.json\'s "service" and pre-flight', async () => {
  assert.deepEqual(parseScQuery(QUERY('RUNNING', 4321)), { name: 'MSSQL$SQLEXPRESS', state: 'RUNNING', pid: 4321, exitCode: 0, serviceExitCode: 0 });
  assert.equal(parseScQuery(QUERY('STOPPED')).pid, null);
  assert.equal(parseScQuery('[SC] EnumQueryServicesStatus:OpenService FAILED 1060:'), null);
  assert.deepEqual(parseScConfig('[SC] QueryServiceConfig SUCCESS\n\nSERVICE_NAME: MSSQL$SQLEXPRESS\n        START_TYPE         : 3   DEMAND_START\n        BINARY_PATH_NAME   : "C:\\sql\\sqlservr.exe" -sSQLEXPRESS\n        DISPLAY_NAME       : SQL Server (SQLEXPRESS)\n'), { displayName: 'SQL Server (SQLEXPRESS)', startType: 'DEMAND_START', binary: '"C:\\sql\\sqlservr.exe" -sSQLEXPRESS' });
  assert.match(scProblem({ stdout: '[SC] StartService: OpenService FAILED 5:\n\nAccess is denied.' }), /needs an administrator/);
  assert.match(scProblem({ stdout: '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:' }), /no such service/);
  assert.match(scProblem({ stdout: '[SC] StartService FAILED 1058:' }), /disabled/);
  assert.match(serviceEventsScript(0, "it's", "It's Display"), /ProviderName -eq 'it''s' -or \(\$_\.ProviderName -eq 'Service Control Manager' -and \$_\.Message -like '\*It''s Display\*'\)/);
  assert.equal(serviceSpec('MSSQL$SQLEXPRESS'), 'MSSQL$SQLEXPRESS');
  assert.equal(serviceSpec('a"b'), null);

  const { procs, problems } = readSpec({ procs: { sql: { service: 'MSSQL$SQLEXPRESS', port: 1433, dump: true }, both: { service: 'x', run: 'y' }, bad: { service: 3 }, d: { run: 'x', dump: 'yes' } } });
  assert.deepEqual(problems, ['"both": it has "service" and "run": Windows runs the service, so it has no command of its own', '"bad": "service" is a Windows service\'s name, as sc query shows it ("MSSQL$SQLEXPRESS")', '"d": "dump" is true or false']);
  assert.deepEqual(procs.map((p) => [p.name, p.run, p.service, p.dump]), [['sql', 'sc start "MSSQL$SQLEXPRESS"', 'MSSQL$SQLEXPRESS', true]]);
  assert.deepEqual(specFor({ procs, profiles: {} }).procs.sql, { service: 'MSSQL$SQLEXPRESS', dump: true, port: 1433 });

  const control = { query: async (n) => (n === 'Gone' ? null : parseScQuery(QUERY('STOPPED'))), config: async (n) => (n === 'Off' ? { startType: 'DISABLED' } : { displayName: 'SQL Server (SQLEXPRESS)', startType: 'DEMAND_START' }) };
  const facts = await gatherServices([{ name: 'sql', service: 'MSSQL$SQLEXPRESS' }, { name: 'gone', service: 'Gone' }, { name: 'off', service: 'Off' }], { platform: 'win32', run: async () => Promise.reject(new Error('denied')), services: control });
  assert.deepEqual(checkServices(facts).map(checkLine), [
    "✗ The terminal isn't an administrator's — Windows starts and stops services only for an administrator: start the terminal as administrator, or run Bosun through gsudo",
    '✓ SQL Server (SQLEXPRESS) is there (stopped)',
    '✗ There\'s no service "Gone" (gone) — install it, or fix its "service" in bosun.json (sc query lists them)',
    '✗ Off is disabled (off) — sc config "Off" start= demand',
  ]);
  assert.equal(checkServices(facts, { adminSaid: true }).length, 3);
  assert.deepEqual(checkServices({ platform: 'linux', list: [{ proc: 'sql' }] }).map((c) => c.title), ['Windows services run only on Windows']);
  assert.deepEqual(runChecks({ services: facts }).length, 4);
});

/** A fake service manager: one service, which starts, stops, and can stop by itself. */
function fakeServices(initial = 'STOPPED') {
  const calls = [];
  const state = { state: initial, pid: initial === 'RUNNING' ? 77 : 0, exit: 0 };
  return {
    calls,
    state,
    control: {
      query: async (n) => (n === 'Gone' ? null : parseScQuery(QUERY(state.state, state.pid, state.exit))),
      config: async () => ({ displayName: 'SQL Server (SQLEXPRESS)', startType: 'DEMAND_START' }),
      start: async (n) => {
        calls.push(`start ${n}`);
        Object.assign(state, { state: 'RUNNING', pid: 4321 });
      },
      stop: async (n) => {
        calls.push(`stop ${n}`);
        Object.assign(state, { state: 'STOPPED', pid: 0 });
      },
      stopNow: (n) => calls.push(`stop now ${n}`),
      events: async () => [{ time: Date.now(), level: 'error', source: 'MSSQL$SQLEXPRESS', id: 17058, message: 'initerrlog: Could not open error log file' }],
    },
  };
}

test('a Windows service as a process: started, its process followed, stopped; one that stops by itself crashed', async () => {
  const fake = fakeServices();
  const crew = readSpec({ procs: { sql: { service: 'MSSQL$SQLEXPRESS' }, gone: { service: 'Gone' } } }).procs;
  const sup = new Supervisor(crew, { dir: temp(), services: fake.control, iisTimes: { every: 20, eventsEvery: 60_000 } });
  const p = sup.get('sql');
  sup.start('sql');
  await until(() => p.status === 'running' && p.pid === 4321, 'the service');
  assert.match(said(p), /── sc start "MSSQL\$SQLEXPRESS"\n── started SQL Server \(SQLEXPRESS\) \(MSSQL\$SQLEXPRESS\)/);
  await sup.restart('sql');
  await until(() => fake.calls.length === 3, 'started again');
  assert.deepEqual(fake.calls, ['start MSSQL$SQLEXPRESS', 'stop MSSQL$SQLEXPRESS', 'start MSSQL$SQLEXPRESS']);
  await until(() => p.pid === 4321 && p.status === 'running', 'started again');
  // It stops by itself: a crash, with the event log's say.
  Object.assign(fake.state, { state: 'STOPPED', pid: 0, exit: 1067 });
  await until(() => p.status === 'crashed', 'the crash');
  assert.match(said(p), /stopped by itself \(exit 1067\)[\s\S]*Could not open error log file/);
  sup.start('gone');
  await until(() => sup.get('gone').status === 'crashed', 'the missing one');
  assert.match(said(sup.get('gone')), /no such service/);
  sup.dispose();

  const running = fakeServices('RUNNING');
  const b = new Supervisor(crew, { dir: temp(), services: running.control, iisTimes: { every: 20, eventsEvery: 60_000 } });
  b.start('sql');
  await until(() => b.get('sql').pid === 77, 'the running service');
  assert.match(said(b.get('sql')), /already running: Bosun leaves it running when it quits/);
  b.killAllNow();
  assert.deepEqual(running.calls, []);
  b.dispose();
});

test('crash dumps: .NET told to write its own, ProcDump on an IIS worker, each new dump said', async () => {
  const env = dumpEnv('/dumps', 'api');
  assert.equal(env.DOTNET_DbgEnableMiniDump, '1');
  assert.equal(env.DOTNET_DbgMiniDumpType, '4');
  assert.equal(env.COMPlus_DbgMiniDumpName, join('/dumps', 'api.%e.%p.%t.dmp'));
  assert.deepEqual(procdumpArgs(4120, '/dumps', 'shop'), ['-accepteula', '-ma', '-e', '4120', join('/dumps', 'shop_PROCESSNAME_PID_YYMMDD_HHMMSS.dmp')]);
  assert.equal(isDumpOf('api.dotnet.4120.1761746587.dmp', 'api'), true);
  assert.equal(isDumpOf('shop_w3wp.exe_4120_261029_140307.dmp', 'shop'), true);
  assert.equal(isDumpOf('api2.x.dmp', 'api'), false);
  assert.equal(isDumpOf('api.log', 'api'), false);
  assert.equal(procdumpSays('[14:03:07] Dump 1 initiated: C:\\dumps\\x.dmp'), true);
  assert.equal(procdumpSays('ProcDump v11.0 - Sysinternals process dump utility'), false);
  assert.equal(dumpSize(5 * 1024 ** 3), '5.0 GB');
  assert.match(dumpNote('/d/x.dmp', 300 * 1024 ** 2), /^── crash dump written: \/d\/x\.dmp \(300 MB\): open it with dotnet-dump analyze/);

  // A command: the settings in its environment, and a dump that appears is said.
  const folder = temp();
  const sup = new Supervisor(readSpec({ procs: { api: { run: 'node -e "console.log(process.env.DOTNET_DbgEnableMiniDump, process.env.DOTNET_DbgMiniDumpName); setTimeout(() => {}, 60000)"', dump: true } } }).procs, { dir: temp(), dumpDir: folder, dumpEvery: 20 });
  const p = sup.get('api');
  sup.start('api');
  await until(() => /^1 .*api\.%e\.%p\.%t\.dmp$/m.test(said(p)), 'the settings');
  writeFileSync(join(folder, 'api.dotnet.99.1.dmp'), 'x'.repeat(2048));
  writeFileSync(join(folder, 'other.dotnet.99.1.dmp'), 'x');
  await until(() => /crash dump written: .*api\.dotnet\.99\.1\.dmp \(1 MB\)/.test(said(p)), 'the dump');
  assert.doesNotMatch(said(p), /other\.dotnet/);
  assert.match(whyPrompt(p), /A crash dump of it was written to .*api\.dotnet\.99\.1\.dmp/);
  await sup.stopAll();
  sup.dispose();

  // An IIS site: ProcDump on its worker, again on the new one after a recycle.
  const spawned = [];
  const procdumpSpawn = (file, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), file, args, pid: null });
    child.kill = () => ((child.killed = true), child.emit('close', null));
    spawned.push(child);
    return child;
  };
  const fake = fakeIis({ port: 1 });
  const site = new Supervisor(readSpec({ procs: { shop: { iis: 'Shop', dump: true } } }).procs, { dir: temp(), iis: fake.control, iisTimes: { every: 20 }, dumpDir: temp(), procdumpSpawn, findTool: (n) => (n === 'procdump64' ? 'C:\\tools\\procdump64.exe' : null), warmWait: 1 });
  site.start('shop');
  await until(() => spawned.length === 1, 'ProcDump');
  assert.equal(spawned[0].file, 'C:\\tools\\procdump64.exe');
  assert.equal(spawned[0].args[3], '11');
  spawned[0].stdout.write('[14:03:07] Dump 1 initiated: C:\\dumps\\shop_w3wp.exe_11.dmp\nnoise\n');
  await until(() => /── procdump: \[14:03:07\] Dump 1 initiated/.test(said(site.get('shop'))), 'its line');
  assert.doesNotMatch(said(site.get('shop')), /noise/);
  await site.restart('shop');
  await until(() => spawned.length === 2, 'ProcDump on the new worker');
  assert.equal(spawned[0].killed, true);
  assert.equal(spawned[1].args[3], '12');
  site.killAllNow();
  assert.equal(spawned[1].killed, true);
  site.dispose();

  // Without ProcDump: said once.
  const none = new Supervisor(readSpec({ procs: { shop: { iis: 'Shop', dump: true } } }).procs, { dir: temp(), iis: fakeIis({ port: 1 }).control, iisTimes: { every: 20 }, dumpDir: temp(), findTool: () => null, warmWait: 1 });
  none.start('shop');
  await until(() => /"dump" needs ProcDump on the PATH for an IIS site: winget install Microsoft\.Sysinternals\.ProcDump/.test(said(none.get('shop'))), 'the hint');
  none.killAllNow();
  none.dispose();

  assert.deepEqual(toolsOf([{ name: 'shop', run: 'x', iis: { site: 'Shop' }, dump: true }, { name: 'api', run: 'node a', dump: true }], { platform: 'win32', which: (n) => (n === 'procdump' ? 'C:\\procdump.exe' : null) }), [{ tool: 'procdump', procs: ['shop'], found: true }]);
});
