import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { branch, isGithubPr, prDetail, prRows, prState } from '../format.js';
import { theme } from '../theme.js';
import { fit, relTime, stringWidth } from '../text.js';
import { applyFilter, shownFilter } from '../filters.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const prId = (pr) => `${pr.org ?? ''}/${pr.key}`;
const SHOW_LABEL = { all: '', review: 'waiting on your review', mine: 'yours' };
const NEXT_SHOW = { all: 'review', review: 'mine', mine: 'all' };
// The pane's hint leads with the key for the step the pull request is at (publish, approve, complete).
const STEP_HINT = { publish: 'p publish · ↵ more', approval: 'a approve · w wait · ↵ more', complete: 'c complete · m auto · ↵ more' };
// Your own GitHub pull request waits on someone else's review there; one held while its checks run merges itself with m.
const stepHint = (pr) => {
  if (pr.flow?.step === 'approval' && isGithubPr(pr) && pr.isMine) return 'o ask on GitHub · m auto-merge · ↵ more';
  if (pr.flow?.waiting?.kind === 'checks') return 'checks running · m auto-merge · ↵ more';
  if (pr.flow?.waiting?.kind === 'checks-failed') return 'checks failed · o on GitHub · ↵ more';
  return STEP_HINT[pr.flow?.step] ?? '↵ more';
};

/** Active pull requests in the tracked repos: waiting on your review, then yours, then everyone else's. */
export function PrsView({ failed, prs, show, filter, jump, ctx, width, height, active }) {
  // The filter's fields (who: the author, project:, repo:) narrow them; its words search them.
  const rows = useMemo(() => {
    const { items, text } = applyFilter('prs', prs ?? [], filter, (p) => p.isMine);
    return prRows(items, { show, filter: text });
  }, [prs, show, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => !rows[i]?.header, resetKey: `${show}:${filter}` });
  const pr = rows[nav.index]?.pr;
  const repoW = Math.min(18, Math.max(4, ...rows.filter((r) => r.pr).slice(0, 200).map((r) => r.pr.repoName.length)));
  // Who opened it and when, as a right-hand column the same width on every row. It goes when
  // the terminal is too narrow to leave the titles 20 columns.
  const meta = (p) => `  ${p.isMine ? 'you' : p.author?.displayName ?? ''} · ${relTime(Date.parse(p.createdAt))}`;
  const titleW = innerW - 2 - 2 - 6 - repoW - 1;
  const widest = Math.min(26, Math.max(0, ...rows.slice(nav.offset, nav.offset + innerH).filter((r) => r.pr).map((r) => stringWidth(meta(r.pr)))));
  const metaW = titleW - widest >= 20 ? widest : 0;

  useEffect(() => {
    ctx.select({ pr, filterSource: { tab: 'prs', items: prs ?? [] } });
  }, [pr]);

  // Another tab asked for a pull request (↵ on it in the Inbox, /pr 817): put the cursor on it.
  useEffect(() => {
    if (!jump) return;
    const i = rows.findIndex((r) => r.pr && prId(r.pr) === jump);
    if (i >= 0) nav.setIndex(i);
    ctx.jumped();
  }, [jump, rows]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'f') return ctx.showGroup(NEXT_SHOW[show]);
    if (input === 'F') return a.pickFilter(ctx);
    if (nav.handle(input, key) || !pr) return;
    if (key.return) ctx.showPrFull(pr);
    else if (input === 'a') a.vote(ctx, pr, 10);
    else if (input === 'A') a.vote(ctx, pr, 5);
    else if (input === 'w') a.vote(ctx, pr, -5);
    else if (input === 'x') a.vote(ctx, pr, -10);
    else if (input === '0') a.vote(ctx, pr, 0);
    else if (input === 'c') a.complete(ctx, pr);
    else if (input === 'm') a.autoComplete(ctx, pr);
    else if (input === 'p') a.publish(ctx, pr);
  };
  useInput(keys, { isActive: active });
  // A click picks a row, a double-click is ↵, and the wheel scrolls the list (the pane beside it takes neither).
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const shown = rows.filter((r) => r.pr).length;
  const hint = prs ? [String(shown), SHOW_LABEL[show], filter ? `matching ${shownFilter(filter)}` : '', 'f to filter'].filter(Boolean).join(' · ') : '';
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
                { text: metaW ? fit(r.pr.title, titleW - metaW) : r.pr.title, strong: true },
                { text: metaW ? fit(meta(r.pr), metaW, 'right') : '', color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={pr ? `!${pr.id} ${branch(pr.sourceBranch)}` : 'Pull request'} hint={pr ? stepHint(pr) : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={pr ? prDetail(pr) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
