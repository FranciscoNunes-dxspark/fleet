// A LESS, SCSS or CSS file read as rules: each rule's full selector (nesting and `&` resolved, so
// `.btn { &-primary {} }` is `.btn-primary`), the classes and ids in it, the imports, the variables
// and mixins it defines and uses. A small scanner over braces and semicolons, not a compiler: what a
// mixin expands to, or a selector built with @{interpolation}, isn't seen.
import { lineIndex, stripComments } from '../text.js';
import { selectorTokens } from './script.js';

const AT_RULES = new Set(['import', 'media', 'font-face', 'keyframes', 'charset', 'supports', 'page', 'namespace', 'plugin', 'document', 'viewport', 'layer', 'container', 'property', 'counter-style', 'font-feature-values', 'arguments', 'rest', 'include', 'mixin', 'extend', 'use', 'forward', 'function', 'return', 'if', 'else', 'each', 'for', 'while', 'debug', 'warn', 'error', 'content', 'at-root']);

/** Splits on commas outside parentheses and brackets. */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

/** A child rule's selectors under its parents' (`&` replaced, else a descendant), at most 40. */
export function composeSelectors(parents, prelude) {
  const children = splitTop(prelude);
  const out = [];
  for (const p of parents) {
    for (const c of children) {
      out.push(c.includes('&') ? c.replace(/&/g, p) : p ? `${p} ${c}` : c);
      if (out.length >= 40) return out;
    }
  }
  return out;
}

export function parseStyle(source, dialect = 'less') {
  const out = { imports: [], vars: [], varUses: [], mixins: [], mixinCalls: [], rules: [], classes: [], ids: [] };
  const text = stripComments(source, { lineComments: dialect !== 'css', templates: false });
  const lineOf = lineIndex(text);
  const sigil = dialect === 'scss' ? '$' : '@';
  const stack = [{ selectors: [''], rule: false }];
  let start = 0;

  const varUses = (s, offset, except) => {
    const re = dialect === 'scss' ? /\$([\w-]+)/g : /@@?\{?([\w-]+)\}?/g;
    for (const m of s.matchAll(re)) {
      if (m[1] === except || (dialect !== 'scss' && AT_RULES.has(m[1]))) continue;
      out.varUses.push([`${sigil}${m[1]}`, lineOf(offset + m.index)]);
    }
    for (const m of s.matchAll(/var\(\s*(--[\w-]+)/g)) out.varUses.push([m[1], lineOf(offset + m.index)]);
  };

  const statement = (raw, offset) => {
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (!s) return;
    const at = offset + lead;
    const line = lineOf(at);
    let m;
    if ((m = /^@import\s*(?:\(([^)]*)\)\s*)?(?:url\(\s*)?["']?([^"');]+)["']?\s*\)?/.exec(s))) {
      for (const spec of s.slice(m.index + '@import'.length).match(/["'][^"']+["']/g)?.map((q) => q.slice(1, -1)) ?? [m[2].trim()]) {
        out.imports.push({ spec, line, options: m[1] ?? null });
      }
    } else if (dialect === 'scss' && (m = /^@(?:use|forward)\s+["']([^"']+)["']/.exec(s))) out.imports.push({ spec: m[1], line, options: null });
    else if (dialect !== 'scss' && (m = /^@([\w-]+)\s*:\s*([\s\S]*)$/.exec(s))) {
      out.vars.push({ name: `@${m[1]}`, line, value: m[2].trim().slice(0, 120) });
      varUses(m[2], at + s.indexOf(':') + 1, m[1]);
    } else if (dialect === 'scss' && (m = /^\$([\w-]+)\s*:\s*([\s\S]*)$/.exec(s))) {
      out.vars.push({ name: `$${m[1]}`, line, value: m[2].trim().slice(0, 120) });
      varUses(m[2], at + s.indexOf(':') + 1, m[1]);
    } else if ((m = /^(--[\w-]+)\s*:\s*([\s\S]*)$/.exec(s))) {
      out.vars.push({ name: m[1], line, value: m[2].trim().slice(0, 120) });
      varUses(m[2], at, null);
    } else if (dialect === 'scss' && (m = /^@include\s+([\w-]+)/.exec(s))) out.mixinCalls.push([m[1], line]);
    else if ((m = /^([.#][\w-]+(?:\s*>?\s*[.#][\w-]+)*)\s*(?:\(([\s\S]*)\))?\s*(?:!important)?$/.exec(s))) {
      // A mixin call: .rounded(4px); #ns > .mixin(); .clearfix;
      out.mixinCalls.push([m[1].replace(/\s+/g, '').split('>').pop(), line]);
      if (m[2]) varUses(m[2], at, null);
    } else if ((m = /^&?:extend\(([^)]*)\)/.exec(s))) {
      for (const c of selectorTokens(m[1]).classes) out.mixinCalls.push([`.${c}`, line]);
    } else varUses(s, at, null);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (c === '(') {
      // Parentheses can hold ; and { (a detached ruleset's call, a mixin's guard); skip them whole.
      let depth = 1;
      while (++i < text.length && depth) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
      }
      i--;
    } else if (c === '@' && text[i + 1] === '{') {
      const end = text.indexOf('}', i);
      if (end !== -1) i = end;
    } else if (c === '#' && text[i + 1] === '{') {
      const end = text.indexOf('}', i);
      if (end !== -1) i = end;
    } else if (c === ';') {
      statement(text.slice(start, i), start);
      start = i + 1;
    } else if (c === '{') {
      const raw = text.slice(start, i);
      const lead = raw.length - raw.trimStart().length;
      const prelude = raw.trim().replace(/\s+/g, ' ');
      const at = start + lead;
      const line = lineOf(at);
      const parent = stack[stack.length - 1];
      let m;
      if (prelude.startsWith('@')) {
        // @media, @supports, @keyframes, a detached ruleset (@x: {): their selectors are the parent's.
        varUses(prelude, at, null);
        const keyframes = /^@(?:-\w+-)?keyframes\b/.test(prelude);
        const media = /^@(media|supports|container)\b/.test(prelude) ? [parent.media, prelude].filter(Boolean).join(' and ') : parent.media;
        stack.push({ selectors: parent.selectors, rule: false, skip: keyframes || parent.skip, media, mixin: parent.mixin });
        if (dialect === 'scss' && (m = /^@mixin\s+([\w-]+)/.exec(prelude))) out.mixins.push({ name: m[1], line });
      } else if (parent.skip || /^(from|to|\d+%)/.test(prelude)) {
        stack.push({ selectors: parent.selectors, rule: false, skip: true, media: parent.media });
      } else if ((m = /^([.#][\w-]+)\s*\(([\s\S]*)\)\s*(?:when\b[\s\S]*)?$/.exec(prelude))) {
        // A mixin definition, .bordered(@w: 1px) { … }: not a class on the page.
        out.mixins.push({ name: m[1], line });
        varUses(prelude, at, null);
        stack.push({ selectors: [m[1]], rule: false, mixin: true });
      } else {
        const selectors = composeSelectors(parent.selectors, prelude);
        varUses(prelude, at, null);
        const index = out.rules.length;
        out.rules.push({ selector: selectors.join(', ').slice(0, 300), line, ...(parent.media ? { media: parent.media.slice(0, 120) } : {}) });
        const classes = new Set();
        const ids = new Set();
        for (const s of selectors) {
          const t = selectorTokens(s);
          t.classes.forEach((x) => classes.add(x));
          t.ids.forEach((x) => ids.add(x));
        }
        // Only what this rule adds: a nested rule repeats its parents' classes, which aren't styled here.
        const own = selectorTokens(prelude.replace(/&/g, ''));
        const inherited = new Set(parent.selectors.flatMap((s) => selectorTokens(s).classes));
        for (const x of classes) if (!inherited.has(x) || own.classes.includes(x)) out.classes.push([x, line, index]);
        const inheritedIds = new Set(parent.selectors.flatMap((s) => selectorTokens(s).ids));
        for (const x of ids) if (!inheritedIds.has(x) || own.ids.includes(x)) out.ids.push([x, line, index]);
        stack.push({ selectors, rule: true, mixin: parent.mixin, media: parent.media });
      }
      start = i + 1;
    } else if (c === '}') {
      statement(text.slice(start, i), start);
      if (stack.length > 1) stack.pop();
      start = i + 1;
    }
  }
  statement(text.slice(start), start);
  return out;
}
