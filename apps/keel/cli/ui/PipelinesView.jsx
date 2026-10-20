import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { HEALTH, branch, pipelineDetail, runState } from '../format.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useAsync, useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const pipelineId = (row) => `${row.org ?? ''}/${row.key}`;

const matches = (row, text) => {
  const q = text.trim().toLowerCase();
  return !q || [row.definition.name, row.projectName, row.repoName, branch(row.branch), row.health].some((s) => String(s ?? '').toLowerCase().includes(q));
};

/** Pipeline health in the tracked projects: failing first, then unstable, healthy and idle. */
export function PipelinesView({ failed, pipelines, version, filter, jump, ctx, width, height, active }) {
  const rows = useMemo(() => (pipelines ?? []).filter((r) => matches(r, filter)), [pipelines, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.55) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { resetKey: filter });
  const row = rows[nav.index];
  const nameW = Math.min(30, Math.max(8, ...rows.slice(0, 200).map((r) => r.definition.name.length)));
  // Runs reload with the rest of the data (the version moves on each poll and after each action).
  const runs = useAsync(split && row ? `${pipelineId(row)}:${version}` : null, () => ctx.service.pipelineRuns(row.projectId, row.definition.id).then((r) => r.runs), 150);

  // The runs on screen are this pipeline's (an older poll's, while the new ones load), never the last row's.
  const mine = row && runs.key?.startsWith(`${pipelineId(row)}:`);

  useEffect(() => {
    ctx.select({ pipeline: row });
  }, [row]);

  useEffect(() => {
    if (!jump) return;
    const i = rows.findIndex((r) => pipelineId(r) === jump);
    if (i >= 0) nav.setIndex(i);
    ctx.jumped();
  }, [jump, rows]);

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key) || !row) return;
      if (key.return) ctx.showPipelineRuns(row);
      else if (input === 'n') a.runPipeline(ctx, row);
      else if (input === 'c') a.cancelRun(ctx, row);
    },
    { isActive: active },
  );

  const failing = (pipelines ?? []).filter((r) => r.health === 'failing').length;
  const hint = pipelines ? [`${rows.length}`, failing ? `${failing} failing` : '', filter ? `matching "${filter}"` : ''].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (!pipelines) empty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!rows.length) empty = filter ? `  Nothing matches "${filter}". /find with nothing clears it.` : '  No pipelines in your tracked projects.';
  return (
    <Box width={width} height={height}>
      <Panel title="Pipelines" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          const h = HEALTH[r.health] ?? HEALTH.unknown;
          const now = r.running?.[0];
          const last = r.lastRun ?? r.latest;
          return (
            <Row
              key={pipelineId(r)}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: `${h.icon} `, color: h.color },
                { text: `${fit(r.definition.name, nameW)} `, strong: true },
                { text: r.passRate != null ? `${fit(`${Math.round(r.passRate * 100)}%`, 4, 'right')} ` : '     ', color: theme.dim },
                now ? { text: `${runState(now).icon} ${runState(now).label} · `, color: runState(now).color } : { text: '' },
                { text: `${r.projectName}${r.repoName ? ` / ${r.repoName}` : ''}`, color: theme.dim },
                { text: !now && last?.finishedAt ? ` · ${relTime(Date.parse(last.finishedAt))}` : '', color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={row ? row.definition.name : 'Pipeline'} hint={row ? 'n run · c cancel · ↵ all runs' : ''} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={row ? pipelineDetail(row, mine ? runs.value : null, { error: mine ? runs.error?.message : null }) : []} />
        </Panel>
      ) : null}
    </Box>
  );
}
