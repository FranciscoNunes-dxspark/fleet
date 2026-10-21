import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import { teamBrief, teamDetail, teamRows } from '../team.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/**
 * The team, as the web app's Team page: who carries what (in progress, the sprint, reviews, pull
 * requests), people with too much on first. Beside it, the selected person's work items and pull
 * requests from what the other tabs read. ↵ and p take you to their work items or pull requests.
 */
export function TeamView({ version, workItems, prs, filter, ctx, width, height, active }) {
  const data = useAsync(`team:${version}`, () => ctx.service.team(), 50);
  const rows = useMemo(() => teamRows(data.value, filter), [data.value, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.5) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { resetKey: filter });
  const r = rows[nav.index];
  const nameW = Math.min(22, Math.max(8, ...rows.map((x) => x.person.displayName.length)));

  useEffect(() => {
    ctx.select({ person: r?.person });
  }, [r]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key) || !r) return;
    if (key.return) ctx.showWorkItemsOf(r.person);
    else if (input === 'p') ctx.showPrsOf(r.person);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const flagged = rows.filter((x) => x.flags?.length).length;
  const hint = data.value ? [String(rows.length), flagged ? `${flagged} with too much on` : '', filter ? `matching "${filter}"` : ''].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (data.error && !data.value) empty = `  Couldn't read the team: ${String(data.error.message).split('\n')[0]}`;
  else if (!data.value) empty = '  Reading Azure DevOps…';
  else if (!rows.length) empty = filter ? `  Nobody matches "${filter}". /find with nothing clears it.` : "  Nobody in your tracked projects' teams yet.";
  return (
    <Box width={width} height={height}>
      <Panel title="Team" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((x, i) => (
          <Row
            key={x.person.id}
            width={innerW}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: x.flags?.length ? '⚠ ' : '  ', color: theme.warn },
              { text: `${fit(x.person.displayName, nameW)}  `, strong: true },
              { text: teamBrief(x), color: theme.dim },
            ]}
          />
        ))}
      </Panel>
      {split ? (
        <Panel title={r ? r.person.displayName : 'Person'} hint={r ? '↵ work items · p pull requests' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={r ? teamDetail(r, { workItems: workItems?.items, prs }) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
