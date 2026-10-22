import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { approvalsFor, githubDetail, githubRows, githubStrip, isGithubRelease, releaseDetail, releaseHealth, releaseRows, stageStrip } from '../releases.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { applyFilter, shownFilter } from '../filters.js';
import { useAsync, useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const releaseId = (d) => `${d.org ?? ''}/${d.key}`;

/**
 * Classic release pipelines, as the web app's Releases tab: each stage's latest deployment, what's
 * deploying or waiting for approval, and the recent releases. Below them, the tracked GitHub repos'
 * releases with their files. Read when the tab opens, and again with each load (the version moves
 * on each check and after each action).
 */
export function ReleasesView({ version, filter, ctx, width, height, active }) {
  const data = useAsync(`releases:${version}`, () => ctx.service.releases(), 50);
  const github = useAsync(`repo-releases:${version}`, () => ctx.service.repoReleases(), 50);
  // The filter's fields (project:) narrow them; its words search them.
  const rows = useMemo(() => {
    const { items, text } = applyFilter('releases', data.value?.definitions ?? [], filter);
    const repos = applyFilter('releases', github.value ?? [], filter);
    return [...releaseRows(data.value && { ...data.value, definitions: items }, text), ...githubRows(repos.items, repos.text)];
  }, [data.value, github.value, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.5) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(rows.length, innerH, { resetKey: filter });
  const d = rows[nav.index];
  const approvals = data.value?.approvals ?? [];
  const nameW = Math.min(28, Math.max(8, ...rows.map((r) => r.name.length)));

  useEffect(() => {
    ctx.select({ release: d, releaseApprovals: approvals, filterSource: { tab: 'releases', items: [...(data.value?.definitions ?? []), ...(github.value ?? [])] } });
  }, [d, data.value, github.value]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'F') return a.pickFilter(ctx);
    if (nav.handle(input, key) || !d) return;
    if (key.return) ctx.showReleaseFull(d, approvals);
    else if (input === 'D') a.downloadReleaseFile(ctx, d);
    else if (input === 'n') a.createRelease(ctx, d);
    else if (input === 'd') a.deployStage(ctx, d);
    else if (input === 'a') a.decideRelease(ctx, d, 'approved');
    else if (input === 'x') a.decideRelease(ctx, d, 'rejected');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const waiting = rows.filter((r) => approvalsFor(r, approvals).length).length;
  const hint = data.value ? [String(rows.length), waiting ? `${waiting} waiting for approval` : '', filter ? `matching ${shownFilter(filter)}` : ''].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (data.error && !data.value) empty = `  Couldn't read the release pipelines: ${String(data.error.message).split('\n')[0]}`;
  else if (!data.value) empty = '  Reading Azure DevOps…';
  else if (!rows.length) empty = filter ? `  Nothing matches ${shownFilter(filter)}. /find with nothing clears it.` : '  No classic release pipelines (Pipelines → Releases in Azure DevOps) or GitHub releases in your tracked projects.';
  return (
    <Box width={width} height={height}>
      <Panel title="Releases" hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: empty.includes("Couldn't") ? theme.del : theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          const h = releaseHealth(r);
          const asks = approvalsFor(r, approvals).length;
          return (
            <Row
              key={releaseId(r)}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={isGithubRelease(r) ? [
                { text: '↓ ', color: theme.accent },
                { text: `${fit(r.name, nameW)}  `, strong: true },
                ...githubStrip(r),
              ] : [
                { text: `${asks ? '‖' : h.icon} `, color: asks ? theme.warn : h.color },
                { text: `${fit(r.name, nameW)}  `, strong: true },
                ...stageStrip(r),
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={d ? d.name : 'Release pipeline'} hint={!d ? '' : isGithubRelease(d) ? 'D download · ↵ all · o GitHub' : 'n release · d deploy · ↵ all'} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={!d ? [] : isGithubRelease(d) ? githubDetail(d) : releaseDetail(d, approvals)} />
        </Panel>
      ) : null}
    </Box>
  );
}
