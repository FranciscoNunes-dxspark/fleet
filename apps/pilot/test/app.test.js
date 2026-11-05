// Pilot's own window (`pilot app`): the recent projects, the folder browser and pickers, a session
// that opens, closes and switches projects through the API, the window's browser and its lifecycle,
// and the installer's shortcuts onto it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindowArgs, createSession, findAppBrowser, handler, lifecycle } from '../src/web/server.js';
import { describeFolder, forgetProject, listFolders, pickFolder, pickerKind, pinProject, projectFolder, recentProjects, rememberProject } from '../src/web/projects.js';
import { pageHtml } from '../src/web/page.js';

const SHOP = fileURLToPath(new URL('./fixtures/shop', import.meta.url));

function tempEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-app-'));
  return { dir, env: { PILOT_CACHE: join(dir, 'cache') }, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Calls the handler as a server would: a GET, or a POST with a JSON body and Pilot's header. */
function call(serve, url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((ok) => {
    const req = Object.assign(new EventEmitter(), { method, url, headers: { host: 'localhost:4170', ...(method === 'POST' ? { 'x-pilot': '1' } : {}), ...headers } });
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      writeHead(status, headers) {
        this.status = status;
        Object.assign(this.headers, headers);
        return this;
      },
      write() {},
      end(b) {
        const text = String(b ?? '');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // The page.
        }
        ok({ status: this.status, body: text, json });
      },
    };
    serve(req, res);
    if (method === 'POST') {
      req.emit('data', JSON.stringify(body ?? {}));
      req.emit('end');
    }
  });
}

test('the recent projects: newest first, pinned ones above, forgotten, missing ones marked', () => {
  const t = tempEnv();
  try {
    const a = join(t.dir, 'A');
    const b = join(t.dir, 'B');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(b, 'Shop.sln'), '');
    assert.deepEqual(recentProjects(t.env), []);
    rememberProject(a, t.env);
    rememberProject(b, t.env);
    assert.deepEqual(recentProjects(t.env).map((p) => p.name), ['Shop', 'A'], 'the solution names B');
    pinProject(a, true, t.env);
    rememberProject(b, t.env);
    assert.deepEqual(recentProjects(t.env).map((p) => [p.name, p.pinned]), [['A', true], ['Shop', false]]);
    rememberProject(a, t.env);
    assert.equal(recentProjects(t.env).length, 2, 'never twice');
    rmSync(b, { recursive: true });
    assert.equal(recentProjects(t.env).find((p) => p.name === 'Shop').missing, true);
    forgetProject(b, t.env);
    assert.deepEqual(recentProjects(t.env).map((p) => p.name), ['A']);
    for (let i = 0; i < 20; i++) rememberProject(join(t.dir, `p${i}`), t.env);
    assert.equal(recentProjects(t.env).length, 15, 'a list of 15 at most');
  } finally {
    t.done();
  }
});

test('a folder as the start page shows it, and what a path given means', () => {
  assert.deepEqual(describeFolder(join(SHOP, 'Shop.Web')), { name: 'Shop.Web', solution: null, web: true });
  assert.equal(describeFolder(join(SHOP, 'nope')).web, false);
  assert.equal(projectFolder(SHOP), SHOP);
  assert.equal(projectFolder(`"${SHOP}"`), SHOP, 'quotes pasted with the path');
  assert.equal(projectFolder(join(SHOP, 'Shop.Web', 'Shop.Web.csproj')), join(SHOP, 'Shop.Web'), 'a file opens its folder (a .sln)');
  assert.equal(projectFolder(join(SHOP, 'nope')), null);
  assert.equal(projectFolder(''), null);
});

test('the folder browser: folders sorted, build output and hidden ones left out, projects marked', () => {
  const t = tempEnv();
  try {
    for (const d of ['b', 'A', 'node_modules', '.git', 'obj', 'Web']) mkdirSync(join(t.dir, d));
    mkdirSync(join(t.dir, 'Web', 'Views'));
    writeFileSync(join(t.dir, 'file.txt'), '');
    const l = listFolders(t.dir);
    assert.deepEqual(l.folders.map((f) => f.name), ['A', 'b', 'Web']);
    assert.equal(l.folders.find((f) => f.name === 'Web').web, true);
    assert.equal(l.parent, dirname(t.dir));
    assert.match(listFolders(join(t.dir, 'nope')).error, /Not a folder/);
  } finally {
    t.done();
  }
});

test('the system folder picker: which there is, its answer, a cancel, and none', async () => {
  assert.equal(pickerKind('win32'), 'windows');
  assert.equal(pickerKind('darwin'), 'macos');
  assert.equal(pickerKind('linux', () => true, { PATH: '/usr/bin' }), null, 'no display, no picker');
  assert.equal(pickerKind('linux', (p) => p.endsWith('kdialog'), { DISPLAY: ':0', PATH: '/usr/bin' }), 'kdialog');
  const ran = [];
  const fake = (out, err = null) => (cmd, args, opts, cb) => {
    ran.push([cmd, args, opts.env.PILOT_PICK_START]);
    cb(err, out);
  };
  assert.equal(await pickFolder({ kind: 'zenity', start: SHOP, run: fake(`${SHOP}/\n`) }), SHOP);
  assert.deepEqual(ran[0].slice(0, 2), ['zenity', ['--file-selection', '--directory', '--title=Open a project folder', `--filename=${SHOP}/`]]);
  assert.equal(await pickFolder({ kind: 'windows', start: SHOP, run: fake(SHOP) }), SHOP);
  assert.equal(ran[1][0], 'powershell');
  assert.equal(ran[1][2], SHOP, 'where the dialog starts goes in the environment, not the script');
  assert.match(ran[1][1].at(-1), /FileOpenDialog|IFileDialog/);
  assert.equal(await pickFolder({ kind: 'macos', run: fake('', Object.assign(new Error('cancelled'), { code: 1 })) }), null);
  assert.deepEqual(await pickFolder({ kind: 'kdialog', run: fake('', Object.assign(new Error('no'), { code: 'ENOENT' })) }), { unsupported: true });
  assert.deepEqual(await pickFolder({ kind: null }), { unsupported: true });
});

test('a session: no project, then one opened, switched and closed through the API', async () => {
  const t = tempEnv();
  try {
    const session = createSession({ env: t.env, watchFiles: false, app: true, picker: null });
    const serve = handler({ session, port: () => 4170 });
    let r = await call(serve, '/api/project');
    assert.equal(r.json.root, null);
    assert.equal(r.json.app, true);
    r = await call(serve, '/api/overview');
    assert.equal(r.status, 409, 'a view with no project');
    assert.equal(r.json.noProject, true);
    r = await call(serve, '/');
    assert.equal(r.status, 200);
    assert.match(r.body, /<title>Pilot<\/title>/);
    // The picker isn't there: the UI browses folders itself.
    r = await call(serve, '/api/action/pick', { method: 'POST' });
    assert.deepEqual(r.json, { unsupported: true });
    r = await call(serve, `/api/dirs?path=${encodeURIComponent(SHOP)}`);
    assert.deepEqual(r.json.folders.map((f) => f.name), ['Shop.Core', 'Shop.Web']);
    // Opening: a folder, or a file in it.
    r = await call(serve, '/api/action/open', { method: 'POST', body: { path: join(SHOP, 'Shop.Web', 'Shop.Web.csproj') } });
    assert.equal(r.json.root, join(SHOP, 'Shop.Web'));
    r = await call(serve, '/api/action/open', { method: 'POST', body: { path: SHOP } });
    assert.equal(r.json.root, SHOP);
    assert.ok(r.json.stats.files > 10);
    assert.deepEqual(r.json.recent.map((p) => p.path), [SHOP, join(SHOP, 'Shop.Web')]);
    r = await call(serve, '/api/overview');
    assert.equal(r.status, 200);
    r = await call(serve, '/');
    assert.match(r.body, /<title>shop - Pilot<\/title>/);
    r = await call(serve, '/api/action/open', { method: 'POST', body: { path: join(SHOP, 'nope') } });
    assert.match(r.json.error, /no folder/);
    assert.equal(session.root(), SHOP, 'a failed open leaves the project open');
    // Actions on the project need one; actions on the session need the header too.
    r = await call(serve, '/api/action/open', { method: 'POST', body: { path: SHOP }, headers: { 'x-pilot': '' } });
    assert.equal(r.status, 403);
    r = await call(serve, '/api/action/close', { method: 'POST' });
    assert.equal(r.json.root, null);
    r = await call(serve, '/api/action/rename', { method: 'POST', body: { from: 'a', to: 'b' } });
    assert.equal(r.status, 409);
    r = await call(serve, '/api/action/forget', { method: 'POST', body: { path: SHOP } });
    assert.deepEqual(r.json.recent.map((p) => p.path), [join(SHOP, 'Shop.Web')]);
    r = await call(serve, '/api/action/toString', { method: 'POST' });
    assert.equal(r.status, 404, 'only the actions themselves');
  } finally {
    t.done();
  }
});

test('a fixed project (pilot ui) can\'t be closed, and only the window quits', async () => {
  const t = tempEnv();
  try {
    const session = createSession({ root: SHOP, env: t.env, watchFiles: false });
    const serve = handler({ session, port: () => 4170 });
    const r = await call(serve, '/api/action/quit', { method: 'POST' });
    assert.match(r.json.error, /ctrl\+c/);
    let quit = 0;
    const win = createSession({ env: t.env, watchFiles: false, app: true });
    win.quit = () => quit++;
    await call(handler({ session: win, port: () => 4170 }), '/api/action/quit', { method: 'POST' });
    await new Promise((ok) => setTimeout(ok, 150));
    assert.equal(quit, 1);
  } finally {
    t.done();
  }
});

test('the window\'s lifecycle: it stops once its last window has gone, not on a reload', async () => {
  let quit = 0;
  const watching = lifecycle(() => quit++, { grace: 40, wait: 1000 });
  watching(1);
  watching(-1);
  watching(1); // a reload: back within the grace
  await new Promise((ok) => setTimeout(ok, 80));
  assert.equal(quit, 0);
  watching(-1);
  await new Promise((ok) => setTimeout(ok, 80));
  assert.equal(quit, 1);
  // A window that never connects (the browser didn't start): it stops after the wait.
  let never = 0;
  lifecycle(() => never++, { grace: 10, wait: 30 });
  await new Promise((ok) => setTimeout(ok, 60));
  assert.equal(never, 1);
});

test('the window\'s browser: Edge on Windows, else Chrome, as an app window in a profile of its own', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const env = { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PROGRAMFILES: 'C:\\Program Files' };
  const has = (...paths) => (p) => paths.some((x) => p.replace(/\//g, '\\') === x || p === x);
  assert.equal(findAppBrowser(env, 'win32', has(edge, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).replace(/\//g, '\\'), edge);
  assert.match(findAppBrowser(env, 'win32', has('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')), /chrome\.exe$/);
  assert.equal(findAppBrowser({ PILOT_BROWSER: '/x/brave' }, 'linux', () => false), '/x/brave');
  assert.equal(findAppBrowser({ PATH: '' }, 'linux', () => false), null);
  const args = appWindowArgs('http://127.0.0.1:4170/', '/c/app-profile');
  assert.ok(args.includes('--app=http://127.0.0.1:4170/'));
  assert.ok(args.includes('--user-data-dir=/c/app-profile'));
  assert.ok(args.includes('--no-first-run'));
});

test('the page knows the project and the window', () => {
  const html = pageHtml({ root: 'C:\\src\\<Shop>', name: '<Shop>', version: '1.2.3', app: true, picker: true });
  assert.match(html, /<title>&lt;Shop&gt; - Pilot<\/title>/);
  assert.match(html, /"app":true,"picker":true/);
  assert.ok(!html.includes('<Shop>'), 'names escaped');
});

test('the installer opens Pilot\'s window: the Start menu, folders and solutions in Explorer', () => {
  const iss = readFileSync(fileURLToPath(new URL('../installer/Pilot.iss', import.meta.url)), 'utf8');
  assert.match(iss, /Name: "\{userprograms\}\\Pilot"; Filename: "\{app\}\\pilot\.exe"; Parameters: "app"/);
  assert.match(iss, /Directory\\shell\\Pilot\\command"; ValueType: string; ValueData: """\{app\}\\pilot\.exe"" app --root ""%V\\\."""/);
  assert.match(iss, /SystemFileAssociations\\\.sln\\shell\\Pilot\\command"; ValueType: string; ValueData: """\{app\}\\pilot\.exe"" app --root ""%1"""/);
  assert.ok(!/ProjectFolder|Parameters: "ui"/.test(iss), 'no project asked for at install time');
});
