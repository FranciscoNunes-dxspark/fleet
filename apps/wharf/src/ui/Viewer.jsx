import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { wrap } from '@fleet/kit/text.js';
import { markRanges, matcher, matchingLines } from '@fleet/kit/search.js';
import { isTrouble, logLine, logTone } from '../rows.js';
import { useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * Text over the view (ctx.showText, ctx.showLogs): a command's output, or a container's log. Scrolls;
 * esc or q closes it. With `source` (an async function that returns the whole text) it asks again
 * every `every` ms and, while following (f; on until you scroll up, G goes back to it), stays at the
 * end. For a `log`, e shows only the lines that read as trouble, and lines are coloured by their level.
 * / (or ctrl+f) searches: matches light up as you type, ↵ stops typing, n and N go from match to match
 * (from the newest, in a log), esc clears the search.
 */
export function Viewer({ title, text: given = '', source, every = 1500, log = false, process, project, search: initialSearch, ctx, width, height, active, onClose }) {
  const innerW = width - 4;
  const innerH = height - 2;
  const [text, setText] = useState(given);
  const [failed, setFailed] = useState(null);
  const [troubleOnly, setTroubleOnly] = useState(false);
  const [follow, setFollowState] = useState(Boolean(source));
  const followRef = useRef(follow);
  const setFollow = (on) => {
    followRef.current = on;
    setFollowState(on);
  };

  useEffect(() => {
    if (!source) return;
    let live = true;
    let timer;
    const again = async () => {
      try {
        const next = await source();
        if (live) {
          setText(next);
          setFailed(null);
        }
      } catch (e) {
        if (live) setFailed(String(e.message).split('\n')[0]);
      }
      if (live) timer = setTimeout(again, every);
    };
    again();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  const lines = String(text)
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => !troubleOnly || isTrouble(l))
    .flatMap((l) => {
      const shown = log ? logLine(l) : l;
      return (shown ? wrap(shown, innerW) : ['']).map((w, i) => ({ text: w, tone: log && i === 0 ? logTone(l) : undefined }));
    });
  const max = Math.max(0, lines.length - innerH);
  const [top, setTopState] = useState(follow ? Number.MAX_SAFE_INTEGER : 0);
  const topRef = useRef(top);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };
  const shown = followRef.current ? max : Math.min(top, max);

  // The search: what's typed, whether it's still being typed, and the match it's on.
  const [search, setSearchState] = useState({ query: initialSearch ?? '', typing: false, at: 0 });
  const searchRef = useRef(search);
  const setSearch = (next) => {
    searchRef.current = next;
    setSearchState(next);
  };
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const cleared = { query: '', typing: false, at: 0 };
  // A search the viewer opened with (a line a sibling handed over): once the log is in, on its newest match.
  const pending = useRef(Boolean(initialSearch));
  useEffect(() => {
    if (!pending.current) return;
    const hits = matchingLines(linesRef.current.map((l) => l.text), searchRef.current.query);
    if (!hits.length) return;
    pending.current = false;
    if (source) setFollow(false);
    setSearch({ ...searchRef.current, at: hits.length - 1 });
    setTop(hits.at(-1) - Math.floor(innerH / 3));
  }, [text]);

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    // Moving up leaves the end; reaching it again (or G, or f) follows once more.
    const go = (n) => {
      const at = Math.max(0, Math.min(max, n));
      if (source) setFollow(at >= max);
      setTop(at);
    };
    const here = followRef.current ? max : Math.min(topRef.current, max);
    // Match `n` (round from either end) a third of the way down; a log's search starts from its newest.
    const goTo = (n, query = searchRef.current.query) => {
      const hits = matchingLines(linesRef.current.map((l) => l.text), query);
      if (!hits.length) return setSearch({ ...searchRef.current, query, at: 0 });
      const at = ((n % hits.length) + hits.length) % hits.length;
      setSearch({ ...searchRef.current, query, at });
      go(hits[at] - Math.floor(innerH / 3));
    };
    const first = log ? -1 : 0;
    const s = searchRef.current;
    if (s.typing) {
      if (key.escape) return setSearch(cleared);
      if (key.return) return setSearch({ ...s, typing: false });
      if (key.backspace || key.delete) return s.query ? goTo(first, s.query.slice(0, -1)) : setSearch(cleared);
      if (key.ctrl || key.meta || !input) return;
      return goTo(first, s.query + input.replace(/[\x00-\x1f\x7f]/g, ''));
    }
    if (input === '/' || (key.ctrl && input === 'f')) return setSearch({ query: '', typing: true, at: 0 });
    if (s.query && key.escape) return setSearch(cleared);
    if (s.query && input === 'n') return goTo(s.at + 1);
    if (s.query && input === 'N') return goTo(s.at - 1);
    if (key.escape || input === 'q') return onClose();
    if (input === 'j' || key.downArrow) return go(here + 1);
    if (input === 'k' || key.upArrow) return go(here - 1);
    if (input === ' ' || key.pageDown || (key.ctrl && input === 'd')) return go(here + innerH - 1);
    if (input === 'b' || key.pageUp || (key.ctrl && input === 'u')) return go(here - innerH + 1);
    if (input === 'g') return go(0);
    if (input === 'G') return go(max);
    if (input === 'f' && source) {
      setFollow(!followRef.current);
      return setTop(max);
    }
    if (log && input === 'e') {
      setTroubleOnly((t) => !t);
      return go(Number.MAX_SAFE_INTEGER);
    }
    // t: the newest trouble line, as a line for Sonar, Hail or Bosun to paste into their prompts.
    if (log && input === 't') return ctx.shareTrouble?.({ process: process ?? title, project, text });
    if (input === 'y') return ctx.copy(lines.slice(here, here + innerH).map((l) => l.text).join('\n'), 'what is on screen');
    if (input === 'Y') return ctx.copy(String(text), `${String(text).split('\n').length} lines`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (!e.wheel) return;
    const at = Math.max(0, Math.min(max, (followRef.current ? max : Math.min(topRef.current, max)) + e.wheel * 3));
    if (source) setFollow(at >= max);
    setTop(at);
  });

  const find = matcher(search.query);
  const hits = find ? matchingLines(lines.map((l) => l.text), search.query) : [];
  const here = hits[Math.min(search.at, hits.length - 1)];
  const where = search.query || search.typing ? `/${search.query}${search.typing ? '▏' : ''} ${hits.length ? `${Math.min(search.at, hits.length - 1) + 1}/${hits.length}` : 'no match'} · ` : '';
  const pos = lines.length > innerH ? `${shown + 1}-${Math.min(lines.length, shown + innerH)}/${lines.length} · ` : '';
  const hint = [where, failed ? `${failed} · ` : '', troubleOnly ? 'trouble only · ' : '', source ? (follow ? 'following · ' : 'f follows · ') : '', pos, 'esc close'].join('');
  return (
    <Panel title={title} hint={hint} width={width} height={height} focused={active}>
      {lines.slice(shown, shown + innerH).map((l, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...markRanges([{ text: l.text, color: l.tone ? theme[l.tone] : undefined }], find ? find(l.text) : [], { bg: shown + i === here ? theme.matchHere : theme.match, color: theme.ink })]} />
      ))}
    </Panel>
  );
}
