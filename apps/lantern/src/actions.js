// Every user-facing operation, written once: keys and slash commands call these with `ctx` (App's).
import { existsSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { contextIn, copiedNote, describeContext, notMine, takeLine } from '@fleet/kit/family.js';
import { resolveFolder, samePath } from '@fleet/kit/folders.js';
import { describeEnvironments, setEnvironment } from '@fleet/kit/environments.js';
import { findingsLine, findingsText } from '@fleet/kit/findings.js';
import { domainLines } from '@fleet/kit/webchecks.js';
import { THEMES, applyTheme, isColour, setAccent, theme } from './theme.js';
import { configFile } from './config.js';
import { CATEGORY_LABEL, bytes, formatMetric, vitalsLine } from './audit.js';
import { normalUrl, pathOf } from './pages.js';
import { compareRows, compareSentence, markdownReport, requestContext } from './share.js';
import { sarifOf } from './security.js';
import { VERSION } from './app.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The pages the folder names (lantern.json, the project's environments), read again; the ones /open added stay. */
export function loadPages(ctx) {
  const r = ctx.provider.pages(ctx.cwd());
  ctx.setPages(r.pages, r.domains);
  for (const e of r.errors) ctx.note(e, 'error');
  return r;
}

/** A page from what was typed: its name or URL among the pages, else a URL, else the selected page. */
export function pageFrom(ctx, text = '') {
  const t = text.trim();
  if (!t) return ctx.selectedPage();
  const pages = ctx.pages;
  const env = ctx.env?.name;
  const named = pages.filter((p) => p.url === t || p.name === t || `${p.env}:${p.name}` === t || p.env === t);
  if (named.length) return named.find((p) => p.env === env) ?? named[0];
  const url = normalUrl(t);
  return url ? pages.find((p) => p.url === url) ?? { name: pathOf(url), url } : null;
}

/** a, ↵ and /audit: the page measured in a headless Chrome (three runs, the median), axe-core, the links, the headers and the certificate. */
export async function audit(ctx, target) {
  const page = typeof target === 'object' && target ? target : pageFrom(ctx, target ?? '');
  if (!page) return ctx.note(ctx.pages.length ? `No page ${target}: a URL, or a page's name.` : 'No page to audit: /open <url>, or name them in lantern.json or .fleet/project.json.', 'error') ?? false;
  const runs = Math.max(1, Math.min(9, Number(ctx.config.runs) || 3));
  let result;
  const r = await ctx.task(
    `audit ${page.url}`,
    async (signal) => {
      result = await ctx.provider.audit(page.url, { runs, override: ctx.config.chrome, signal, name: page.name, env: page.env, onProgress: ctx.progress, links: ctx.config.checkLinks !== false });
      if (result.error && !result.findings.length) throw new Error(result.error);
      ctx.addResult(result);
      const lines = [`${findingsLine(result.counts) || 'nothing found'}`, result.lab ? `${vitalsLine(result.vitals)} (lab, median of ${result.runs})` : result.note ?? 'no lab numbers'];
      if (result.error) lines.push(result.error);
      return { stdout: lines.join('\n') };
    },
    { label: 'Auditing' },
  );
  if (!r.ok) return false;
  ctx.logActivity(`Audited ${page.url}: ${findingsLine(result.counts) || 'nothing found'}${result.lab ? `, LCP ${formatMetric('lcp', result.vitals.lcp)}` : ''}`);
  return true;
}

/** alt+a and /audit all: every page, one after another. */
export async function auditAll(ctx) {
  for (const p of [...ctx.pages]) if (!(await audit(ctx, p))) return false;
  return true;
}

/** /open <url>: a page of its own for this session, selected and audited. */
export function open(ctx, text = '') {
  const url = normalUrl(text);
  if (!url) return ctx.note('/open needs a URL: /open https://shop.example/', 'error') ?? false;
  const page = ctx.addPage({ name: pathOf(url), url });
  ctx.setView('findings');
  return audit(ctx, page);
}

/** s and /security: the headers, cookies, certificate, mixed content and source maps of a page, without a browser. */
export async function security(ctx, target = '') {
  const page = typeof target === 'object' && target ? target : pageFrom(ctx, target);
  if (!page) return ctx.note('/security needs a page or a URL.', 'error') ?? false;
  const r = await ctx.task(`security ${page.url}`, async (signal) => {
    const s = await ctx.provider.security(page.url, { signal });
    ctx.showText(`Security of ${page.url}`, findingsText(s.findings, { header: `${page.url} → ${s.final ?? '?'} (${s.status ?? s.error})\n` }));
    return { stdout: findingsLine(countOf(s.findings)) || 'nothing found' };
  }, { label: 'Checking' });
  return r.ok;
}

const countOf = (list) => list.reduce((c, f) => ({ ...c, [f.severity]: (c[f.severity] ?? 0) + 1 }), {});

/** /domains [host]: DNS, the redirects from http:// and the bare domain, https, the certificate, for every host the pages are on (or one). */
export async function domains(ctx, host = '') {
  const hosts = host.trim() ? [host.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '')] : ctx.hosts;
  if (!hosts.length) return ctx.note('No hosts: /domains <host>, or name pages in lantern.json or .fleet/project.json.', 'error') ?? false;
  ctx.setView('domains');
  const r = await ctx.task(`domains ${hosts.join(', ')}`, async (signal) => {
    const lines = [];
    for (const h of hosts) {
      ctx.progress(h);
      const d = await ctx.provider.domain(h, { signal });
      ctx.setDomain(d);
      lines.push(`${h}: ${findingsLine(countOf(d.findings)) || 'nothing found'}${d.days !== null ? `, certificate ${d.days} days` : ''}`);
    }
    return { stdout: lines.join('\n') };
  }, { label: 'Checking domains' });
  if (r.ok) ctx.logActivity(`Checked ${plural(hosts.length, 'domain')}: ${hosts.join(', ')}`);
  return r.ok;
}

/** ↵ on a domain: its records, redirects, https, certificate and findings. */
export function showDomain(ctx, d) {
  const findings = d.findings.length ? ['', ...findingsText(d.findings).trimEnd().split('\n')] : ['', 'Nothing found.'];
  ctx.showText(d.host, [...domainLines(d), ...findings].join('\n'));
}

/** ↵ on a finding: what, where, why, how to fix. */
export function showFinding(ctx, f) {
  const lines = [
    f.title,
    '',
    `Severity  ${f.severity}${f.impact ? ` (axe: ${f.impact})` : ''}`,
    `Category  ${CATEGORY_LABEL[f.category] ?? f.category}`,
    `Rule      ${f.rule}${f.wcag ? `  ·  ${f.wcag}` : ''}`,
    `Where     ${f.host ? `${f.host} (${f.where})` : f.where}`,
    ...(f.selector ? [`Element   ${f.selector}`] : []),
    ...(f.selectors?.length > 1 ? f.selectors.slice(1).map((s) => `          ${s}`) : []),
    ...(f.url ? [`URL       ${f.url}`] : []),
    ...(f.excerpt ? ['', `Seen: ${f.excerpt}`] : []),
    ...(f.why ? ['', `Why: ${f.why}`] : []),
    ...(f.fix ? ['', `Fix: ${f.fix}`] : []),
    ...(f.metric && f.category === 'perf' ? ['', 'A lab number: a headless Chrome on this machine, not what visitors measure (field data).'] : []),
  ];
  ctx.showText(f.rule, lines.join('\n'));
}

/** ↵ on a request in the Waterfall: hands it to Hail, as a `request` context, to send again and look at. */
export function shareRequest(ctx, req) {
  const line = takeLine('request', requestContext(req));
  ctx.copy(line, 'a request for Hail');
  ctx.note(copiedNote('hail', line));
  return true;
}

/** t on a page: the page and how many findings it has, as a `page` context another Lantern (or Fleet) takes. */
export function sharePage(ctx, page) {
  const result = ctx.resultFor(page.url);
  const data = { url: page.url, ...(page.env ? { env: page.env } : {}), ...(result ? { findings: result.findings.length } : {}) };
  const line = takeLine('page', data);
  ctx.copy(line, 'the page');
  ctx.note(`Copied ${describeContext({ kind: 'page', data })}: /take it in Lantern to audit it.`);
  return true;
}

/** /take: a page (a URL to audit); anything else says whose it is. */
export function take(ctx, text) {
  const context = contextIn(text);
  if (!context) return ctx.note('/take needs what a sibling copied: a family:v1:… line.', 'error') ?? false;
  if (context.kind === 'page') return open(ctx, String(context.data.url ?? ''));
  return ctx.note(notMine('lantern', context), 'error') ?? false;
}

/** x on a finding: its rule left out on this page (asks; kept in the settings as `ignore`, rule or rule:where). */
export async function ignore(ctx, f) {
  const id = `${f.rule}:${f.where}`;
  const yes = await ctx.confirm({ title: `Ignore ${f.rule} on ${f.where}?`, detail: `It stays out of the list, the counts and lantern audit's exit code. /unignore puts it back; kept in ${configFile()}.` });
  if (!yes) return false;
  ctx.setConfig((c) => ({ ...c, ignore: [...new Set([...(c.ignore ?? []), id])] }));
  ctx.note(`Ignoring ${id}`, 'ok');
  return true;
}

/** /unignore [rule|all]: back in the list; alone, says what's ignored. */
export function unignore(ctx, id = '') {
  const list = ctx.config.ignore ?? [];
  const t = id.trim();
  if (!t) return ctx.note(list.length ? `Ignored: ${list.join(', ')}. /unignore <rule> or /unignore all.` : 'Nothing is ignored.');
  const next = /^all$/i.test(t) ? [] : list.filter((x) => x !== t && !x.startsWith(`${t}:`));
  if (next.length === list.length) return ctx.note(`${t} isn't ignored.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, ignore: next }));
  ctx.note(next.length ? `Not ignoring ${t} any more.` : 'Nothing is ignored now.', 'ok');
  return true;
}

/**
 * /compare [a] [b]: the Compare view on two pages: environments' names (the selected page's path in
 * each), URLs, or `last` for the selected page's previous run against its latest.
 */
export function compare(ctx, text = '') {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    ctx.setView('compare');
    return true;
  }
  if (words[0] === 'last' || words[0] === 'runs') {
    ctx.setCompare({ mode: 'runs' });
    ctx.setView('compare');
    return true;
  }
  const sel = ctx.selectedPage();
  const pick = (w) => {
    const env = ctx.pages.find((p) => p.env === w && sel && pathOf(p.url) === pathOf(sel.url)) ?? ctx.pages.find((p) => p.env === w);
    return env ?? pageFrom(ctx, w);
  };
  const a = words.length > 1 ? pick(words[0]) : sel;
  const b = pick(words.at(-1));
  if (!a || !b) return ctx.note(`Compare what with what? Environments (${[...new Set(ctx.pages.map((p) => p.env).filter(Boolean))].join(', ') || 'none named'}), URLs, or last.`, 'error') ?? false;
  ctx.setCompare({ mode: 'pages', a: a.url, b: b.url });
  ctx.setView('compare');
  return true;
}

/** y in Compare: the comparison as text. */
export function compareText(a, b) {
  return [compareSentence(a, b), '', ...compareRows(a, b).map((r) => `${r.label.padEnd(16)}${r.a.padStart(12)}${r.b.padStart(12)}  ${r.delta}`)].join('\n');
}

/** /chrome [path|auto]: the browser Lantern drives; alone, says which. */
export function chrome(ctx, text = '') {
  const t = text.trim();
  if (!t) {
    const b = ctx.provider.browser({ override: ctx.config.chrome });
    return ctx.note(b ? `Chrome: ${b.path}${ctx.config.chrome ? ' (from the settings)' : ' (found)'}. /chrome <path> names another, /chrome auto looks again.` : `No Chrome, Edge or Chromium found${ctx.config.chrome ? ` at ${ctx.config.chrome}` : ''}. /chrome <path> names one.`);
  }
  if (t === 'auto') {
    ctx.setConfig((c) => {
      const { chrome: _drop, ...rest } = c;
      return rest;
    });
    return ctx.note('Chrome: looked for in the usual places.', 'ok') ?? true;
  }
  if (!existsSync(t)) return ctx.note(`There's no ${t}.`, 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, chrome: t }));
  ctx.note(`Chrome: ${t}`, 'ok');
  return true;
}

/** /runs [n]: how many times a page is measured (the median is shown). */
export function runs(ctx, text = '') {
  const n = Number(text.trim());
  if (!text.trim()) return ctx.note(`Each page is measured ${ctx.config.runs ?? 3} times, and the median shown: lab numbers are noisy. /runs <1-9> changes it.`);
  if (!Number.isInteger(n) || n < 1 || n > 9) return ctx.note('/runs takes 1 to 9.', 'error') ?? false;
  ctx.setConfig((c) => ({ ...c, runs: n }));
  ctx.note(`Measuring each page ${plural(n, 'time')}.`, 'ok');
  return true;
}

/** /sarif [file]: every audited page's findings as SARIF (lantern.sarif unless named), asking before replacing one. */
export async function sarif(ctx, file = '') {
  const results = ctx.latestResults();
  if (!results.length) return ctx.note('Nothing audited yet: a audits the selected page.', 'error') ?? false;
  const name = file.trim() || 'lantern.sarif';
  const path = isAbsolute(name) ? name : resolve(ctx.cwd(), name);
  if (ctx.provider.name !== 'demo' && existsSync(path) && !(await ctx.confirm({ title: `Replace ${name}?`, detail: path, danger: true }))) return false;
  const list = results.flatMap((r) => ctx.shownFindings(r));
  ctx.provider.writeFile(path, `${JSON.stringify(sarifOf(list, VERSION), null, 2)}\n`);
  ctx.note(`${plural(list.length, 'result')} in ${path}`, 'ok');
  return true;
}

/** /report [file]: the audited pages as Markdown, shown to copy, or written to a file. */
export function report(ctx, file = '') {
  const results = ctx.latestResults();
  if (!results.length) return ctx.note('Nothing audited yet: a audits the selected page.', 'error') ?? false;
  const md = markdownReport(results.map((r) => ({ ...r, findings: ctx.shownFindings(r) })), { name: basename(ctx.cwd()) });
  if (!file.trim()) return ctx.showText('Report', md) ?? true;
  const path = isAbsolute(file.trim()) ? file.trim() : resolve(ctx.cwd(), file.trim());
  ctx.provider.writeFile(path, md);
  ctx.note(`Report in ${path}`, 'ok');
  return true;
}

/** /env [name]: the project's environment; a name switches every app of the family to it (and selects its first page here). */
export function env(ctx, name = '') {
  if (!name.trim()) return ctx.note(describeEnvironments(ctx.cwd()));
  const r = setEnvironment(ctx.cwd(), name, { by: 'lantern' });
  if (!r.ok) return ctx.note(r.error, 'error') ?? false;
  const first = ctx.pages.findIndex((p) => p.env === r.env.name);
  if (first >= 0) ctx.select(first);
  ctx.note(`Environment: ${r.env.name}${r.env.prod ? ' (production)' : ''}, for every app.`, 'ok');
  return true;
}

/** /move <folder>: another folder's pages. */
export function move(ctx, folder = '') {
  const dir = ctx.cwd();
  if (!folder.trim()) return ctx.note(`Reading ${dir}. /move <folder> reads another (one beside this, in it, or a path).`);
  const target = resolveFolder(dir, folder);
  if (!target) return ctx.note(`There's no folder ${folder.trim()} here or beside ${basename(dir)}.`, 'error') ?? false;
  if (samePath(target, dir)) return ctx.note(`Lantern is reading ${basename(target)} already.`);
  ctx.moveTo(target);
  loadPages(ctx);
  return true;
}

/** o: the page (or a finding's help, a request's URL) in the browser. */
export function openInBrowser(ctx, url) {
  ctx.openUrl(url);
  ctx.note(`Opening ${url}`);
  return true;
}

/** ! and /run: a shell command in the folder. */
export async function raw(ctx, command) {
  if (!command) return ctx.note('Type a command after !, e.g. !curl -I https://shop.example/', 'error') ?? false;
  const r = await ctx.task(command, (signal) => ctx.provider.run(command, { cwd: ctx.cwd(), signal }), { label: 'Running' });
  return r.ok;
}

/** ↵ on a request in the Waterfall when Hail isn't wanted: what it was. */
export function requestLines(req) {
  return [`${req.method} ${req.url}`, `${req.status ?? '—'} ${req.mime ?? ''}`, `${req.type}, ${bytes(req.size ?? 0)}, ${req.start} ms → ${req.end ?? '?'} ms`].join('\n');
}

/** /theme: dark, light or auto; with no argument says which. */
export function setTheme(ctx, value) {
  if (!value) return ctx.note(`Theme: ${ctx.config.theme ?? 'auto'} (${theme.mode} here). /theme ${THEMES.join('|')} changes it.`);
  if (!THEMES.includes(value)) return ctx.note(`Theme is one of ${THEMES.join(', ')}.`, 'error') ?? false;
  const next = { ...ctx.config, theme: value };
  ctx.setConfig(next);
  applyTheme(next);
  ctx.note(`Theme: ${value}`);
  return true;
}

/** /accent: a #rrggbb colour, or `default`. */
export function accent(ctx, value) {
  if (!value) return ctx.note(`Accent: ${ctx.config.accent ?? 'default'} (${theme.accent}). /accent #rrggbb changes it.`);
  if (value !== 'default' && !isColour(value)) return ctx.note('An accent is #rrggbb, or "default".', 'error') ?? false;
  const next = { ...ctx.config };
  if (value === 'default') delete next.accent;
  else next.accent = value;
  ctx.setConfig(next);
  setAccent(next.accent);
  ctx.note(`Accent: ${value}`);
  return true;
}

/** /mouse: on or off. */
export function mouse(ctx, value) {
  if (!['on', 'off'].includes(value)) return ctx.note(`Mouse is ${ctx.config.mouse === false ? 'off' : 'on'}. /mouse on|off changes it.`);
  ctx.setConfig({ ...ctx.config, mouse: value === 'on' });
  ctx.note(`Mouse: ${value}${value === 'off' ? ' (the terminal selects text again)' : ''}`);
  return true;
}

/** /settings: what's set, and where it's kept. */
export function settings(ctx) {
  const c = ctx.config;
  const on = (v) => (v === false ? 'off' : 'on');
  const b = ctx.provider.browser({ override: c.chrome });
  ctx.showText(
    'Settings',
    [
      `Theme            ${c.theme ?? 'auto'} (${theme.mode} here)       /theme dark|light|auto`,
      `Accent colour    ${c.accent ?? 'default'}       /accent #rrggbb`,
      `Mouse            ${on(c.mouse)}       /mouse on|off`,
      `Chrome           ${c.chrome ?? 'found'}: ${b ? b.path : 'none'}       /chrome <path>|auto (or LANTERN_CHROME)`,
      `Runs per page    ${c.runs ?? 3}       /runs <1-9> (the median is shown)`,
      `Links checked    ${on(c.checkLinks)}       "checkLinks" in the file (each page's links get a HEAD request)`,
      `Ignored          ${(c.ignore ?? []).join(', ') || 'none'}       x in Findings, /unignore`,
      `Update checks    ${on(c.checkForUpdates)}       "checkForUpdates" in the file`,
      `Auto-update      ${on(c.autoUpdate)}       "autoUpdate" in the file`,
      `History          ${(c.history ?? []).length} lines`,
      '',
      `Kept in ${configFile()}; the last ${3} audits of each page in runs.json beside it.`,
    ].join('\n'),
  );
  return true;
}
