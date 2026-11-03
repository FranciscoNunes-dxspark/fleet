import React, { useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { wrap } from '@fleet/kit/text.js';
import { markRanges, matcher, matchingLines } from '@fleet/kit/search.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * Text over the view (ctx.showText): a finding, a package, the report, a command's output. Scrolls; esc
 * or q closes it. / (or ctrl+f) searches: matches light up as you type, ↵ stops typing, n and N go from
 * match to match, esc clears the search.
 */
export function Viewer({ title, text = '', ctx, width, height, active, onClose }) {
  const innerW = width - 4;
  const innerH = height - 2;
  const lines = String(text)
    .replace(/\n$/, '')
    .split('\n')
    .flatMap((l) => (l ? wrap(l, innerW) : ['']));
  const max = Math.max(0, lines.length - innerH);
  const [top, setTopState] = useState(0);
  const topRef = useRef(top);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };
  const shown = Math.min(top, max);

  const [search, setSearchState] = useState({ query: '', typing: false, at: 0 });
  const searchRef = useRef(search);
  const setSearch = (next) => {
    searchRef.current = next;
    setSearchState(next);
  };
  const cleared = { query: '', typing: false, at: 0 };

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    const here = Math.min(topRef.current, max);
    const goTo = (n, query = searchRef.current.query) => {
      const hits = matchingLines(lines, query);
      if (!hits.length) return setSearch({ ...searchRef.current, query, at: 0 });
      const at = ((n % hits.length) + hits.length) % hits.length;
      setSearch({ ...searchRef.current, query, at });
      setTop(hits[at] - Math.floor(innerH / 3));
    };
    const s = searchRef.current;
    if (s.typing) {
      if (key.escape) return setSearch(cleared);
      if (key.return) return setSearch({ ...s, typing: false });
      if (key.backspace || key.delete) return s.query ? goTo(0, s.query.slice(0, -1)) : setSearch(cleared);
      if (key.ctrl || key.meta || !input) return;
      return goTo(0, s.query + input.replace(/[\x00-\x1f\x7f]/g, ''));
    }
    if (input === '/' || (key.ctrl && input === 'f')) return setSearch({ query: '', typing: true, at: 0 });
    if (s.query && key.escape) return setSearch(cleared);
    if (s.query && input === 'n') return goTo(s.at + 1);
    if (s.query && input === 'N') return goTo(s.at - 1);
    if (key.escape || input === 'q') return onClose();
    if (input === 'j' || key.downArrow) return setTop(here + 1);
    if (input === 'k' || key.upArrow) return setTop(here - 1);
    if (input === ' ' || key.pageDown || (key.ctrl && input === 'd')) return setTop(here + innerH - 1);
    if (input === 'b' || key.pageUp || (key.ctrl && input === 'u')) return setTop(here - innerH + 1);
    if (input === 'g') return setTop(0);
    if (input === 'G') return setTop(max);
    if (input === 'y') return ctx.copy(lines.slice(here, here + innerH).join('\n'), 'what is on screen');
    if (input === 'Y') return ctx.copy(String(text), `${String(text).split('\n').length} lines`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setTop(Math.min(topRef.current, max) + e.wheel * 3);
  });

  const find = matcher(search.query);
  const hits = find ? matchingLines(lines, search.query) : [];
  const here = hits[Math.min(search.at, hits.length - 1)];
  const where = search.query || search.typing ? `/${search.query}${search.typing ? '▏' : ''} ${hits.length ? `${Math.min(search.at, hits.length - 1) + 1}/${hits.length}` : 'no match'} · ` : '';
  const pos = lines.length > innerH ? `${shown + 1}-${Math.min(lines.length, shown + innerH)}/${lines.length} · ` : '';
  return (
    <Panel title={title} hint={`${where}${pos}esc close`} width={width} height={height} focused={active}>
      {lines.slice(shown, shown + innerH).map((l, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...markRanges([{ text: l }], find ? find(l) : [], { bg: shown + i === here ? theme.matchHere : theme.match, color: theme.ink })]} />
      ))}
    </Panel>
  );
}
