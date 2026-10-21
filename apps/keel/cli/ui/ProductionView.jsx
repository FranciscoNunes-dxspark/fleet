import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import { monitorBrief, monitorDetail, monitorRows, monitorState } from '../format.js';
import { shownFilter } from '../filters.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/**
 * Production monitors, as the web app's Production page: those that need you first (down,
 * degraded, deploying), each with its numbers, its latest deploys and what's waiting to ship to it.
 */
export function ProductionView({ failed, production, version, filter, ctx, width, height, active }) {
  const rows = useMemo(() => monitorRows(production?.monitors, filter), [production, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.56) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { resetKey: filter });
  const m = rows[nav.index];
  // What's merged and not deployed, per environment: read with each load (the version moves), only while this tab is open.
  const waiting = useAsync(`undeployed:${version}`, () => ctx.service.undeployed().then((r) => r.targets), 150);
  // undefined while it's read; null when its environment isn't one Keel can compare.
  const target = (mon) => (!mon?.targetKey ? null : waiting.value ? waiting.value.find((t) => t.key === mon.targetKey) ?? null : waiting.error ? null : undefined);
  const numbersW = Math.min(20, Math.max(0, ...rows.map((r) => stringWidth(monitorBrief(r)))));

  useEffect(() => {
    ctx.select({ monitor: m, monitorTarget: target(m) });
  }, [m, waiting.value]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key) || !m) return;
    if (key.return) ctx.showMonitorFull(m, target(m));
  };
  useInput(keys, { isActive: active });
  // A click picks a row, a double-click is ↵, and the wheel scrolls the list (the pane beside it takes neither).
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const problems = rows.filter((r) => r.state === 'down' || r.state === 'degraded').length;
  const hint = production ? [String(rows.length), problems ? `${problems} need you` : '', filter ? `matching ${shownFilter(filter)}` : ''].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (!production) empty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!production.enabled) empty = '  Production monitoring is off on this Keel.';
  else if (!rows.length) empty = filter ? `  Nothing matches ${shownFilter(filter)}. /find with nothing clears it.` : '  No production monitors yet. Add them in the web app: Settings → Production monitors.';
  return (
    <Box width={width} height={height}>
      <Panel title="Production" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          const st = monitorState(r);
          const nameW = innerW - 2 - 2 - (numbersW ? numbersW + 2 : 0);
          return (
            <Row
              key={r.id}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: `${st.icon} `, color: st.color },
                { text: fit(r.name, nameW), strong: true },
                { text: numbersW ? `  ${fit(monitorBrief(r), numbersW, 'right')}` : '', color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={m ? monitorState(m).label : 'Monitor'} hint={m ? '↵ all of it · o open the site' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={m ? monitorDetail(m, target(m)) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
