import React, { useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { wrap } from '@fleet/kit/text.js';
import { isTrouble } from '../crew.js';
import { lineText, markRanges, matcher } from '../search.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * Text over the view (ctx.showText): a command's output, an item. `lines` (rows of
 * segments) draws it in colour instead of `text`, which y still copies. Scrolls; esc or q closes it.
 * `bottom` starts it at the end, as for a log. / (or ctrl+f) searches it (n N go from match to match, esc clears
 * the search); for a `log`, e shows only the lines that read as trouble. `rich` says more about each
 * line of `text` by its number: `color(i)`, `trouble(i)` (for e), and `opens(i)` with `open(i)`, what ↵
 * shows of it (the line of the search's match, else the lowest on screen that opens).
 */
export function TextViewer({ title, text, lines: given, loading, bottom = false, log = false, rich, ctx, width, height, active, onClose }) {
  const innerW = width - 4;
  const innerH = height - 2;
  const [troubleOnly, setTroubleOnly] = useState(false);
  const source = String(text ?? '')
    .split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !troubleOnly || (rich?.trouble ? rich.trouble(i) : isTrouble(l)));
  // Each row on screen, and the line of the text it came from.
  const origin = [];
  const lines = loading
    ? [[{ text: 'Loading…', color: theme.dim }]]
    : (given ??
      source.flatMap(({ l, i }) =>
        (l ? wrap(l, innerW) : ['']).map((w) => {
          origin.push(i);
          return [{ text: w, color: rich?.color?.(i) }];
        }),
      ));
  const max = Math.max(0, lines.length - innerH);
  const [top, setTopState] = useState(bottom ? max : 0);
  const topRef = useRef(bottom ? max : 0);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };

  // The search: what's typed, whether it's still being typed, and the match it's on.
  const [search, setSearchState] = useState({ query: '', typing: false, at: 0 });
  const searchRef = useRef(search);
  const setSearch = (next) => {
    searchRef.current = next;
    setSearchState(next);
  };
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const hitsIn = (all, query) => {
    const find = matcher(query);
    return find ? all.flatMap((l, i) => (find(lineText(l)).length ? [i] : [])) : [];
  };
  /** Puts match `n` (round from either end) a third of the way down; a log's search starts from its newest. */
  const goTo = (n, query = searchRef.current.query) => {
    const hits = hitsIn(linesRef.current, query);
    if (!hits.length) return setSearch({ ...searchRef.current, query, at: 0 });
    const at = ((n % hits.length) + hits.length) % hits.length;
    setSearch({ ...searchRef.current, query, at });
    setTop(hits[at] - Math.floor(innerH / 3));
  };
  const cleared = { query: '', typing: false, at: 0 };
  const first = bottom ? -1 : 0;

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    const s = searchRef.current;
    if (s.typing) {
      if (key.escape) return setSearch(cleared);
      if (key.return) return setSearch({ ...s, typing: false });
      if (key.backspace || key.delete) {
        if (!s.query) return setSearch(cleared);
        return goTo(first, s.query.slice(0, -1));
      }
      if (key.ctrl || key.meta || !input) return;
      return goTo(first, s.query + input.replace(/[\x00-\x1f\x7f]/g, ''));
    }
    if (input === '/' || (key.ctrl && input === 'f')) return setSearch({ query: '', typing: true, at: 0 });
    if (s.query && key.escape) return setSearch(cleared);
    if (s.query && input === 'n') return goTo(s.at + 1);
    if (s.query && input === 'N') return goTo(s.at - 1);
    if (key.return && rich?.open && !given) {
      const hits = s.query ? hitsIn(linesRef.current, s.query) : [];
      const from = Math.min(topRef.current, max);
      let row = hits.length ? hits[Math.min(s.at, hits.length - 1)] : -1;
      for (let r = Math.min(linesRef.current.length, from + innerH) - 1; row < 0 && r >= from; r--) if (rich.opens(origin[r])) row = r;
      if (row >= 0 && rich.opens(origin[row])) rich.open(origin[row]);
      return;
    }
    if (log && input === 'e') {
      setTroubleOnly((t) => !t);
      return setTop(bottom ? Number.MAX_SAFE_INTEGER : 0);
    }
    if (key.escape || input === 'q') return onClose();
    if (input === 'j' || key.downArrow) return setTop(topRef.current + 1);
    if (input === 'k' || key.upArrow) return setTop(topRef.current - 1);
    if (input === ' ' || key.pageDown || (key.ctrl && input === 'd')) return setTop(topRef.current + innerH - 1);
    if (input === 'b' || key.pageUp || (key.ctrl && input === 'u')) return setTop(topRef.current - innerH + 1);
    if (input === 'g') return setTop(0);
    if (input === 'G') return setTop(max);
    if (input === 'y') return ctx.copy(String(text ?? ''), `${lines.length} line${lines.length === 1 ? '' : 's'}`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setTop(topRef.current + e.wheel * 3);
  });

  const shown = Math.min(top, max);
  const pos = lines.length > innerH ? `${shown + 1}-${Math.min(lines.length, shown + innerH)}/${lines.length} · ` : '';
  const find = matcher(search.query);
  const hits = find ? hitsIn(lines, search.query) : [];
  const here = hits[Math.min(search.at, hits.length - 1)];
  const where = search.query || search.typing ? `/${search.query}${search.typing ? '▏' : ''} ${hits.length ? `${Math.min(search.at, hits.length - 1) + 1}/${hits.length}` : 'no match'} · ` : '';
  const filtered = troubleOnly ? 'trouble only · ' : '';
  return (
    <Panel title={title} hint={`${where}${filtered}${pos}esc close`} width={width} height={height} focused={active}>
      {lines.slice(shown, shown + innerH).map((l, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...(find ? markRanges(l, find(lineText(l)), { bg: shown + i === here ? theme.matchHere : theme.match, color: theme.ink }) : l)]} />
      ))}
    </Panel>
  );
}
