// One run of a page in the headless browser, over the DevTools protocol (cdp.js): a fresh tab, the
// vitals observed from inside the page, every request in the order it went, console errors, a scripted
// click for INP, what the page's DOM says (title, description, canonical, robots, lang, images, links,
// what blocks the first paint) and, when asked, axe-core run in the page. Returns the raw run that
// audit.js judges; nothing here decides what is wrong.

// Put in the page before its own scripts: the Core Web Vitals as the browser reports them (LCP, CLS as
// its largest session window, INP as the longest interaction, FCP), on window.__lantern.
export const VITALS_SCRIPT = `(() => {
  const v = window.__lantern = { lcp: null, lcpElement: null, cls: 0, inp: null, fcp: null };
  const describe = (el) => { try { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList && el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : ''); } catch { return null; } };
  const watch = (type, fn, opts = {}) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...opts }); } catch {} };
  watch('largest-contentful-paint', (e) => { v.lcp = e.startTime; v.lcpElement = e.element ? describe(e.element) : e.url || null; });
  let session = 0, first = 0, last = 0;
  watch('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    if (session && e.startTime - last < 1000 && e.startTime - first < 5000) session += e.value;
    else { session = e.value; first = e.startTime; }
    last = e.startTime;
    v.cls = Math.max(v.cls, session);
  });
  watch('event', (e) => { if (e.interactionId) v.inp = Math.max(v.inp || 0, e.duration); }, { durationThreshold: 16 });
  watch('first-input', (e) => { v.inp = Math.max(v.inp || 0, e.duration); });
  watch('paint', (e) => { if (e.name === 'first-contentful-paint') v.fcp = e.startTime; });
})();`;

// Read after the load: the vitals so far, TTFB from the navigation's timing, and the DOM's facts.
export const FACTS_SCRIPT = `(() => {
  const v = window.__lantern || {};
  const nav = performance.getEntriesByType('navigation')[0];
  const meta = (name) => document.querySelector('meta[name="' + name + '" i]')?.getAttribute('content') ?? null;
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      const sibs = e.parentElement ? [...e.parentElement.children].filter((c) => c.tagName === e.tagName) : [];
      if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(e) + 1) + ')';
      parts.unshift(p);
      if (e.id) { parts[0] = '#' + CSS.escape(e.id); break; }
    }
    return parts.join(' > ');
  };
  const head = document.head;
  return {
    vitals: { lcp: v.lcp, lcpElement: v.lcpElement, cls: v.cls, inp: v.inp, fcp: v.fcp, ttfb: nav ? nav.responseStart : null },
    title: document.title || null,
    description: meta('description'),
    robots: meta('robots'),
    viewport: meta('viewport'),
    canonical: document.querySelector('link[rel="canonical" i]')?.href ?? null,
    lang: document.documentElement.getAttribute('lang'),
    h1: document.querySelectorAll('h1').length,
    images: [...document.images].slice(0, 200).map((img) => ({ src: img.currentSrc || img.src, selector: sel(img), width: img.getAttribute('width'), height: img.getAttribute('height'), styled: Boolean(img.style.width && img.style.height) || getComputedStyle(img).aspectRatio !== 'auto', lazy: img.loading === 'lazy' })),
    links: [...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/.test(h)).map((h) => h.split('#')[0]))].slice(0, 300),
    blocking: head ? [
      ...[...head.querySelectorAll('script[src]')].filter((s) => !s.async && !s.defer && s.type !== 'module').map((s) => ({ kind: 'script', url: s.src })),
      ...[...head.querySelectorAll('link[rel="stylesheet" i]')].filter((l) => !l.media || l.media === 'all' || matchMedia(l.media).matches).map((l) => ({ kind: 'stylesheet', url: l.href })),
    ] : [],
  };
})()`;

// Run in the page once axe-core is in it: the violations, each with its nodes' selectors.
export const AXE_RUN = `axe.run(document, { resultTypes: ['violations'] }).then((r) => r.violations.map((v) => ({
  id: v.id, impact: v.impact, help: v.help, description: v.description, helpUrl: v.helpUrl,
  tags: v.tags, nodes: v.nodes.length,
  targets: v.nodes.slice(0, 5).map((n) => ({ selector: [].concat(n.target).join(' '), summary: n.failureSummary, html: String(n.html || '').slice(0, 160) })),
})))`;

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    }, { once: true });
  });

const RESOURCE_TYPES = { Document: 'document', Script: 'script', Stylesheet: 'stylesheet', Image: 'image', Font: 'font', Media: 'media', XHR: 'fetch', Fetch: 'fetch' };

/**
 * One run of `url` in a new tab of the browser `client` is connected to: { vitals, requests, facts,
 * console, axe?, error? }. `axeSource` is axe-core's text, injected only when given. Waits for the load
 * event (up to `timeout`) and then for the network to be quiet for half a second (up to 5 s more).
 */
export async function runPage(client, url, { axeSource = null, signal, timeout = 30_000, width = 1350, height = 940, interact = true, now = () => Date.now() } = {}) {
  const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => client.send(method, params, sessionId);
  const requests = new Map();
  const consoleErrors = [];
  const offs = [];
  const on = (method, fn) => offs.push(client.on(method, fn, sessionId));
  let lastActivity = now();
  let loaded = false;
  let main = null;
  on('Network.requestWillBeSent', (p) => {
    lastActivity = now();
    const was = requests.get(p.requestId);
    // A redirect reuses the request's id: the hop before is kept as a request of its own.
    if (was && p.redirectResponse) requests.set(`${p.requestId}:${was.url}`, { ...was, status: p.redirectResponse.status, end: p.timestamp, redirect: true });
    requests.set(p.requestId, { id: p.requestId, url: p.request.url, method: p.request.method, type: RESOURCE_TYPES[p.type] ?? 'other', start: p.timestamp, end: null, status: null, size: 0, mime: null, priority: p.request.initialPriority ?? null });
    if (p.type === 'Document' && !main) main = p.requestId;
  });
  on('Network.responseReceived', (p) => {
    lastActivity = now();
    const r = requests.get(p.requestId);
    if (r) Object.assign(r, { status: p.response.status, mime: p.response.mimeType, protocol: p.response.protocol ?? null, fromCache: Boolean(p.response.fromDiskCache), timing: p.response.timing ? { receiveHeadersEnd: p.response.timing.receiveHeadersEnd, sendStart: p.response.timing.sendStart } : null });
  });
  on('Network.loadingFinished', (p) => {
    lastActivity = now();
    const r = requests.get(p.requestId);
    if (r) Object.assign(r, { end: p.timestamp, size: p.encodedDataLength ?? 0 });
  });
  on('Network.loadingFailed', (p) => {
    lastActivity = now();
    const r = requests.get(p.requestId);
    if (r) Object.assign(r, { end: p.timestamp, failed: p.errorText ?? 'failed', blocked: p.blockedReason ?? null });
  });
  on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push({ source: 'console', text: (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
  });
  on('Runtime.exceptionThrown', (p) => consoleErrors.push({ source: 'exception', text: String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'Uncaught exception').split('\n')[0].slice(0, 300) }));
  on('Log.entryAdded', (p) => {
    if (p.entry?.level === 'error') consoleErrors.push({ source: p.entry.source ?? 'browser', text: String(p.entry.text ?? '').slice(0, 300), url: p.entry.url });
  });
  on('Page.loadEventFired', () => {
    loaded = true;
  });
  try {
    await Promise.all([send('Page.enable'), send('Network.enable'), send('Runtime.enable'), send('Log.enable')]);
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: VITALS_SCRIPT });
    const nav = await send('Page.navigate', { url });
    if (nav.errorText) return { error: `${url}: ${nav.errorText}` };
    const until = now() + timeout;
    while (!loaded && now() < until) await sleep(100, signal);
    if (!loaded) return { error: `${url} didn't finish loading within ${timeout / 1000} s` };
    const quietBy = now() + 5000;
    while (now() - lastActivity < 500 && now() < quietBy) await sleep(100, signal);
    if (interact) {
      // A click where nothing is likely to navigate (the page's top-left corner), and a key: INP needs an interaction.
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 4, y: height - 4, button: 'left', clickCount: 1 });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
      await sleep(300, signal);
    }
    const facts = (await send('Runtime.evaluate', { expression: FACTS_SCRIPT, returnByValue: true })).result?.value ?? {};
    let axe = null;
    if (axeSource) {
      await send('Runtime.evaluate', { expression: axeSource });
      const r = await send('Runtime.evaluate', { expression: AXE_RUN, awaitPromise: true, returnByValue: true });
      axe = r.exceptionDetails ? { error: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0] } : r.result?.value ?? [];
    }
    const list = [...requests.values()].sort((a, b) => a.start - b.start);
    const t0 = list[0]?.start ?? 0;
    return {
      vitals: { ...facts.vitals, inp: facts.vitals?.inp ?? (interact ? 0 : null) },
      facts: { ...facts, vitals: undefined },
      requests: list.map((r) => ({ ...r, start: Math.round((r.start - t0) * 1000), end: r.end ? Math.round((r.end - t0) * 1000) : null, main: r.id === main && !r.redirect })),
      console: consoleErrors,
      axe,
    };
  } finally {
    for (const off of offs) off();
    await client.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}
