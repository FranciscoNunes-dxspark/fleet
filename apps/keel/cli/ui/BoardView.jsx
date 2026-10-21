import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { boardCards, boardColumns, cardLines, columnTitle } from '../board.js';
import { theme } from '../theme.js';
import { relTime } from '../text.js';
import { useAsync, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

// A column is at least this wide; more columns than fit scroll sideways with the cursor.
const MIN_COL = 30;
const CARD_H = 2;

/**
 * A team's board, as the web app's Board page: its real columns side by side (WIP limits, split
 * Doing/Done), each card two lines. h/l go between columns, j/k between cards, < > move a card.
 * The team, its board (Stories, Features, Epics…) and open work or the sprint are picked here.
 */
export function BoardView({ version, filter, meta, ctx, width, height, active }) {
  // Which board: the server's default (the first tracked team's first board) until one is picked.
  const [pick, setPick] = useState({});
  const [mode, setMode] = useState('open');
  const data = useAsync(`board:${pick.projectId ?? ''}:${pick.teamId ?? ''}:${pick.boardId ?? ''}:${mode}:${version}`, () => ctx.service.board({ ...pick, mode }), 50);
  const d = data.value;
  const columns = useMemo(() => (d?.project ? boardColumns(d) : []), [d]);
  const cards = useMemo(() => boardCards(d, columns, filter), [d, columns, filter]);
  const [col, setCol] = useState(0);
  const [at, setAt] = useState({});
  const offsets = useRef({});
  // After a card moves, the cursor follows it to its new column once the board reads again.
  const follow = useRef(null);

  const c = Math.max(0, Math.min(col, columns.length - 1));
  const list = cards[c] ?? [];
  const index = Math.max(0, Math.min(at[columns[c]?.key] ?? 0, list.length - 1));
  const w = list[index];

  useEffect(() => {
    if (!follow.current) return;
    const id = follow.current;
    const ci = cards.findIndex((l) => l.some((x) => x.id === id));
    if (ci < 0) return;
    follow.current = null;
    setCol(ci);
    setAt((m) => ({ ...m, [columns[ci].key]: cards[ci].findIndex((x) => x.id === id) }));
  }, [cards]);

  useEffect(() => {
    ctx.select({ workItem: w, board: d, boardColumn: columns[c] });
  }, [w, d, c]);

  const setIndex = (i) => setAt((m) => ({ ...m, [columns[c].key]: Math.max(0, Math.min(i, list.length - 1)) }));
  const move = (dir) => {
    if (!w) return;
    // The next column this card can go in, that way.
    for (let i = c + dir; i >= 0 && i < columns.length; i += dir) {
      if (columns[i].accepts(w)) {
        follow.current = w.id;
        return a.moveCard(ctx, w, columns[i]);
      }
    }
    ctx.note(`${w.type} ${w.id} can't go further ${dir > 0 ? 'right' : 'left'} on this board.`);
  };
  const chooseColumn = async () => {
    if (!w) return;
    const target = await ctx.confirm({
      title: `Move ${w.type} ${w.id} to`,
      detail: `It's in ${columns[c].label} now.`,
      options: [...columns.filter((x) => x.accepts(w)).map((x) => ({ label: x.label, value: x })), { label: 'Leave it', value: null }],
    });
    if (!target) return;
    follow.current = w.id;
    a.moveCard(ctx, w, target);
  };
  const chooseTeam = async () => {
    if (!d?.options?.length) return;
    const o = await ctx.confirm({
      title: 'Whose board?',
      options: [...d.options.map((x) => ({ label: `${x.teamName} (${x.projectName})`, value: x })), { label: 'Leave it', value: null }],
    });
    if (!o) return;
    setPick({ projectId: o.projectId, teamId: o.teamId });
    setCol(0);
    setAt({});
  };
  const chooseBoard = async () => {
    if (!d?.project) return;
    if (!(d.boards?.length > 1)) return ctx.note(`${d.project.teamName} has one board.`);
    const b = await ctx.confirm({
      title: `Which of ${d.project.teamName}'s boards?`,
      options: [...d.boards.map((x) => ({ label: `${x.name} (${x.types.join(', ')})`, value: x })), { label: 'Leave it', value: null }],
    });
    if (!b) return;
    setPick({ projectId: d.project.id, teamId: d.project.teamId, boardId: b.id });
    setCol(0);
    setAt({});
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 't') return chooseTeam();
    if (input === 'v') return chooseBoard();
    if (input === 'f') return setMode((m) => (m === 'open' ? 'sprint' : 'open'));
    if (!columns.length) return;
    if (key.leftArrow || input === 'h') return setCol(Math.max(0, c - 1));
    if (key.rightArrow || input === 'l') return setCol(Math.min(columns.length - 1, c + 1));
    if (key.downArrow || input === 'j') return setIndex(index + 1);
    if (key.upArrow || input === 'k') return setIndex(index - 1);
    if (input === 'g') return setIndex(0);
    if (input === 'G') return setIndex(list.length - 1);
    if (!w) return;
    if (input === '>' || input === 'L') return move(1);
    if (input === '<' || input === 'H') return move(-1);
    if (input === 'm') return chooseColumn();
    if (input === ' ') return a.toggleCardDone(ctx, d, w, columns[c]);
    if (key.return) return ctx.showWorkItemFull(w);
    if (input === 's') return a.setState(ctx, w);
    if (input === 'i') return a.assign(ctx, w, 'me');
    if (input === 'b') return a.toggleBlocked(ctx, w);
  };
  useInput(keys, { isActive: active });

  // Columns side by side, as many as fit; the rest scroll in as the cursor goes to them.
  const shown = Math.max(1, Math.min(columns.length, Math.floor(width / MIN_COL)));
  const colW = Math.floor(width / shown);
  const start = Math.max(0, Math.min(c - Math.floor(shown / 2), columns.length - shown));
  const bodyH = height - 1;
  const perCol = Math.max(1, Math.floor((bodyH - 2) / CARD_H));
  const offsetOf = (key, sel) => {
    let o = offsets.current[key] ?? 0;
    if (sel < o) o = sel;
    if (sel >= o + perCol) o = sel - perCol + 1;
    offsets.current[key] = Math.max(0, o);
    return offsets.current[key];
  };

  // A click picks a card (its column, then its row); a double-click is ↵; the wheel moves in the column under it.
  useMouse(ctx, (e) => {
    if (e.y < 2 || !columns.length) return;
    const ci = start + Math.min(shown - 1, Math.floor(e.x / colW));
    if (ci >= columns.length) return;
    if (e.wheel) {
      setCol(ci);
      return setAt((m) => ({ ...m, [columns[ci].key]: Math.max(0, Math.min((m[columns[ci].key] ?? 0) + e.wheel, cards[ci].length - 1)) }));
    }
    const i = (offsets.current[columns[ci].key] ?? 0) + Math.floor((e.y - 2) / CARD_H);
    if (i >= cards[ci].length) return;
    setCol(ci);
    setAt((m) => ({ ...m, [columns[ci].key]: i }));
    if (e.double) ctx.showWorkItemFull(cards[ci][i]);
  });

  let head;
  if (data.error && !d) head = [{ text: `Couldn't read the board: ${String(data.error.message).split('\n')[0]}`, color: theme.del }];
  else if (!d) head = [{ text: 'Reading the board…', color: theme.dim }];
  // No tracked project has a team with a board (only GitHub owners are tracked, say: they have none).
  else if (!d.project) head = [{ text: 'No boards here: none of your tracked projects has a team. Track an Azure DevOps project in Settings (,).', color: theme.dim }];
  else {
    const it = d.iteration;
    const ends = it?.finishDate ? Date.parse(it.finishDate) - Date.now() : null;
    head = [
      { text: d.project.teamName, bold: true },
      { text: ` · ${d.board?.name ?? 'by state'} · ${mode === 'sprint' ? `${it?.name ?? 'the sprint'}` : `open work, and done in the last ${d.doneDays} days`}`, color: theme.dim },
      { text: it && mode === 'sprint' && ends > 0 ? ` · ends in ${relTime(Date.now() - ends)}` : '', color: theme.dim },
      { text: filter ? ` · matching "${filter}"` : '', color: theme.dim },
      { text: start > 0 ? `  ◂ ${start} more` : '', color: theme.accent },
      { text: start + shown < columns.length ? `  ${columns.length - start - shown} more ▸` : '', color: theme.accent },
      { text: '   t team · v board · f sprint or open', color: theme.dim },
    ];
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row pointer={false} width={width} segments={head} />
      <Box width={width} height={bodyH}>
        {columns.slice(start, start + shown).map((column, j) => {
          const ci = start + j;
          const here = cards[ci] ?? [];
          const sel = ci === c ? index : -1;
          const off = offsetOf(column.key, Math.max(0, ci === c ? index : at[column.key] ?? 0));
          const title = columnTitle(column, here);
          const thisW = j === shown - 1 ? width - colW * (shown - 1) : colW;
          return (
            <Panel key={column.key} title={title.text} hint={title.over ? 'over the limit' : column.split ? 'doing · done' : ''} width={thisW} height={bodyH} focused={active && ci === c}>
              {!here.length ? <Row pointer={false} width={thisW - 2} segments={[{ text: '  Nothing here', color: theme.dim }]} /> : null}
              {here.slice(off, off + perCol).flatMap((card, i) =>
                cardLines(card, { split: column.split, blockedTag: meta?.blockedTag }).map((segs, line) => (
                  <Row key={`${card.id}:${line}`} width={thisW - 2} pointer={line === 0} selected={off + i === sel} focused={active} segments={line === 0 ? segs : [{ text: '' }, ...segs]} />
                )),
              )}
            </Panel>
          );
        })}
      </Box>
    </Box>
  );
}
