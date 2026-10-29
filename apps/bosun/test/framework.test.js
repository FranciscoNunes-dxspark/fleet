// .NET Framework sites: their appSettings file written from Bosun's settings (appsettings.js), what an
// error page says (errorpage.js), Trace and Debug output heard through OutputDebugString (dbwin.js),
// and a site served from a publish folder built with its web.config transform (dotnet.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARK, appSettingsFile, appSettingsNote, appSettingsXml, writeAppSettings } from '../src/appsettings.js';
import { errorPage, htmlText } from '../src/errorpage.js';
import { DebugOutput, dbwinCommand, dbwinCompile, fromTree, parseDbwin, problemNote } from '../src/dbwin.js';
import { execFileSync } from 'node:child_process';
import { dotnetCrew, msbuildPublishLine } from '../src/dotnet.js';
import { readSpec, specFor } from '../src/crew.js';
import { Supervisor } from '../src/supervisor.js';

const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const temp = () => mkdtempSync(join(tmpdir(), 'bosun-fx-'));
const said = (p) => p.lines.map((l) => l.text).join('\n');
const WEB_CONFIG = '<configuration><appSettings file="App_Data\\local.config"><add key="Mode" value="base" /></appSettings></configuration>';
const LONG = 'node -e "setTimeout(() => {}, 60000)"';

test('the appSettings file: named by web.config, written from the settings, never over one that isn\'t Bosun\'s', () => {
  assert.equal(appSettingsFile(WEB_CONFIG), 'App_Data\\local.config');
  assert.equal(appSettingsFile('<appSettings><add key="a" value="b" /></appSettings>'), null);
  assert.equal(appSettingsFile(''), null);
  assert.equal(appSettingsXml({ b: 'x & "y"', a: '<1>\nline' }), `<?xml version="1.0" encoding="utf-8"?>\n${MARK}\n<appSettings>\n  <add key="a" value="&lt;1&gt;&#xA;line" />\n  <add key="b" value="x &amp; &quot;y&quot;" />\n</appSettings>\n`);

  const dir = temp();
  assert.equal(writeAppSettings(dir, { A: '1' }), null, 'no web.config');
  writeFileSync(join(dir, 'web.config'), WEB_CONFIG);
  assert.equal(writeAppSettings(dir, {}), null, 'nothing to write and no file');
  mkdirSync(join(dir, 'App_Data'));
  const first = writeAppSettings(dir, { ApiUrl: 'http://localhost:5000', Mode: 'mock' });
  assert.deepEqual(first, { file: 'App_Data\\local.config', written: true, changed: true, count: 2 });
  assert.match(readFileSync(join(dir, 'App_Data', 'local.config'), 'utf8'), /<add key="Mode" value="mock" \/>/);
  assert.equal(writeAppSettings(dir, { ApiUrl: 'http://localhost:5000', Mode: 'mock' }).changed, false);
  assert.equal(writeAppSettings(dir, {}).changed, true, "Bosun's own file is emptied");
  assert.equal(appSettingsNote(first), "── 2 settings written to App_Data\\local.config (the web.config's appSettings file)");

  writeFileSync(join(dir, 'App_Data', 'local.config'), '<appSettings><add key="Secret" value="mine" /></appSettings>');
  const mine = writeAppSettings(dir, { Mode: 'mock' });
  assert.deepEqual(mine, { file: 'App_Data\\local.config', written: false, reason: "App_Data\\local.config is there and isn't Bosun's: it's left as it is" });
  assert.match(readFileSync(join(dir, 'App_Data', 'local.config'), 'utf8'), /mine/);
  assert.equal(writeAppSettings(dir, {}), null, "one of yours with nothing to give it isn't mentioned");
});

test('a process\'s settings reach its web.config\'s appSettings file before it starts', async () => {
  const dir = temp();
  writeFileSync(join(dir, '.env'), 'ApiUrl=http://localhost:5000\n');
  writeFileSync(join(dir, 'web.config'), WEB_CONFIG);
  mkdirSync(join(dir, 'App_Data'));
  const crew = readSpec({ envFile: '.env', procs: { legacy: { run: LONG, env: { Mode: 'mock' } } } });
  const sup = new Supervisor(crew.procs.map((p) => ({ ...p, fileEnv: { ApiUrl: 'http://localhost:5000' } })), { dir });
  sup.start('legacy');
  const text = readFileSync(join(dir, 'App_Data', 'local.config'), 'utf8');
  assert.match(text, /key="ApiUrl" value="http:\/\/localhost:5000"/);
  assert.match(text, /key="Mode" value="mock"/);
  assert.match(said(sup.get('legacy')), /── 2 settings written to App_Data\\local\.config/);
  await sup.stopAll();
  sup.dispose();
});

test('an IIS site gets its settings, and one already running is recycled when they changed', async () => {
  const site = temp();
  writeFileSync(join(site, 'web.config'), WEB_CONFIG.replace('App_Data\\local.config', 'bosun.config'));
  const calls = [];
  const control = {
    site: async () => ({ name: 'Shop', id: 2, state: 'Started', bindings: [], physicalPath: site, logDir: null }),
    pool: async () => ({ name: 'Shop', state: 'Started', runtime: 'v4.0' }),
    poolOf: async () => 'Shop',
    shared: async () => false,
    workers: async () => [10],
    recycle: async (n) => calls.push(`recycle ${n}`),
    stopNow: () => {},
  };
  const crew = readSpec({ procs: { shop: { iis: 'Shop', env: { Mode: 'one' } } } }).procs;
  const sup = new Supervisor(crew, { dir: temp(), iis: control, iisTimes: { every: 20 } });
  const p = sup.get('shop');
  sup.start('shop');
  await until(() => p.status === 'running', 'the site');
  assert.deepEqual(calls, ['recycle Shop']);
  assert.match(readFileSync(join(site, 'bosun.config'), 'utf8'), /value="one"/);
  // bosun.json changed: r writes the new settings, then recycles.
  sup.setCrew(readSpec({ procs: { shop: { iis: 'Shop', env: { Mode: 'two' } } } }).procs);
  await sup.restart('shop');
  assert.match(readFileSync(join(site, 'bosun.config'), 'utf8'), /value="two"/);
  assert.deepEqual(calls, ['recycle Shop', 'recycle Shop']);
  sup.killAllNow();
  sup.dispose();
});

const YSOD = `<html><head><title>Object reference not set to an instance of an object.</title></head><body>
<span><H1>Server Error in '/' Application.<hr width=100% size=1 color=silver></H1>
<h2> <i>Object reference not set to an instance of an object.</i> </h2></span>
<b> Description: </b>An unhandled exception occurred during the execution of the current web request.<br><br>
<b> Exception Details: </b>System.NullReferenceException: Object reference not set to an instance of an object.<br><br>
<b> Source File: </b> C:\\src\\shop\\Controllers\\HomeController.cs<b> &nbsp;&nbsp; Line: </b> 12
<br><br><b>Stack Trace:</b> <br><br>
<table width=100% bgcolor="#ffffcc"><tr><td><code><pre>

[NullReferenceException: Object reference not set to an instance of an object.]
   Shop.Controllers.HomeController.Index() in C:\\src\\shop\\Controllers\\HomeController.cs:12
   lambda_method(Closure , ControllerBase , Object[] ) +87
</pre></code></td></tr></table></body></html>`;

test('error pages: the yellow screen, ASP.NET Core\'s, IIS\'s detailed errors, problem details, a title', () => {
  assert.equal(htmlText('a&nbsp;&amp;&#39;b&#x41;<br>c'), "a &'bA\nc");
  assert.deepEqual(errorPage(YSOD), {
    headline: 'System.NullReferenceException: Object reference not set to an instance of an object.',
    lines: ['at C:\\src\\shop\\Controllers\\HomeController.cs:12', '[NullReferenceException: Object reference not set to an instance of an object.]', '   Shop.Controllers.HomeController.Index() in C:\\src\\shop\\Controllers\\HomeController.cs:12', '   lambda_method(Closure , ControllerBase , Object[] ) +87'],
  });
  assert.deepEqual(errorPage('<html><title>Runtime Error</title><body>…<customErrors mode="Off"/>…</body></html>').headline, "Runtime Error (the site's customErrors hide it)");
  assert.deepEqual(errorPage('<h1>An unhandled exception occurred while processing the request.</h1><div class="titleerror">InvalidOperationException: No service for type &#x27;IShop&#x27;</div><p class="location">Shop.Startup.Configure in Startup.cs, line 40</p>'), { headline: "InvalidOperationException: No service for type 'IShop'", lines: ['at Shop.Startup.Configure in Startup.cs, line 40'] });
  assert.deepEqual(errorPage('<div class="content-container"><h3>HTTP Error 500.19 - Internal Server Error</h3><h4>The requested page cannot be accessed because the related configuration data for the page is invalid.</h4></div><table><tr><th>Module</th><td>&nbsp;&nbsp;&nbsp;IIS Web Core</td></tr><tr><th>Error Code</th><td>&nbsp;&nbsp;&nbsp;0x8007000d</td></tr><tr><th>Requested URL</th><td>http://localhost/</td></tr></table><fieldset><legend>Config Error</legend><table><tr><td>Unrecognized element \'foo\'</td></tr></table></fieldset>'), {
    headline: 'HTTP Error 500.19 - Internal Server Error',
    lines: ['The requested page cannot be accessed because the related configuration data for the page is invalid.', 'Module IIS Web Core', 'Error Code 0x8007000d', "Config Error: Unrecognized element 'foo'"],
  });
  assert.deepEqual(errorPage('{"type":"x","title":"An error occurred","status":500,"detail":"Database down"}'), { headline: 'An error occurred: Database down', lines: [] });
  assert.deepEqual(errorPage('<html><head><title>HTTP Error 500.30 - ASP.NET Core app failed to start</title></head></html>'), { headline: 'HTTP Error 500.30 - ASP.NET Core app failed to start', lines: [] });
  assert.deepEqual(errorPage('Internal error: the cache is gone\nmore'), { headline: 'Internal error: the cache is gone', lines: [] });
  assert.equal(errorPage(''), null);
  assert.equal(errorPage('<html><body></body></html>'), null);
});

test('a health page answering 5xx puts what its page says in the log, once a start', async () => {
  const server = createServer((req, res) => {
    res.statusCode = 500;
    res.end(YSOD);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const sup = new Supervisor(readSpec({ procs: { web: { run: LONG, port, health: '/health' } } }).procs, { dir: temp() });
  const p = sup.get('web');
  sup.start('web');
  await until(async () => {
    await sup.checkPorts();
    return p.health === 500;
  }, 'the failing health page');
  await sup.checkPorts();
  const text = said(p);
  assert.equal(text.match(/answered 500/g)?.length, 1);
  assert.match(p.trouble, /\/health answered 500: System\.NullReferenceException: Object reference not set/);
  assert.match(text, /\n {4}at C:\\src\\shop\\Controllers\\HomeController\.cs:12\n/);
  await sup.stopAll();
  sup.dispose();
  server.close();
});

/** A fake helper: what it's said is written to its stdout by the test. */
function fakeHelper() {
  const children = [];
  const spawnImpl = (file, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), file, args, killed: false });
    child.kill = () => {
      child.killed = true;
      child.emit('close', null);
    };
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

test('debug output: the helper\'s lines read and handed to the process whose tree said them', async () => {
  assert.deepEqual(parseDbwin('4120\t880,4\tShop: order 7 saved\r'), { pid: 4120, chain: [880, 4], text: 'Shop: order 7 saved' });
  assert.deepEqual(parseDbwin('77\t\ta\tb'), { pid: 77, chain: [], text: 'a\tb' });
  assert.deepEqual(parseDbwin('ready\t\t'), { ready: true });
  assert.deepEqual(parseDbwin('!\tGlobal\\\tA required privilege is not held by the client.'), { problem: 'A required privilege is not held by the client.', global: true });
  assert.equal(parseDbwin('nonsense'), null);
  assert.equal(fromTree({ pid: 5, chain: [9, 3] }, [3]), true);
  assert.equal(fromTree({ pid: 5, chain: [9] }, [3, null]), false);
  assert.match(problemNote({ problem: 'A required privilege is not held by the client.', global: true }), /^can't hear IIS's workers \(session 0\) without an administrator's terminal/);
  const [file, args] = dbwinCommand(321);
  assert.equal(file, 'powershell.exe');
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Add-Type -ReferencedAssemblies System\.Core, System\.Management -TypeDefinition @'\nusing System;/);
  assert.match(script, /\[BosunDbwin\]::Run\(321\)/);
  assert.match(script, /Listen\("Global\\\\"\)/);

  const helper = fakeHelper();
  const out = new DebugOutput({ spawnImpl: helper.spawnImpl, pid: 321 });
  const a = [];
  const b = [];
  const offA = out.subscribe({ wants: (e) => fromTree(e, [100]), line: (e) => a.push(e.text), problem: (t) => a.push(`! ${t}`) });
  assert.equal(helper.children.length, 1);
  const child = helper.children[0];
  child.stdout.write('ready\t\t\n101\t100,1\tfrom a\'s tree\n200\t1\tfrom elsewhere\n!\tGlobal\\\tA required privilege is not held');
  child.stdout.write(' by the client.\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(a, ["from a's tree", "! can't hear IIS's workers (session 0) without an administrator's terminal: only this session's processes are heard"]);
  const offB = out.subscribe({ wants: (e) => fromTree(e, [200]), line: (e) => b.push(e.text), problem: (t) => b.push(`! ${t}`) });
  assert.equal(helper.children.length, 1, 'one helper for everyone');
  assert.match(b[0], /^! can't hear IIS's workers/, 'a late subscriber hears the problem too');
  child.stdout.write('200\t\tfor b\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.slice(1), ['for b']);
  offA();
  assert.equal(child.killed, false);
  offB();
  assert.equal(child.killed, true, 'gone with the last one');
});

test("debug output: the reader's C# compiles in Windows PowerShell", { skip: process.platform !== 'win32' && 'Windows PowerShell is Windows\' only' }, () => {
  const script = `${dbwinCompile()}[BosunDbwin].FullName\n`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.match(out, /BosunDbwin/);
});

test('"trace": a process hears its tree\'s debug output; off Windows it says there is none', async () => {
  const subs = [];
  const output = { subscribe: (sub) => (subs.push(sub), () => subs.splice(subs.indexOf(sub), 1)) };
  const crew = readSpec({ procs: { legacy: { run: LONG, trace: true } } });
  assert.deepEqual(crew.problems, []);
  assert.equal(specFor({ procs: crew.procs, profiles: {} }).procs.legacy.trace, true);
  assert.deepEqual(readSpec({ procs: { x: { run: 'x', trace: 'yes' } } }).problems, ['"x": "trace" is true or false']);
  const sup = new Supervisor(crew.procs, { dir: temp(), debugOutput: output });
  const p = sup.get('legacy');
  sup.start('legacy');
  assert.equal(subs.length, 1);
  const pid = p.pid;
  assert.equal(subs[0].wants({ pid: 99999, chain: [pid] }), true);
  assert.equal(subs[0].wants({ pid: 99998, chain: [1] }), false);
  subs[0].line({ pid: 99999, chain: [pid], text: 'Trace: cache warmed' });
  subs[0].problem('session 0 is out of reach');
  assert.match(said(p), /Trace: cache warmed\n── trace: session 0 is out of reach/);
  await sup.stopAll();
  assert.equal(subs.length, 0, 'unsubscribed when it stopped');
  sup.dispose();

  const none = new Supervisor(crew.procs, { dir: temp(), debugOutput: null });
  none.start('legacy');
  assert.match(said(none.get('legacy')), /── "trace" hears Windows' debug output: there is none here/);
  await none.stopAll();
  none.dispose();
});

test('a .NET Framework site served from a publish folder is published there, its web.config transformed', () => {
  assert.equal(msbuildPublishLine('msbuild', 'Shop.csproj', 'publish', 'Release'), '"msbuild" "Shop.csproj" /restore /p:RestorePackagesConfig=true /nologo /v:m /p:Configuration=Release /p:DeployOnBuild=true /p:WebPublishMethod=FileSystem /p:PublishUrl="publish" /p:DeleteExistingFiles=false');
  const dir = temp();
  writeFileSync(join(dir, 'Shop.csproj'), '<Project><ProjectTypeGuids>{349c5851-65df-11da-9384-00065b846f21}</ProjectTypeGuids></Project>');
  const crew = (physicalPath) => dotnetCrew(dir, { win: true, iisSites: () => [{ site: 'Shop', physicalPath }], msbuild: () => 'msbuild' }).procs[0].iis.build;
  assert.match(crew(join(dir, 'publish-debug')), /\/p:Configuration=Debug .*\/p:PublishUrl="publish-debug"/);
  assert.match(crew(join(dir, 'out', 'site')), /\/p:Configuration=Release .*\/p:PublishUrl="out[\\/]site"/);
  assert.equal(crew(dir), '"msbuild" "Shop.csproj" /restore /p:RestorePackagesConfig=true /nologo /v:m');
});
