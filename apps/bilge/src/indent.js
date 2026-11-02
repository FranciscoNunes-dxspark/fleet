// The indented text Yarn and pnpm write their lock files in, read into a tree: pnpm-lock.yaml and
// Yarn 2+'s yarn.lock are YAML (`key: value`), Yarn 1's is its own (`key "value"`). Only what lock
// files use: maps by indentation, quoted keys and values, `- ` list items; a flow value ({…}, […]) is
// kept as its text. Not a YAML parser, and never needs to be one. Pure.

/** A quoted scalar's text ("…" with escapes, '…' with '' for a quote); anything else as it is. */
export function unquote(s) {
  const t = String(s ?? '').trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// The end of a quoted key starting at 0, or -1.
function quoteEnd(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}

/** One line's key and value (undefined when it opens a map), or null when it has no key. */
function splitLine(content, yaml) {
  if (content.endsWith(':') && (!yaml || !/:\s/.test(content.slice(0, -1).replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, '')))) {
    // A key alone opens a map. Yarn 1 writes several descriptors as one key, some quoted and some not, so a
    // key that isn't one quoted string is kept as written, for the lock file's own reader to split.
    const key = content.slice(0, -1).trim();
    return { key: /^"[^"]*"$|^'[^']*'$/.test(key) ? unquote(key) : key };
  }
  let key;
  let rest;
  if (content[0] === '"' || content[0] === "'") {
    const end = quoteEnd(content);
    if (end < 0) return null;
    key = unquote(content.slice(0, end + 1));
    rest = content.slice(end + 1);
    rest = yaml ? rest.replace(/^\s*:/, '') : rest;
  } else if (yaml) {
    const at = content.indexOf(': ');
    if (at < 0) return null;
    key = content.slice(0, at);
    rest = content.slice(at + 1);
  } else {
    const m = /^(\S+)\s+([\s\S]*)$/.exec(content);
    if (!m) return null;
    [, key, rest] = m;
  }
  return { key, value: unquote(rest.trim()) };
}

/**
 * The tree of `text`: each node is { line, value?, map: Map(key → node), list: [text] }, `line` 1-based.
 * `yaml` false reads Yarn 1's `key value` lines.
 */
export function indentTree(text, { yaml = true } = {}) {
  const root = { line: 0, indent: -1, map: new Map(), list: [] };
  const stack = [root];
  String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const content = raw.trim();
      if (!content || content.startsWith('#')) return;
      const indent = raw.length - raw.trimStart().length;
      while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
      const parent = stack.at(-1);
      if (content === '-' || content.startsWith('- ')) {
        parent.list.push(unquote(content.slice(1)));
        return;
      }
      const kv = splitLine(content, yaml);
      if (!kv) return;
      const node = { line: i + 1, indent, map: new Map(), list: [] };
      if (kv.value !== undefined && kv.value !== '') node.value = kv.value;
      parent.map.set(kv.key, node);
      if (node.value === undefined) stack.push(node);
    });
  return root;
}

/** A child's value (`node.map.get(key).value`), or undefined. */
export const valueOf = (node, key) => node?.map.get(key)?.value;

/** A map node as { key: value }, or {} when there's none. */
export const objectOf = (node) => Object.fromEntries([...(node?.map ?? new Map())].map(([k, n]) => [k, n.value ?? Object.fromEntries([...n.map].map(([k2, n2]) => [k2, n2.value]))]));
