// What is wrong with a page, from what was measured: the judges for performance, accessibility, SEO and
// the basics, and `assemble`, which puts a page's runs, its links and its security checks into the one
// result the views, the headless commands and the history read. Pure: browser.js, html.js and the kit's
// webchecks.js do the measuring.
//
// Findings are in the kit's findings.js shape ({ rule, severity, title, where, why, fix, excerpt? }) with
// `category` (perf, a11y, seo, security) and, where there is one, `selector`, `wcag`, `metric`, `value`,
// `helpUrl`. `where` is the page's URL.
import { countFindings, sortFindings } from '@fleet/kit/findings.js';

export const CATEGORIES = ['perf', 'a11y', 'seo', 'security'];
export const CATEGORY_LABEL = { perf: 'Performance', a11y: 'Accessibility', seo: 'SEO and basics', security: 'Security' };
export const CATEGORY_SHORT = { perf: 'perf', a11y: 'a11y', seo: 'seo ', security: 'sec ' };

// Google's thresholds: up to the first is good, past the second is poor.
export const THRESHOLDS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500], ttfb: [800, 1800], fcp: [1800, 3000] };
export const METRICS = [
  { id: 'lcp', label: 'LCP', name: 'Largest Contentful Paint' },
  { id: 'cls', label: 'CLS', name: 'Cumulative Layout Shift' },
  { id: 'inp', label: 'INP', name: 'Interaction to Next Paint' },
  { id: 'ttfb', label: 'TTFB', name: 'Time to First Byte' },
  { id: 'fcp', label: 'FCP', name: 'First Contentful Paint' },
];
// Past these, the page weighs too much: medium, then high.
export const WEIGHT = { total: [3_000_000, 6_000_000], script: [1_000_000, 2_500_000] };
const LINKS_MAX = 40;

/** A metric as a person reads it: 1.8 s, 340 ms, 0.04; INP 0 (a click nothing slowed) as "<16 ms". */
export function formatMetric(id, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (id === 'cls') return value.toFixed(2);
  if (id === 'inp' && value === 0) return '<16 ms';
  if (id === 'weight') return bytes(value);
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

/** 1.2 MB, 340 kB, 512 B. */
export function bytes(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1000) return `${Math.round(n / 1000)} kB`;
  return `${n} B`;
}

/** good, needs-improvement or poor for a metric's value; null without one. */
export function rating(id, value) {
  const t = THRESHOLDS[id];
  if (!t || value === null || value === undefined) return null;
  return value > t[1] ? 'poor' : value > t[0] ? 'needs-improvement' : 'good';
}

/** The median of the numbers in `list` (nulls left out), or null. */
export function median(list) {
  const xs = list.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/** The vitals of several runs: each metric's median, and every run's value as `samples`. */
export function medianVitals(runs) {
  const samples = Object.fromEntries(METRICS.map((m) => [m.id, runs.map((r) => r.vitals?.[m.id] ?? null)]));
  const vitals = Object.fromEntries(METRICS.map((m) => [m.id, median(samples[m.id])]));
  vitals.lcpElement = runs.find((r) => r.vitals?.lcpElement)?.vitals.lcpElement ?? null;
  return { vitals, samples };
}

/** What the requests weigh, over the wire: { total, count, byType: { type: bytes } }. */
export function weightOf(requests = []) {
  const byType = {};
  let total = 0;
  for (const r of requests) {
    if (r.redirect) continue;
    byType[r.type] = (byType[r.type] ?? 0) + (r.size ?? 0);
    total += r.size ?? 0;
  }
  return { total, count: requests.filter((r) => !r.redirect).length, byType };
}

const finding = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== ''));

const VITAL_TEXT = {
  lcp: { why: 'The main content shows late: people wait, and leave.', fix: 'Serve the largest element sooner: a smaller or preloaded hero image, less render-blocking CSS and JS, a faster server.' },
  cls: { why: 'Things move while people read and tap: they lose their place or press the wrong thing.', fix: 'Give images, ads and embeds their size up front (width and height, aspect-ratio), and never insert content above what is shown.' },
  inp: { why: 'The page is slow to answer a click or a key: it feels broken.', fix: 'Break up long tasks, do less in event handlers, and defer what the first paint does not need.' },
  ttfb: { why: 'The server takes long to answer before anything can start.', fix: 'Cache the page (a CDN, output caching), and make the server-side work behind it cheaper.' },
  fcp: { why: 'Nothing shows for a while after the request.', fix: 'Inline the critical CSS, defer scripts, and cut the redirects and server time before the first byte.' },
};

/** Vitals past Google's thresholds: needs improvement is medium, poor is high (FCP a step milder). Rules lcp-slow, cls-high, inp-slow, ttfb-slow, fcp-slow. */
export function vitalsFindings(vitals, { where, runs = 1 } = {}) {
  if (!vitals) return [];
  const out = [];
  const rule = { lcp: 'lcp-slow', cls: 'cls-high', inp: 'inp-slow', ttfb: 'ttfb-slow', fcp: 'fcp-slow' };
  for (const m of METRICS) {
    const v = vitals[m.id];
    const r = rating(m.id, v);
    if (!r || r === 'good') continue;
    const severity = m.id === 'fcp' ? (r === 'poor' ? 'medium' : 'low') : r === 'poor' ? 'high' : 'medium';
    out.push(
      finding({
        rule: rule[m.id],
        category: 'perf',
        severity,
        title: `${m.label} is ${formatMetric(m.id, v)} (${r === 'poor' ? 'poor' : 'needs improvement'}, good is ${formatMetric(m.id, THRESHOLDS[m.id][0])} or less)`,
        where,
        metric: m.id,
        value: v,
        excerpt: m.id === 'lcp' && vitals.lcpElement ? `Largest element: ${vitals.lcpElement}` : `Lab value, the median of ${runs} run${runs === 1 ? '' : 's'}`,
        why: VITAL_TEXT[m.id].why,
        fix: VITAL_TEXT[m.id].fix,
      }),
    );
  }
  return out;
}

const fileOf = (url) => {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).at(-1) ?? u.host;
  } catch {
    return String(url);
  }
};

/** Too heavy (all of it, or its JavaScript), render-blocking scripts and styles, images without their size or in old formats. */
export function weightFindings({ weight, requests = [], facts }, { where } = {}) {
  const out = [];
  if (weight) {
    for (const [key, label] of [['total', 'The page'], ['script', 'Its JavaScript']]) {
      const n = key === 'total' ? weight.total : weight.byType.script ?? 0;
      const [warn, bad] = WEIGHT[key];
      if (n > warn) out.push(finding({ rule: key === 'total' ? 'page-heavy' : 'script-heavy', category: 'perf', severity: n > bad ? 'high' : 'medium', title: `${label} weighs ${bytes(n)}${key === 'total' ? ` over ${weight.count} requests` : ''}`, where, metric: key === 'total' ? 'weight' : undefined, value: n, excerpt: Object.entries(weight.byType).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, b]) => `${t} ${bytes(b)}`).join(' · '), why: 'Every byte is time on a slow connection, and data on a metered one.', fix: key === 'total' ? 'Compress images (WebP, AVIF), split the JavaScript and load what is below the fold later.' : 'Split the bundle by route, drop what is unused, and defer what the first paint does not need.' }));
    }
  }
  for (const b of facts?.blocking ?? []) {
    const r = requests.find((q) => q.url === b.url);
    out.push(finding({ rule: 'render-blocking', category: 'perf', severity: 'low', title: `${fileOf(b.url)} blocks the first paint`, where, url: b.url, excerpt: `${b.kind === 'script' ? '<script> in <head> without async or defer' : '<link rel="stylesheet"> in <head>'}${r?.size ? `, ${bytes(r.size)}` : ''}`, why: 'The browser draws nothing until it has fetched and run it.', fix: b.kind === 'script' ? 'Add defer (or async), or move it to the end of <body>.' : 'Inline the CSS the first screen needs and load the rest without blocking (media="print" onload, or preload).' }));
  }
  const images = facts?.images ?? [];
  const noSize = images.filter((i) => !(i.width && i.height) && !i.styled);
  for (const img of noSize.slice(0, 10)) out.push(finding({ rule: 'image-no-dimensions', category: 'perf', severity: 'low', title: `${fileOf(img.src)} has no width and height`, where, selector: img.selector, url: img.src, why: 'The browser can\'t keep its space before it loads, so the page shifts when it does (CLS).', fix: 'Give the <img> width and height attributes (or a CSS aspect-ratio).' }));
  for (const r of requests.filter((q) => q.type === 'image' && /image\/(jpeg|png|gif|bmp)/i.test(q.mime ?? '') && (q.size ?? 0) > 100_000).slice(0, 10)) {
    out.push(finding({ rule: 'image-old-format', category: 'perf', severity: 'low', title: `${fileOf(r.url)} is a ${bytes(r.size)} ${r.mime.replace('image/', '').toUpperCase()}`, where, url: r.url, why: 'WebP and AVIF are usually a quarter to a half the size for the same picture.', fix: 'Serve WebP or AVIF (a <picture> with the old format as the fallback), sized for where it shows.' }));
  }
  return out;
}

const IMPACT = { critical: 'critical', serious: 'high', moderate: 'medium', minor: 'low' };

/** WCAG 1.4.3 (AA), from axe's tags (wcag143, wcag2aa); null when it names no criterion. */
export function wcagOf(tags = []) {
  const crit = tags.map((t) => /^wcag(\d)(\d)(\d+)$/.exec(t)).find(Boolean);
  const level = tags.map((t) => /^wcag2\d?(a{1,3})$/.exec(t)).find(Boolean)?.[1]?.toUpperCase();
  if (!crit && !level) return tags.includes('best-practice') ? 'best practice' : null;
  return `${crit ? `WCAG ${crit[1]}.${crit[2]}.${crit[3]}` : 'WCAG'}${level ? ` (${level})` : ''}`;
}

/** axe-core's violations as findings: impact critical, serious, moderate, minor as critical, high, medium, low; the rule is axe's id. */
export function a11yFindings(axe, { where } = {}) {
  if (!Array.isArray(axe)) return [];
  return axe.map((v) =>
    finding({
      rule: v.id,
      category: 'a11y',
      severity: IMPACT[v.impact] ?? 'medium',
      impact: v.impact,
      title: `${v.help}${v.nodes > 1 ? ` (${v.nodes} elements)` : ''}`,
      where,
      selector: v.targets?.[0]?.selector,
      selectors: v.targets?.map((t) => t.selector),
      wcag: wcagOf(v.tags),
      excerpt: v.targets?.[0]?.html,
      why: v.description,
      fix: `${String(v.targets?.[0]?.summary ?? '').split('\n').filter(Boolean).slice(0, 2).join(' ')}${v.helpUrl ? ` (${v.helpUrl})` : ''}`.trim(),
      helpUrl: v.helpUrl,
    }),
  );
}

/** The basics a search engine and a browser read: title, description, canonical, robots, lang, viewport, one h1. */
export function seoFindings(facts, { where } = {}) {
  if (!facts) return [];
  const out = [];
  const add = (f) => out.push(finding({ category: 'seo', where, ...f }));
  if (!facts.title) add({ rule: 'title-missing', severity: 'medium', title: 'No <title>', why: 'Search results and tabs show the address instead of a name.', fix: 'Give the page a <title> of 10 to 60 characters that says what it is.' });
  else if (facts.title.length > 60 || facts.title.length < 10) add({ rule: 'title-length', severity: 'low', title: `The title is ${facts.title.length} characters`, excerpt: facts.title, why: facts.title.length > 60 ? 'Search results cut it short at about 60.' : 'Too short to say what the page is.', fix: 'Keep it between 10 and 60 characters.' });
  if (!facts.description) add({ rule: 'description-missing', severity: 'low', title: 'No meta description', why: 'Search results make up their own snippet from the page.', fix: '<meta name="description" content="…"> of 50 to 160 characters.' });
  if (!facts.canonical) add({ rule: 'canonical-missing', severity: 'low', title: 'No canonical link', why: 'The same page under several addresses (query strings, www or not) splits its ranking.', fix: '<link rel="canonical" href="the page\'s one address">' });
  if (/noindex/i.test(facts.robots ?? '')) add({ rule: 'noindex', severity: 'medium', title: 'The page asks not to be indexed', excerpt: `robots: ${facts.robots}`, why: 'Search engines leave it out: right for staging, wrong in production.', fix: 'Take noindex out of the robots meta tag where the page should be found.' });
  if (!facts.lang) add({ rule: 'lang-missing', severity: 'medium', title: 'No lang on <html>', why: 'Screen readers guess the language (and pronounce it wrongly); translation and search guess too.', fix: '<html lang="en"> (or the page\'s language).' });
  if (!facts.viewport) add({ rule: 'viewport-missing', severity: 'medium', title: 'No viewport meta tag', why: 'Phones draw it as a shrunken desktop page.', fix: '<meta name="viewport" content="width=device-width, initial-scale=1">' });
  if (facts.h1 === 0) add({ rule: 'h1-missing', severity: 'low', title: 'No <h1>', why: 'The page has no main heading for search engines and screen readers to start from.', fix: 'One <h1> saying what the page is.' });
  return out;
}

/** Errors in the console while the page loaded: one finding per distinct message, ten at most. */
export function consoleFindings(errors = [], { where } = {}) {
  const seen = new Map();
  for (const e of errors) if (!seen.has(e.text)) seen.set(e.text, e);
  return [...seen.values()].slice(0, 10).map((e) => finding({ rule: 'console-error', category: 'seo', severity: e.source === 'exception' ? 'medium' : 'low', title: `${e.source === 'exception' ? 'Uncaught' : 'Console error'}: ${e.text.slice(0, 120)}`, where, excerpt: e.url ? `${e.text} (${e.url})` : e.text, why: 'Something on the page failed: a feature may not work.', fix: 'Open the page with the developer tools and fix the error at its source.' }));
}

/** Links that answer 404, 410 or 5xx, or not at all: on the same site medium, elsewhere low. */
export function linkFindings(links, { where } = {}) {
  if (!links?.broken) return [];
  const origin = (() => {
    try {
      return new URL(where).origin;
    } catch {
      return '';
    }
  })();
  return links.broken.map((l) => {
    const same = l.url.startsWith(origin);
    return finding({ rule: 'broken-link', category: 'seo', severity: same ? 'medium' : 'low', title: `A link ${l.status ? `answers ${l.status}` : "doesn't answer"}: ${l.url.slice(0, 100)}`, where, url: l.url, excerpt: l.error ?? `${l.status}`, why: same ? 'People (and search engines) following it land on an error.' : 'A link to another site leads nowhere now.', fix: same ? 'Fix the link or redirect the old address.' : 'Update or remove the link.' });
  });
}

/** The links worth checking on a page: http(s), the same site's first, at most `max`. */
export function linksToCheck(links = [], pageUrl, max = LINKS_MAX) {
  let origin = '';
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    // Not a URL: every link is elsewhere.
  }
  const same = links.filter((l) => l.startsWith(origin) && l !== pageUrl);
  const other = links.filter((l) => !l.startsWith(origin));
  return [...same, ...other].slice(0, max);
}

/** Whether an answer to a link means it's broken: 404, 410, 5xx, or none at all (403 and 429 are a site turning robots away). */
export const isBroken = (res) => Boolean(res.error) || res.status === 404 || res.status === 410 || res.status >= 500;

/** Security findings (the kit's webchecks) in Lantern's shape: the category, `where` the page. */
export const securityFindings = (list = [], { where } = {}) => list.map((f) => ({ ...f, category: 'security', where: f.where ?? where, host: f.where !== where ? f.where : undefined }));

/**
 * A page's result: { url, name?, env?, at, chrome, runs, lab, vitals, samples, weight, requests, facts,
 * console, a11y, links, security, findings, counts, note?, error? }. `runs` are browser.js's raw runs
 * (the first's requests and facts are kept, axe from whichever has it), or none without a browser, when
 * `facts` come from html.js. `security` is webchecks' checkSite result, `links` { checked, broken }.
 */
export function assemble({ url, name, env, runs = [], facts: htmlOnly = null, links = null, security = null, chrome = null, note, at = Date.now() }) {
  const ok = runs.filter((r) => !r.error);
  const first = ok[0] ?? null;
  const { vitals, samples } = ok.length ? medianVitals(ok) : { vitals: null, samples: null };
  const requests = first?.requests ?? [];
  const weight = first ? weightOf(requests) : null;
  const facts = first?.facts ?? htmlOnly;
  const axe = ok.find((r) => r.axe)?.axe ?? null;
  const consoleErrors = first?.console ?? [];
  const where = url;
  const findings = sortFindings([
    ...vitalsFindings(vitals, { where, runs: ok.length }),
    ...weightFindings({ weight, requests, facts }, { where }),
    ...a11yFindings(axe, { where }),
    ...seoFindings(facts, { where }),
    ...consoleFindings(consoleErrors, { where }),
    ...linkFindings(links, { where }),
    ...securityFindings(security?.findings, { where }),
  ]);
  const errors = runs.filter((r) => r.error).map((r) => r.error);
  return {
    url,
    ...(name ? { name } : {}),
    ...(env ? { env } : {}),
    at,
    chrome,
    lab: Boolean(ok.length),
    runs: ok.length,
    vitals,
    samples,
    weight,
    requests,
    facts,
    console: consoleErrors,
    a11y: axe?.error ? { error: axe.error } : axe ? { violations: axe.length } : null,
    links,
    security: security ? { final: security.final, status: security.status, chain: security.chain, httpChain: security.httpChain, cert: security.cert, error: security.error } : null,
    findings,
    counts: countFindings(findings),
    ...(note ? { note } : {}),
    ...(errors.length && !ok.length ? { error: errors[0] } : {}),
  };
}

/** A result's findings in one category ('all' for every one) at `min` severity or worse. */
export function filterFindings(list, { category = 'all', min = 'all' } = {}) {
  const order = ['critical', 'high', 'medium', 'low', 'unknown'];
  return list.filter((f) => (category === 'all' || f.category === category) && (min === 'all' || order.indexOf(f.severity) <= order.indexOf(min)));
}

/** "LCP 1.8 s · CLS 0.04 · INP <16 ms", the vitals in a line. */
export const vitalsLine = (vitals) => (vitals ? METRICS.slice(0, 4).map((m) => `${m.label} ${formatMetric(m.id, vitals[m.id])}`).join(' · ') : 'no lab numbers (no browser)');
