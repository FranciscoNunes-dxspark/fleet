import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { branch, prDetail, prRows, prState } from '../format.js';
import { theme } from '../theme.js';
import { fit, relTime, stringWidth } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const prId = (pr) => `${pr.org ?? ''}/${pr.key}`;
const SHOW_LABEL = { all: '', review: 'waiting on your review', mine: 'yours' };
const NEXT_SHOW = { all: 'review', review: 'mine', mine: 'all' };

/** Active pull requests in the tracked repos: waiting on your review, then yours, then everyone else's. */
export function PrsView({ failed, prs, show, filter, jump, ctx, width, height, active }) {
  const rows = useMemo(() => prRows(prs ?? [], { show, filter }), [prs, show, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => !rows[i]?.header, resetKey: `${show}:${filter}` });
  const pr = rows[nav.index]?.pr;
  const repoW = Math.min(18, Math.max(4, ...rows.filter((r) => r.pr).slice(0, 200).map((r) => r.pr.repoName.length)));

  useEffect(() => {
    ctx.select({ pr });
  }, [pr]);

  // Another tab asked for a pull request (↵ on it in the Inbox, /pr 817): put the cursor on it.
  useEffect(() => {
    if (!jump) return;
    const i = rows.findIndex((r) => r.pr && prId(r.pr) === jump);
    if (i >= 0) nav.setIndex(i);
    ctx.jumped();
  }, [jump, rows]);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (input === 'f') return ctx.showGroup(NEXT_SHOW[show]);
      if (nav.handle(input, key) || !pr) return;
      if (key.return) ctx.showPrFull(pr);
      else if (input === 'a') a.vote(ctx, pr, 10);
      else if (input === 'A') a.vote(ctx, pr, 5);
      else if (input === 'w') a.vote(ctx, pr, -5);
      else if (input === 'x') a.vote(ctx, pr, -10);
      else if (input === '0') a.vote(ctx, pr, 0);
      else if (input === 'c') a.complete(ctx, pr);
      else if (input === 'm') a.autoComplete(ctx, pr);
    },
    { isActive: active },
  );

  const shown = rows.filter((r) => r.pr).length;
  const hint = prs ? [String(shown), SHOW_LABEL[show], filter ? `matching "${filter}"` : '', 'f to filter'].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (!prs) empty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!rows.length) empty = filter || show !== 'all' ? '  None match. f or /show all shows them all; /find with nothing clears the filter.' : '  No active pull requests in your tracked repos.';
  return (
    <Box width={width} height={height}>
      <Panel title="Pull requests" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          if (r.header) return <Row key={`h:${r.title}`} pointer={false} width={innerW} segments={[{ text: r.title, color: theme.dim, bold: true }]} />;
          const st = prState(r.pr);
          // The title gives way before who opened it and when, unless that leaves it too short.
          const meta = `  ${r.pr.author?.displayName ?? ''} · ${relTime(Date.parse(r.pr.createdAt))}`;
          const titleW = innerW - 2 - 2 - 6 - repoW - 1;
          const showMeta = titleW - stringWidth(meta) >= 24;
          return (
            <Row
              key={prId(r.pr)}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: `${st.icon} `, color: st.color },
                { text: fit(`!${r.pr.id}`, 6), color: theme.dim },
                { text: `${fit(r.pr.repoName, repoW)} `, color: theme.info },
                { text: showMeta ? fit(r.pr.title, titleW - stringWidth(meta)) : r.pr.title, strong: true },
                { text: showMeta ? meta : '', color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={pr ? `!${pr.id} ${branch(pr.sourceBranch)}` : 'Pull request'} hint={pr ? 'a approve · w wait · c complete · ↵ more' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={pr ? prDetail(pr) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
