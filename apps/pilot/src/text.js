// Small helpers the parsers share: line numbers from offsets, comments blanked out without moving
// anything, and paths that are always `/`-separated.

/** A function from a character offset in `text` to its 1-based line. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** `text` with every character in [from, to) but newlines turned to spaces, so offsets and lines hold. */
const blank = (text, from, to) => text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, ' ') + text.slice(to);

/**
 * C-like comments (`//` and `/* *\/`) blanked, strings left alone. `lineComments` false keeps `//`
 * (CSS has none, and `url(//cdn…)` would lose its tail).
 */
export function stripComments(text, { lineComments = true, templates = true } = {}) {
  let out = '';
  let i = 0;
  let from = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'" || (templates && c === '`')) {
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n' && c !== '`') break;
        i++;
      }
      i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const to = end === -1 ? n : end + 2;
      out += text.slice(from, i) + text.slice(i, to).replace(/[^\n]/g, ' ');
      i = from = to;
    } else if (lineComments && c === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = n;
      out += text.slice(from, i) + ' '.repeat(end - i);
      i = from = end;
    } else i++;
  }
  return out + text.slice(from);
}

/** Razor's `@* … *@` and HTML's `<!-- … -->` comments blanked. */
export function stripRazorComments(text) {
  let out = text;
  for (const re of [/@\*[\s\S]*?\*@/g, /<!--[\s\S]*?-->/g]) {
    for (const m of [...out.matchAll(re)]) out = blank(out, m.index, m.index + m[0].length);
  }
  return out;
}

/** A path with `/` separators. */
export const slash = (p) => p.replace(/\\/g, '/');

/** The text of `line` (1-based) in `text`, trimmed and cut to `max` characters, for a snippet. */
export function lineText(text, line, max = 140) {
  let start = 0;
  for (let l = 1; l < line; l++) {
    start = text.indexOf('\n', start) + 1;
    if (start === 0) return '';
  }
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  const s = text.slice(start, end).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Valid CSS class or id token (no Razor, no interpolation). */
export const isToken = (s) => /^-?[A-Za-z_][\w-]*$/.test(s);

/** The string literals inside `text` ("…", '…', `…` without ${}). */
export function literals(text) {
  const out = [];
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`$]*)`/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The offset of the `}` matching the `{` at `open` (C# and Razor strings and chars skipped), or the text's end. */
export function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const verbatim = text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@') || (text[i - 1] === '@' && text[i - 2] === '$');
      i++;
      while (i < text.length) {
        if (verbatim && text[i] === '"' && text[i + 1] === '"') i += 2;
        else if (!verbatim && text[i] === '\\') i += 2;
        else if (text[i] === '"') break;
        else if (!verbatim && text[i] === '\n') break;
        else i++;
      }
    } else if (c === "'") {
      const end = text.indexOf("'", i + (text[i + 1] === '\\' ? 3 : 2));
      if (end !== -1 && end - i < 10) i = end;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return text.length;
}

/** The top-level arguments of a call whose `(` is at `open`: [{ text, literal }], and the offset after `)`. */
export function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  let i = open;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
    } else if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i));
        break;
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    if (i - open > 2000) break;
  }
  return {
    args: args
      .map((a) => a.trim())
      .filter((a, n) => a || n > 0)
      .map((a) => {
        const m = /^(?:\w+\s*:\s*)?(?:@?"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')$/.exec(a);
        return { text: a, literal: m ? (m[1] ?? m[2]) : null, named: /^(\w+)\s*:/.exec(a)?.[1] ?? null };
      }),
    end: i + 1,
  };
}
