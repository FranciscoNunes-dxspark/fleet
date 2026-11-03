// A compose file read from its text, with the line each key and list item is on: the subset of YAML
// compose files use (block mappings and lists, `- key: value` items, one-line flow lists and maps,
// quoted strings, block scalars, comments, anchors, aliases and `<<` merges), without a YAML library,
// so the security check can say compose.yaml:12. Pure.
//
// What doesn't fit the subset is skipped rather than guessed at: a check reads what it can.

// Each mapping and list made here has its lines: a key's (or an item's) line number, from 1.
const LINES = new WeakMap();

/** The line `key` of a mapping (or item `key` of a list) is on; undefined when it isn't known. */
export const lineOf = (node, key) => (node && typeof node === 'object' ? LINES.get(node)?.[key] : undefined);

/** A line without its comment: `#` at the start or after a space, outside quotes. */
function uncomment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && !(quote === '"' && text[i - 1] === '\\')) quote = null;
    } else if (ch === '"' || ch === "'") {
      // A quote only opens a string at the start of a value, not inside a word (it's).
      if (i === 0 || /[\s:\[{,-]/.test(text[i - 1])) quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/** A plain or quoted scalar as a value: true, false, null and numbers as themselves, the rest a string. */
export function scalar(raw) {
  const s = String(raw ?? '').trim();
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1).replace(/''/g, "'");
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s)) return Number(s);
  return s;
}

/** Splits a flow collection's inside at its top-level commas. */
function splitFlow(inner) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Where a mapping line's key ends: the first `: ` (or a final `:`) outside quotes; -1 when it isn't one. */
function keyEnd(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if ((ch === '"' || ch === "'") && i === 0) quote = ch;
    else if (ch === ':' && (i === text.length - 1 || text[i + 1] === ' ' || text[i + 1] === '\t')) return i;
    else if (ch === '[' || ch === '{') return -1;
  }
  return -1;
}

/** A one-line flow value: `[a, b]`, `{ k: v }`, an alias, or a scalar. `line` is where it is. */
function flowValue(text, line, anchors) {
  const s = text.trim();
  if (s.startsWith('*')) return anchors.get(s.slice(1)) ?? null;
  if (s.startsWith('[') && s.endsWith(']')) {
    const items = splitFlow(s.slice(1, -1)).map((p) => flowValue(p, line, anchors));
    LINES.set(items, items.map(() => line));
    return items;
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const out = {};
    const lines = {};
    for (const p of splitFlow(s.slice(1, -1))) {
      const i = keyEnd(p);
      const key = String(scalar(i < 0 ? p : p.slice(0, i)));
      out[key] = i < 0 ? null : flowValue(p.slice(i + 1), line, anchors);
      lines[key] = line;
    }
    LINES.set(out, lines);
    return out;
  }
  return scalar(s);
}

/** The text's lines that hold something: { indent, text, line }, block scalars' lines kept whole. */
function tokenize(source) {
  const raw = String(source ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const full = raw[i].replace(/\t/g, '  ');
    if (/^\s*(---|\.\.\.)\s*$/.test(full) && out.length) break;
    if (/^\s*(---|%)/.test(full)) continue;
    const text = uncomment(full);
    if (!text.trim()) continue;
    const indent = text.length - text.trimStart().length;
    const entry = { indent, text: text.trim(), line: i + 1 };
    out.push(entry);
    // A block scalar (| or >): the lines indented under it are its text, not keys.
    if (/(?:^|[:-]\s)[|>][+-]?\d*$/.test(entry.text) || /^[|>][+-]?\d*$/.test(entry.text)) {
      const body = [];
      let j = i + 1;
      for (; j < raw.length; j++) {
        const r = raw[j].replace(/\t/g, '  ');
        if (r.trim() && r.length - r.trimStart().length <= indent) break;
        body.push(r);
      }
      const min = Math.min(...body.filter((b) => b.trim()).map((b) => b.length - b.trimStart().length), Infinity);
      entry.block = body.map((b) => (b.trim() ? b.slice(min) : '')).join('\n').replace(/\n+$/, '');
      i = j - 1;
    }
    // A flow collection spread over lines: joined until its brackets close.
    if (/(?:^|:\s|-\s)[[{]/.test(entry.text)) {
      const opened = (t) => [...t].reduce((n, ch) => n + (ch === '[' || ch === '{' ? 1 : ch === ']' || ch === '}' ? -1 : 0), 0);
      let depth = opened(entry.text);
      while (depth > 0 && i + 1 < raw.length) {
        const next = uncomment(raw[++i]).trim();
        entry.text += ` ${next}`;
        depth += opened(next);
      }
    }
  }
  return out;
}

/** Reads a compose file (or any YAML in the subset): the document as plain values, null when empty. */
export function parseYaml(source) {
  const tokens = tokenize(source);
  const anchors = new Map();
  let pos = 0;

  // A value written after `key:` or `- `: inline, a block scalar, or the block indented under it.
  const valueAfter = (rest, tok, indent) => {
    let text = rest.trim();
    let anchor = null;
    const m = /^&(\S+)\s*(.*)$/.exec(text);
    if (m) [, anchor, text] = m;
    let value;
    if (tok.block !== undefined && /^[|>]/.test(text)) {
      value = text.startsWith('>') ? tok.block.replace(/([^\n])\n(?=[^\n])/g, '$1 ') : tok.block;
    } else if (text) value = flowValue(text, tok.line, anchors);
    else {
      const next = tokens[pos];
      // The block under it: indented further, or a list at the same indent (`key:` then `- item`).
      if (next && (next.indent > indent || (next.indent === indent && /^-(\s|$)/.test(next.text)))) value = block(next.indent);
      else value = null;
    }
    if (anchor) anchors.set(anchor, value);
    return value;
  };

  const block = (indent) => {
    const first = tokens[pos];
    if (!first || first.indent !== indent) return null;
    return /^-(\s|$)/.test(first.text) ? list(indent) : mapping(indent);
  };

  const list = (indent) => {
    const out = [];
    const lines = [];
    while (pos < tokens.length && tokens[pos].indent === indent && /^-(\s|$)/.test(tokens[pos].text)) {
      const tok = tokens[pos];
      const rest = tok.text.replace(/^-\s*/, '');
      lines.push(tok.line);
      if (rest && keyEnd(rest) > 0 && !/^["']?[[{]/.test(rest)) {
        // `- key: value`: a mapping whose first key shares the dash's line, at the column after it.
        const column = indent + (tok.text.length - rest.length);
        tokens[pos] = { ...tok, indent: column, text: rest };
        out.push(mapping(column));
      } else {
        pos++;
        out.push(valueAfter(rest, tok, indent));
      }
    }
    LINES.set(out, lines);
    return out;
  };

  const mapping = (indent) => {
    const out = {};
    const lines = {};
    while (pos < tokens.length && tokens[pos].indent === indent && !/^-(\s|$)/.test(tokens[pos].text)) {
      const tok = tokens[pos];
      const end = keyEnd(tok.text);
      pos++;
      if (end < 0) continue;
      const key = String(scalar(tok.text.slice(0, end)));
      const value = valueAfter(tok.text.slice(end + 1), tok, indent);
      if (key === '<<') {
        // A merge: the aliased mappings' keys, under the ones written here.
        for (const src of Array.isArray(value) ? value : [value]) {
          if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
          for (const [k, v] of Object.entries(src)) {
            if (k in out) continue;
            out[k] = v;
            lines[k] = lineOf(src, k) ?? tok.line;
          }
        }
        continue;
      }
      out[key] = value;
      lines[key] = tok.line;
    }
    LINES.set(out, lines);
    return out;
  };

  while (pos < tokens.length) {
    const doc = block(tokens[pos].indent);
    if (doc !== null) return doc;
    pos++;
  }
  return null;
}

/** A compose file's services: [{ name, service (its mapping), line }]; empty when it has none. */
export function composeServices(source) {
  const doc = parseYaml(source);
  const services = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.services : null;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return [];
  return Object.entries(services)
    .filter(([, s]) => s && typeof s === 'object' && !Array.isArray(s))
    .map(([name, service]) => ({ name, service, line: lineOf(services, name) }));
}
