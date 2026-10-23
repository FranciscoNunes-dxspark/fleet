import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { isTrouble } from '../crew.js';
import { KEEP_LINES, seconds } from '../supervisor.js';
import { markRanges, matcher } from '../search.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { testsLabel } from '../hailcheck.js';
import { Panel, Row } from './parts.jsx';

const STATUS_COLOUR = () => ({ running: theme.add, starting: theme.warn, stopping: theme.warn, crashed: theme.del, exited: theme.dim, stopped: theme.dim });

/** How long it has been up, or how long ago it ended: 42s, 5m, 2h. */
export function uptime(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** A process's port as its row shows it: :3000 ✓ (answers, health page fine), :3000 ✗, :3000 … (not yet). */
export function portSegments(p) {
  if (!p.port) return [];
  if (p.portOpen == null || !p.child) return [{ text: ` :${p.port}`, color: theme.dim }];
  if (!p.portOpen) return [{ text: ` :${p.port} …`, color: theme.warn }];
  if (p.health != null && (p.health === 0 || p.health >= 400)) return [{ text: ` :${p.port} ✗${p.health ? ` ${p.health}` : ''}`, color: theme.del }];
  return [{ text: ` :${p.port} ✓`, color: theme.add }];
}

/** A row's status: its state, or while it waits to start again, when it will. */
export function statusSegment(p, now = Date.now()) {
  if (p.restartAt) return { text: ` restarting in ${seconds(p.restartAt - now)}`, color: theme.warn };
  return { text: ` ${fit(p.status, 8)}`, color: STATUS_COLOUR()[p.status] };
}

/** What a row says after the status: how long it has been up, that it gave up restarting, its exit code. */
export function afterStatus(p, now = Date.now()) {
  if (p.restartAt) return { text: '' };
  if (p.gaveUp && !p.child) return { text: ' gave up', color: theme.del };
  if (p.child && p.startedAt) return { text: ` ${uptime(p.startedAt, now)}`, color: theme.dim };
  if (p.code != null && p.status === 'crashed') return { text: ` code ${p.code}`, color: theme.dim };
  return { text: '' };
}

/** Its Hail checks' outcome, beside it: ✓ tests, ✗ 2 failed, … tests. */
export function testsSegments(p) {
  const l = testsLabel(p.tests);
  return l ? [{ text: l.text, color: theme[l.tone] }] : [];
}

/** The lines of every process, in the order they came, each with its name in front: the `a` log. */
export function mergedLines(procs, last) {
  // Each log is in time order already (unless the clock went back), so the newest `last` are taken
  // from the logs' ends, newest first, rather than sorting them all on every frame. A tie goes to the
  // later process, as the stable sort below would order it.
  const tails = procs.map((p) => (p.lines.length > last ? p.lines.slice(-last) : p.lines));
  if (!tails.every(inOrder)) return slowMerge(procs, tails, last);
  const at = tails.map((t) => t.length - 1);
  const out = [];
  while (out.length < last) {
    let pick = -1;
    for (let k = tails.length - 1; k >= 0; k--) if (at[k] >= 0 && (pick < 0 || tails[k][at[k]].at > tails[pick][at[pick]].at)) pick = k;
    if (pick < 0) break;
    out.push({ ...tails[pick][at[pick]--], name: procs[pick].name });
  }
  return out.reverse();
}

const inOrder = (lines) => {
  for (let i = 1; i < lines.length; i++) if (lines[i].at < lines[i - 1].at) return false;
  return true;
};

const slowMerge = (procs, tails, last) =>
  tails
    .flatMap((t, k) => t.map((l) => ({ ...l, name: procs[k].name })))
    .sort((x, y) => x.at - y.at)
    .slice(-last);

/** The crew: each process with its state, port and uptime, and beside it the log of the one under the cursor (or all of them). */
export function CrewView({ procs, ctx, width, height, active }) {
  const innerH = height - 2;
  const listW = Math.min(44, Math.max(30, Math.floor(width * 0.32)));
  const logW = width - listW;
  const nav = useListNav(procs.length, innerH);
  const sel = procs[nav.index];
  // `a`: every process's log at once. `back`: lines scrolled up from the bottom with the wheel.
  const [merged, setMerged] = useState(false);
  const [back, setBack] = useState(0);
  const lastSel = useRef(sel?.name);
  if (lastSel.current !== sel?.name) {
    lastSel.current = sel?.name;
    if (back) setBack(0);
  }
  const nameW = Math.min(16, Math.max(6, ...procs.map((p) => stringWidth(p.name))));
  // The log pane's search (ctrl+f then n N, esc clears it) and `e`, only the lines that read as trouble.
  const [search, setSearchState] = useState({ query: '', typing: false, at: 0 });
  const searchRef = useRef(search);
  const setSearch = (next) => {
    searchRef.current = next;
    setSearchState(next);
  };
  const [troubleOnly, setTroubleOnly] = useState(false);
  // Uptimes and restart countdowns count by the second.
  const [, setSecond] = useState(0);
  const ticking = procs.some((p) => p.child || p.restartAt);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setSecond((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  // The pane's lines: the one's or all of them, only the troubled ones with `e`.
  const all = merged ? mergedLines(procs, KEEP_LINES) : (sel?.lines ?? []);
  const list = troubleOnly ? all.filter((l) => isTrouble(l.text)) : all;
  const listRef = useRef(list);
  listRef.current = list;
  const hitsIn = (lines, query) => {
    const find = matcher(query);
    return find ? lines.flatMap((l, i) => (find(l.text).length ? [i] : [])) : [];
  };

  /** Scrolls to match `n` (round from either end), a third of the way down the pane. */
  const goTo = (n, query = searchRef.current.query) => {
    const lines = listRef.current;
    const hits = hitsIn(lines, query);
    if (!hits.length) return setSearch({ ...searchRef.current, query, at: 0 });
    const at = ((n % hits.length) + hits.length) % hits.length;
    setSearch({ ...searchRef.current, query, at });
    const top = hits[at] - Math.floor(innerH / 3);
    setBack(Math.max(0, Math.min(lines.length - innerH, lines.length - innerH - top)));
  };
  const cleared = { query: '', typing: false, at: 0 };
  // Typed, the search starts from the newest match, as a log is read from the bottom; n goes newer, N older.
  const searchKeys = (input, key) => {
    const s = searchRef.current;
    if (s.typing) {
      if (key.escape) return setSearch(cleared);
      if (key.return) return setSearch({ ...s, typing: false });
      if (key.backspace || key.delete) {
        if (!s.query) return setSearch(cleared);
        const q = s.query.slice(0, -1);
        setSearch({ ...s, query: q });
        return goTo(-1, q);
      }
      if (key.ctrl || key.meta || !input) return;
      const q = s.query + input.replace(/[\x00-\x1f\x7f]/g, '');
      setSearch({ ...s, query: q });
      return goTo(-1, q);
    }
    if (key.ctrl && input === 'f') return setSearch({ query: '', typing: true, at: 0 });
    if (key.escape) {
      setSearch(cleared);
      return setBack(0);
    }
    if (input === 'n') return goTo(s.at + 1);
    if (input === 'N') return goTo(s.at - 1);
  };
  // Typing a search, ctrl+f, and n N esc while one is up, are this view's, not the app's.
  useEffect(() => () => void (ctx.claimsKey = null), []);
  ctx.claimsKey = active ? (input, key) => searchRef.current.typing || (key.ctrl && input === 'f') || (Boolean(searchRef.current.query) && (key.escape || input === 'n' || input === 'N')) : null;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (ctx.claimsKey?.(input, key)) return searchKeys(input, key);
    if (nav.handle(input, key)) return setBack(0);
    if (input === 'e') {
      setBack(0);
      return setTroubleOnly((t) => !t);
    }
    if (input === 'R') return a.restart(ctx, 'all');
    if (input === 'a') {
      setBack(0);
      return setMerged((m) => !m);
    }
    if (input === 'p') return a.profiles(ctx);
    if (!sel) return;
    if (key.return) a.showLog(ctx, sel.name);
    else if (input === 'r') a.restart(ctx, sel.name);
    else if (input === 's') a.toggle(ctx, sel.name);
    else if (input === 'w') a.why(ctx, sel.name);
    else if (input === 'o') a.openProc(ctx, sel.name);
    else if (input === 'f') a.free(ctx, ctx.crew?.takenPort(sel.name) ?? sel.port);
    else if (input === 'c') {
      a.clearLog(ctx, sel.name);
      setBack(0);
    } else if (input === 'l') a.saveLogPrompt(ctx, sel.name);
    else if (input === 'y') ctx.copy(sel.spec.run, 'its command');
    else if (input === 't') a.shareTrouble(ctx, sel.name);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) {
      if (e.wheel) setBack((b) => Math.max(0, b - e.wheel * 3));
      return;
    }
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1)) {
      setBack(0);
      if (e.double) keys('', { return: true });
    }
  });

  const colour = STATUS_COLOUR();
  const now = Date.now();
  const lineW = logW - 3;
  const from = Math.max(0, list.length - back - innerH);
  const visible = list.slice(from, Math.max(0, list.length - back));
  const tagW = merged ? nameW + 1 : 0;
  const logTitle = merged ? 'All' : (sel?.name ?? '');
  const find = matcher(search.query);
  const hits = find ? hitsIn(list, search.query) : [];
  const here = hits[Math.min(search.at, hits.length - 1)];
  const where = search.query || search.typing ? `find ${search.query}${search.typing ? '▏' : ''} ${hits.length ? `${Math.min(search.at, hits.length - 1) + 1}/${hits.length}` : 'no match'}` : '';
  const logHint = [where, troubleOnly ? 'trouble only · e all' : '', back ? `${back} up · wheel down follows` : '', !merged && !troubleOnly && sel?.trouble ? 'trouble' : ''].filter(Boolean).join(' · ');

  return (
    <>
      <Panel title="Crew" hint={`${procs.filter((p) => p.child).length}/${procs.length}`} width={listW} height={height} focused={active}>
        {procs.length === 0 ? <Row pointer={false} width={listW - 2} segments={[{ text: '  Nothing to run: /init writes a bosun.json.', color: theme.dim }]} /> : null}
        {procs.slice(nav.offset, nav.offset + innerH).map((p, i) => (
          <Row
            key={p.name}
            width={listW - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: '● ', color: colour[p.status] },
              { text: fit(p.name, nameW), strong: true },
              statusSegment(p, now),
              ...testsSegments(p),
              ...portSegments(p),
              afterStatus(p, now),
              ...(p.trouble && p.status !== 'stopped' ? [{ text: ' !', color: theme.del, bold: true }] : []),
            ]}
          />
        ))}
      </Panel>
      <Panel title={logTitle} hint={logHint} width={logW} height={height}>
        {visible.map((l, i) => {
          const text = fit(l.text, lineW - tagW);
          const line = [{ text, color: l.text.startsWith('── ') ? theme.dim : isTrouble(l.text) ? theme.del : undefined }];
          return (
            <Row
              key={i}
              pointer={false}
              width={logW - 2}
              segments={[
                { text: ' ' },
                ...(merged ? [{ text: fit(l.name, nameW) + ' ', color: theme.accent }] : []),
                ...(find ? markRanges(line, find(text), { bg: from + i === here ? theme.matchHere : theme.match, color: theme.ink }) : line),
              ]}
            />
          );
        })}
      </Panel>
    </>
  );
}

