// What the running site says, through the Chrome or Edge on the machine: the element a selector
// finds and the rules that really style it (inspect), the CSS rules and script bytes a page really
// uses (coverage), what breaks sideways at each of the project's breakpoints (responsive), and
// screenshots of many pages at once, with a report (shots).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { design } from './audit.js';
import { changes } from './changes.js';
import { complexity } from './analysis.js';
import { SHOTS_DIR, findChrome, openBrowser, pagePath, pageUrl, shot, slugOf, withPage } from './shots.js';
import { selectorTokens } from './parse/script.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const at = (file, line) => (line ? `${file}:${line}` : file);
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const norm = (sel) => String(sel).replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').trim().toLowerCase();

/** A served URL (http://host/Content/site.css?v=1) as the project's file, and that file's sources. */
function servedFile(idx, url) {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '');
    // In whichever web project serves it: its wwwroot first, then its folder.
    const candidates = (idx.projects.length ? idx.projects : ['']).flatMap((proj) => [[proj, 'wwwroot', path], [proj, path]].map((parts) => parts.filter(Boolean).join('/')));
    for (const p of candidates) {
      const hit = idx.exists(p);
      if (hit) return { file: hit, sources: idx.sourcesOf(hit).map((s) => s.file) };
      const src = idx.sourcesOf(p);
      if (src.length) return { file: p, sources: src.map((s) => s.file) };
    }
  } catch {
    // Not a URL (an inline <style>).
  }
  return null;
}

/** Where a rule with this selector is written in the project's stylesheets: [file:line]. */
function ruleSource(idx, selector, files) {
  const want = norm(selector);
  const out = [];
  for (const f of files) {
    for (const r of idx.files.get(f)?.data?.rules ?? []) if (norm(r.selector).split(',').includes(want) || norm(r.selector) === want) out.push(at(f, r.line));
  }
  // Imported files too: a rule in site.css may be written in a LESS file site.less imports.
  if (!out.length) {
    for (const f of idx.files.values()) {
      if (f.kind !== 'style' || f.vendor || !f.data?.rules) continue;
      for (const r of f.data.rules) if (norm(r.selector).split(',').includes(want)) out.push(at(f.rel, r.line));
      if (out.length > 3) break;
    }
  }
  return out.slice(0, 3);
}

// ─── inspect ──────────────────────────────────────────────────────────────────────────────────

const COMPUTED = ['display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'border-top-width', 'border-top-style', 'border-top-color', 'border-radius', 'z-index', 'opacity', 'visibility', 'overflow-x', 'overflow-y', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'box-shadow', 'cursor'];

/** The real element(s) a selector finds on the running page: box, computed styles, and every rule that styles it, in cascade order, with what wins. */
export async function inspect(idx, target, selector, { url = null, width = 1280, mobile = false, cookies = [], browser = null } = {}) {
  const u = pageUrl(idx, target, url);
  if (u.error) return { data: { error: u.error }, text: u.error };
  const result = await withPage(u.url, async (s) => {
    const sheets = new Map();
    s.on((msg) => {
      if (msg.method === 'CSS.styleSheetAdded') sheets.set(msg.params.header.styleSheetId, msg.params.header);
    });
    await s('DOM.enable');
    await s('CSS.enable');
    const { root } = await s('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await s('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    const elements = [];
    for (const nodeId of nodeIds.slice(0, 3)) {
      const box = await s('DOM.getBoxModel', { nodeId }).catch(() => null);
      const { outerHTML } = await s('DOM.getOuterHTML', { nodeId });
      const { computedStyle } = await s('CSS.getComputedStyleForNode', { nodeId });
      const matched = await s('CSS.getMatchedStylesForNode', { nodeId });
      const rules = (matched.matchedCSSRules ?? []).map((m) => {
        const header = sheets.get(m.rule.styleSheetId);
        const served = header?.sourceURL ? servedFile(idx, header.sourceURL) : null;
        const line = m.rule.style?.range ? m.rule.style.range.startLine + 1 - (header?.startLine ?? 0) : null;
        const sel = m.rule.selectorList.selectors.filter((_, i) => m.matchingSelectors.includes(i)).map((x) => x.text).join(', ');
        return {
          selector: sel,
          origin: m.rule.origin,
          media: (m.rule.media ?? []).map((x) => x.text).join(' and ') || null,
          sheet: header?.sourceURL ?? (header?.isInline ? 'inline <style>' : null),
          served: served ? at(served.file, line) : null,
          source: served ? ruleSource(idx, sel, served.sources.length ? served.sources : [served.file]) : [],
          props: (m.rule.style?.cssProperties ?? []).filter((p) => p.text != null || p.range).map((p) => ({ name: p.name, value: p.value, important: !!p.important })),
        };
      });
      if (matched.inlineStyle?.cssProperties?.length) rules.push({ selector: 'style="…"', origin: 'inline', props: matched.inlineStyle.cssProperties.filter((p) => p.range).map((p) => ({ name: p.name, value: p.value, important: !!p.important })), source: [] });
      // The winner per property: the browser lists rules from weakest to strongest; !important beats the rest.
      const winner = new Map();
      rules.forEach((r, i) => r.props.forEach((p) => {
        const w = winner.get(p.name);
        if (!w || (p.important && !w.important) || (p.important === w.important)) winner.set(p.name, { rule: i, important: p.important });
      }));
      rules.forEach((r, i) => r.props.forEach((p) => {
        p.wins = winner.get(p.name)?.rule === i;
      }));
      const q = box?.model?.border;
      elements.push({
        html: outerHTML.replace(/\s+/g, ' ').slice(0, 240),
        box: q ? { x: Math.round(q[0]), y: Math.round(q[1]), width: Math.round(q[2] - q[0]), height: Math.round(q[5] - q[1]) } : null,
        computed: Object.fromEntries(computedStyle.filter((c) => COMPUTED.includes(c.name)).map((c) => [c.name, c.value])),
        rules: rules.filter((r) => r.origin !== 'user-agent' || r.props.some((p) => p.wins)),
      });
    }
    return { count: nodeIds.length, elements };
  }, { width, mobile, cookies, browser });
  const lines = [`${selector} on ${u.url}: ${plural(result.count, 'element')}${result.count > 3 ? ' (the first 3 shown)' : ''}.`];
  if (!result.count) lines.push('Nothing matches: the element may be drawn by a script after load, need a signed-in session (--cookie), or have another class.');
  result.elements.forEach((el, i) => {
    lines.push('', `${i + 1}. ${el.html}`);
    if (el.box) lines.push(`   box: ${el.box.width}×${el.box.height} at ${el.box.x},${el.box.y}`);
    const c = el.computed;
    lines.push(`   computed: display ${c.display}, ${c.width}×${c.height}, margin ${c['margin-top']} ${c['margin-right']} ${c['margin-bottom']} ${c['margin-left']}, padding ${c['padding-top']} ${c['padding-right']} ${c['padding-bottom']} ${c['padding-left']}, color ${c.color}, background ${c['background-color']}, font ${c['font-size']} ${c['font-weight']}`);
    lines.push('   rules, weakest first (✓ wins, ✗ overridden):');
    for (const r of el.rules) {
      lines.push(`     ${r.selector}${r.media ? `  @media ${r.media}` : ''}  ${r.origin === 'user-agent' ? '(browser default)' : r.source.length ? `→ ${r.source.join(', ')}` : r.served ?? r.sheet ?? ''}`);
      for (const p of r.props) lines.push(`        ${p.wins ? '✓' : '✗'} ${p.name}: ${p.value}${p.important ? ' !important' : ''}`);
    }
  });
  return { data: { url: u.url, selector, ...result }, text: lines.join('\n') };
}

// ─── coverage ─────────────────────────────────────────────────────────────────────────────────

/** The style rules of a stylesheet's text: { selector, start, end } (inside @media too; not @font-face, @keyframes). */
export function cssRules(text) {
  const out = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
  const stack = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === '{') {
      const sel = clean.slice(start, i).trim();
      stack.push({ sel, at: start + (clean.slice(start, i).length - clean.slice(start, i).trimStart().length), skip: /^@(font-face|(-\w+-)?keyframes|page)/i.test(sel) || stack.some((x) => x.skip) });
      start = i + 1;
    } else if (c === '}') {
      const open = stack.pop();
      if (open && open.sel && !open.sel.startsWith('@') && !open.skip && !/^(from|to|\d+%)/.test(open.sel)) out.push({ selector: open.sel.replace(/\s+/g, ' '), start: open.at, end: i + 1 });
      start = i + 1;
    } else if (c === ';' && !stack.length) start = i + 1;
  }
  return out;
}

/** Bytes used in a script from V8's block coverage: nested ranges, the innermost deciding. */
export function usedBytes(functions) {
  let length = 0;
  for (const f of functions) for (const r of f.ranges) length = Math.max(length, r.endOffset);
  const used = new Uint8Array(length);
  const ranges = functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) used.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
  let n = 0;
  for (const x of used) n += x;
  return { used: n, total: length };
}

/** The CSS rules and script bytes pages really use, from Chrome's coverage; selectors no page used, traced to the project's stylesheets. */
export async function coverage(idx, targets, { url = null, cookies = [], width = 1280 } = {}) {
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  const chrome = findChrome();
  if (!chrome) return { data: { error: 'no browser' }, text: 'No Chrome, Chromium or Edge found: install one, or set PILOT_CHROME to its path.' };
  const browser = await openBrowser(chrome);
  const sheets = new Map(); // url → { selectors: Map(selector → used), bytes, used }
  const scripts = new Map(); // url → { used, total }
  const pages = [];
  try {
    for (const t of list) {
      const u = pageUrl(idx, t, url);
      if (u.error) {
        pages.push({ target: t, error: u.error });
        continue;
      }
      const r = await withPage(u.url, async (s) => {
        const { ruleUsage } = await s('CSS.stopRuleUsageTracking');
        const { result } = await s('Profiler.takePreciseCoverage');
        const texts = new Map();
        for (const id of new Set(ruleUsage.map((x) => x.styleSheetId))) texts.set(id, (await s('CSS.getStyleSheetText', { styleSheetId: id }).catch(() => ({ text: '' }))).text);
        return { ruleUsage, js: result, texts, headers: s.sheets };
      }, {
        browser,
        cookies,
        width,
        before: async (s) => {
          s.sheets = new Map();
          s.on((msg) => {
            if (msg.method === 'CSS.styleSheetAdded') s.sheets.set(msg.params.header.styleSheetId, msg.params.header);
          });
          await s('DOM.enable');
          await s('CSS.enable');
          await s('CSS.startRuleUsageTracking');
          await s('Profiler.enable');
          await s('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
        },
      });
      // Chrome lists the rules a page used; the others are every rule of the sheet it doesn't list.
      let rules = 0;
      for (const [id, text] of r.texts) {
        const header = r.headers.get(id);
        const key = header?.sourceURL || `inline <style> on ${u.url}`;
        const used = r.ruleUsage.filter((x) => x.styleSheetId === id && x.used);
        if (!sheets.has(key)) sheets.set(key, { selectors: new Map(), length: text.length });
        const sh = sheets.get(key);
        for (const rule of cssRules(text)) {
          const hit = used.some((x) => x.startOffset < rule.end && x.endOffset > rule.start);
          sh.selectors.set(rule.selector, (sh.selectors.get(rule.selector) ?? false) || hit);
          rules++;
        }
      }
      for (const sc of r.js) {
        if (!/^https?:/.test(sc.url)) continue;
        const b = usedBytes(sc.functions);
        const prev = scripts.get(sc.url);
        scripts.set(sc.url, { total: b.total, used: Math.max(prev?.used ?? 0, b.used) });
      }
      pages.push({ target: t, url: u.url, rules });
    }
  } finally {
    browser.close();
  }
  const css = [...sheets].map(([sheet, sh]) => {
    const all = [...sh.selectors];
    const unused = all.filter(([, used]) => !used).map(([s]) => s);
    const served = servedFile(idx, sheet);
    return { sheet, file: served?.file ?? null, sources: served?.sources ?? [], rules: all.length, unused: unused.length, share: all.length ? (all.length - unused.length) / all.length : 0, unusedSelectors: unused };
  }).sort((a, b) => b.unused - a.unused);
  // Classes only in rules no page used: candidates to drop, as Chrome saw it.
  const usedClasses = new Set();
  const unusedClasses = new Map();
  for (const c of css) {
    for (const [sel, used] of sheets.get(c.sheet).selectors) {
      // A rule for a state (:hover, :focus…) never runs while a page just loads: no evidence either way.
      if (!used && /:(hover|focus|focus-within|focus-visible|active|visited|checked|disabled|invalid|valid|target|placeholder-shown)\b/.test(sel)) continue;
      for (const cls of selectorTokens(sel).classes) {
        if (used) usedClasses.add(cls);
        else if (!unusedClasses.has(cls)) unusedClasses.set(cls, { sheet: c.sheet, sources: c.sources });
      }
    }
  }
  const neverUsed = [...unusedClasses].filter(([cls]) => !usedClasses.has(cls)).map(([cls, w]) => ({ class: cls, written: (idx.symbols.classes.get(cls) ?? []).filter((u) => u.role === 'style' && !u.vendor).slice(0, 2).map((u) => at(u.file, u.line)), sheet: w.sheet }));
  const js = [...scripts].map(([u, x]) => ({ url: u, file: servedFile(idx, u)?.file ?? null, ...x, share: x.total ? x.used / x.total : 0 })).sort((a, b) => b.total - b.used - (a.total - a.used));
  const lines = [`Coverage on ${plural(pages.filter((p) => !p.error).length, 'page')} (${pages.filter((p) => !p.error).map((p) => p.url).join(', ')}):`];
  for (const p of pages.filter((x) => x.error)) lines.push(`  ${p.target}: ${p.error}`);
  lines.push('', 'Stylesheets: rules these pages used');
  for (const c of css.slice(0, 20)) lines.push(`  ${String(Math.round(c.share * 100)).padStart(3)}% of ${String(c.rules).padStart(5)} rules  ${c.file ?? c.sheet}${c.sources.length ? ` ← ${c.sources.join(', ')}` : ''}`);
  lines.push('', 'Scripts: bytes these pages ran');
  for (const s of js.slice(0, 20)) lines.push(`  ${String(Math.round(s.share * 100)).padStart(3)}% of ${kb(s.total).padStart(7)}  ${s.file ?? s.url}`);
  if (neverUsed.length) lines.push('', `${plural(neverUsed.length, 'class', 'classes')} styled but used by none of these pages:`, ...neverUsed.slice(0, 40).map((n) => `  .${n.class}  ${n.written.join(', ') || n.sheet}`));
  lines.push('', 'Unused here may still be used on pages not visited, after an interaction (a modal, a hover, an error), or signed in: cover those pages too before deleting.');
  return { data: { pages, css: css.map((c) => ({ ...c, unusedSelectors: c.unusedSelectors.slice(0, 500) })), js, neverUsed }, text: lines.join('\n') };
}

// ─── responsive ───────────────────────────────────────────────────────────────────────────────

/** The widths worth checking: either side of each of the project's breakpoints, or a phone, tablet and desktop. */
export function breakpointWidths(idx) {
  const widths = new Set();
  for (const b of design(idx).data.breakpoints) {
    const m = /(min|max)-width ([\d.]+)px/.exec(b.query);
    if (!m) continue;
    const n = Math.round(Number(m[2]));
    widths.add(m[1] === 'max' ? n : n - 1);
    widths.add(m[1] === 'max' ? n + 1 : n);
  }
  const list = [...widths].filter((w) => w >= 280 && w <= 2560).sort((a, b) => a - b);
  return list.length ? [...new Set([360, ...list])].slice(0, 8) : [360, 768, 1280];
}

const OVERFLOW = `(() => {
  const W = document.documentElement.clientWidth;
  const offends = new Set();
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right <= W + 1 && r.left >= -1) continue;
    let p = el.parentElement, clipped = false, inside = false;
    while (p && p !== document.body) {
      if (offends.has(p)) inside = true;
      const o = getComputedStyle(p).overflowX;
      if (o !== 'visible') { clipped = true; break; }
      p = p.parentElement;
    }
    if (clipped) continue;
    offends.add(el);
    if (inside) continue;
    out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, classes: typeof el.className === 'string' ? el.className.split(/\\s+/).filter(Boolean).slice(0, 4) : [], left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
  }
  return { width: W, scrollWidth: document.documentElement.scrollWidth, offenders: out.slice(0, 30) };
})()`;

/** The page at each width: a screenshot, whether it scrolls sideways, and the elements that stick out, traced to the markup. */
export async function responsive(idx, target, { url = null, widths = null, cookies = [] } = {}) {
  const u = pageUrl(idx, target, url);
  if (u.error) return { data: { error: u.error }, text: u.error };
  const chrome = findChrome();
  if (!chrome) return { data: { error: 'no browser' }, text: 'No Chrome, Chromium or Edge found: install one, or set PILOT_CHROME to its path.' };
  const list = widths ?? breakpointWidths(idx);
  const slug = slugOf(u.url);
  const dir = join(idx.root, SHOTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  const ignore = join(idx.root, '.pilot', '.gitignore');
  writeFileSync(ignore, '*\n');
  const browser = await openBrowser(chrome);
  const results = [];
  try {
    for (const w of list) {
      const r = await withPage(u.url, async (s) => {
        const { result } = await s('Runtime.evaluate', { expression: OVERFLOW, returnByValue: true });
        const { result: vp } = await s('Runtime.evaluate', { expression: '!!document.querySelector(\'meta[name="viewport"]\')', returnByValue: true });
        result.value.viewportMeta = vp.value;
        const metrics = await s('Page.getLayoutMetrics');
        const h = Math.min(8000, Math.ceil((metrics.cssContentSize ?? metrics.contentSize).height));
        const shotData = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
        writeFileSync(join(dir, `responsive-${w}.png`), Buffer.from(shotData.data, 'base64'));
        return result.value;
      }, { browser, width: w, height: 800, mobile: w < 600, cookies });
      const offenders = r.offenders.map((o) => {
        const where = [...(o.id ? (idx.symbols.ids.get(o.id) ?? []) : []), ...o.classes.flatMap((c) => idx.symbols.classes.get(c) ?? [])].filter((x) => x.role === 'markup').slice(0, 2).map((x) => at(x.file, x.line));
        return { ...o, markup: where };
      });
      // Without <meta name="viewport">, a phone lays the page out 980px wide and zooms out.
      const zoomed = r.width > w + 1 && !r.viewportMeta;
      results.push({ width: w, layoutWidth: r.width, zoomed, scrolls: r.scrollWidth > r.width + 1, scrollWidth: r.scrollWidth, offenders, shot: `${SHOTS_DIR}/${slug}/responsive-${w}.png` });
    }
  } finally {
    browser.close();
  }
  const lines = [`${u.url} at ${list.join(', ')} px:`];
  for (const r of results) {
    if (r.zoomed) lines.push('', `  ${r.width}px: NO <meta name="viewport">: a phone lays the page out ${r.layoutWidth}px wide and shrinks it to fit`);
    lines.push('', `  ${r.width}px: ${r.scrolls ? `SCROLLS SIDEWAYS (content ${r.scrollWidth}px wide)` : 'fits'}${r.offenders.length ? `, ${plural(r.offenders.length, 'element')} sticking out` : ''}  ${r.shot}`);
    for (const o of r.offenders.slice(0, 6)) lines.push(`    <${o.tag}${o.id ? ` id="${o.id}"` : ''}${o.classes.length ? ` class="${o.classes.join(' ')}"` : ''}> ${o.width}px wide, from ${o.left} to ${o.right}${o.markup.length ? `  ${o.markup.join(', ')}` : ''}`);
  }
  lines.push('', 'Read the PNGs to see each width.');
  return { data: { url: u.url, widths: list, results }, text: lines.join('\n') };
}

// ─── Many screenshots ─────────────────────────────────────────────────────────────────────────

/** The pages to shoot: 'changed' (git's), 'all' (every page whose URL needs no value), or a list. */
export function pageSet(idx, which, { limit = 40, base = null } = {}) {
  if (Array.isArray(which)) return which;
  const urls = which === 'changed'
    ? changes(idx, { base }).data.pages.map((p) => p.url)
    : complexity(idx).data.pages.map((p) => p.url);
  return [...new Set(urls.filter((x) => x && !/[{[]/.test(x)))].slice(0, limit);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Screenshots of a set of pages (one browser for all), compared where a before exists, with an HTML report. */
export async function shots(idx, which = 'changed', { url = null, widths = [1280], as = null, cookies = [], limit = 40, threshold = null, base = null, shoot = shot } = {}) {
  let list;
  try {
    list = pageSet(idx, which, { limit, base });
  } catch (e) {
    return { data: { error: e.message }, text: e.message };
  }
  if (!list.length) return { data: { pages: [] }, text: which === 'changed' ? 'No changed page to shoot.' : 'No page to shoot.' };
  const chrome = shoot === shot ? findChrome() : null;
  if (shoot === shot && !chrome) return { data: { error: 'no browser' }, text: 'No Chrome, Chromium or Edge found: install one, or set PILOT_CHROME to its path.' };
  const browser = chrome ? await openBrowser(chrome) : null;
  const rows = [];
  try {
    for (const page of list) {
      try {
        const r = await shoot(idx, page, { url, widths, as, cookies, browser });
        rows.push({ page, ...r.data });
      } catch (e) {
        rows.push({ page, error: e.message });
      }
    }
  } finally {
    browser?.close();
  }
  const worst = (r) => Math.max(0, ...(r.shots ?? []).map((s) => s.compare?.share ?? 0));
  const failed = threshold != null ? rows.filter((r) => worst(r) * 100 > threshold) : [];
  // An HTML report beside the shots: each page's before, after and diff.
  const html = `<!doctype html><meta charset="utf-8"><title>Pilot screenshots</title><style>body{font:14px system-ui;margin:20px;background:#f6f7f9}section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:0 0 16px}div{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}img{width:100%;border:1px solid #ddd}h2{font-size:15px;margin:0 0 8px}.bad{color:#c00}</style><h1>Screenshots</h1>${rows.map((r) => `<section><h2>${esc(r.url ?? r.page)} ${r.error ? `<span class="bad">${esc(r.error)}</span>` : ''}</h2>${(r.shots ?? []).map((s) => `<p>${esc(s.width)} px: ${s.compare ? `<b class="${s.compare.share * 100 > (threshold ?? 100) ? 'bad' : ''}">${(s.compare.share * 100).toFixed(2)}% changed</b>` : esc(s.label)}</p><div>${['before', 'after', 'diff'].map((l) => `<a href="${esc(r.slug)}/${l}-${esc(s.width)}.png"><img src="${esc(r.slug)}/${l}-${esc(s.width)}.png" alt="${l}" onerror="this.remove()"></a>`).join('')}</div>`).join('')}</section>`).join('')}`;
  mkdirSync(join(idx.root, SHOTS_DIR), { recursive: true });
  writeFileSync(join(idx.root, SHOTS_DIR, 'report.html'), html);
  const lines = [`${plural(rows.length, 'page')} shot${which === 'changed' ? ' (the ones the changes reach)' : ''}:`];
  for (const r of rows) {
    if (r.error) {
      lines.push(`  ${r.page}: ${r.error}`);
      continue;
    }
    lines.push(`  ${(r.url ?? r.page).padEnd(40)} ${(r.shots ?? []).map((s) => (s.compare ? `${s.width}: ${(s.compare.share * 100).toFixed(2)}% changed` : `${s.width}: ${s.label}`)).join(', ')}`);
  }
  lines.push('', `Report: ${SHOTS_DIR}/report.html`);
  if (threshold != null) lines.push(failed.length ? `${plural(failed.length, 'page')} changed more than ${threshold}%: ${failed.map((f) => f.url ?? f.page).join(', ')}` : `No page changed more than ${threshold}%.`);
  return { data: { pages: rows, failed: failed.map((f) => f.url ?? f.page), report: `${SHOTS_DIR}/report.html`, ...(failed.length ? { error: 'over threshold' } : {}) }, text: lines.join('\n') };
}

export { pagePath };
