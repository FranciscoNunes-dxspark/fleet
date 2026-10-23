import React from 'react';
import { useInput } from 'ink';
import { incident, showOperation, why } from '../actions.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/** The exceptions in scope grouped by problem, most frequent first, with how they went over the span. */
export function ProblemsView({ problems, scope, ctx, width, height, active }) {
  const list = problems?.rows ?? [];
  const innerH = height - 2;
  const nav = useListNav(list.length, innerH, { resetKey: problems });
  const sel = list[nav.index];
  ctx.selectProblem(sel ?? null);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'c') return ctx.chooseComponent();
    if (!sel) return;
    if (key.return) return showOperation(ctx, sel);
    if (input === 'w') return why(ctx, sel);
    if (input === 'I') return incident(ctx, sel);
    if (input === 'l') return ctx.logsFor(null, `exceptions | where problemId == '${sel.problemId.replace(/'/g, "\\'")}' | order by timestamp desc | take 50`);
    if (input === 'y') return ctx.copy(sel.message ?? sel.problemId, 'the message');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const where = scope.component ? `${scope.component.name}${scope.role ? ` · ${scope.role}` : ''}` : scope.why;
  const status = problems?.loading ? 'looking…' : problems?.error ? 'failed' : `${list.length} problem${list.length === 1 ? '' : 's'} · ${problems?.span?.label ?? ''}`;
  const message = problems?.error ?? (problems?.loading && !list.length ? 'Looking for exceptions…' : !list.length && problems ? 'No exceptions in this span. t changes it.' : null);
  return (
    <Panel title="Problems" hint={`${where} · ${status}`} width={width} height={height} focused={active}>
      {message ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${message}`, color: problems?.error ? theme.del : theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((p, i) => (
        <Row
          key={p.problemId}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(String(p.count), 6, 'right'), color: theme.del, bold: true },
            { text: ` ${(problems.spark?.[p.problemId] ?? '').padStart(12)} `, color: theme.warn },
            { text: fit(p.type.split('.').pop(), 22), strong: true },
            { text: ` ${fit(p.role ?? '', 16)}`, color: theme.info },
            { text: ` ${fit(`${relTime(Date.parse(p.last))} ago`, 8)}`, color: theme.dim },
            { text: ` ${p.message ?? ''}` },
          ]}
        />
      ))}
    </Panel>
  );
}
