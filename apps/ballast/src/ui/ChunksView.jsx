import React, { useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { totals } from '../build.js';
import { formatBytes, sizeIn } from '../sizes.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const SORTS = ['size', 'name'];
const BAR = 10;

/**
 * Every file the build ships: its path, raw, gzip and brotli sizes, a bar of its share of the whole (in
 * the measure), `entry` for what a page loads first, and OVER with the budget it is over.
 */
export function ChunksView({ build, checks, measure, ctx, width, height, active }) {
  // One row for the columns' names.
  const innerH = height - 3;
  const [sort, setSort] = useState('size');
  const chunks = build?.chunks ?? [];
  const list = sort === 'name' ? [...chunks].sort((x, y) => x.file.localeCompare(y.file)) : [...chunks].sort((x, y) => sizeIn(y, measure) - sizeIn(x, measure));
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.file });
  const sel = list[nav.index];
  // The budget each file is over, the tightest first.
  const overOf = (c) => checks.filter((b) => b.files.some((f) => f.file === c.file && f.over)).sort((x, y) => x.limit - y.limit)[0];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 's') return setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length]);
    if (input === 'c') return a.check(ctx);
    if (!sel) return;
    if (key.return || input === 'l') a.showChunk(ctx, sel);
    else if (input === 'y') ctx.copy(sel.file);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 2) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const all = sizeIn(totals(chunks), measure) || 1;
  const fileW = Math.max(20, inner - 66);
  const over = checks.filter((b) => b.over).length;
  const hint = build ? [`${chunks.length} file${chunks.length === 1 ? '' : 's'}`, `${formatBytes(sizeIn(totals(chunks), measure))} ${measure}`, over ? `${over} over budget` : checks.length ? 'within budgets' : '', `sorted by ${sort} (s)`].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (!build) empty = '  Reading the build…';
  else if (!chunks.length) empty = '  No stats file and no output folder (dist, build, .next/static, out): /build builds it once with stats.';
  return (
    <Panel title={chunks.length ? `Chunks · ${build.source.label}` : 'Chunks'} hint={hint} width={width} height={height} focused={active}>
      {empty ? (
        <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} />
      ) : (
        <Row pointer={false} width={width - 2} segments={[{ text: `  ${fit('file', fileW)} ${fit('raw', 9, 'right')} ${fit('gzip', 9, 'right')} ${fit('brotli', 9, 'right')} share of ${measure}`, color: theme.dim }]} />
      )}
      {list.slice(nav.offset, nav.offset + innerH).map((c, i) => {
        const share = sizeIn(c, measure) / all;
        const filled = Math.max(share > 0 ? 1 : 0, Math.round(share * BAR));
        const b = overOf(c);
        return (
          <Row
            key={c.file}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(c.file, fileW), strong: true, color: c.modules.length ? undefined : theme.dim },
              { text: ` ${fit(formatBytes(c.raw), 9, 'right')}`, color: measure === 'raw' ? undefined : theme.dim },
              { text: ` ${fit(c.gzip == null ? '—' : formatBytes(c.gzip), 9, 'right')}`, color: measure === 'gzip' ? undefined : theme.dim, bold: measure === 'gzip' },
              { text: ` ${fit(c.brotli == null ? '—' : formatBytes(c.brotli), 9, 'right')}`, color: measure === 'brotli' ? undefined : theme.dim },
              { text: ` ${'█'.repeat(filled)}${'░'.repeat(BAR - filled)}`, color: b ? theme.del : theme.accent },
              { text: c.entry ? ' entry' : '      ', color: theme.info },
              ...(b ? [{ text: ` OVER ${formatBytes(b.limit)}`, color: theme.del, bold: true }] : []),
            ]}
          />
        );
      })}
    </Panel>
  );
}
