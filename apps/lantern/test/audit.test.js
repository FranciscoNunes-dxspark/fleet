// The judges, the median, the HTML read without a browser, --fail-on, Compare's rows and the report. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a11yFindings, assemble, consoleFindings, formatMetric, linkFindings, linksToCheck, median, medianVitals, rating, seoFindings, vitalsFindings, wcagOf, weightFindings, weightOf } from '../src/audit.js';
import { htmlFacts } from '../src/html.js';
import { failures, parseFailOn } from '../src/failon.js';
import { compareRows, compareSentence, delta, markdownReport, requestContext } from '../src/share.js';
import { withoutIgnored } from '../src/security.js';
import { normalUrl, pathOf } from '../src/pages.js';

const rules = (list) => list.map((f) => f.rule);

test('metrics: words, ratings by Google\'s thresholds, the median of the runs', () => {
  assert.deepEqual([formatMetric('lcp', 1840), formatMetric('ttfb', 420), formatMetric('cls', 0.123), formatMetric('inp', 0), formatMetric('lcp', null)], ['1.8 s', '420 ms', '0.12', '<16 ms', '—']);
  assert.deepEqual([rating('lcp', 2500), rating('lcp', 2600), rating('lcp', 4100), rating('cls', 0.3)], ['good', 'needs-improvement', 'poor', 'poor']);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, null, 4]), 2.5);
  assert.equal(median([null]), null);
  const { vitals, samples } = medianVitals([{ vitals: { lcp: 1000, cls: 0.1 } }, { vitals: { lcp: 3000, cls: 0.3 } }, { vitals: { lcp: 2000, cls: 0.2, lcpElement: 'img' } }]);
  assert.deepEqual([vitals.lcp, vitals.cls, vitals.lcpElement, samples.lcp], [2000, 0.2, 'img', [1000, 3000, 2000]]);
});

test('vitals past the thresholds: needs improvement medium, poor high; FCP a step milder', () => {
  const found = vitalsFindings({ lcp: 4200, cls: 0.12, inp: 150, ttfb: 900, fcp: 3500 }, { where: 'u', runs: 3 });
  assert.deepEqual(found.map((f) => [f.rule, f.severity]), [['lcp-slow', 'high'], ['cls-high', 'medium'], ['ttfb-slow', 'medium'], ['fcp-slow', 'medium']]);
  assert.match(found[0].title, /LCP is 4\.2 s \(poor, good is 2\.5 s or less\)/);
  assert.equal(found[1].excerpt, 'Lab value, the median of 3 runs');
});

test('weight, render-blocking, images without a size and in old formats', () => {
  const requests = [
    { type: 'document', url: 'https://s/', size: 20_000 },
    { type: 'script', url: 'https://s/app.js', size: 1_400_000 },
    { type: 'image', url: 'https://s/hero.png', size: 500_000, mime: 'image/png' },
    { type: 'image', url: 'https://s/ok.webp', size: 500_000, mime: 'image/webp' },
    { type: 'document', url: 'http://s/', size: 0, redirect: true },
  ];
  const weight = weightOf(requests);
  assert.deepEqual([weight.total, weight.count, weight.byType.script], [2_420_000, 4, 1_400_000]);
  const facts = { blocking: [{ kind: 'script', url: 'https://s/app.js' }], images: [{ src: 'https://s/hero.png', selector: '#hero' }, { src: 'https://s/ok.webp', width: '10', height: '10' }] };
  const found = weightFindings({ weight, requests, facts }, { where: 'https://s/' });
  assert.deepEqual(rules(found), ['script-heavy', 'render-blocking', 'image-no-dimensions', 'image-old-format']);
  assert.match(found[1].excerpt, /without async or defer, 1\.4 MB/);
  assert.equal(found[2].selector, '#hero');
});

test("axe's violations: impact to severity, the WCAG criterion, the first element and how to fix it", () => {
  assert.equal(wcagOf(['cat.color', 'wcag2aa', 'wcag143']), 'WCAG 1.4.3 (AA)');
  assert.equal(wcagOf(['wcag21aa', 'wcag1410']), 'WCAG 1.4.10 (AA)');
  assert.equal(wcagOf(['best-practice']), 'best practice');
  const found = a11yFindings([{ id: 'color-contrast', impact: 'serious', help: 'Contrast', helpUrl: 'https://deque/cc', tags: ['wcag2aa', 'wcag143'], nodes: 3, targets: [{ selector: '.price', summary: 'Fix any of the following:\n  Element has insufficient color contrast' }] }], { where: 'u' });
  assert.deepEqual([found[0].severity, found[0].selector, found[0].wcag, found[0].title], ['high', '.price', 'WCAG 1.4.3 (AA)', 'Contrast (3 elements)']);
  assert.match(found[0].fix, /insufficient color contrast \(https:\/\/deque\/cc\)/);
  assert.deepEqual(a11yFindings({ error: 'x' }), []);
});

test('SEO and basics, console errors, broken links', () => {
  assert.deepEqual(rules(seoFindings({ title: null, description: null, canonical: null, robots: 'noindex, nofollow', lang: null, viewport: null, h1: 0 }, { where: 'u' })), ['title-missing', 'description-missing', 'canonical-missing', 'noindex', 'lang-missing', 'viewport-missing', 'h1-missing']);
  assert.deepEqual(rules(seoFindings({ title: 'A title long enough', description: 'd', canonical: 'c', lang: 'en', viewport: 'v', h1: 1 }, { where: 'u' })), []);
  assert.deepEqual(rules(seoFindings({ title: 'x'.repeat(70), description: 'd', canonical: 'c', lang: 'en', viewport: 'v', h1: 1 })), ['title-length']);
  const errors = consoleFindings([{ source: 'console', text: 'a' }, { source: 'console', text: 'a' }, { source: 'exception', text: 'TypeError' }], { where: 'u' });
  assert.deepEqual(errors.map((f) => f.severity), ['low', 'medium']);
  const links = linkFindings({ checked: 2, broken: [{ url: 'https://s/x', status: 404 }, { url: 'https://other/y', error: 'ENOTFOUND' }] }, { where: 'https://s/' });
  assert.deepEqual(links.map((f) => f.severity), ['medium', 'low']);
  assert.deepEqual(linksToCheck(['https://other/a', 'https://s/b', 'https://s/'], 'https://s/'), ['https://s/b', 'https://other/a']);
});

test('assemble: a page without runs has no lab numbers, says why, and is still judged on its HTML and headers', () => {
  const facts = htmlFacts('<html><head><title>Hello there friend</title><script src="/a.js"></script><link rel="stylesheet" href="/s.css" media="print"></head><body><img src="x.png" width="1" height="1"><a href="/b#top">b</a><a href="mailto:x">m</a></body></html>', 'https://s/p');
  assert.deepEqual([facts.title, facts.lang, facts.blocking.map((b) => b.url), facts.links], ['Hello there friend', null, ['https://s/a.js'], ['https://s/b']]);
  const r = assemble({ url: 'https://s/p', facts, note: 'No Chrome', security: { findings: [{ rule: 'csp-missing', severity: 'medium', title: 'No CSP', where: 'https://s/p' }] }, at: 5 });
  assert.equal(r.lab, false);
  assert.equal(r.vitals, null);
  assert.equal(r.note, 'No Chrome');
  assert.ok(rules(r.findings).includes('lang-missing') && rules(r.findings).includes('csp-missing'));
  assert.equal(r.findings.find((f) => f.rule === 'csp-missing').category, 'security');
  const failed = assemble({ url: 'https://s/', runs: [{ error: 'net::ERR' }] });
  assert.equal(failed.error, 'net::ERR');
  assert.deepEqual(rules(withoutIgnored(r.findings, ['csp-missing', 'lang-missing:https://s/p'])).filter((x) => x === 'csp-missing' || x === 'lang-missing'), []);
});

test('--fail-on: levels, categories with axe\'s words, metrics with units, and what fails', () => {
  assert.deepEqual(parseFailOn('a11y:serious, perf:lcp>2.5s, cls>0.1, perf:weight>2mb, high').terms.map((t) => [t.category ?? t.metric ?? null, t.level ?? t.over]), [['a11y', 'high'], ['lcp', 2500], ['cls', 0.1], ['weight', 2_000_000], [null, 'high']]);
  assert.deepEqual(parseFailOn('none').terms, []);
  assert.match(parseFailOn('ux:high').error, /categories are perf, a11y, seo, security/);
  assert.match(parseFailOn('sometimes').error, /a level is/);
  const result = { vitals: { lcp: 2900, cls: 0.05 }, weight: { total: 1_000_000 }, findings: [{ category: 'a11y', severity: 'medium' }, { category: 'security', severity: 'high' }] };
  assert.deepEqual(failures(result, parseFailOn('a11y:serious,perf:lcp>2.5s,perf:cls>0.1,security:high').terms), ['LCP 2.9 s > 2.5 s (perf:lcp>2.5s)', '1 finding at security:high']);
  assert.deepEqual(failures(result, parseFailOn('a11y:moderate').terms), ['1 finding at a11y:moderate']);
});

test('Compare: the rows, the changes and the sentence; a request for Hail; the report', () => {
  const a = { url: 'https://staging.s/', env: 'staging', at: 1, vitals: { lcp: 1800, cls: 0.02, inp: 100, ttfb: 400, fcp: 1000 }, weight: { total: 2_000_000, count: 10 }, findings: [{ category: 'a11y', severity: 'high' }] };
  const b = { url: 'https://s/', env: 'prod', at: 2, vitals: { lcp: 2900, cls: 0.02, inp: 100, ttfb: 800, fcp: 1000 }, weight: { total: 1_500_000, count: 10 }, findings: [] };
  assert.equal(compareSentence(a, b), 'staging LCP is 1.8 s, prod 2.9 s; TTFB 400 ms against 800 ms (lab numbers).');
  const rows = compareRows(a, b);
  assert.deepEqual(rows.find((r) => r.id === 'lcp'), { id: 'lcp', label: 'LCP', a: '1.8 s', b: '2.9 s', delta: '+1.1 s (61% worse)', worse: true });
  assert.equal(rows.find((r) => r.id === 'weight').delta, '−500 kB (25% lighter)');
  assert.equal(rows.find((r) => r.id === 'a11y').delta, '−1');
  assert.equal(delta('cls', 0.02, 0.021), 'about the same');
  const runs = compareSentence({ ...a, env: undefined, url: 'https://s/', at: 1 }, { ...b, env: undefined, at: 2 });
  assert.match(runs, /^s, earlier LCP is 1\.8 s, s, latest 2\.9 s/);
  assert.deepEqual(requestContext({ method: 'GET', url: 'https://s/app.js?v=2', type: 'script', status: 200, start: 10, end: 60 }), { method: 'GET', url: 'https://s/app.js?v=2', headers: {}, body: '', name: 'script app.js', app: 'lantern', response: { status: 200, ms: 50 } });
  const md = markdownReport([{ ...a, findings: [{ severity: 'high', category: 'a11y', title: 'Contrast | low', selector: '.p', fix: 'Darker', wcag: 'WCAG 1.4.3 (AA)' }] }], { name: 'shop', when: new Date(0) });
  assert.match(md, /\| staging https:\/\/staging\.s\/ \| 1\.8 s \| 0\.02 \| 100 ms \| 400 ms \| 2\.0 MB \| 1 high \|/);
  assert.match(md, /\| HIGH \| a11y \| Contrast \\\| low \(WCAG 1\.4\.3 \(AA\)\) \| `\.p` \| Darker \|/);
});

test('URLs as typed', () => {
  assert.equal(normalUrl('shop.example/x'), 'https://shop.example/x');
  assert.equal(normalUrl('http://a.b'), 'http://a.b/');
  assert.equal(normalUrl('ftp://a.b'), null);
  assert.equal(normalUrl(''), null);
  assert.equal(pathOf('https://a.b/c?d=1'), '/c?d=1');
});
