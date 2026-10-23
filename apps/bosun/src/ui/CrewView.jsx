import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { isTrouble } from '../crew.js';
import { seconds } from '../supervisor.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
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

/** The lines of every process, in the order they came, each with its name in front: the `a` log. */
export function mergedLines(procs, last) {
  const tails = procs.flatMap((p) => p.lines.slice(-last).map((l) => ({ ...l, name: p.name })));
  return tails.sort((x, y) => x.at - y.at).slice(-last);
}

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
  // Uptimes and restart countdowns count by the second.
  const [, setSecond] = useState(0);
  const ticking = procs.some((p) => p.child || p.restartAt);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setSecond((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return setBack(0);
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
    else if (input === 'y') ctx.copy(sel.spec.run, 'its command');
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
  const shown = merged ? mergedLines(procs, innerH + back) : (sel?.lines ?? []).slice(-(innerH + back));
  const visible = shown.slice(0, Math.max(0, shown.length - back)).slice(-innerH);
  const tagW = merged ? nameW + 1 : 0;
  const logTitle = merged ? 'All' : (sel?.name ?? '');
  const logHint = [back ? `${back} up · wheel down follows` : '', !merged && sel?.trouble ? 'trouble' : ''].filter(Boolean).join(' · ');

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
              ...portSegments(p),
              afterStatus(p, now),
              ...(p.trouble && p.status !== 'stopped' ? [{ text: ' !', color: theme.del, bold: true }] : []),
            ]}
          />
        ))}
      </Panel>
      <Panel title={logTitle} hint={logHint} width={logW} height={height}>
        {visible.map((l, i) => (
          <Row
            key={i}
            pointer={false}
            width={logW - 2}
            segments={[
              { text: ' ' },
              ...(merged ? [{ text: fit(l.name, nameW) + ' ', color: theme.accent }] : []),
              { text: fit(l.text, lineW - tagW), color: l.text.startsWith('── ') ? theme.dim : isTrouble(l.text) ? theme.del : undefined },
            ]}
          />
        ))}
      </Panel>
    </>
  );
}

