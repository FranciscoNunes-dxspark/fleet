import React, { useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { cellMark, driftCounts, filterRows } from '../drift.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const CELL_W = 10;
const FILTER_WORDS = { all: '', diff: 'only what differs', missing: 'only what is missing' };

/**
 * The matrix: a row per key, a column per source (the folder's, the app's, the vault's), each cell
 * saying whether the source has it and which group of equal values it is in, never the value. The
 * columns scroll sideways (h l) when they don't all fit.
 */
export function DriftView({ matrix, filter, ctx, width, height, active, loading }) {
  const innerH = height - 3;
  const rows = filterRows(matrix.rows, filter);
  // Where the cursor was when an overlay (a key's values, a list) took the view's place, found again.
  const was = ctx.cursor('drift');
  const nav = useListNav(rows.length, innerH, { keyOf: (i) => rows[i]?.norm, resetKey: filter, start: Math.max(0, rows.findIndex((r) => r.norm === was)) });
  ctx.cursor('drift', rows[nav.index]?.norm);
  // The row as of the last key, which may not have been drawn yet.
  const current = () => rows[nav.current()];
  const [colOff, setColOff] = useState(0);

  const inner = width - 4;
  const cols = matrix.columns;
  const keyW = Math.max(12, Math.min(40, Math.floor(inner * 0.36), Math.max(8, ...rows.map((r) => stringWidth(r.key))) + 1));
  const fits = Math.max(1, Math.floor((inner - 2 - keyW) / (CELL_W + 1)));
  // The app's and the vault's columns stay at the right; the folder's scroll past them when they don't all fit.
  const pinned = cols.map((c, i) => i).filter((i) => cols[i].kind !== 'local');
  const scrolling = cols.map((c, i) => i).filter((i) => cols[i].kind === 'local');
  const room = Math.max(1, fits - pinned.length);
  const off = Math.max(0, Math.min(colOff, scrolling.length - room));
  const shown = [...scrolling.slice(off, off + room), ...pinned].slice(0, Math.max(fits, 1));
  const more = scrolling.length > room;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'd') return ctx.setFilter(filter === 'diff' ? 'all' : 'diff');
    if (input === 'm') return ctx.setFilter(filter === 'missing' ? 'all' : 'missing');
    if (input === 'c') return a.chooseColumns(ctx);
    if (input === 'h' || key.leftArrow) return setColOff(Math.max(0, off - 1));
    if (input === 'l' || key.rightArrow) return setColOff(Math.min(Math.max(0, scrolling.length - room), off + 1));
    if (input === 't') return a.toSonar(ctx);
    if (input === 'o') return ctx.data.target ? ctx.openUrl(ctx.provider.portalUrl(ctx.data.target)) : ctx.note('Pick an App Service app first: /app.', 'error');
    const sel = current();
    if (!sel) return;
    if (key.return) a.showRow(ctx, sel);
    else if (input === 'v') a.revealRow(ctx, sel);
    else if (input === 'y') a.copyRow(ctx, sel);
    else if (input === 'a') a.addToEnv(ctx, sel);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 2) && e.double) keys('', { return: true });
  });

  const counts = driftCounts(matrix.rows);
  const said = [
    `${rows.length}${rows.length !== matrix.rows.length ? `/${matrix.rows.length}` : ''} key${matrix.rows.length === 1 ? '' : 's'}`,
    FILTER_WORDS[filter],
    counts.differs ? `${counts.differs} differ` : '',
    counts.broken ? `${counts.broken} broken` : '',
    counts.missing ? `${counts.missing} missing somewhere` : '',
    more ? `h l: columns ${off + 1}-${Math.min(scrolling.length, off + room)} of the folder's ${scrolling.length}` : '',
  ].filter(Boolean);
  const empty = !cols.length
    ? loading
      ? '  Reading the folder…'
      : '  No sources: no .env, appsettings*.json, user secrets or http-client env files here, and no app or vault picked (/app, /vault). c shows the hidden ones.'
    : !matrix.rows.length
      ? '  The sources have no keys.'
      : !rows.length
        ? filter === 'diff'
          ? '  Nothing differs and nothing is broken. d shows every key.'
          : '  No source lacks a key. m shows every key.'
        : null;
  return (
    <Panel title="Drift" hint={said.join(' · ')} width={width} height={height} focused={active}>
      <Row
        pointer={false}
        width={width - 2}
        segments={[
          { text: `  ${fit(off > 0 ? '‹ key' : 'key', keyW)}`, color: theme.dim },
          ...shown.map((i) => cols[i]).map((c) => ({ text: ` ${fit(c.label, CELL_W)}`, color: c.kind === 'app' ? theme.info : c.kind === 'vault' ? theme.accent : theme.dim, bold: c.kind !== 'local' })),
          ...(off + room < scrolling.length ? [{ text: ' ›', color: theme.dim }] : []),
        ]}
      />
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => (
        <Row
          key={r.norm}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(r.key, keyW), strong: true, color: r.broken ? theme.del : r.differs ? theme.warn : undefined },
            ...shown.map((i) => {
              const cell = r.cells[i];
              const m = cellMark(cell, r);
              return { text: ` ${fit(m.text, CELL_W)}`, color: theme[m.tone] };
            }),
          ]}
        />
      ))}
    </Panel>
  );
}
