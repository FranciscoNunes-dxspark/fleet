import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { summarize, summaryLine } from '../plan.js';
import { ACTION_MARK, ACTION_WORD, actionTone, changeRows, siteOf } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * The changes a plan makes, what loses something first: the action's mark, the address, how many
 * attributes change, and why (a replacement's cause). With `drifted`, what changed outside the code.
 */
export function ChangesView({ changes, drifted = false, empty, hint: extra, showAll, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = drifted ? changes : changeRows(changes, { all: showAll });
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.address });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'a' && !drifted) return ctx.toggleAll();
    if (!sel) return;
    if (key.return || input === 'l') a.showChange(ctx, sel, { drifted });
    else if (input === 't') a.shareDeclaration(ctx, sel);
    else if (input === 's') a.shareSite(ctx, sel);
    else if (input === 'y') ctx.copy(sel.address);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const addrW = Math.max(24, Math.min(56, Math.floor(inner * 0.4)));
  const hidden = drifted ? 0 : changes.length - list.length;
  const hint = drifted ? `${changes.length} changed outside${extra ? ` · ${extra}` : ''}` : [summaryLine(summarize(changes)) || 'no changes', hidden ? `${hidden} unchanged (a)` : '', extra].filter(Boolean).join(' · ');
  return (
    <Panel title={drifted ? 'Drift' : 'Changes'} hint={hint} width={width} height={height} focused={active}>
      {!list.length ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${empty}`, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((c, i) => {
        const n = c.diff.filter((d) => !d.noise).length;
        return (
          <Row
            key={`${c.address}:${i}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: `${drifted ? '~' : ACTION_MARK[c.action]} `, color: drifted ? theme.warn : actionTone(c.action), bold: true },
              { text: fit(c.address, addrW), strong: true, color: ['noop', 'ignore'].includes(c.action) ? theme.dim : undefined },
              { text: ` ${fit(drifted ? 'drifted' : ACTION_WORD[c.action], 10)}`, color: drifted ? theme.warn : actionTone(c.action) },
              { text: ` ${fit(n ? `${n} attribute${n === 1 ? '' : 's'}` : '', 14)}`, color: theme.dim },
              ...(siteOf(c) ? [{ text: ' app ', color: theme.info }] : []),
              ...(c.reason ? [{ text: ` ${c.reason}`, color: theme.dim }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
