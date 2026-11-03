import React, { useEffect, useMemo } from 'react';
import { Box, useInput } from 'ink';
import { SEVERITY_TAG, findingDetail, findingMatches, gapNotes, reviewScope } from '../security.js';
import { findingsLine } from '@fleet/kit/findings.js';
import { shownFilter } from '../filters.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Lines, Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { wrapLines } from './wrap.js';

/**
 * /security: the security review of Azure DevOps projects, worst first, over the current tab (an
 * overlay, as Settings is). The selected finding shows beside the list; ↵ opens it in the viewer
 * (esc there comes back here); App's keys over it, as over Settings: o opens it in Azure DevOps
 * (ctx.current() is the finding), / the prompt, esc closes the review.
 */
export function SecurityView({ review, start = 0, filter, ctx, width, height, active }) {
  const findings = useMemo(() => (review?.findings ?? []).filter((f) => findingMatches(f, filter)), [review, filter]);
  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.6) : width;
  const sideW = width - listW;
  const innerH = height - 2;
  const innerW = listW - 2;
  const nav = useListNav(findings.length, innerH, { resetKey: filter, start });
  const finding = findings[nav.index];

  useEffect(() => {
    ctx.select({ finding });
  }, [finding]);

  const keys = (input, key) => {
    if (!ctx.securityHasKeys()) return;
    if (nav.handle(input, key) || !finding) return;
    // The viewer's esc comes back here, on the same finding.
    if (key.return) ctx.showText(finding.title, findingDetail(finding), { back: { security: review, at: nav.index } });
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const gaps = gapNotes(review);
  let empty = null;
  if (!findings.length) empty = filter ? `  Nothing matches ${shownFilter(filter)}. /find with nothing clears it.` : '  Nothing found: these projects pass every check Keel makes.';
  const hint = `${filter ? `${findings.length} matching ${shownFilter(filter)}` : findingsLine(review.counts) || 'nothing found'}${gaps.length ? ` · ${gaps.length} not read` : ''}`;
  const detail = finding ? findingDetail(finding).split('\n') : [];
  if (gaps.length) detail.push('', 'Not reviewed:', ...gaps.map((g) => `  ${g}`));
  return (
    <Box width={width} height={height}>
      <Panel title={`Security · ${reviewScope(review)}`} hint={hint} width={listW} height={height} focused={active}>
        {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
        {empty && gaps.length ? gaps.map((g, i) => <Row key={`gap${i}`} pointer={false} width={innerW} segments={[{ text: `  ${g}`, color: theme.warn }]} />) : null}
        {findings.slice(nav.offset, nav.offset + innerH).map((f, i) => {
          const tag = SEVERITY_TAG[f.severity] ?? SEVERITY_TAG.unknown;
          return (
            <Row
              key={`${f.org ?? ''}|${f.rule}|${f.where}`}
              width={innerW}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: fit(tag.label, 5), color: theme[tag.color] },
                { text: f.title, strong: true },
                { text: `  ${f.where}`, color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      {split ? (
        <Panel title={finding ? finding.rule : 'Finding'} hint={finding ? '↵ in full · o open · esc close' : 'esc close'} width={sideW} height={height}>
          <Lines width={sideW - 2} height={innerH} lines={wrapLines(detail, sideW - 2)} />
        </Panel>
      ) : null}
    </Box>
  );
}
