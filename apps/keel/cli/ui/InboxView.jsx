import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { KIND, SEVERITY, inboxDetail } from '../format.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const matches = (item, text) => {
  const q = text.trim().toLowerCase();
  return !q || [item.title, item.context, KIND[item.kind], ...item.reasons.map((r) => r.text)].some((s) => String(s ?? '').toLowerCase().includes(q));
};

/** What needs you, most urgent first: the web app's Inbox (domain/attention.js). */
export function InboxView({ failed, attention, filter, ctx, width, height, active }) {
  const items = useMemo(() => (attention?.items ?? []).filter((i) => matches(i, filter)), [attention, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(items.length, innerH, { resetKey: filter });
  const item = items[nav.index];

  useEffect(() => {
    ctx.select({ item });
  }, [item]);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key) || !item) return;
      if (key.return) a.follow(ctx, item);
      else if (input === 's') a.snooze(ctx, item);
      else if (input === 'a' || input === 'x') {
        if (item.kind === 'approval') a.decide(ctx, item, input === 'a' ? 'approved' : 'rejected');
        else if (item.target?.type === 'pr') ctx.note('↵ opens the pull request in its tab, where a approves it.');
      }
    },
    { isActive: active },
  );

  const snoozed = attention?.snoozedCount ? ` · ${attention.snoozedCount} snoozed` : '';
  const hint = attention ? `${items.length}${filter ? ` matching "${filter}"` : ''}${snoozed}` : '';
  let empty = null;
  if (!attention) empty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!items.length) empty = filter ? `  Nothing matches "${filter}". /find with nothing clears it.` : '  Nothing needs you right now.';
  return (
    <Box width={width} height={height}>
      <Panel title="Inbox" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {items.slice(nav.offset, nav.offset + innerH).map((it, i) => {
          const sev = SEVERITY[it.severity] ?? SEVERITY.low;
          return (
            <Row
              key={`${it.org ?? ''}/${it.key}`}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: `${sev.icon} `, color: sev.color },
                { text: fit(KIND[it.kind] ?? it.kind, 9), color: theme.dim },
                { text: it.title, strong: true },
                { text: `  ${it.context ?? ''}`, color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={item ? KIND[item.kind] ?? 'Item' : 'Item'} hint={item ? (item.kind === 'approval' ? 'a approve · x reject · s snooze' : '↵ open · s snooze') : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={item ? inboxDetail(item) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
