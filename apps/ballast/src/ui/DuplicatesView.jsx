import React, { useMemo } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { duplicates } from '../modules.js';
import { formatBytes } from '../sizes.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * Packages bundled more than once, the most to win first: the package, whether it is two versions or
 * one from two paths, the versions, how many copies, and what all but the biggest copy weigh.
 */
export function DuplicatesView({ build, measure, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = useMemo(() => duplicates(build?.chunks ?? [], measure), [build, measure]);
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.name });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') a.showDuplicate(ctx, sel);
    else if (input === 'p') a.packageDetail(ctx, sel.name);
    else if (input === 'w') a.whyForBilge(ctx, sel.name);
    else if (input === 'y') ctx.copy(sel.name);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const nameW = Math.max(16, Math.min(36, inner - 60));
  const wasted = list.reduce((n, d) => n + d.wastedSize, 0);
  const hint = build ? (list.length ? `${list.length} bundled twice or more · ≈ ${formatBytes(wasted)} ${measure} to win` : 'none') : '';
  const empty = !build ? '  Reading the build…' : !list.length ? (build.chunks.some((c) => c.modules.length) ? '  No package is bundled twice.' : '  Nothing inside the files to compare: the stats (or source maps) say what each holds.') : null;
  return (
    <Panel title="Duplicates" hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((d, i) => (
        <Row
          key={d.name}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(d.name, nameW), strong: true },
            { text: ` ${fit(d.kind === 'versions' ? `${d.versions.length} versions` : `${d.installs.length} paths`, 11)}`, color: d.kind === 'versions' ? theme.warn : theme.info },
            { text: ` ${fit(d.versions.join(', ') || '?', 18)}`, color: theme.dim },
            { text: ` ${fit(`+${formatBytes(d.wastedSize)}`, 10, 'right')}`, color: theme.del, bold: true },
            { text: ` ${fit(`+${formatBytes(d.wasted)} raw`, 14, 'right')}`, color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
