import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { isTrouble } from '../crew.js';
import { Replayer, SPEEDS, clock, marksOf, nextMark, timeline } from '../replay.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { afterStatus, mergedLines, portSegments, statusSegment, testsSegments } from './CrewView.jsx';

const STATUS_COLOUR = () => ({ running: theme.add, starting: theme.warn, stopping: theme.warn, crashed: theme.del, exited: theme.dim, stopped: theme.dim });
const STEP = 1000;
const TICK = 100;

/**
 * A recorded session played back (/replay): the timeline with its crashes (✗) and trouble (!) on top,
 * and under it the crew and the log of the one under the cursor (or all, with a) as they were at
 * that moment. ← → step a second (shift: ten), [ ] jump to the crash or trouble before or after,
 * space plays and pauses, + - change the speed, esc closes.
 */
export function ReplayView({ session, title, ctx, width, height, active, onClose }) {
  const replayer = useMemo(() => new Replayer(session), [session]);
  const marks = useMemo(() => marksOf(session), [session]);
  const [t, setTState] = useState(session.start);
  const tRef = useRef(session.start);
  const setT = (next) => {
    tRef.current = Math.max(session.start, Math.min(session.end, next));
    setTState(tRef.current);
  };
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [merged, setMerged] = useState(false);
  const [said, setSaid] = useState(null);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const next = tRef.current + TICK * speed;
      setT(next);
      if (next >= session.end) setPlaying(false);
    }, TICK);
    return () => clearInterval(timer);
  }, [playing, speed]);

  const procs = replayer.at(t);
  const innerH = height - 4;
  const listW = Math.min(44, Math.max(30, Math.floor(width * 0.32)));
  const logW = width - listW;
  const nav = useListNav(procs.length, innerH);
  const sel = procs[nav.index];

  const jump = (dir) => {
    const m = nextMark(marks, tRef.current, dir);
    if (!m) return setSaid(dir > 0 ? 'nothing went wrong after this' : 'nothing went wrong before this');
    setPlaying(false);
    setSaid(m.text);
    setT(m.t);
    const i = procs.findIndex((p) => p.name === m.p);
    if (i >= 0 && !merged) nav.setIndex(i);
  };

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    if (key.escape || input === 'q') return onClose();
    if (key.rightArrow || key.leftArrow) {
      setPlaying(false);
      setSaid(null);
      return setT(tRef.current + (key.rightArrow ? 1 : -1) * (key.shift ? 10 * STEP : STEP));
    }
    if (input === ']') return jump(1);
    if (input === '[') return jump(-1);
    if (input === ' ') {
      if (!playing && tRef.current >= session.end) setT(session.start);
      return setPlaying((p) => !p);
    }
    if (input === '+' || input === '=') return setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)]);
    if (input === '-' || input === '_') return setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)]);
    if (input === 'a') return setMerged((m) => !m);
    nav.handle(input, key);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    // A click on the timeline goes to that moment; in the list, picks the process.
    if (e.y === 0 && !e.wheel) {
      const span = session.end - session.start;
      setPlaying(false);
      return setT(session.start + Math.round((Math.max(0, Math.min(barW - 1, e.x - 1)) / Math.max(1, barW - 1)) * span));
    }
    if (e.x < listW && !e.wheel) nav.pick(e.y - 3);
  });

  const barW = Math.max(10, width - 2);
  const bar = timeline(session, marks, t, barW);
  const barSegs = [{ text: ' ' }];
  bar.cells.forEach((c, i) => {
    const color = c === '✗' ? theme.del : c === '!' ? theme.warn : theme.border;
    barSegs.push(i === bar.cursor ? { text: '●', color: theme.accent, bold: true } : { text: c, color });
  });
  const total = session.end - session.start;
  const status = [
    { text: ` ${playing ? '▶' : '❚❚'} `, color: theme.accent, bold: true },
    { text: `${clock(t - session.start)} / ${clock(total)}`, bold: true },
    { text: `  ${new Date(t).toLocaleTimeString()}`, color: theme.dim },
    { text: `  ${speed}×`, color: theme.accent },
    { text: `  ${marks.filter((m) => m.kind === 'crash').length} crashes · ${marks.filter((m) => m.kind === 'trouble').length} trouble`, color: theme.dim },
    ...(session.cut ? [{ text: '  (recording stopped at 20 MB)', color: theme.warn }] : []),
    ...(said ? [{ text: `  ${said}`, color: theme.del }] : []),
  ];

  const colour = STATUS_COLOUR();
  const nameW = Math.min(16, Math.max(6, ...procs.map((p) => stringWidth(p.name))));
  const all = merged ? mergedLines(procs, 3000) : (sel?.lines ?? []);
  const visible = all.slice(-innerH);
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row pointer={false} width={width} segments={barSegs} />
      <Row pointer={false} width={width} segments={status} />
      <Box width={width} height={height - 2}>
        <Panel title={title} hint={`${procs.filter((p) => p.child).length}/${procs.length}`} width={listW} height={height - 2} focused={active}>
          {procs.slice(nav.offset, nav.offset + innerH).map((p, i) => (
            <Row
              key={p.name}
              width={listW - 2}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: '● ', color: colour[p.status] },
                { text: fit(p.name, nameW), strong: true },
                statusSegment(p, t),
                ...testsSegments(p),
                ...portSegments(p),
                afterStatus(p, t),
                ...(p.trouble && p.status !== 'stopped' ? [{ text: ' !', color: theme.del, bold: true }] : []),
              ]}
            />
          ))}
        </Panel>
        <Panel title={merged ? 'All' : (sel?.name ?? '')} hint="as it was then" width={logW} height={height - 2}>
          {visible.map((l, i) => (
            <Row
              key={i}
              pointer={false}
              width={logW - 2}
              segments={[
                { text: ' ' },
                ...(merged ? [{ text: fit(l.name, nameW) + ' ', color: theme.accent }] : []),
                { text: fit(l.text, logW - 3 - (merged ? nameW + 1 : 0)), color: l.text.startsWith('── ') ? theme.dim : isTrouble(l.text) ? theme.del : undefined },
              ]}
            />
          ))}
        </Panel>
      </Box>
    </Box>
  );
}
