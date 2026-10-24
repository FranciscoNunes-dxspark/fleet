// Just enough YAML for a compose file: block mappings and lists (a list may sit at its key's indent),
// "- key: value" items, quoted and plain scalars, [flow, lists], {flow: maps} of scalars, | and >
// blocks, comments. No anchors, tags or documents after the first. Pure.

/** A scalar as YAML reads it: quotes taken off, numbers, true/false, null, flow lists and maps. */
export function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return s.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(scalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    return Object.fromEntries(splitFlow(s.slice(1, -1)).map((item) => {
      const at = item.indexOf(':');
      return at < 0 ? [scalar(item), null] : [scalar(item.slice(0, at)), scalar(item.slice(at + 1))];
    }));
  }
  return s;
}

/** The items of a flow collection's inside, split at commas outside quotes and brackets. */
function splitFlow(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** A line without its comment: a # at its start or after a space, outside quotes. */
function uncomment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#'"[{][^:]*?)\s*:(?:\s+(.*))?$/;
const ITEM = /^-(?:\s+(.*))?$/;

/** The first document of `text` as plain objects, lists and scalars. */
export function parseYaml(text) {
  const raw = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const lines = [];
  for (const [n, full] of raw.entries()) {
    if (/^(---|\.\.\.)\s*$/.test(full)) {
      if (lines.length) break;
      continue;
    }
    const line = uncomment(full).replace(/\s+$/, '');
    if (!line.trim()) {
      lines.push({ blank: true, raw: full, n });
      continue;
    }
    lines.push({ indent: line.length - line.trimStart().length, text: line.trimStart(), raw: full, n });
  }
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && lines[i].blank) i++;
  };
  const peek = () => {
    skipBlank();
    return lines[i];
  };

  // A | or > block: the lines indented past `indent`, kept as they are (|) or folded into one (>).
  const block = (indent, style) => {
    const body = [];
    let at = null;
    while (i < lines.length && (lines[i].blank || lines[i].indent > indent)) {
      const l = lines[i++];
      if (l.blank) body.push('');
      else {
        at ??= l.raw.length - l.raw.trimStart().length;
        body.push(l.raw.slice(at));
      }
    }
    while (body.length && body.at(-1) === '') body.pop();
    return style.startsWith('|') ? `${body.join('\n')}\n` : `${body.join(' ')}\n`;
  };

  // The value after "key:" (or "-") when it isn't on the same line: what's indented further, a list at
  // the same indent (for a key), or nothing.
  const nested = (indent, forKey) => {
    const next = peek();
    if (!next) return null;
    if (next.indent > indent) return node(next.indent);
    if (forKey && next.indent === indent && ITEM.test(next.text)) return node(indent);
    return null;
  };

  const value = (rest, indent, forKey) => {
    if (rest == null || rest === '') return nested(indent, forKey);
    if (/^[|>][+-]?\d*$/.test(rest)) return block(indent, rest);
    return scalar(rest);
  };

  const node = (indent) => {
    const first = peek();
    if (ITEM.test(first.text)) {
      const list = [];
      while (peek() && peek().indent === indent && ITEM.test(peek().text)) {
        const l = lines[i];
        const rest = ITEM.exec(l.text)[1];
        if (rest != null && KEY.test(rest) && !/^["'[{]/.test(rest)) {
          // "- key: value": a mapping whose keys line up with this one's.
          const inner = indent + (l.text.length - rest.length);
          lines[i] = { ...l, indent: inner, text: rest };
          list.push(node(inner));
        } else {
          i++;
          list.push(value(rest, indent, false));
        }
      }
      return list;
    }
    const map = {};
    while (peek() && peek().indent === indent && !ITEM.test(peek().text)) {
      const l = lines[i++];
      const m = KEY.exec(l.text);
      if (!m) continue;
      map[scalar(m[1])] = value(m[2], indent, true);
    }
    return map;
  };

  return peek() ? node(peek().indent) : null;
}
