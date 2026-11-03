import React, { useMemo, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { theme } from '../theme.js';
import { fit, fitSegments, stringWidth } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { RUNNER_NAMES } from '../parsers/index.js';
import { duration } from '../model.js';
import { treeRows } from '../tree.js';

const MARK = { failed: '✗', passed: '✓', skipped: '○' };
const tone = (status) => (status === 'failed' ? theme.del : status === 'passed' ? theme.add : theme.dim);

/** A file's or suite's counts, the failures first: "2✗ 10✓ 1○". */
function countSegs(c) {
  const segs = [];
  if (c.failed) segs.push({ text: ` ${c.failed}✗`, color: theme.del, bold: true });
  if (c.passed) segs.push({ text: ` ${c.passed}✓`, color: theme.add });
  if (c.skipped) segs.push({ text: ` ${c.skipped}○`, color: theme.dim });
  return segs;
}

/** Files, suites and tests, with how each went and how long it took; f keeps the failures only. */
export function TreeView({ run, ctx, width, height, active, onPickFailure }) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  // Built again only when the run, the filter or a fold changes, not on every key that moves the cursor.
  const tests = run?.tests;
  const rows = useMemo(() => treeRows(tests ?? [], { failuresOnly, collapsed }), [tests, failuresOnly, collapsed]);
  const innerH = height - 2;
  const nav = useListNav(rows.length, innerH, { keyOf: (i) => rows[i]?.key });
  const sel = rows[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'f') return setFailuresOnly((f) => !f);
    if (!sel) return;
    if (key.return || input === 'l' || key.rightArrow || key.leftArrow || input === 'h') {
      if (sel.kind === 'test') {
        if (key.leftArrow || input === 'h') return;
        return sel.test.status === 'failed' ? onPickFailure(sel.test) : a.showTest(ctx, sel.test);
      }
      return setCollapsed((was) => {
        const next = new Set(was);
        const fold = key.leftArrow || input === 'h' ? true : key.rightArrow || input === 'l' ? false : !next.has(sel.key);
        if (fold) next.add(sel.key);
        else next.delete(sel.key);
        return next;
      });
    }
    if (input === 'r') return a.runTests(ctx, sel.tests, sel.kind === 'test' ? null : sel.kind === 'file' ? sel.label : `the ${sel.label} suite`);
    if (input === 't' && sel.kind === 'test') return a.share(ctx, sel.test);
    if (input === 'y') return ctx.copy(sel.kind === 'test' ? [...sel.test.suite, sel.test.name].join(' › ') : sel.label);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const innerW = width - 2;
  const c = run?.counts;
  const hint = run ? `${failuresOnly ? 'failures only · ' : ''}${c.total} tests · f ${failuresOnly ? 'everything' : 'failures only'} · r run · ↵ fold or show` : '';
  return (
    <Panel title="Tree" hint={hint} width={width} height={height} focused={active}>
      {!run ? <Row pointer={false} width={innerW} segments={[{ text: '  Nothing has run yet: ctrl+r runs every test.', color: theme.dim }]} /> : null}
      {run && !rows.length ? <Row pointer={false} width={innerW} segments={[{ text: failuresOnly ? '  Nothing failed. f shows everything.' : '  No tests in the last run.', color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
        const indent = '  '.repeat(r.depth);
        const right = [...(r.kind === 'test' ? [] : countSegs(r.counts)), { text: `  ${fit(duration(r.duration), 7, 'right')}`, color: theme.dim }];
        const rightW = right.reduce((n, s) => n + stringWidth(s.text), 0);
        let left;
        if (r.kind === 'file') left = [{ text: collapsed.has(r.key) ? '▸ ' : '▾ ', color: theme.dim }, { text: r.label, strong: true, color: r.counts.failed ? theme.del : undefined }, { text: `  ${RUNNER_NAMES[r.runner]}`, color: theme.dim }];
        else if (r.kind === 'suite') left = [{ text: `${indent}${collapsed.has(r.key) ? '▸ ' : '▾ '}`, color: theme.dim }, { text: r.label, color: r.counts.failed ? theme.del : undefined }];
        else {
          const t = r.test;
          left = [{ text: `${indent}${t.flaky && t.status === 'passed' ? '↻' : MARK[t.status]} `, color: t.flaky && t.status === 'passed' ? theme.warn : tone(t.status) }, { text: r.label, color: t.status === 'skipped' ? theme.dim : undefined }];
        }
        const leftW = Math.max(10, innerW - 2 - rightW);
        return <Row key={r.key} width={innerW} selected={nav.offset + i === nav.index} focused={active} segments={[...fitSegments(left, leftW), ...right]} />;
      })}
    </Panel>
  );
}
