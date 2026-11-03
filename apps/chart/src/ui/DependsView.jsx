import React, { useMemo } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { actionRank } from '../plan.js';
import { dependencyRows, dependentsOf } from '../graph.js';
import { ACTION_MARK, ACTION_WORD, actionTone } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const LOSES = new Set(['delete', 'replace']);

/**
 * What is destroyed or replaced and what each reaches, walked once: `reachOf` (address → what depends
 * on it), `affected` as graph.js's affectedBy gives it (address → what it is affected by), and each
 * change's action by address.
 */
function reaches(changes, dependsOn) {
  const lost = changes.filter((c) => LOSES.has(c.action));
  const reachOf = new Map();
  const affected = {};
  for (const c of lost) {
    const deps = dependentsOf(dependsOn, c.address);
    reachOf.set(c.address, deps);
    for (const d of deps) (affected[d] ??= []).push(c.address);
  }
  const actionOf = new Map();
  for (const c of changes) if (!actionOf.has(c.address)) actionOf.set(c.address, c.action);
  return { lost, reachOf, affected, actionOf };
}

/**
 * What depends on what: the plan's resources as a tree, what nothing depends on at the top and under
 * each what depends on it. What is destroyed or replaced is red with how many it affects; what
 * depends on one of those is yellow, with which. `focus` is the address the cursor starts on.
 */
export function DependsView({ changes, dependsOn, focus, empty, ctx, width, height, active }) {
  const innerH = height - 2;
  // The tree and what each destroy reaches, once per plan rather than on every key: over thousands of
  // resources each took a second.
  const rows = useMemo(() => (dependsOn ? dependencyRows(changes, dependsOn, { rank: actionRank }) : []), [changes, dependsOn]);
  const { lost, reachOf, affected, actionOf } = useMemo(() => reaches(changes, dependsOn), [changes, dependsOn]);
  const start = Math.max(0, rows.findIndex((r) => r.change.address === focus && !r.repeat));
  const nav = useListNav(rows.length, innerH, { start, resetKey: `${focus}:${rows.length}`, keyOf: (i) => (rows[i] ? `${rows[i].change.address}:${rows[i].depth}` : null) });
  const sel = rows[nav.index]?.change;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') a.showChange(ctx, sel);
    else if (input === 'y') ctx.copy(sel.address);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const hint = !dependsOn ? '' : lost.length ? `${lost.length} destroyed or replaced · ${Object.keys(affected).length} affected` : 'nothing destroyed';
  const inner = width - 4;
  return (
    <Panel title="Depends" hint={hint} width={width} height={height} focused={active}>
      {!rows.length ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${empty}`, color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const c = r.change;
        const indent = r.depth ? `${'  '.repeat(r.depth - 1)}└ ` : '';
        const loses = LOSES.has(c.action);
        const n = loses ? (reachOf.get(c.address)?.length ?? 0) : 0;
        const by = affected[c.address];
        const verb = (addr) => (actionOf.get(addr) === 'replace' ? 'replacing' : 'destroying');
        const tail = r.repeat ? '  (above)' : loses && n ? `  ${ACTION_WORD[c.action]}: affects ${n}` : by ? `  ← ${by.map((x) => `${verb(x)} ${x}`).join(', ')}` : '';
        return (
          <Row
            key={`${c.address}:${r.depth}:${nav.offset + i}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: indent, color: theme.border },
              { text: `${ACTION_MARK[c.action]} `, color: actionTone(c.action), bold: true },
              { text: fit(c.address, Math.max(10, Math.min(44, inner - indent.length - 24))), strong: !r.repeat, color: r.repeat || ['noop', 'ignore'].includes(c.action) ? theme.dim : loses ? theme.del : undefined, bold: loses },
              { text: tail, color: loses ? theme.del : by ? theme.warn : theme.dim, bold: loses && n > 0 },
            ]}
          />
        );
      })}
    </Panel>
  );
}
