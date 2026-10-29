// IIS sites and .NET projects: appcmd's output and IIS's logs read (iis.js), log files followed
// (tail.js), a site run by the supervisor through a fake appcmd, the health check's host, /free with
// http.sys's port, the IIS pre-flight, and the crew worked out from .NET projects (dotnet.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appcmdProblem, bindingUrl, eventIsSite, frameworkCovers, frameworkOfRelease, iisControl, iisSpec, mainBinding, parseAppcmd, parseBindings, parseEvents, parseSiteConfig, w3cFields, w3cJson, webConfigFacts } from '../src/iis.js';
import { cutLines, logPattern, newest, tailLogs } from '../src/tail.js';
import { loadCrew, readSpec, specFor } from '../src/crew.js';
import { Supervisor, httpStatus } from '../src/supervisor.js';
import { checkIis, checkLine, checkPorts, checkTools, gatherIis, toolsOf } from '../src/preflight.js';
import { dotnetCrew, iisExpressPort, launchProfile, procName, projectKind, within } from '../src/dotnet.js';
import { free, procUrl } from '../src/actions.js';
import { parseFilter, passes, parseStructured } from '../src/structured.js';

const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const temp = () => mkdtempSync(join(tmpdir(), 'bosun-iis-'));
const said = (p) => p.lines.map((l) => l.text).join('\n');

test('appcmd: its list lines, bindings, a site\'s config and what it says when it fails', () => {
  const sites = parseAppcmd('SITE "Default Web Site" (id:1,bindings:http/*:80:,net.tcp/808:*,https/*:443:shop.local,state:Started)\r\nSITE "Shop" (id:2,bindings:http/127.0.0.1:8080:shop.local,state:Stopped)\n');
  assert.deepEqual(sites.map((s) => [s.kind, s.name, s.attrs.id, s.attrs.state]), [['SITE', 'Default Web Site', '1', 'Started'], ['SITE', 'Shop', '2', 'Stopped']]);
  assert.equal(sites[0].attrs.bindings, 'http/*:80:,net.tcp/808:*,https/*:443:shop.local');
  assert.deepEqual(parseBindings(sites[0].attrs.bindings), [{ scheme: 'http', ip: null, port: 80, host: null }, { scheme: 'https', ip: null, port: 443, host: 'shop.local' }]);
  assert.deepEqual(mainBinding(parseBindings('https/*:443:shop.local,http/*:80:,http/*:80:shop.local')), { scheme: 'http', ip: null, port: 80, host: 'shop.local' });
  assert.equal(mainBinding([]), null);
  assert.equal(bindingUrl({ scheme: 'http', port: 80, host: 'shop.local' }), 'http://shop.local');
  assert.equal(bindingUrl({ scheme: 'https', port: 4443, host: null, ip: null }), 'https://localhost:4443');
  assert.equal(bindingUrl({ scheme: 'http', port: 8080, host: null, ip: '10.0.0.5' }), 'http://10.0.0.5:8080');
  assert.deepEqual(parseAppcmd('APPPOOL "Shop" (MgdVersion:v4.0,MgdMode:Integrated,state:Started)')[0].attrs, { MgdVersion: 'v4.0', MgdMode: 'Integrated', state: 'Started' });
  assert.deepEqual(parseAppcmd('WP "4120" (applicationPool:Shop)')[0], { kind: 'WP', name: '4120', attrs: { applicationPool: 'Shop' } });
  const config = parseSiteConfig(`<site name="Shop" id="2" serverAutoStart="true">
    <application path="/admin" applicationPool="Admin"><virtualDirectory path="/" physicalPath="C:\\admin" /></application>
    <application path="/" applicationPool="Shop"><virtualDirectory path="/" physicalPath="%SystemDrive%\\src\\shop" /></application>
    <logFile directory="D:\\logs" /></site>`);
  assert.deepEqual(config, { id: 2, name: 'Shop', physicalPath: '%SystemDrive%\\src\\shop', logDir: 'D:\\logs', freb: { enabled: false, directory: null } });
  assert.equal(appcmdProblem({ stdout: 'ERROR ( hresult:80070005, message:Command execution failed.\nAccess is denied. )' }), 'IIS needs an administrator: start the terminal as administrator (or run Bosun through gsudo)');
  assert.match(appcmdProblem({ code: 'ENOENT' }), /IIS isn't installed/);
  assert.equal(appcmdProblem({ stdout: 'ERROR ( message:Cannot find SITE object with identifier "Nope". )' }), 'Cannot find SITE object with identifier "Nope".');
});

test('the iis control runs appcmd with the right words, and reads what it says', async () => {
  const runs = [];
  const out = {
    'list site Shop': 'SITE "Shop" (id:2,bindings:http/*:8080:,state:Started)',
    'list site Shop /config': '<site name="Shop" id="2"><application path="/"><virtualDirectory path="/" physicalPath="%SystemDrive%\\shop" /></application></site>',
    'list apppool Shop': 'APPPOOL "Shop" (MgdVersion:,MgdMode:Integrated,state:Started)',
    'list app': 'APP "Default Web Site/" (applicationPool:DefaultAppPool)\nAPP "Shop/" (applicationPool:Shop)\nAPP "Shop/api" (applicationPool:Shop)\nAPP "Blog/" (applicationPool:DefaultAppPool)',
    'list wp': 'WP "4120" (applicationPool:Shop)\nWP "77" (applicationPool:DefaultAppPool)',
    'list vdir': 'VDIR "Shop/" (physicalPath:%SystemDrive%\\shop)\nVDIR "Shop/api/" (physicalPath:C:\\api)',
  };
  const exec = async (args) => {
    runs.push(args.join(' '));
    const key = args.join(' ');
    if (key === 'list site Nope') throw Object.assign(new Error('failed'), { stdout: 'ERROR ( message:Cannot find SITE object with identifier "Nope". )' });
    if (key === 'start site Shop') throw Object.assign(new Error('failed'), { stdout: 'ERROR ( message:Site "Shop" is already started. )' });
    if (key === 'list apppool Locked') throw Object.assign(new Error('failed'), { stdout: 'ERROR ( hresult:80070005, message:Access is denied. )' });
    return out[key] ?? '';
  };
  const iis = iisControl({ exec, env: { SystemDrive: 'C:', windir: 'C:\\Windows' } });
  const site = await iis.site('Shop');
  assert.deepEqual(site, { name: 'Shop', id: 2, state: 'Started', bindings: [{ scheme: 'http', ip: null, port: 8080, host: null }], physicalPath: 'C:\\shop', logDir: 'C:\\inetpub\\logs\\LogFiles', freb: { enabled: false, directory: 'C:\\inetpub\\logs\\FailedReqLogFiles' } });
  assert.equal(await iis.site('Nope'), null);
  assert.deepEqual(await iis.pool('Shop'), { name: 'Shop', state: 'Started', runtime: '', mode: 'Integrated' });
  await assert.rejects(iis.pool('Locked'), (e) => /Access is denied/.test(e.stdout));
  assert.equal(await iis.poolOf('shop'), 'Shop');
  assert.equal(await iis.shared('Shop', 'Shop'), false);
  assert.equal(await iis.shared('DefaultAppPool', 'Blog'), true);
  assert.deepEqual(await iis.workers('Shop'), [4120]);
  assert.deepEqual(await iis.vdirs(), [{ site: 'Shop', path: '/', physicalPath: 'C:\\shop' }, { site: 'Shop', path: '/api/', physicalPath: 'C:\\api' }]);
  await iis.startSite('Shop');
  await iis.recycle('Shop');
  assert.ok(runs.includes('recycle apppool Shop'));
});

test('web.config, the .NET Framework installed, and bosun.json\'s "iis"', () => {
  assert.deepEqual(webConfigFacts('<configuration><system.webServer><aspNetCore processPath="dotnet" arguments=".\\Shop.dll" stdoutLogEnabled="true" stdoutLogFile=".\\logs\\stdout" hostingModel="InProcess" /></system.webServer></configuration>'), { core: true, hostingModel: 'inprocess', stdoutLog: true, stdoutFile: '.\\logs\\stdout', framework: null, customErrors: null });
  assert.deepEqual(webConfigFacts('<configuration><system.web><compilation debug="true" targetFramework="4.7.2" /><httpRuntime targetFramework="4.7.2" /><customErrors mode="Off" /></system.web></configuration>'), { core: false, hostingModel: null, stdoutLog: false, stdoutFile: null, framework: '4.7.2', customErrors: 'Off' });
  assert.equal(webConfigFacts('<aspNetCore processPath="dotnet" />').stdoutLog, false);
  assert.equal(frameworkOfRelease(528449), '4.8');
  assert.equal(frameworkOfRelease(533325), '4.8.1');
  assert.equal(frameworkOfRelease(461814), '4.7.2');
  assert.equal(frameworkOfRelease(1000), null);
  assert.equal(frameworkCovers('4.8', '4.7.2'), true);
  assert.equal(frameworkCovers('4.7.2', '4.8'), false);
  assert.equal(frameworkCovers('4.8', '4.8'), true);
  assert.deepEqual(iisSpec('Shop'), { site: 'Shop', pool: null, build: null, offline: true, failedRequests: false });
  assert.deepEqual(iisSpec({ site: 'Shop', pool: 'ShopPool', build: 'msbuild', offline: false }), { site: 'Shop', pool: 'ShopPool', build: 'msbuild', offline: false, failedRequests: false });
  assert.equal(iisSpec({ pool: 'x' }), null);
  assert.equal(iisSpec(''), null);

  const { procs, problems } = readSpec({
    procs: {
      shop: { iis: { site: 'Shop', build: 'msbuild Shop.csproj' }, health: '/health', host: 'shop.local', logs: 'App_Data/logs/*.log' },
      blog: { iis: 'Blog' },
      api: { run: 'dotnet run', build: 'dotnet build', logs: ['a.log', 'b/*.txt'] },
      both: { iis: 'X', run: 'x' },
      bad: { iis: { pool: 'p' } },
      built: { iis: 'X', build: 'b' },
      host: { run: 'x', host: 'not a host' },
      logs: { run: 'x', logs: 3 },
    },
  });
  assert.deepEqual(problems, [
    '"both": it has "iis" and "run": IIS runs the site, so it has no command of its own',
    '"bad": "iis" is a site\'s name, or { "site": "Shop", "pool": "ShopPool", "build": "msbuild", "failedRequests": true }',
    '"built": an IIS site\'s "build" goes in "iis" ({ "site": "X", "build": "…" })',
    '"host": "host" is a host name, as "shop.local"',
    '"logs": "logs" is a log file\'s path or glob, or a list of them',
  ]);
  assert.deepEqual(procs.map((p) => [p.name, p.run, p.iis?.site ?? null, p.build, p.host, p.logs]), [
    ['shop', 'appcmd start site "Shop"', 'Shop', null, 'shop.local', ['App_Data/logs/*.log']],
    ['blog', 'appcmd start site "Blog"', 'Blog', null, null, []],
    ['api', 'dotnet run', null, 'dotnet build', null, ['a.log', 'b/*.txt']],
  ]);
  const spec = specFor({ procs, profiles: {} });
  assert.deepEqual(spec.procs.shop, { iis: { site: 'Shop', build: 'msbuild Shop.csproj' }, health: '/health', host: 'shop.local', logs: 'App_Data/logs/*.log' });
  assert.deepEqual(spec.procs.blog, { iis: 'Blog' });
  assert.deepEqual(spec.procs.api, { run: 'dotnet run', build: 'dotnet build', logs: ['a.log', 'b/*.txt'] });
  assert.deepEqual(readSpec(spec).procs.map((p) => p.name), ['shop', 'blog', 'api']);
});

test('the request log and the event log as structured lines, the ones of this site', () => {
  const fields = w3cFields('#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken');
  assert.equal(fields.length, 15);
  assert.equal(w3cFields('#Software: Microsoft Internet Information Services 10.0'), null);
  const line = w3cJson(fields, '2026-10-29 14:03:07 ::1 GET /orders id=3 80 - ::1 Mozilla/5.0+(Windows) - 500 19 0 812');
  const s = parseStructured(line);
  assert.equal(s.level, 'error');
  assert.equal(s.message, 'GET /orders?id=3 500.19 812ms');
  assert.equal(s.time, Date.UTC(2026, 9, 29, 14, 3, 7));
  assert.equal(s.obj.status, 500);
  assert.equal(s.obj.ms, 812);
  assert.equal(s.obj.agent, 'Mozilla/5.0 (Windows)');
  assert.equal(parseStructured(w3cJson(fields, '2026-10-29 14:03:08 ::1 GET /missing - 80 - ::1 - - 404 0 2 3')).level, 'warn');
  assert.equal(w3cJson(fields, 'too few columns'), null);
  assert.equal(w3cJson(null, 'x'), null);

  const events = parseEvents(JSON.stringify([
    { TimeCreated: '/Date(1761746587000)/', Id: 1011, Level: 2, ProviderName: 'IIS AspNetCore Module V2', Message: "Application '/LM/W3SVC/2/ROOT' with physical root 'C:\\shop\\' failed to load coreclr." },
    { TimeCreated: '/Date(1761746588000)/', Id: 5002, Level: 2, ProviderName: 'WAS', Message: "Application pool 'Shop' is being automatically disabled due to a series of failures." },
    { TimeCreated: '/Date(1761746589000)/', Id: 1000, Level: 2, ProviderName: 'Application Error', Message: 'Faulting application name: w3wp.exe\nFaulting process id: 0x1018' },
    { TimeCreated: '/Date(1761746590000)/', Id: 1309, Level: 3, ProviderName: 'ASP.NET 4.0.30319.0', Message: 'Application domain: /LM/W3SVC/20/ROOT-1-1337' },
    { TimeCreated: '/Date(1761746591000)/', Id: 1026, Level: 2, ProviderName: '.NET Runtime', Message: 'Application: w3wp.exe\nDescription: The process was terminated due to an unhandled exception.' },
  ]));
  assert.deepEqual(events.map((e) => [e.time, e.level, e.source]), [[1761746587000, 'error', 'IIS AspNetCore Module V2'], [1761746588000, 'error', 'WAS'], [1761746589000, 'error', 'Application Error'], [1761746590000, 'warn', 'ASP.NET 4.0.30319.0'], [1761746591000, 'error', '.NET Runtime']]);
  const mine = { siteId: 2, pool: 'Shop', pids: [0x1018] };
  assert.deepEqual(events.map((e) => eventIsSite(e, mine)), [true, true, true, false, false]);
  assert.equal(eventIsSite(events[4], { ...mine, alone: true }), true);
  assert.equal(parseEvents(JSON.stringify({ TimeCreated: '2026-10-29T14:00:00Z', Id: 1, Level: 4, ProviderName: 'WAS', Message: 'one' }))[0].level, 'info');
  assert.deepEqual(parseEvents(''), []);

  const filter = parseFilter('status>=500 ms>100');
  assert.deepEqual(filter.problems, []);
  assert.equal(passes(filter, { text: line }), true);
  assert.equal(passes(parseFilter('status<500'), { text: line }), false);
  assert.equal(passes(parseFilter('nope>1'), { text: line }), false);
  assert.deepEqual(parseFilter('status>=high').problems, ['status>= compares numbers: status>=500']);
});

test('log files followed: from the end, the newest of a glob, a new one read whole, W3C made structured', async () => {
  assert.deepEqual(cutLines('par', 't one\r\ntwo\nthr'), { lines: ['part one', 'two'], rest: 'thr' });
  assert.equal(newest([{ name: 'a.log', mtime: 1 }, { name: 'b.log', mtime: 3 }, { name: 'c.txt', mtime: 9 }], /\.log$/), 'b.log');
  const dir = temp();
  assert.deepEqual(logPattern('logs/stdout_*.log', { cwd: dir }).dir, join(dir, 'logs'));
  assert.equal(logPattern('%LOGS%/app.log', { cwd: '.', env: { LOGS: dir } }).file, 'app.log');
  assert.equal(logPattern('${LOGS}/app.log', { cwd: '.', env: { LOGS: dir } }).dir, dir);

  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs', 'stdout_1.log'), 'old line\n');
  writeFileSync(join(dir, 'app.log'), 'before\n');
  const got = [];
  const t = tailLogs(['logs/stdout_*.log', 'app.log', 'w3c/u_ex*.log'], { cwd: dir, every: 60_000, onLine: (text, file) => got.push([text, file.slice(dir.length + 1).replace(/\\/g, '/')]) });
  appendFileSync(join(dir, 'app.log'), 'after one\nafter t');
  appendFileSync(join(dir, 'logs', 'stdout_1.log'), 'new line\n');
  t.look();
  assert.deepEqual(got, [['new line', 'logs/stdout_1.log'], ['after one', 'app.log']]);
  appendFileSync(join(dir, 'app.log'), 'wo\n');
  // The app started again: a new stdout file, read from its start.
  writeFileSync(join(dir, 'logs', 'stdout_2.log'), 'started again\n');
  const later = new Date(Date.now() + 5000);
  (await import('node:fs')).utimesSync(join(dir, 'logs', 'stdout_2.log'), later, later);
  mkdirSync(join(dir, 'w3c'));
  writeFileSync(join(dir, 'w3c', 'u_ex261029.log'), '#Software: Microsoft Internet Information Services 10.0\n#Fields: date time cs-method cs-uri-stem sc-status time-taken\n2026-10-29 14:03:07 GET /orders 500 812\n');
  got.length = 0;
  t.look();
  assert.deepEqual(got.map(([text, file]) => [parseStructured(text)?.message ?? text, file]), [['started again', 'logs/stdout_2.log'], ['after two', 'app.log'], ['GET /orders 500 812ms', 'w3c/u_ex261029.log']]);
  t.close();
});

/** A fake IIS: one site and its pool, what was asked of it, and its worker changing on a recycle. */
function fakeIis({ siteState = 'Stopped', poolState = 'Stopped', shared = false, physicalPath = null, logDir = null } = {}) {
  const calls = [];
  const state = { site: siteState, pool: poolState, workers: [] };
  const control = {
    site: async (name) => (name === 'Shop' ? { name, id: 2, state: state.site, bindings: [{ scheme: 'http', ip: null, port: 8080, host: 'shop.local' }], physicalPath, logDir } : null),
    pool: async (name) => (name === 'ShopPool' ? { name, state: state.pool, runtime: '', mode: 'Integrated' } : null),
    poolOf: async () => 'ShopPool',
    shared: async () => shared,
    workers: async () => state.workers,
    startSite: async (n) => {
      calls.push(`start site ${n}`);
      state.site = 'Started';
    },
    stopSite: async (n) => {
      calls.push(`stop site ${n}`);
      state.site = 'Stopped';
    },
    startPool: async (n) => {
      calls.push(`start pool ${n}`);
      state.pool = 'Started';
      state.workers = [4120];
    },
    stopPool: async (n) => {
      calls.push(`stop pool ${n}`);
      state.pool = 'Stopped';
      state.workers = [];
    },
    recycle: async (n) => {
      calls.push(`recycle ${n}`);
      state.workers = [5532];
    },
    stopNow: (s, p) => calls.push(`stop now ${s} ${p}`),
  };
  return { calls, state, control };
}

const iisCrew = (extra = {}) => readSpec({ procs: { shop: { iis: 'Shop', health: '/health', ...extra } } }).procs;

test('an IIS site as a process: started through appcmd, its worker and port followed, recycled, stopped', async () => {
  const fake = fakeIis();
  const sup = new Supervisor(iisCrew(), { dir: temp(), iis: fake.control, iisTimes: { every: 20 } });
  const p = sup.get('shop');
  sup.start('shop');
  await until(() => p.status === 'running' && p.pid === 4120, 'the site to start and its worker to show');
  assert.deepEqual(fake.calls, ['start pool ShopPool', 'start site Shop']);
  assert.equal(p.port, 8080);
  assert.deepEqual(p.site, { physicalPath: null, scheme: 'http', host: 'shop.local', ip: null, port: 8080 });
  assert.match(said(p), /── appcmd start site "Shop"\n── started Shop in IIS \(pool ShopPool\): http:\/\/shop\.local:8080\n── worker started \(pid 4120\)/);
  assert.equal(procUrl(p), 'http://shop.local:8080');

  await sup.restart('shop');
  assert.deepEqual(fake.calls.slice(2), ['recycle ShopPool']);
  await until(() => p.pid === 5532, 'the new worker');
  assert.match(said(p), /── recycling\n── recycled ShopPool\n── recycled: worker 4120 → 5532/);
  assert.equal(p.status, 'running');

  await sup.stop('shop');
  assert.equal(p.status, 'stopped');
  assert.deepEqual(fake.calls.slice(3), ['stop site Shop', 'stop pool ShopPool']);
  assert.equal(p.pid, null);
  sup.dispose();
});

test('an IIS site already running is left running when Bosun quits; one it started is stopped; a shared pool is never stopped', async () => {
  const running = fakeIis({ siteState: 'Started', poolState: 'Started' });
  running.state.workers = [99];
  const a = new Supervisor(iisCrew(), { dir: temp(), iis: running.control, iisTimes: { every: 20 } });
  a.start('shop');
  await until(() => a.get('shop').pid === 99, 'the running site');
  assert.match(said(a.get('shop')), /Shop was already running in IIS \(pool ShopPool\): Bosun leaves it running when it quits/);
  a.killAllNow();
  assert.deepEqual(running.calls, []);

  const shared = fakeIis({ shared: true });
  const b = new Supervisor(iisCrew(), { dir: temp(), iis: shared.control, iisTimes: { every: 20 } });
  b.start('shop');
  await until(() => b.get('shop').status === 'running', 'the shared site');
  assert.match(said(b.get('shop')), /shared with other sites/);
  b.killAllNow();
  assert.deepEqual(shared.calls, ['start pool ShopPool', 'start site Shop', 'stop now Shop null']);
  a.dispose();
  b.dispose();
});

test('an IIS site whose pool stops by itself crashed; one IIS lacks says so', async () => {
  const fake = fakeIis();
  const events = [];
  const sup = new Supervisor([...iisCrew(), ...readSpec({ procs: { nope: { iis: 'Nope' } } }).procs], { dir: temp(), iis: fake.control, iisTimes: { every: 20 }, onEvent: (e) => events.push(e.type) });
  sup.start('shop');
  sup.start('nope');
  await until(() => sup.get('shop').pid === 4120, 'the worker');
  fake.state.pool = 'Stopped';
  await until(() => sup.get('shop').status === 'crashed', 'the crash');
  assert.match(sup.get('shop').trouble ?? said(sup.get('shop')), /stopped by itself: rapid-fail protection/);
  await until(() => sup.get('nope').status === 'crashed', 'the missing site');
  assert.match(said(sup.get('nope')), /IIS has no site named "Nope"/);
  assert.deepEqual(events, ['exit', 'exit']);
  sup.dispose();
});

test('an IIS site\'s build runs with app_offline.htm in its folder, and its logs are followed', async () => {
  const site = temp();
  const logs = temp();
  writeFileSync(join(site, 'web.config'), '<configuration><system.webServer><aspNetCore processPath="dotnet" stdoutLogEnabled="true" stdoutLogFile=".\\logs\\stdout" /></system.webServer></configuration>');
  mkdirSync(join(site, 'logs'));
  mkdirSync(join(logs, 'W3SVC2'));
  const fake = fakeIis({ physicalPath: site, logDir: logs });
  const check = `node -e "console.log(require('fs').existsSync(process.argv[1]) ? 'offline during the build' : 'online during the build')" "${join(site, 'app_offline.htm')}"`;
  const crew = readSpec({ procs: { shop: { iis: { site: 'Shop', build: check } } } }).procs;
  const sup = new Supervisor(crew, { dir: temp(), iis: fake.control, iisTimes: { every: 20, tailEvery: 20 } });
  const p = sup.get('shop');
  sup.start('shop');
  await until(() => p.status === 'running' && p.pid, 'the built site');
  assert.match(said(p), /── build: node -e[^\n]*\noffline during the build\n── built\n── started Shop/);
  assert.equal(existsSync(join(site, 'app_offline.htm')), false);
  writeFileSync(join(site, 'logs', 'stdout_20261029_4120.log'), 'Now listening on: http://localhost\n');
  writeFileSync(join(logs, 'W3SVC2', 'u_ex261029.log'), '#Fields: date time cs-method cs-uri-stem sc-status time-taken\n2026-10-29 14:03:07 GET /health 503 4\n');
  await until(() => /Now listening/.test(said(p)) && /GET \/health 503/.test(said(p)), 'the stdout log and the request log');
  assert.match(p.trouble, /GET \/health 503 4ms/);

  // A failed build keeps the site as it was.
  writeFileSync(join(site, 'app_offline.htm'), 'mine');
  p.spec.iis.build = 'node -e "process.exit(3)"';
  await sup.restart('shop');
  assert.match(said(p), /── the build failed \(exit 3\)\n── the site still runs what was built before\n── recycled ShopPool/);
  assert.equal(existsSync(join(site, 'app_offline.htm')), true, "an app_offline.htm that was there stays");
  sup.dispose();
});

test('"build" runs before "run", which runs only when it passed; "logs" are followed into the log', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'app.log'), 'old\n');
  const crew = readSpec({
    procs: {
      ok: { run: 'node -e "setTimeout(() => {}, 60000)"', build: 'node -e "console.log(\'built it\')"', logs: 'app.log' },
      broken: { run: 'node -e "console.log(\'ran anyway\')"', build: 'node -e "process.exit(2)"' },
    },
  }).procs;
  const { tailLogs: tail } = await import('../src/tail.js');
  const sup = new Supervisor(crew, { dir, tail: (patterns, opts) => tail(patterns, { ...opts, every: 20 }) });
  sup.start('ok');
  sup.start('broken');
  await until(() => /built it/.test(said(sup.get('ok'))), 'the build');
  appendFileSync(join(dir, 'app.log'), 'from the file\n');
  await until(() => /from the file/.test(said(sup.get('ok'))), 'the log file');
  assert.doesNotMatch(said(sup.get('ok')), /\bold\b/);
  await until(() => sup.get('broken').status === 'crashed', 'the broken build');
  assert.doesNotMatch(said(sup.get('broken')), /^ran anyway$/m);
  await sup.stopAll();
  sup.dispose();
});

test('the health check asks for the host a site is bound to', async () => {
  const hosts = [];
  const server = createServer((req, res) => {
    hosts.push(req.headers.host);
    res.statusCode = req.headers.host?.startsWith('shop.local') ? 200 : 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  assert.equal((await httpStatus(`http://127.0.0.1:${port}/`, { headers: { host: 'other' } })).status, 404);
  const crew = readSpec({ procs: { web: { run: 'node -e "setTimeout(() => {}, 60000)"', port, health: '/health', host: 'shop.local' } } }).procs;
  const sup = new Supervisor(crew, { dir: temp() });
  sup.start('web');
  await until(async () => {
    await sup.checkPorts();
    return sup.get('web').health === 200;
  }, 'the healthy page');
  assert.equal(hosts.at(-1), `shop.local:${port}`);
  assert.equal(procUrl(sup.get('web')), `http://shop.local:${port}`);
  await sup.stopAll();
  sup.dispose();
  server.close();
});

test('/free never stops System, which holds http.sys\'s ports (IIS\'s)', async () => {
  const notes = [];
  let killed = null;
  const site = { name: 'shop', port: 80, spec: { iis: { site: 'Shop' } } };
  const ctx = { pidsOnPort: () => [4], killPids: (p) => (killed = p), note: (t, k) => notes.push([t, k]), confirm: async () => true, crew: { list: () => [site] } };
  await free(ctx, '80');
  assert.deepEqual(notes.at(-1), ["Port 80 is shop's, IIS site Shop, through http.sys: s stops it.", 'error']);
  await free(ctx, '8080');
  assert.match(notes.at(-1)[0], /^Port 8080 is held by http.sys \(the System process\)/);
  assert.equal(killed, null);
  ctx.pidsOnPort = () => [4, 321];
  await free(ctx, '8080');
  assert.deepEqual(killed, [321]);
  assert.equal(checkLine(checkPorts([{ proc: 'web', port: 80, taken: true, pids: [4] }])[0]), "✗ web's port 80 is taken by http.sys — an IIS site or IIS Express binds it (appcmd list site shows the bindings): stop that site, or give web another port");
});

test('pre-flight: Windows, an administrator, the service, the site, its pool and what its web.config needs', async () => {
  assert.deepEqual(checkIis({ platform: 'linux', sites: [{ proc: 'shop', site: 'Shop' }] }).map(checkLine), ["✗ IIS sites run only on Windows — open this project's crew in Bosun on the Windows machine that hosts them"]);
  assert.deepEqual(checkIis({ platform: 'win32', service: 'missing', sites: [{}] }).map((c) => c.title), ["IIS isn't installed"]);
  assert.deepEqual(checkIis(null), []);

  const site = temp();
  writeFileSync(join(site, 'web.config'), '<configuration><system.web><compilation targetFramework="4.8" /></system.web></configuration>');
  const fake = fakeIis({ physicalPath: site });
  const runs = [];
  const run = async (line) => {
    runs.push(line);
    if (line === 'net session') throw new Error('Access is denied.');
    if (line === 'sc query W3SVC') return { stdout: 'SERVICE_NAME: W3SVC\n        STATE              : 4  RUNNING\n' };
    if (line.startsWith('reg query')) return { stdout: '    Release    REG_DWORD    0x70bf6\n' };
    return { stdout: '' };
  };
  const facts = await gatherIis([{ name: 'shop', iis: { site: 'Shop', pool: null } }, { name: 'gone', iis: { site: 'Gone', pool: null } }], { platform: 'win32', run, iis: fake.control, exists: () => false });
  assert.deepEqual(facts.sites[0], { proc: 'shop', site: 'Shop', exists: true, physicalPath: site, bindings: [{ scheme: 'http', ip: null, port: 8080, host: 'shop.local' }], pool: 'ShopPool', poolExists: true, runtime: '', core: false, hostingBundle: null, framework: '4.8', installed: '4.7.2' });
  assert.deepEqual(checkIis(facts).map(checkLine), [
    '✓ IIS (W3SVC) is running',
    "✗ The terminal isn't an administrator's — IIS starts and stops sites only for an administrator: start the terminal as administrator, or run Bosun through gsudo",
    `✓ IIS site Shop (pool ShopPool) serves ${site}`,
    '✗ ShopPool loads no .NET CLR, and Shop is ASP.NET on .NET Framework 4.8 — appcmd set apppool "ShopPool" /managedRuntimeVersion:v4.0',
    '✗ .NET Framework 4.7.2 is installed, and Shop targets 4.8 — install .NET Framework 4.8 (its Developer Pack too, to build)',
    '✗ IIS has no site "Gone" (gone) — add it in IIS Manager, or fix its "site" in bosun.json',
  ]);
  const core = checkIis({ platform: 'win32', service: 'RUNNING', admin: true, sites: [{ proc: 'api', site: 'Api', exists: true, pool: 'Api', poolExists: true, runtime: '', core: true, hostingBundle: false, physicalPath: 'C:\\api' }] });
  assert.match(checkLine(core.at(-1)), /^✗ The ASP.NET Core Hosting Bundle isn't installed, and Api runs through the ASP.NET Core module/);
  assert.match(checkIis({ platform: 'win32', sites: [{ proc: 'x', site: 'X', error: 'IIS needs an administrator' }] }).map(checkLine)[0], /✗ x: couldn't read IIS site X — IIS needs an administrator/);

  const procs = [
    { name: 'api', run: 'dotnet run --launch-profile "http"' },
    { name: 'legacy', run: '"%ProgramFiles%\\IIS Express\\iisexpress.exe" /path:"%CD%" /port:51234 /systray:false', build: '"msbuild" "Legacy.csproj" /restore' },
    { name: 'shop', run: 'appcmd start site "Shop"', iis: { site: 'Shop', build: 'dotnet publish -c Release -o "bin/pub"' } },
    { name: 'web', run: 'vite' },
  ];
  const tools = toolsOf(procs, { platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => false, which: (n) => (n === 'dotnet' ? 'C:\\dotnet\\dotnet.exe' : null) });
  assert.deepEqual(tools, [{ tool: 'dotnet', procs: ['api', 'shop'], found: true }, { tool: 'msbuild', procs: ['legacy'], found: false }, { tool: 'iisexpress', procs: ['legacy'], found: false }]);
  assert.deepEqual(checkTools(tools).map((c) => c.ok), [true, false, false]);
  assert.match(checkLine(checkTools(tools)[1]), /^✗ MSBuild isn't there, and legacy needs it — install Visual Studio or its Build Tools/);
});

test('.NET projects: an IIS site serving one, IIS Express for .NET Framework, dotnet run for ASP.NET Core', () => {
  assert.equal(projectKind('<Project Sdk="Microsoft.NET.Sdk.Web">'), 'core');
  assert.equal(projectKind('<Project Sdk="Microsoft.NET.Sdk">'), null);
  assert.equal(projectKind('<Project ToolsVersion="15.0"><ProjectTypeGuids>{349c5851-65df-11da-9384-00065b846f21};{fae04ec0-301f-11d3-bf4b-00c04f79efbc}</ProjectTypeGuids>'), 'framework');
  assert.equal(iisExpressPort('<IISUrl>http://localhost:51234/</IISUrl>'), 51234);
  assert.equal(iisExpressPort('<DevelopmentServerPort>8888</DevelopmentServerPort>'), 8888);
  assert.equal(iisExpressPort('<IISUrl>http://localhost/</IISUrl>'), null);
  assert.deepEqual(launchProfile('\uFEFF{"profiles":{"IIS Express":{"commandName":"IISExpress"},"https":{"commandName":"Project","applicationUrl":"https://localhost:7001;http://localhost:5001"}}}'), { name: 'https', port: 5001 });
  assert.equal(launchProfile('not json'), null);
  assert.equal(procName('Default Web Site'), 'default-web-site');
  assert.equal(procName('Shop.Web'), 'shop.web');
  assert.equal(within('/src/shop', '/src/shop/bin/publish', false), true);
  assert.equal(within('/src/shop', '/src/shopping', false), false);
  assert.equal(within('/SRC/Shop', '/src/shop', true), true);

  const dir = temp();
  for (const [folder, file, text] of [
    ['Shop.Web', 'Shop.Web.csproj', '<Project ToolsVersion="15.0"><Import Project="$(VSToolsPath)\\WebApplications\\Microsoft.WebApplication.targets" /><IISUrl>http://localhost:51234/</IISUrl></Project>'],
    ['Legacy', 'Legacy.csproj', '<Project><ProjectTypeGuids>{349c5851-65df-11da-9384-00065b846f21}</ProjectTypeGuids><IISUrl>http://localhost:50111/</IISUrl></Project>'],
    ['Api', 'Api.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'],
    ['Admin', 'Admin.csproj', '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'],
    ['Core', 'Core.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>'],
  ]) {
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, file), text);
  }
  mkdirSync(join(dir, 'Api', 'Properties'));
  writeFileSync(join(dir, 'Api', 'Properties', 'launchSettings.json'), '{"profiles":{"http":{"commandName":"Project","applicationUrl":"http://localhost:5080"}}}');
  writeFileSync(join(dir, 'Shop.sln'), '');
  const asked = [];
  const crew = dotnetCrew(dir, {
    win: true,
    iisSites: () => (asked.push('iis'), [{ site: 'Shop', physicalPath: join(dir, 'Shop.Web') }, { site: 'Admin Site', physicalPath: join(dir, 'Admin', 'bin', 'Release', 'net8.0', 'publish') }]),
    msbuild: () => (asked.push('msbuild'), 'C:\\VS\\MSBuild.exe'),
  });
  assert.deepEqual(asked, ['iis', 'msbuild']);
  assert.match(crew.from, /the \.NET projects \(Admin\.csproj, Api\.csproj, Core\.csproj, Legacy\.csproj, Shop\.Web\.csproj\)/);
  assert.deepEqual(crew.procs.map((p) => [p.name, p.cwd, p.run, p.build ?? null, p.iis, p.port]), [
    ['admin-site', 'Admin', 'appcmd start site "Admin Site"', null, { site: 'Admin Site', pool: null, build: `dotnet publish -c Release -o "${join('bin', 'Release', 'net8.0', 'publish')}"`, offline: true }, null],
    ['api', 'Api', 'dotnet run --launch-profile "http"', null, undefined, 5080],
    ['legacy', 'Legacy', '"%ProgramFiles%\\IIS Express\\iisexpress.exe" /path:"%CD%" /port:50111 /systray:false', '"C:\\VS\\MSBuild.exe" "Legacy.csproj" /restore /p:RestorePackagesConfig=true /nologo /v:m', undefined, 50111],
    ['shop', 'Shop.Web', 'appcmd start site "Shop"', null, { site: 'Shop', pool: null, build: '"C:\\VS\\MSBuild.exe" "Shop.Web.csproj" /restore /p:RestorePackagesConfig=true /nologo /v:m', offline: true }, null],
  ]);
  // Off Windows there's no IIS to ask.
  assert.deepEqual(dotnetCrew(dir, { win: false, iisSites: () => assert.fail('asked IIS'), msbuild: () => 'msbuild' }).procs.map((p) => p.name), ['admin', 'api', 'legacy', 'shop.web']);
  assert.equal(dotnetCrew(temp()), null);

  // loadCrew reads them when there's nothing else, and /init writes them out.
  const loaded = loadCrew(dir, { dotnet: { win: false, msbuild: () => 'msbuild' } });
  assert.equal(loaded.procs.length, 4);
  const spec = specFor(loaded);
  assert.deepEqual(spec.procs.legacy, { run: '"%ProgramFiles%\\IIS Express\\iisexpress.exe" /path:"%CD%" /port:50111 /systray:false', build: '"msbuild" "Legacy.csproj" /restore /p:RestorePackagesConfig=true /nologo /v:m', cwd: 'Legacy', port: 50111 });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  const both = loadCrew(dir, { dotnet: { win: false, msbuild: () => 'msbuild' } });
  assert.deepEqual(both.procs.map((p) => p.name), ['dev', 'admin', 'api', 'legacy', 'shop.web']);
  assert.match(both.from, /^package\.json's dev script and the \.NET projects/);
});
