import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { SEVERITY_LABEL, securityRows, severityTone } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { countFindings, findingPlace, findingsLine } from '@fleet/kit/findings.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/**
 * What security.js found: in what the plan on screen would deploy, then in the folder's source files
 * (/security reads them), worst first under each heading: the severity, what, where, and what was seen.
 */
export function SecurityView({ planned, source, sourcesRead, hasPlan, ctx, width, height, active }) {
  const innerH = height - 2;
  const rows = securityRows({ planned, source });
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.finding), keyOf: (i) => (rows[i]?.finding ? `${rows[i].from}:${rows[i].finding.rule}:${rows[i].finding.where}:${rows[i].finding.line ?? ''}:${rows[i].finding.attribute ?? ''}` : rows[i]?.heading) });
  const sel = rows[nav.index]?.finding;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') a.showFinding(ctx, sel);
    else if (input === 't') a.shareFinding(ctx, sel);
    else if (input === 'y') ctx.copy(findingPlace(sel));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const titleW = Math.max(24, Math.min(46, Math.floor(inner * 0.44)));
  const whereW = Math.max(20, Math.min(48, Math.floor(inner * 0.3)));
  const all = [...planned, ...source];
  const hint = [findingsLine(countFindings(all)) || (hasPlan || sourcesRead ? 'nothing found' : ''), sourcesRead ? '' : '/security reads the source files'].filter(Boolean).join(' · ');
  const empty = !hasPlan && !sourcesRead ? '/security reads the .tf, .tfvars and .bicep files here (nothing is run); /plan or /whatif judges what they would deploy.' : 'Nothing insecure found in what was read.';
  return (
    <Panel title="Security" hint={hint} width={width} height={height} focused={active}>
      {!rows.length ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${empty}`, color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) =>
        r.heading ? (
          <Row key={`h:${r.heading}`} pointer={false} width={width - 2} segments={[{ text: r.heading, color: theme.accent, bold: true }, { text: `  ${r.count}`, color: theme.dim }]} />
        ) : (
          <Row
            key={`${r.from}:${nav.offset + i}`}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(SEVERITY_LABEL[r.finding.severity] ?? '?', 5), color: severityTone(r.finding.severity), bold: true },
              { text: fit(r.finding.title, titleW), strong: true },
              { text: ` ${fit(r.from === 'plan' ? r.finding.resource : findingPlace(r.finding), whereW)}`, color: theme.info },
              ...(r.finding.excerpt ? [{ text: ` ${r.finding.excerpt}`, color: theme.dim }] : []),
            ]}
          />
        ),
      )}
    </Panel>
  );
}
