import React, { useMemo, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { moduleTree, treeRows } from '../modules.js';
import { formatBytes } from '../sizes.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** The name a node hands on: a package's, or a module's package's. */
const packageName = (node) => node.name ?? node.pkg?.name ?? null;

/**
 * What is inside one chunk (`file`), or every chunk (null): packages and the project's folders as a
 * tree, biggest first, each with its size in the measure (an estimate at its chunk's ratio), its raw
 * size, its share and how many modules it holds.
 */
export function ModulesView({ build, file, measure, ctx, width, height, active }) {
  const innerH = height - 2;
  const chunks = (build?.chunks ?? []).filter((c) => (file ? c.file === file : c.modules.length));
  const tree = useMemo(() => moduleTree(chunks, measure), [build, file, measure]);
  const [open, setOpen] = useState(() => new Set());
  const rows = treeRows(tree, open);
  const nav = useListNav(rows.length, innerH, { keyOf: (i) => rows[i]?.node.key, resetKey: file ?? '' });
  const sel = rows[nav.index];
  const total = tree.reduce((n, x) => n + x.bytes, 0) || 1;
  const choices = [null, ...(build?.chunks ?? []).filter((c) => c.modules.length).map((c) => c.file)];

  const toggle = (node, on = !open.has(node.key)) =>
    setOpen((was) => {
      const next = new Set(was);
      if (on) next.add(node.key);
      else next.delete(node.key);
      return next;
    });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'c' || input === 'C') return ctx.showModules(choices[(choices.indexOf(file) + (input === 'C' ? choices.length - 1 : 1)) % choices.length]);
    if (!sel) return;
    const { node } = sel;
    if (key.return || input === 'l' || key.rightArrow) {
      if (node.children?.length) return toggle(node);
      return a.showModule(ctx, node);
    }
    if (input === 'h' || key.leftArrow) {
      if (sel.open) return toggle(node, false);
      // Up to the node this one is in.
      for (let i = nav.index - 1; i >= 0; i--) if (rows[i].depth < sel.depth) return nav.setIndex(i);
      return;
    }
    if (input === 'p') return packageName(node) ? a.packageDetail(ctx, packageName(node)) : ctx.note('That is the project\'s own code, not a package.');
    if (input === 'w') return packageName(node) ? a.whyForBilge(ctx, packageName(node)) : ctx.note('That is the project\'s own code: t copies it for Splice.');
    if (input === 't') return node.kind === 'module' ? a.shareModule(ctx, node) : ctx.note('t hands Splice one file of the project\'s own: open the folder and pick one.');
    if (input === 'y') ctx.copy(node.id ?? node.installPath ?? node.path ?? node.name);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const labelW = Math.max(24, inner - 40);
  const where = file ?? `all ${choices.length - 1} chunks`;
  const hint = build ? [where, `${formatBytes(total)} raw`, 'c next chunk', '↵ opens'].join(' · ') : '';
  const empty = !build ? '  Reading the build…' : !chunks.length ? '  Nothing inside to show: the stats (or source maps) say what a file holds, and there are none for this one. /build builds with them.' : null;
  return (
    <Panel title={`Modules · ${file ?? 'all chunks'}`} hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map(({ node, depth, open: isOpen }, i) => {
        const mark = node.children?.length ? (isOpen ? '▾ ' : '▸ ') : '  ';
        const label = node.kind === 'package' ? `${node.label}${node.versions.length ? ` ${node.versions.join(', ')}` : ''}` : node.label;
        const share = node.bytes / total;
        return (
          <Row
            key={node.key}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(`${'  '.repeat(depth)}${mark}${label}`, labelW), strong: node.kind === 'package' || node.kind === 'dir', color: node.kind === 'package' && node.installs > 1 ? theme.warn : node.kind === 'install' ? theme.dim : undefined },
              { text: ` ${fit(formatBytes(node.size), 9, 'right')}`, bold: true },
              { text: ` ${fit(formatBytes(node.bytes), 9, 'right')}`, color: theme.dim },
              { text: ` ${fit(`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`, 6, 'right')}`, color: share >= 0.2 ? theme.del : share >= 0.05 ? theme.warn : theme.dim },
              { text: node.modules > 1 ? ` ${node.modules} modules` : '', color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
