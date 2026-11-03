import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { runLabel } from '../compare.js';
import { formatBytes, formatDelta, formatPercent } from '../sizes.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** The rows: the headline, then the chunks that changed, then the packages (headers can't be selected). */
function compareRows(result) {
  const rows = [{ kind: 'headline' }];
  const chunks = result.chunks.filter((c) => c.status !== 'same');
  rows.push({ kind: 'header', text: chunks.length ? `Files (${chunks.length} changed, ${result.chunks.length - chunks.length} the same)` : 'Files: none changed' });
  rows.push(...chunks.map((c) => ({ kind: 'chunk', row: c })));
  if (result.packages.length) rows.push({ kind: 'header', text: `Packages (${result.packages.length} changed)` }, ...result.packages.map((p) => ({ kind: 'package', row: p })));
  return rows;
}

/**
 * This build against its base: the headline ("+42.1 kB gzip, from date-fns 4 now imported whole"),
 * every file that changed, and every package, biggest change first.
 */
export function CompareView({ compare, measure, ctx, width, height, active }) {
  const innerH = height - 2;
  const result = compare?.result;
  const rows = result ? compareRows(result) : [];
  const selectable = (i) => rows[i]?.kind === 'chunk' || rows[i]?.kind === 'package';
  const nav = useListNav(rows.length, innerH, { selectable, keyOf: (i) => (rows[i]?.row ? `${rows[i].kind}:${rows[i].row.name}` : rows[i]?.kind), resetKey: `${compare?.base}:${compare?.run?.key}` });
  const sel = selectable(nav.index) ? rows[nav.index] : null;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'b') return a.compare(ctx, compare?.base === 'main' ? 'last' : 'main');
    if (input === 'm') return a.markdown(ctx);
    if (input === 'y' && result) return ctx.copy(result.headline, 'the headline');
    if (!sel) return;
    if (key.return || input === 'l') a.showChange(ctx, sel.row);
    else if (input === 'p') return sel.kind === 'package' ? a.packageDetail(ctx, sel.row.name) : ctx.note('p is for a package: pick one under Packages.');
    else if (input === 'w') return sel.kind === 'package' ? a.whyForBilge(ctx, sel.row.name) : ctx.note('w is for a package: pick one under Packages.');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const nameW = Math.max(20, inner - 46);
  const m = result?.measure ?? measure;
  const size = (x) => (x ? formatBytes(x[m] ?? x.raw) : '—');
  const hint = compare ? `against ${compare.name} · b ${compare.base === 'main' ? 'the last build' : 'main'} · m markdown` : 'b main · /compare <ref>';
  let empty = null;
  if (!compare) empty = '  Nothing compared yet: the first build read is kept, and the next is compared with it. b compares with main.';
  else if (!result) empty = `  ${compare.missing}${compare.base !== 'last' ? '' : ' b compares with main.'}`;
  return (
    <Panel title={result ? `Compare · against ${runLabel(compare.run, compare.name)}` : 'Compare'} hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const at = nav.offset + i;
        if (r.kind === 'headline') {
          const t = result.total;
          return <Row key="headline" pointer={false} width={width - 2} segments={[{ text: ` ${result.headline}`, bold: true, color: t.delta > 0 ? theme.del : t.delta < 0 ? theme.add : undefined }, { text: `  ${formatBytes(t.before)} → ${formatBytes(t.after)}${t.before ? ` (${formatPercent(t.delta, t.before)})` : ''}`, color: theme.dim }]} />;
        }
        if (r.kind === 'header') return <Row key={`h:${r.text}`} pointer={false} width={width - 2} segments={[{ text: ` ${r.text}`, color: theme.accent, bold: true }]} />;
        const x = r.row;
        const label = r.kind === 'package' ? x.reason : x.name;
        return (
          <Row
            key={`${r.kind}:${x.name}`}
            width={width - 2}
            selected={at === nav.index}
            focused={active}
            segments={[
              { text: fit(label, nameW), strong: true },
              { text: ` ${fit(size(x.before), 9, 'right')}`, color: theme.dim },
              { text: ` → ${fit(size(x.after), 9, 'right')}`, color: theme.dim },
              { text: ` ${fit(x.status === 'added' ? 'new' : x.status === 'removed' ? 'gone' : formatDelta(x.delta), 11, 'right')}`, color: x.delta > 0 ? theme.del : x.delta < 0 ? theme.add : theme.dim, bold: Math.abs(x.delta) >= 1000 },
            ]}
          />
        );
      })}
    </Panel>
  );
}
