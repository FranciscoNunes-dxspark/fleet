// A TypeScript or JavaScript file read for what ties it to the rest of the project: what it imports
// (ES modules, require, AMD, /// <reference>), what it defines (functions, classes, namespaces,
// methods, globals), the CSS classes, ids and data- attributes it selects or sets (jQuery, the DOM,
// classList, markup in strings), and the server routes it calls ('/Orders/Save'). Regular
// expressions over the text with comments blanked: what's computed at run time isn't seen.
import { isToken, lineIndex, literals, stripComments } from '../text.js';

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

export function parseScript(source) {
  const out = { imports: [], defs: [], classes: [], ids: [], attrs: [], urls: [] };
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
  return out;
}
