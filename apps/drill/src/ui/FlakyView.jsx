import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { theme } from '../theme.js';
import { fit, relTime } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { RUNNER_NAMES } from '../parsers/index.js';
import { WINDOW } from '../flaky.js';

/** The test a flaky entry is, as the last run has it, or one made from what the history kept (to run it again, or hand it on). */
const asTest = (f, run) => run?.tests.find((t) => t.id === f.id) ?? { id: f.id, runner: f.runner, file: f.file, suite: f.suite ?? [], name: f.name, status: 'passed', duration: 0, ...(f.line ? { line: f.line } : {}), ...(f.fqn ? { fqn: f.fqn } : {}) };

/** Tests that both passed and failed in their last runs (flaky.js), the most often failing first. */
export function FlakyView({ flaky, run, ctx, width, height, active }) {
  const innerH = height - 2;
  const nav = useListNav(flaky.length, innerH, { keyOf: (i) => flaky[i]?.id });
  const sel = flaky[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l')
      return ctx.showText(
        [...(sel.suite ?? []), sel.name].join(' › '),
        [`${sel.fails} of its last ${sel.runs} runs failed (${sel.marks}, oldest first: ✓ passed, ✗ failed, ↻ passed on a retry).`, `${RUNNER_NAMES[sel.runner] ?? sel.runner} · ${sel.file}${sel.line ? `:${sel.line}` : ''}`, sel.lastFailed ? `It last failed ${relTime(sel.lastFailed)}.` : ''].join('\n'),
      );
    if (input === 'r') return a.runTests(ctx, [asTest(sel, run)]);
    if (input === 't') return a.share(ctx, asTest(sel, run));
    if (input === 'y') return ctx.copy([...(sel.suite ?? []), sel.name].join(' › '));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const innerW = width - 2;
  const nameW = Math.max(20, Math.floor(innerW * 0.45));
  return (
    <Panel title="Flaky" hint={flaky.length ? `${flaky.length} in the last ${WINDOW} runs · r run · t for Splice` : ''} width={width} height={height} focused={active}>
      {!flaky.length ? <Row pointer={false} width={innerW} segments={[{ text: `  No test has both passed and failed in its last ${WINDOW} runs.`, color: theme.dim }]} /> : null}
      {flaky.slice(nav.offset, nav.offset + innerH).map((f, i) => (
        <Row
          key={f.id}
          width={innerW}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(f.marks, WINDOW + 1), color: theme.warn },
            { text: fit(`${f.fails}/${f.runs}`, 6), color: theme.del },
            { text: fit([...(f.suite ?? []), f.name].join(' › '), nameW), strong: true },
            { text: ` ${f.file}`, color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
