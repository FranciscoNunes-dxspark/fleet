import React, { useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { theme } from '../theme.js';
import { fit, wrap } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { RUNNER_NAMES } from '../parsers/index.js';
import { duration } from '../model.js';
import { failureText, placeOf } from '../share.js';

const ATTACHMENT_LABELS = { screenshot: 'Screenshot', trace: 'Trace', video: 'Video' };

/**
 * A failure as rows for the lower pane: what failed and where, the message, the diff (expected red,
 * actual green), the project's frames and a Playwright failure's attachments. A row with `frame` or
 * `attachment` takes the cursor.
 */
export function failureRows(t, width) {
  const f = t.failure ?? {};
  const w = Math.max(10, width - 4);
  const rows = [];
  const where = placeOf(t);
  rows.push({ segs: [{ text: '✗ ', color: theme.del, bold: true }, { text: [...t.suite, t.name].join(' › '), bold: true }] });
  rows.push({ segs: [{ text: `  ${RUNNER_NAMES[t.runner]} · ${where ? `${where.file}${where.line ? `:${where.line}` : ''}` : t.file} · ${duration(t.duration)}${t.flaky ? ' · flaky' : ''}`, color: theme.dim }] });
  rows.push({ segs: [] });
  for (const line of String(f.message ?? '').split('\n').slice(0, 40)) for (const part of line ? wrap(line, w) : ['']) rows.push({ segs: [{ text: `  ${part}` }] });
  if (f.diff?.length) {
    rows.push({ segs: [] });
    rows.push({ segs: [{ text: '  - Expected', color: theme.del }, { text: '  ' }, { text: '+ Actual', color: theme.add }] });
    for (const d of f.diff.slice(0, 200)) {
      const color = d.kind === '-' ? theme.del : d.kind === '+' ? theme.add : theme.dim;
      rows.push({ segs: [{ text: `  ${d.kind} ${d.text}`, color }] });
    }
  }
  if (f.frames?.length) {
    rows.push({ segs: [] });
    rows.push({ segs: [{ text: f.frames.some((x) => x.own) ? '  The stack, in the project (↵ opens the file there)' : '  The stack (none of it in the project)', color: theme.dim }] });
    for (const fr of f.frames) rows.push({ frame: fr, segs: [{ text: `${fr.file}:${fr.line}`, color: fr.own ? theme.info : theme.dim }, { text: fr.method ? `  ${fr.method}` : '', color: theme.dim }] });
  }
  if (t.attachments?.length) {
    rows.push({ segs: [] });
    for (const at of t.attachments) rows.push({ attachment: at, segs: [{ text: fit(ATTACHMENT_LABELS[at.name] ?? at.name, 11), color: theme.dim }, { text: at.path }, { text: at.name === 'trace' ? '  o opens it' : '', color: theme.dim }] });
  }
  return rows;
}

/**
 * Every failed test, worst news first, and under the list the one the cursor is on. ↵ goes into it, where
 * the cursor walks its frames and attachments; ↵ there opens a frame's file at its line.
 */
export function FailuresView({ run, data, pick, ctx, width, height, active }) {
  const failures = (run?.tests ?? []).filter((t) => t.status === 'failed');
  const [inside, setInside] = useState(false);
  const listH = Math.max(3, Math.min(failures.length + 2, Math.floor(height * 0.35)));
  const detailH = height - listH;
  // The Tree's pick (a failure it opened) puts the cursor on it.
  const picked = pick ? failures.findIndex((t) => t.id === pick) : -1;
  const nav = useListNav(failures.length, listH - 2, { keyOf: (i) => failures[i]?.id, resetKey: pick, start: Math.max(0, picked) });
  const sel = failures[nav.index];
  const rows = sel ? failureRows(sel, width) : [];
  const takes = (i) => Boolean(rows[i]?.frame || rows[i]?.attachment);
  const firstTaking = rows.findIndex((r) => r.frame || r.attachment);
  // Outside, the failure reads from its top; inside, the cursor walks what can be opened.
  const detail = useListNav(rows.length, detailH - 2, { selectable: inside && firstTaking >= 0 ? takes : () => true, resetKey: `${sel?.id}:${inside}`, start: inside ? Math.max(0, firstTaking) : 0 });
  const here = rows[detail.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (inside) {
      if (key.escape || input === 'h' || key.leftArrow) return setInside(false);
      if (detail.handle(input, key)) return;
    } else if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l' || key.rightArrow) {
      if (!inside) return setInside(true);
      if (here?.frame) return a.openFrame(ctx, here.frame);
      if (here?.attachment?.name === 'trace') return a.showTrace(ctx, sel);
      if (here?.attachment) return ctx.copy(here.attachment.path, `the ${here.attachment.name}'s path`);
      return;
    }
    if (input === 'r') return a.runTests(ctx, [sel]);
    if (input === 'o') return a.showTrace(ctx, sel);
    if (input === 't') return a.share(ctx, sel);
    if (input === 'y') return ctx.copy(failureText(sel), 'the failure');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.y < listH) {
      if (e.wheel) return nav.scrollBy(e.wheel * 3);
      if (nav.pick(e.y - 1)) {
        setInside(false);
        if (e.double) setInside(true);
      }
      return;
    }
    if (e.wheel) return detail.scrollBy(e.wheel * 3);
    if (detail.pick(e.y - listH - 1)) {
      setInside(true);
      if (e.double) keys('', { return: true });
    }
  });

  const counts = run?.counts;
  const hint = !run ? '' : failures.length ? `${failures.length} of ${counts.total} · ↵ into it · r again · alt+r all failed` : `none of ${counts.total}`;
  const innerW = width - 2;
  const nameW = Math.max(20, Math.floor(innerW * 0.55));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Panel title="Failures" hint={hint} width={width} height={listH} focused={active && !inside}>
        {!run ? <Row pointer={false} width={innerW} segments={[{ text: data?.suites?.length === 0 ? '  No tests found here: /runners says what was looked for.' : '  Nothing has run yet: ctrl+r runs every test.', color: theme.dim }]} /> : null}
        {run && !failures.length ? <Row pointer={false} width={innerW} segments={[{ text: `  Every test passed (${counts.passed}${counts.skipped ? `, ${counts.skipped} skipped` : ''}).`, color: theme.add }]} /> : null}
        {failures.slice(nav.offset, nav.offset + listH - 2).map((t, i) => (
          <Row
            key={t.id}
            width={innerW}
            selected={nav.offset + i === nav.index}
            focused={active && !inside}
            segments={[
              { text: '✗ ', color: theme.del },
              { text: fit([...t.suite, t.name].join(' › '), nameW), strong: true },
              { text: ` ${fit(t.file, Math.max(8, innerW - nameW - 22))}`, color: theme.dim },
              { text: ` ${fit(RUNNER_NAMES[t.runner], 11)}`, color: theme.dim },
              { text: t.flaky ? ' flaky' : '', color: theme.warn },
            ]}
          />
        ))}
      </Panel>
      <Panel title="Failure" hint={sel ? (inside ? 'j k frames · ↵ open · h back · t for Splice · y copy' : '↵ into it') : ''} width={width} height={detailH} focused={active && inside}>
        {rows.slice(detail.offset, detail.offset + detailH - 2).map((r, i) => (
          <Row key={i} width={innerW} pointer={takes(detail.offset + i)} selected={inside && detail.offset + i === detail.index} focused={active && inside} segments={r.segs} />
        ))}
      </Panel>
    </Box>
  );
}
