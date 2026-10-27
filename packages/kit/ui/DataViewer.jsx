import React, { useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { fit, stringWidth } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { cellText, flatten, fromTable, parseData, prettyLines, prettyText, query, scalarText, showPath, summary, tableOf } from '../datatree.js';

/** The colour a kind of value is drawn in, read from the theme as it draws. */
const tone = (kind) => ({ key: theme.info, string: theme.add, number: theme.warn, boolean: theme.accent, null: theme.dim, punct: theme.dim, object: theme.dim, array: theme.dim, more: theme.dim })[kind];

/** What `text` or `rows` ({ columns, rows } of cell values, or an array of objects) reads as, once. */
function load(text, rows) {
  if (rows) {
    const value = Array.isArray(rows) ? rows : fromTable(rows.columns, rows.rows);
    return { kind: 'rows', value };
  }
  return parseData(text);
}

/**
 * JSON, JSON lines or CSV/TSV (`text`) or a result set (`rows`: { columns, rows }) over the view, as a tree to open
 * and close (j k move, → ← or ↵ open and close, y copies the value, p its path) or, for rows of fields, a table (t
 * switches; ↵ opens a row as a tree). / asks for a path (.items[0].name, .items[], | length), showing what it
 * matches (y copies it); esc clears that, then closes. Pure parsing and querying are in datatree.js.
 */
export function DataViewer({ title, text, rows, ctx, width, height, active, onClose }) {
  const model = useMemo(() => load(text, rows), [text, rows]);
  const table = useMemo(() => (model.error ? null : tableOf(model.value)), [model]);
  const innerW = width - 4;
  const innerH = Math.max(1, height - 3);
  const [mode, setMode] = useState(table && (model.kind === 'csv' || model.kind === 'tsv' || model.kind === 'rows') ? 'table' : 'tree');
  const [drill, setDrill] = useState(null);
  const [open, setOpen] = useState(() => new Set(['']));
  const [col, setCol] = useState(0);
  const [colOffset, setColOffset] = useState(0);
  const [ask, setAskState] = useState({ typing: false, text: '', result: null });
  const askRef = useRef(ask);
  const setAsk = (next) => {
    askRef.current = next;
    setAskState(next);
  };

  const root = model.error ? null : drill == null ? model.value : model.value[drill];
  const base = drill == null ? '' : `[${drill}]`;
  const treeRows = useMemo(() => (model.error ? [] : flatten(root, open)), [model, root, open]);
  const resultLines = useMemo(() => (ask.result?.values ? ask.result.values.flatMap((v) => prettyLines(v, { max: 2000 })) : []), [ask.result]);
  const showing = ask.result?.values ? 'result' : mode;

  const tableRows = table?.rows ?? [];
  const treeNav = useListNav(treeRows.length, innerH, { keyOf: (i) => treeRows[i]?.path, resetKey: drill });
  const tableNav = useListNav(tableRows.length, innerH - 1, { resetKey: model });
  const resultNav = useListNav(resultLines.length, innerH, { resetKey: ask.result });
  const nav = showing === 'result' ? resultNav : showing === 'table' ? tableNav : treeNav;

  // Table columns: each as wide as its widest of the first rows, up to 30.
  const widths = useMemo(
    () => (table ? table.columns.map((c, i) => Math.min(30, Math.max(stringWidth(c), ...tableRows.slice(0, 200).map((r) => stringWidth(cellText(r[i]))))) ) : []),
    [table],
  );
  const lastCol = table ? table.columns.length - 1 : 0;
  const moveCol = (to) => {
    const c = Math.max(0, Math.min(lastCol, to));
    setCol(c);
    // Scroll the columns until this one is whole on screen.
    let off = Math.min(colOffset, c);
    while (off < c && widths.slice(off, c + 1).reduce((n, w) => n + w + 2, 0) > innerW - 2) off++;
    setColOffset(off);
  };

  const node = treeRows[treeNav.current()];
  const toggle = (path, on) =>
    setOpen((s) => {
      const next = new Set(s);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  const parentOf = (i) => {
    for (let j = i - 1; j >= 0; j--) if (treeRows[j].depth < treeRows[i].depth) return j;
    return -1;
  };

  const run = (q) => {
    if (!q.trim()) return setAsk({ typing: false, text: '', result: null });
    setAsk({ typing: false, text: q, result: query(root, q) });
  };

  const keys = (input, key) => {
    if (ctx.overlayHasKeys && !ctx.overlayHasKeys()) return;
    const a = askRef.current;
    if (a.typing) {
      if (key.escape) return setAsk({ ...a, typing: false, text: a.result ? a.text : '' });
      if (key.return) return run(a.text);
      if (key.backspace || key.delete) return setAsk({ ...a, text: a.text.slice(0, -1) });
      if (key.ctrl || key.meta || !input) return;
      return setAsk({ ...a, text: a.text + input.replace(/[\x00-\x1f\x7f]/g, '') });
    }
    if (input === '/') return setAsk({ ...a, typing: true });
    if (key.escape) return a.result ? setAsk({ typing: false, text: '', result: null }) : drill != null && table ? (setDrill(null), setMode('table')) : onClose();
    if (input === 'q') return onClose();
    if (model.error) return;
    if (showing === 'result') {
      if (input === 'y' && a.result.values) return ctx.copy(a.result.values.map((v) => prettyText(v)).join('\n'), `${a.result.values.length} result${a.result.values.length === 1 ? '' : 's'}`);
      return void resultNav.handle(input, key);
    }
    if (input === 't' && table) {
      setDrill(null);
      return setMode(mode === 'table' ? 'tree' : 'table');
    }
    if (showing === 'table') {
      if (key.rightArrow || input === 'l') return moveCol(col + 1);
      if (key.leftArrow || input === 'h') return moveCol(col - 1);
      const r = tableNav.current();
      if (key.return) {
        setDrill(r);
        return setMode('tree');
      }
      if (input === 'y' && tableRows[r]) return ctx.copy(cellText(tableRows[r][col]), `${table.columns[col]}'s value`);
      if (input === 'r' && tableRows[r]) return ctx.copy(prettyText(model.value[r]), `row ${r + 1} as JSON`);
      return void tableNav.handle(input, key);
    }
    if (!node) return;
    const at = treeNav.current();
    if (key.rightArrow || input === 'l') {
      if (node.expandable && !node.open) return toggle(node.path, true);
      if (node.open && treeRows[at + 1]?.depth > node.depth) return treeNav.setIndex(at + 1);
      return;
    }
    if (key.leftArrow || input === 'h') {
      if (node.open) return toggle(node.path, false);
      const p = parentOf(at);
      return p >= 0 ? treeNav.setIndex(p) : undefined;
    }
    if (key.return || input === ' ') return node.expandable ? toggle(node.path, !node.open) : undefined;
    if (input === 'y') return node.kind === 'more' ? undefined : ctx.copy(node.expandable ? prettyText(node.value) : typeof node.value === 'string' ? node.value : scalarText(node.value), node.expandable ? 'the value as JSON' : 'the value');
    if (input === 'p') return ctx.copy(showPath(base + node.path), 'the path');
    treeNav.handle(input, key);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) nav.scrollBy(e.wheel * 3);
  });

  const hintParts = [];
  if (model.error) hintParts.push('esc close');
  else {
    if (showing === 'result') hintParts.push(`${ask.result.values.length} match${ask.result.values.length === 1 ? '' : 'es'}`, 'y copy', 'esc back');
    else if (showing === 'table') hintParts.push(`${tableRows.length} rows`, '↵ row', 'y cell', 'r row', 't tree');
    else hintParts.push(model.kind === 'jsonl' ? 'JSON lines' : model.kind === 'rows' ? 'rows' : model.kind.toUpperCase(), '→← open', 'y value', 'p path', ...(table ? ['t table'] : []));
    if (showing !== 'result') hintParts.push('/ query', 'esc close');
  }

  const bodyRows = [];
  if (model.error) bodyRows.push(<Row key="e" pointer={false} width={width - 2} segments={[{ text: ` ${model.error}`, color: theme.del }]} />);
  else if (showing === 'result') {
    for (const [i, l] of resultLines.slice(resultNav.offset, resultNav.offset + innerH).entries()) {
      bodyRows.push(<Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...l.map((t) => ({ text: t.text, color: tone(t.kind) }))]} />);
    }
    if (!resultLines.length) bodyRows.push(<Row key="n" pointer={false} width={width - 2} segments={[{ text: ' nothing matched', color: theme.dim }]} />);
  } else if (showing === 'table') {
    const cols = [];
    let used = 0;
    for (let c = colOffset; c <= lastCol && used + widths[c] + 2 <= innerW - 2; c++) (cols.push(c), (used += widths[c] + 2));
    if (!cols.length && table) cols.push(colOffset);
    const cells = (r, head) => cols.map((c) => ({ text: `${fit(head ? table.columns[c] : cellText(r[c]), widths[c])}  `, color: head ? theme.accent : tone(typeof r[c] === 'string' || r[c] == null ? 'string' : typeof r[c] === 'number' ? 'number' : 'boolean'), bold: head }));
    bodyRows.push(<Row key="h" pointer={false} width={width - 2} segments={[{ text: '  ' }, ...cells(null, true)]} />);
    for (let i = tableNav.offset; i < Math.min(tableRows.length, tableNav.offset + innerH - 1); i++) {
      const sel = i === tableNav.index;
      bodyRows.push(
        <Row key={i} width={width - 2} selected={sel} segments={cells(tableRows[i], false).map((s, k) => (sel && cols[k] === col ? { ...s, underline: true, strong: true } : s))} />,
      );
    }
  } else {
    for (let i = treeNav.offset; i < Math.min(treeRows.length, treeNav.offset + innerH); i++) {
      const r = treeRows[i];
      const segs = [{ text: '  '.repeat(r.depth) }];
      if (r.kind === 'more') segs.push({ text: `… ${r.more} more`, color: theme.dim });
      else {
        segs.push({ text: r.expandable ? (r.open ? '▾ ' : '▸ ') : '  ', color: theme.dim });
        segs.push({ text: r.key === '' ? (drill == null ? '$' : `row ${drill + 1}`) : r.key, color: tone('key'), strong: true });
        if (r.expandable) segs.push({ text: ` ${summary(r.value)}`, color: theme.dim });
        else segs.push({ text: ': ', color: theme.dim }, { text: scalarText(r.value), color: tone(r.kind) });
      }
      bodyRows.push(<Row key={i} width={width - 2} selected={i === treeNav.index} segments={segs} />);
    }
  }
  while (bodyRows.length < innerH) bodyRows.push(<Row key={`pad${bodyRows.length}`} pointer={false} width={width - 2} segments={[{ text: ' ' }]} />);
  // The line under the rows: the query being typed, what it asked, or where the cursor is.
  const a = ask;
  const status = model.error
    ? ''
    : a.typing
      ? `/${a.text}▏`
      : a.result?.error
        ? `/${a.text}  ${a.result.error}`
        : a.result
          ? `/${a.text}`
          : showing === 'tree' && node
            ? showPath(base + node.path)
            : '';
  return (
    <Panel title={title} hint={hintParts.join(' · ')} width={width} height={height} focused={active}>
      {bodyRows}
      <Row pointer={false} width={width - 2} segments={[{ text: ` ${status}`, color: a.result?.error ? theme.del : a.typing || a.result ? theme.accent : theme.dim }]} />
    </Panel>
  );
}
