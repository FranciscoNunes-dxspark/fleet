// The browser side without a browser: the CDP client over a stand-in socket, one run of a page against a
// fake Chrome speaking the few DevTools methods Lantern uses, finding and starting Chrome with a fake
// spawn, and the provider end to end with that fake browser and a local HTTP server on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { cdpClient } from '../src/cdp.js';
import { AXE_RUN, FACTS_SCRIPT, VITALS_SCRIPT, runPage } from '../src/browser.js';
import { chromeArgs, chromeCandidates, findChrome, launchChrome } from '../src/chrome.js';
import { axeSource, createLantern } from '../src/provider.js';

test('the CDP client: calls answered by id, errors, events by session, everything waiting rejected on close', async () => {
  const sent = [];
  const socket = { send: (s) => sent.push(JSON.parse(s)), close() {} };
  const client = cdpClient(socket);
  const got = [];
  client.on('Network.requestWillBeSent', (p) => got.push(p.n), 'S1');
  const a = client.send('Target.createTarget', { url: 'about:blank' });
  const b = client.send('Page.navigate', { url: 'x' }, 'S1');
  assert.deepEqual(sent.map((m) => [m.id, m.method, m.sessionId]), [[1, 'Target.createTarget', undefined], [2, 'Page.navigate', 'S1']]);
  socket.onmessage({ data: JSON.stringify({ id: 1, result: { targetId: 'T' } }) });
  socket.onmessage({ data: JSON.stringify({ id: 2, error: { message: 'Cannot navigate' } }) });
  assert.deepEqual(await a, { targetId: 'T' });
  await assert.rejects(b, /Page\.navigate: Cannot navigate/);
  socket.onmessage({ data: JSON.stringify({ method: 'Network.requestWillBeSent', params: { n: 1 }, sessionId: 'S1' }) });
  socket.onmessage({ data: JSON.stringify({ method: 'Network.requestWillBeSent', params: { n: 2 }, sessionId: 'S2' }) });
  assert.deepEqual(got, [1]);
  const c = client.send('Runtime.evaluate', {});
  socket.onclose();
  await assert.rejects(c, /closed the connection/);
});

/**
 * A fake Chrome: answers the methods runPage sends and, on Page.navigate, plays a page load's events
 * (a redirect, the document, a script, an image that fails, a console error, the load). `facts` and
 * `axe` are what the page's scripts would return.
 */
export function fakeBrowser({ facts, axe = [], navigateError } = {}) {
  const bus = new EventEmitter();
  const calls = [];
  const emit = (method, params) => queueMicrotask(() => bus.emit('event', { method, params, sessionId: 'S1' }));
  const client = {
    calls,
    async send(method, params = {}, sessionId) {
      calls.push([method, sessionId ?? null, method === 'Runtime.evaluate' ? params.expression.slice(0, 30) : params]);
      if (method === 'Target.createTarget') return { targetId: 'T1' };
      if (method === 'Target.attachToTarget') return { sessionId: 'S1' };
      if (method === 'Page.navigate') {
        if (navigateError) return { errorText: navigateError };
        const u = new URL(params.url);
        emit('Network.requestWillBeSent', { requestId: '1', type: 'Document', timestamp: 100, request: { url: `http://${u.host}/old`, method: 'GET' } });
        emit('Network.requestWillBeSent', { requestId: '1', type: 'Document', timestamp: 100.05, redirectResponse: { status: 301 }, request: { url: params.url, method: 'GET' } });
        emit('Network.responseReceived', { requestId: '1', response: { status: 200, mimeType: 'text/html' } });
        emit('Network.loadingFinished', { requestId: '1', timestamp: 100.3, encodedDataLength: 12000 });
        emit('Network.requestWillBeSent', { requestId: '2', type: 'Script', timestamp: 100.32, request: { url: `${u.origin}/app.js`, method: 'GET' } });
        emit('Network.responseReceived', { requestId: '2', response: { status: 200, mimeType: 'text/javascript' } });
        emit('Network.loadingFinished', { requestId: '2', timestamp: 100.6, encodedDataLength: 250000 });
        emit('Network.requestWillBeSent', { requestId: '3', type: 'Image', timestamp: 100.4, request: { url: `${u.origin}/gone.png`, method: 'GET' } });
        emit('Network.loadingFailed', { requestId: '3', timestamp: 100.45, errorText: 'net::ERR_ABORTED' });
        emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] });
        emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'fine' }] });
        emit('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: x is undefined\n    at app.js:1' } } });
        emit('Page.loadEventFired', {});
        return { frameId: 'F' };
      }
      if (method === 'Runtime.evaluate') {
        if (params.expression === FACTS_SCRIPT) return { result: { value: facts } };
        if (params.expression === AXE_RUN) return { result: { value: axe } };
        return { result: {} };
      }
      return {};
    },
    on(method, fn, sessionId) {
      const l = (m) => {
        if (m.method === method && (!sessionId || m.sessionId === sessionId)) fn(m.params, m.sessionId);
      };
      bus.on('event', l);
      return () => bus.off('event', l);
    },
    close() {
      calls.push(['close']);
    },
  };
  return client;
}

const FACTS = {
  vitals: { lcp: 1200, lcpElement: 'h1', cls: 0.01, inp: null, fcp: 800, ttfb: 150 },
  title: 'Home page of the test',
  description: 'A page',
  robots: null,
  viewport: 'width=device-width',
  canonical: 'http://x/',
  lang: 'en',
  h1: 1,
  images: [],
  links: [],
  blocking: [],
};

test('one run: the vitals script goes in first, the requests come back in order with the redirect kept, errors and facts, axe when given', async () => {
  const client = fakeBrowser({ facts: FACTS, axe: [{ id: 'label', impact: 'critical', help: 'Form elements must have labels', tags: ['wcag2a', 'wcag412'], nodes: 1, targets: [{ selector: '#q' }] }] });
  const run = await runPage(client, 'http://127.0.0.1:9/', { axeSource: 'window.axe = {}' });
  const methods = client.calls.map((c) => c[0]);
  assert.ok(methods.indexOf('Page.addScriptToEvaluateOnNewDocument') < methods.indexOf('Page.navigate'));
  assert.equal(client.calls.find((c) => c[0] === 'Page.addScriptToEvaluateOnNewDocument')[2].source, VITALS_SCRIPT);
  assert.ok(methods.includes('Input.dispatchMouseEvent'));
  assert.equal(methods.at(-1), 'Target.closeTarget');
  assert.deepEqual(run.requests.map((r) => [r.type, r.url.replace(/^http:\/\/127\.0\.0\.1:9/, ''), r.status, r.start, r.end, r.size, Boolean(r.redirect), r.main]), [
    ['document', '/old', 301, 0, 50, 0, true, false],
    ['document', '/', 200, 50, 300, 12000, false, true],
    ['script', '/app.js', 200, 320, 600, 250000, false, false],
    ['image', '/gone.png', null, 400, 450, 0, false, false],
  ]);
  assert.equal(run.requests[3].failed, 'net::ERR_ABORTED');
  assert.deepEqual(run.console.map((c) => c.text), ['boom', 'TypeError: x is undefined']);
  // No interaction slow enough to be an event entry: INP is under 16 ms, said as 0.
  assert.deepEqual(run.vitals, { ...FACTS.vitals, inp: 0 });
  assert.equal(run.facts.title, 'Home page of the test');
  assert.equal(run.axe[0].id, 'label');
  const without = await runPage(fakeBrowser({ facts: FACTS }), 'http://127.0.0.1:9/');
  assert.equal(without.axe, null);
  const failed = await runPage(fakeBrowser({ facts: FACTS, navigateError: 'net::ERR_NAME_NOT_RESOLVED' }), 'http://nowhere.invalid/');
  assert.match(failed.error, /ERR_NAME_NOT_RESOLVED/);
});

test('finding Chrome: the setting first, then the usual places; the flags; starting it reads its DevTools address', async () => {
  const there = new Set(['/usr/bin/chromium', '/opt/my/chrome']);
  const exists = (p) => there.has(p);
  assert.equal(findChrome({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, exists }), '/usr/bin/chromium');
  assert.equal(findChrome({ override: '/opt/my/chrome', exists }), '/opt/my/chrome');
  assert.equal(findChrome({ override: '/not/there', exists }), null);
  assert.equal(findChrome({ platform: 'linux', env: { PATH: '' }, exists: () => false }), null);
  assert.ok(chromeCandidates({ platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' } }).some((p) => p.endsWith('msedge.exe')));
  assert.ok(chromeCandidates({ platform: 'darwin', env: {} }).some((p) => p.includes('Google Chrome.app')));
  assert.ok(chromeArgs('/tmp/p', { root: true }).includes('--no-sandbox'));
  assert.ok(chromeArgs('/tmp/p', { root: false }).includes('--headless=new'));
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
  const started = launchChrome('/usr/bin/chromium', { spawnImpl: () => child });
  child.stderr.emit('data', Buffer.from('\nDevTools listening on ws://127.0.0.1:40123/devtools/browser/abc\n'));
  const { wsUrl, close } = await started;
  assert.equal(wsUrl, 'ws://127.0.0.1:40123/devtools/browser/abc');
  close();
});

test('axe-core comes from the package as text to put in the page', async () => {
  const source = await axeSource();
  assert.ok(source.length > 100_000);
  assert.match(source, /axe/);
});

test('the provider with a fake Chrome and a local server: three runs, the median, axe on the last, links and headers checked', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html', 'x-powered-by': 'PHP/8.1' }).end('<html><title>t</title></html>');
    else if (req.url === '/gone') res.writeHead(404).end();
    else res.writeHead(200).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const lcps = [1500, 900, 2700];
    let n = 0;
    const clients = [];
    const provider = createLantern({
      find: () => '/fake/chrome',
      launch: async () => ({ wsUrl: 'ws://fake', close: () => clients.push('closed') }),
      connect: async () => {
        const facts = () => ({ ...FACTS, links: [`${base}/ok`, `${base}/gone`], vitals: { ...FACTS.vitals, lcp: lcps[n++] } });
        const c = fakeBrowser({ facts: FACTS, axe: [] });
        const send = c.send;
        // Each run's facts carry the next LCP.
        c.send = async (method, params, s) => (method === 'Runtime.evaluate' && params.expression === FACTS_SCRIPT ? { result: { value: facts() } } : send(method, params, s));
        return c;
      },
      axe: async () => 'window.axe = {}',
    });
    const r = await provider.audit(`${base}/`, { runs: 3 });
    assert.equal(r.runs, 3);
    assert.equal(r.vitals.lcp, 1500);
    assert.deepEqual(r.samples.lcp, [1500, 900, 2700]);
    assert.equal(r.chrome, '/fake/chrome');
    assert.deepEqual(clients, ['closed']);
    assert.deepEqual(r.links.broken.map((l) => [l.url, l.status]), [[`${base}/gone`, 404]]);
    const rules = r.findings.map((f) => f.rule);
    for (const rule of ['broken-link', 'powered-by', 'csp-missing', 'console-error']) assert.ok(rules.includes(rule), rule);
    // Without a browser: no lab numbers, the reason given, the HTML read for the basics.
    const bare = await createLantern({ find: () => null }).audit(`${base}/`, { runs: 3 });
    assert.equal(bare.lab, false);
    assert.match(bare.note, /No Chrome, Edge or Chromium/);
    assert.equal(bare.facts.title, 't');
    assert.ok(bare.findings.some((f) => f.rule === 'lang-missing'));
    assert.ok(bare.findings.some((f) => f.rule === 'powered-by'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
