import React, { useEffect, useMemo, useRef } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { WI_VIEW_IDS, isBlocked, wiDetail, wiRows, wiState, wiViews } from '../format.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { applyFilter, shownFilter } from '../filters.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const wiId = (w) => `${w.org ?? ''}/${w.id}`;

/** Open work items in the tracked projects, by the web app's views: yours first, then the sprint, bugs, blocked and the rest. */
export function WorkItemsView({ failed, workItems, meta, show, filter, jump, ctx, width, height, active }) {
  // The filter's fields (who:, type:, tag:, state:, project:) narrow the items; its words search them.
  const rows = useMemo(() => {
    if (!workItems) return [];
    const isMe = (w) => !!workItems.me && w.assignedTo?.id === workItems.me.id;
    const { items, text } = applyFilter('workitems', workItems.items, filter, isMe);
    return wiRows({ ...workItems, items }, meta, { view: show, filter: text });
  }, [workItems, meta, show, filter]);
  const views = useMemo(() => wiViews(workItems, meta), [workItems, meta]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { resetKey: `${show}:${filter}` });
  const w = rows[nav.index];
  const typeW = Math.min(12, Math.max(3, ...rows.slice(0, 200).map((r) => r.type.length)));
  const idW = Math.max(4, ...rows.slice(0, 200).map((r) => String(r.id).length)) + 1;
  // Who has it and when it last changed, as a right-hand column when there's room for it.
  const who = (r) => `  ${r.assignedTo?.displayName ?? 'unassigned'} · ${relTime(Date.parse(r.changedAt))}`;
  const titleW = innerW - 2 - 2 - typeW - 1 - idW;
  const metaW = titleW >= 50 ? Math.min(28, Math.max(0, ...rows.slice(nav.offset, nav.offset + innerH).map((r) => who(r).length))) : 0;

  // A change of state or priority moves an item in the list: the cursor goes with it, so the next
  // key or command acts on the same work item. (This reads the item from before the change.)
  const kept = useRef(null);
  useEffect(() => {
    const i = kept.current ? rows.findIndex((r) => wiId(r) === kept.current) : -1;
    if (i >= 0 && i !== nav.index) nav.setIndex(i);
  }, [rows]);

  useEffect(() => {
    kept.current = w ? wiId(w) : null;
    ctx.select({ workItem: w, filterSource: { tab: 'workitems', items: workItems?.items ?? [] } });
  }, [w]);

  // Another tab asked for a work item (↵ on it in the Inbox, /wi 4107): put the cursor on it.
  useEffect(() => {
    if (!jump) return;
    const i = rows.findIndex((r) => wiId(r) === jump);
    if (i >= 0) nav.setIndex(i);
    ctx.jumped();
  }, [jump, rows]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'f') return ctx.showView('workitems', WI_VIEW_IDS[(WI_VIEW_IDS.indexOf(show) + 1) % WI_VIEW_IDS.length]);
    if (input === 'F') return a.pickFilter(ctx);
    if (nav.handle(input, key) || !w) return;
    if (key.return) ctx.showWorkItemFull(w);
    else if (input === 's') a.setState(ctx, w);
    else if (input === 'i') a.assign(ctx, w, 'me');
    else if (input === 'b') a.toggleBlocked(ctx, w);
  };
  useInput(keys, { isActive: active });
  // A click picks a row, a double-click is ↵, and the wheel scrolls the list (the pane beside it takes neither).
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const view = views.find((v) => v.id === show) ?? views[0];
  const hint = workItems ? [String(rows.length), view.label, filter ? `matching ${shownFilter(filter)}` : '', 'f next view'].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (!workItems) empty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!rows.length) empty = filter ? `  Nothing matches ${shownFilter(filter)}. /find with nothing clears it.` : `  None: ${view.label}. f shows the next view (/show all for every open item).`;
  return (
    <Box width={width} height={height}>
      <Panel title="Work items" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          const st = wiState(r);
          const blocked = isBlocked(r, meta?.blockedTag);
          return (
            <Row
              key={wiId(r)}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: `${blocked ? '⊘' : st.icon} `, color: blocked ? theme.del : st.color },
                { text: `${fit(r.type, typeW)} `, color: r.typeColor || theme.dim },
                { text: fit(String(r.id), idW), color: theme.dim },
                { text: metaW ? fit(r.title, titleW - metaW) : r.title, strong: true },
                { text: metaW ? fit(who(r), metaW, 'right') : '', color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={w ? `${w.type} ${w.id}` : 'Work item'} hint={w ? 's state · i take it · b blocked · ↵ more' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={w ? wiDetail(w, meta) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
