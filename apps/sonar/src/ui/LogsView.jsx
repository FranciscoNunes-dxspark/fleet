import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { requestForHail, runQuery, saveQuery } from '../actions.js';
import { cellText, completeQuery, hailRequest, records } from '../insights.js';
import { theme } from '../theme.js';
import { clean, fit } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { Grid, columnWidths } from './Grid.jsx';

/**
 * A KQL query over the Application Insights in scope, and what it found as a grid. e (or i) edits
 * the query, with completion of tables, columns and operators; ↵ runs it. Under it, j/k move through
 * the rows, h/l across the columns, ↵ shows a row whole, y copies it, Y copies them all.
 */
export function LogsView({ query, result, scope, ctx, width, height, active }) {
  // The query being edited: its text, where the cursor is, the completion picked, the history position.
  const [edit, setEditState] = useState(null);
  const editRef = useRef(null);
  const setEdit = (e) => {
    editRef.current = e;
    setEditState(e);
  };
  const [col, setCol] = useState(0);
  const table = result ?? { columns: [], rows: [] };
  const extra = edit ? Math.min(5, completeQuery(edit.text, edit.cursor).items.length) : 0;
  const innerH = Math.max(1, height - 6 - extra);
  const nav = useListNav(table.rows.length, innerH, { resetKey: result });
  const widths = columnWidths(table);

  const editKeys = (input, key) => {
    const e = editRef.current;
    const { word, items } = completeQuery(e.text, e.cursor);
    const put = (text, cursor) => setEdit({ ...e, text, cursor, pick: 0 });
    if (key.escape) return setEdit(null);
    if (key.return) {
      setEdit(null);
      return runQuery(ctx, e.text);
    }
    if (key.tab && items.length) {
      const item = items[e.pick % items.length];
      const at = e.cursor - word.length;
      return put(e.text.slice(0, at) + item + e.text.slice(e.cursor), at + item.length);
    }
    if (key.upArrow || key.downArrow) {
      if (items.length) return setEdit({ ...e, pick: (e.pick + (key.upArrow ? items.length - 1 : 1)) % items.length });
      const past = ctx.config.queries ?? [];
      const h = Math.max(-1, Math.min(past.length - 1, e.history + (key.upArrow ? 1 : -1)));
      const text = h < 0 ? e.text : past[h];
      return setEdit({ ...e, text, cursor: text.length, history: h });
    }
    if (key.leftArrow) return setEdit({ ...e, cursor: Math.max(0, e.cursor - 1) });
    if (key.rightArrow) return setEdit({ ...e, cursor: Math.min(e.text.length, e.cursor + 1) });
    if (key.ctrl && input === 'a') return setEdit({ ...e, cursor: 0 });
    if (key.ctrl && input === 'e') return setEdit({ ...e, cursor: e.text.length });
    if (key.ctrl && input === 'u') return put(e.text.slice(e.cursor), 0);
    if (key.backspace || key.delete) return e.cursor > 0 ? put(e.text.slice(0, e.cursor - 1) + e.text.slice(e.cursor), e.cursor - 1) : undefined;
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) put(e.text.slice(0, e.cursor) + text + e.text.slice(e.cursor), e.cursor + text.length);
  };
  // While the query is being typed, every key is the view's.
  useEffect(() => () => void (ctx.claimsKey = null), []);
  ctx.claimsKey = active ? () => Boolean(editRef.current) : null;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (editRef.current) return editKeys(input, key);
    if (input === 'e' || input === 'i') return setEdit({ text: query, cursor: query.length, pick: 0, history: -1 });
    if (input === 'c') return ctx.chooseComponent();
    if (input === 's') return saveQuery(ctx, query);
    if (nav.handle(input, key)) return;
    if (input === 'h' || key.leftArrow) return setCol((c) => Math.max(0, c - 1));
    if (input === 'l' || key.rightArrow) return setCol((c) => Math.min(Math.max(0, table.columns.length - 1), c + 1));
    if (input === 'Y' && table.rows.length) {
      const tsv = [table.columns.map((c) => c.name), ...table.rows.map((r) => r.map((v, i) => cellText(v, table.columns[i].type)))].map((r) => r.join('\t')).join('\n');
      return ctx.copy(tsv, `${table.rows.length} rows (tab-separated)`);
    }
    const row = records(table)[nav.index];
    if (!row) return key.return ? runQuery(ctx, query) : undefined;
    if (key.return) return ctx.showText(`Row ${nav.index + 1} of ${table.rows.length}`, JSON.stringify(row, null, 2));
    if (input === 'y') return ctx.copy(JSON.stringify(row, null, 2), 'the row');
    // A request, to send again in Hail: a /take for its prompt, or (F) the text of a .http file's request.
    if (input === 'H') return requestForHail(ctx, row);
    if (input === 'F') return hailRequest(row) ? ctx.copy(hailRequest(row), 'it as a .http request') : ctx.note('Only a row with a url (from requests) can be a .http request.', 'error');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the border, the query, its rule, the column names and their line.
    if (nav.pick(e.y - 5 - extra) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const shown = edit ?? { text: query, cursor: query.length };
  const start = Math.max(0, shown.cursor - inner + 3);
  const visible = clean(shown.text.slice(start, start + inner - 2));
  const at = shown.cursor - start;
  const { items } = edit ? completeQuery(edit.text, edit.cursor) : { items: [] };
  const where = scope.component ? `${scope.component.name}${scope.role ? ` · ${scope.role}` : ''}` : scope.why;
  const status = !result ? (query ? '↵ runs it' : 'e to write a query') : `${table.rows.length} row${table.rows.length === 1 ? '' : 's'} · ${result.span.label}${table.columns.length > 1 ? ` · columns ${col + 1}-${table.columns.length}` : ''}`;
  return (
    <Panel title="Logs" hint={`${where} · ${status}`} width={width} height={height} focused={active}>
      <Row
        pointer={false}
        width={width - 2}
        segments={
          edit
            ? [{ text: '> ', color: theme.accent, bold: true }, { text: visible.slice(0, at) }, { text: visible[at] ?? ' ', inverse: true }, { text: visible.slice(at + 1) }]
            : [{ text: '> ', color: theme.dim, bold: true }, { text: query || 'requests | take 50   (e edits, ↵ runs, c picks the Application Insights)', color: query ? undefined : theme.dim }]
        }
      />
      {items.slice(0, 5).map((it, i) => (
        <Row key={it} pointer={false} width={width - 2} segments={[{ text: '    ' }, { text: fit(it, 30), color: i === edit.pick % items.length ? theme.accent : theme.dim, bold: i === edit.pick % items.length }, { text: i === 0 ? 'tab completes · ↑↓ pick' : '', color: theme.dim }]} />
      ))}
      <Row pointer={false} width={width - 2} segments={[{ text: '─'.repeat(width - 2), color: theme.border }]} />
      {result ? (
        table.rows.length ? (
          <Grid table={table} widths={widths} width={width - 2} height={innerH} offset={nav.offset} index={nav.index} col={col} active={active && !edit} />
        ) : (
          <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing came back.', color: theme.dim }]} />
        )
      ) : null}
    </Panel>
  );
}
