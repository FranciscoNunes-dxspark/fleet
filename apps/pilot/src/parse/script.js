// A TypeScript or JavaScript file read for what ties it to the rest of the project: what it imports
// (ES modules, require, AMD, /// <reference>), what it defines (functions, classes, namespaces,
// methods, globals), the CSS classes, ids and data- attributes it selects or sets (jQuery, the DOM,
// classList, markup in strings), and the server routes it calls ('/Orders/Save'). Regular
// expressions over the text with comments blanked: what's computed at run time isn't seen.
import { callArgs, isToken, lineIndex, literals, stripComments } from '../text.js';
import { findWidgets } from './widgets.js';

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'else', 'do', 'try', 'with', 'constructor', 'super', 'import', 'await', 'yield']);
const NOT_CLASSES = /^\.(js|jsx|ts|tsx|mjs|cjs|css|less|scss|html?|cshtml|json|png|jpe?g|gif|svg|ico|map|min|txt|xml|pdf|woff2?|ttf|eot)$/i;

/** The classes, ids and data- attributes named in a CSS selector string. */
export function selectorTokens(sel) {
  const classes = [];
  const ids = [];
  const attrs = [];
  const rest = sel.replace(/\[\s*([\w-]+)[^\]]*\]/g, (_, a) => {
    attrs.push(a.toLowerCase());
    return ' ';
  });
  for (const m of rest.matchAll(/([.#])(-?[A-Za-z_][\w-]*)(?![\w-]|@\{|\$\{|\{)/g)) (m[1] === '.' ? classes : ids).push(m[2]);
  return { classes, ids, attrs };
}

/** Whether a string literal reads as nothing but a CSS selector ('.row', '#form .save', 'tr.selected > td'). */
const looksLikeSelector = (s) => /^\s*(?:[a-z][\w-]*)?[.#][A-Za-z_-][\w-]*(?:[\s>+~,]*(?:[a-z][\w-]*)?(?:[.#:][A-Za-z_-][\w-]*|\[[^\]]+\])*)*\s*$/.test(s) && !NOT_CLASSES.test(s.trim());

/** Whether a string literal reads as a server route rather than a file: '/Orders/Save', '~/api/items'. */
const looksLikeRoute = (s) => /^~?\/[A-Za-z][\w-]*(?:\/[\w{}:-]*)*\/?(?:\?.*)?$/.test(s) && !/\.\w{1,5}(\?|$)/.test(s);

/**
 * Where a call's URL argument points: a literal ('/Orders/Row'), the literal start of a concatenation
 * or template ('/Orders/Row/' + id, `/Orders/Row/${id}`), or Razor in an inline script
 * ('@Url.Action("Row", "Orders")'). Returns { url } or { action, controller, area }, or
 * { dynamic: text } when it's a variable.
 */
export function urlOf(expr) {
  const e = String(expr ?? '').trim();
  const razor = /^(['"`]?)@Url\.Action\(\s*"(\w+)"(?:\s*,\s*"(\w+)")?([^)]*)\)/.exec(e);
  if (razor) {
    const area = /\barea\s*=\s*"(\w*)"/i.exec(razor[4])?.[1];
    return { action: razor[2], controller: razor[3] ?? null, ...(area != null ? { area } : {}) };
  }
  const content = /^(['"`]?)@Url\.Content\(\s*"([^"]+)"\s*\)/.exec(e);
  const lit = content ? content[2] : /^(['"`])((?:(?!\1)[^\\$]|\\.|\$(?!\{))*)/.exec(e)?.[2];
  if (lit == null) return e ? { dynamic: e.slice(0, 80) } : null;
  let url = lit.replace(/^~/, '').replace(/[?#].*$/, '');
  if (!url.startsWith('/') && /^[A-Za-z][\w-]*\/[A-Za-z]/.test(url)) url = `/${url}`;
  url = url.replace(/\/+$/, '');
  if (!/^\/[A-Za-z]/.test(url) || /\.\w{1,5}$/.test(url)) return { dynamic: e.slice(0, 80) };
  return { url };
}

// Calls to the server: [pattern, method or null (from the options), how]. The match ends at the `(`.
const AJAX = [
  [/(?:\$|\bjQuery)\.(get|post|getJSON|getScript)\s*\(/g, null, 'jquery'],
  [/(?:\$|\bjQuery)\.ajax\s*\(/g, null, 'ajax'],
  [/\.load\s*\(/g, 'GET', 'load'],
  [/\bfetch\s*\(/g, null, 'fetch'],
  [/\baxios(?:\.(get|post|put|delete|patch))?\s*\(/g, null, 'axios'],
  [/\b(?:this\.)?http(?:Client)?\.(get|post|put|delete|patch)\s*(?:<[^>()]*>)?\s*\(/g, null, 'http'],
  [/\.open\s*\(\s*['"](GET|POST|PUT|DELETE|PATCH)['"]\s*,/g, null, 'xhr'],
];

/** Where a response goes, from the code after the call: $('#x').html(data), el.innerHTML = … */
function responseTarget(after) {
  const m = /(?:\$|jQuery)\(\s*['"]([^'"]+)['"]\s*\)\s*(?:\.\s*(?:find|children)\s*\([^()]*\)\s*)*\.\s*(?:html|append|prepend|replaceWith|after|before)\s*\(/.exec(after)
    ?? /document\.(?:getElementById\(\s*['"]([^'"]+)['"]\s*\)|querySelector\(\s*['"]([^'"]+)['"]\s*\))\.(?:innerHTML|outerHTML)\s*=/.exec(after)
    ?? /document\.(?:getElementById\(\s*['"]([^'"]+)['"]\s*\)|querySelector\(\s*['"]([^'"]+)['"]\s*\))\.insertAdjacentHTML\s*\(/.exec(after);
  if (!m) return null;
  if (m[1] && m[0].startsWith('document.getElementById')) return `#${m[1]}`;
  return m[1] ?? (m[2] ?? null) ?? (m[3] ?? null);
}

/** The server calls in `text`: [{ url | action+controller | dynamic, method, target?, via, line }]. */
export function ajaxCalls(text, lineOf) {
  const out = [];
  for (const [re, fixed, via] of AJAX) {
    for (const m of text.matchAll(re)) {
      const open = m.index + m[0].length - 1;
      const { args, end } = via === 'xhr' ? { args: [{ text: text.slice(open + 1, open + 300).split(/[,)]/)[0] }], end: open + 1 } : callArgs(text, open);
      let expr = args[0]?.text;
      let method = fixed ?? (m[1] ? m[1].toUpperCase().replace(/^GET(JSON|SCRIPT)$/, 'GET') : null);
      if (via === 'xhr') method = m[1];
      // $.ajax({ url: …, type: 'POST' }), axios({ url, method }), fetch(url, { method: 'POST' })
      const options = expr?.startsWith('{') ? expr : args[1]?.text ?? '';
      if (expr?.startsWith('{')) expr = /\burl\s*:\s*([^,\n}]+)/.exec(expr)?.[1];
      method ??= /\b(?:type|method)\s*:\s*['"](\w+)['"]/i.exec(options)?.[1]?.toUpperCase() ?? (via === 'fetch' || via === 'axios' ? 'GET' : via === 'ajax' ? 'GET' : null);
      if (expr == null) continue;
      const where = urlOf(expr);
      if (!where) continue;
      // .load is jQuery's only when called on a selection: $('#x').load(url).
      let target = null;
      if (via === 'load') {
        const before = text.slice(Math.max(0, m.index - 200), m.index);
        const sel = /(?:\$|jQuery)\(\s*['"]([^'"]+)['"]\s*\)\s*$/.exec(before);
        if (!sel && !/[\w$)\]]\s*$/.test(before)) continue;
        if (where.dynamic && !sel) continue;
        target = sel?.[1] ?? null;
      } else {
        // The response is handled in the call's own callbacks or in .done(…)/.then(…) chained to it.
        let to = end;
        for (let k = 0; k < 4; k++) {
          const chain = /^\s*\.\s*(?:done|then|success|always|subscribe|complete)\s*\(/.exec(text.slice(to, to + 80));
          if (!chain) break;
          to = callArgs(text, to + chain[0].length - 1).end;
        }
        target = responseTarget(text.slice(open, to));
      }
      out.push({ ...where, method, via, line: lineOf(m.index), ...(target ? { target } : {}) });
    }
  }
  return out;
}

export function parseScript(source) {
  const out = { imports: [], defs: [], classes: [], ids: [], attrs: [], urls: [], calls: [], widgets: [] };
  const lineOf = lineIndex(source);
  for (const m of source.matchAll(/^\s*\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/gm)) out.imports.push({ spec: m[1], line: lineOf(m.index), kind: 'reference' });
  const text = stripComments(source);

  // Imports.
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?["']([^"'\n]+)["']/g)) out.imports.push({ spec: m[1], line: lineOf(m.index), kind: 'import' });
  for (const m of text.matchAll(/\bexport\s+(?:type\s+)?[\w$*{}\s,]*?\bfrom\s+["']([^"'\n]+)["']/g)) out.imports.push({ spec: m[1], line: lineOf(m.index), kind: 'export' });
  for (const m of text.matchAll(/\b(require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g)) out.imports.push({ spec: m[2], line: lineOf(m.index), kind: m[1] });
  for (const m of text.matchAll(/\b(?:define|require|requirejs)\s*\(\s*(?:["'][^"']*["']\s*,\s*)?\[([^\]]*)\]/g)) {
    for (const spec of literals(m[1])) out.imports.push({ spec, line: lineOf(m.index), kind: 'amd' });
  }

  // Definitions.
  const def = (name, kind, offset) => out.defs.push({ name, kind, line: lineOf(offset) });
  for (const m of text.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) def(m[1], 'function', m.index);
  for (const m of text.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)) def(m[1], 'class', m.index);
  for (const m of text.matchAll(/\b(?:export\s+)?(?:declare\s+)?(interface|enum|type)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>\s*)?[={]/g)) def(m[2], m[1], m.index);
  for (const m of text.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*(?::\s*[^=;{]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g)) def(m[1], 'function', m.index);
  for (const m of text.matchAll(/\b(?:namespace|module)\s+([A-Za-z_$][\w$.]*)\s*\{/g)) def(m[1], 'namespace', m.index);
  for (const m of text.matchAll(/([A-Za-z_$][\w$.]*)\.prototype\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/g)) def(`${m[1]}.${m[2]}`, 'method', m.index);
  for (const m of text.matchAll(/(?:^|[^.\w$])((?:window\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*=\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*=>)/gm)) {
    if (!/\.prototype\./.test(m[1])) def(m[1].replace(/^window\./, ''), 'function', m.index + m[0].indexOf(m[1]));
  }
  for (const m of text.matchAll(/^[ \t]*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?function\b/gm)) def(m[1], 'method', m.index);
  for (const m of text.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^()]*\)\s*(?::\s*[\w$<>[\]|., ]+)?\s*\{/gm)) {
    if (!KEYWORDS.has(m[1])) def(m[1], 'method', m.index);
  }

  // Selectors and classes.
  const add = (tokens, offset) => {
    const line = lineOf(offset);
    for (const c of tokens.classes) out.classes.push([c, line]);
    for (const i of tokens.ids) out.ids.push([i, line]);
    for (const a of tokens.attrs) out.attrs.push([a, line]);
  };
  // Keyed by where the string starts, so $('.x') read as a call and again as a literal counts once.
  const seen = new Set();
  const selector = (s, offset) => {
    if (seen.has(offset)) return;
    seen.add(offset);
    add(selectorTokens(s), offset);
  };
  const contentAt = (m, group) => m.index + m[0].length - 1 - m[group].length;
  const STR = (n = 1) => `(["'\`])((?:(?!\\${n})[^\\\\\\n]|\\\\.)*)\\${n}`;
  for (const m of text.matchAll(new RegExp(String.raw`(?:\$|\bjQuery|\bquerySelector(?:All)?|\.(?:find|closest|parents?|parentsUntil|children|siblings|next(?:All|Until)?|prev(?:All|Until)?|is|not|filter|has|delegate|matches|undelegate|live|die|wrap(?:All|Inner)?|appendTo|prependTo|insertAfter|insertBefore|replaceAll|addBack|add))\s*\(\s*` + STR(), 'g'))) {
    // $('<div class="x">') is markup, read below; a selector otherwise.
    if (!m[2].trim().startsWith('<')) selector(m[2], contentAt(m, 2));
  }
  for (const m of text.matchAll(new RegExp(String.raw`\.(?:on|off|one)\s*\(\s*` + STR(1) + String.raw`\s*,\s*` + STR(3), 'g'))) selector(m[4], contentAt(m, 4));
  for (const m of text.matchAll(/\bgetElementById\s*\(\s*["'`]([\w-]+)["'`]/g)) out.ids.push([m[1], lineOf(m.index)]);
  for (const m of text.matchAll(/\bgetElementsByClassName\s*\(\s*["'`]([^"'`]+)["'`]/g)) for (const c of m[1].split(/\s+/)) if (isToken(c)) out.classes.push([c, lineOf(m.index)]);
  for (const m of text.matchAll(/\.(?:addClass|removeClass|toggleClass|hasClass)\s*\(\s*["'`]([^"'`]+)["'`]/g)) for (const c of m[1].split(/\s+/)) if (isToken(c)) out.classes.push([c, lineOf(m.index)]);
  for (const m of text.matchAll(/\bclassList\.(?:add|remove|toggle|contains|replace)\s*\(([^)]*)\)/g)) for (const lit of literals(m[1])) if (isToken(lit)) out.classes.push([lit, lineOf(m.index)]);
  for (const m of text.matchAll(/\bclassName\s*\+?=\s*["'`]([^"'`]+)["'`]/g)) for (const c of m[1].split(/\s+/)) if (isToken(c)) out.classes.push([c, lineOf(m.index)]);
  for (const m of text.matchAll(/\.(?:data|attr)\s*\(\s*["'`](data-[\w-]+|[\w-]+)["'`]/g)) {
    const name = m[1].startsWith('data-') ? m[1] : /\.data\s*\(/.test(m[0]) ? `data-${m[1].replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` : null;
    if (name) out.attrs.push([name.toLowerCase(), lineOf(m.index)]);
  }
  // Markup in strings: '<tr class="row selected" id="x">', and string literals that are selectors.
  for (const m of text.matchAll(/(["'`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const s = m[2];
    if (s.length > 2000) continue;
    if (s.includes('<') || /class\s*=/.test(s)) {
      for (const c of s.matchAll(/\bclass\s*=\s*\\?["']([^"'\\]*)/g)) for (const w of c[1].split(/\s+/)) if (isToken(w)) out.classes.push([w, lineOf(m.index)]);
      for (const c of s.matchAll(/\bid\s*=\s*\\?["']([\w-]+)/g)) out.ids.push([c[1], lineOf(m.index)]);
    } else if (looksLikeSelector(s)) selector(s, m.index + 1);
    else if (looksLikeRoute(s)) out.urls.push({ url: s.replace(/^~/, '').replace(/[?#].*$/, ''), line: lineOf(m.index) });
  }
  // Template literals with a route in them: `/Orders/Edit/${id}`.
  for (const m of text.matchAll(/`(~?\/[A-Za-z][\w-]*(?:\/[A-Za-z][\w-]*)+)\/?\$\{/g)) out.urls.push({ url: m[1].replace(/^~/, ''), line: lineOf(m.index) });
  // The calls themselves, with their method and where the response goes; a route-shaped string
  // already read as a call isn't listed again.
  out.calls = ajaxCalls(text, lineOf);
  out.calls.sort((a, b) => a.line - b.line);
  const key = (line, url) => `${line}|${url.toLowerCase().replace(/\/+$/, '')}`;
  const called = new Set(out.calls.filter((c) => c.url).map((c) => key(c.line, c.url)));
  out.urls = out.urls.filter((u) => !called.has(key(u.line, u.url)));
  out.widgets = findWidgets(text);
  return out;
}
