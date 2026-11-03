import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { countFindings, findingPlace, findingsLine, sortFindings } from '@fleet/kit/findings.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };
export const severityTone = (s) => ({ critical: theme.del, high: theme.del, medium: theme.warn, low: theme.info })[s] ?? theme.dim;

/** What the captured traffic says, worst first (security.js): ↵ explains one. */
export function SecurityView({ findings, ctx, width, height, active }) {
  const list = sortFindings(findings);
  const innerH = height - 2;
  const nav = useListNav(list.length, innerH, { keyOf: (i) => (list[i] ? `${list[i].rule}|${list[i].where}|${list[i].title}` : null) });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') a.showFinding(ctx, sel);
    else if (input === 'y') ctx.copy(findingPlace(sel), findingPlace(sel));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const titleW = Math.max(20, Math.floor(inner * 0.45));
  return (
    <Panel title="Security" hint={findingsLine(countFindings(list)) || 'nothing found'} width={width} height={height} focused={active}>
      {!list.length ? <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing found in what was captured: no credentials in the clear or in URLs, no cookies set without Secure.', color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((f, i) => (
        <Row
          key={`${f.rule}|${f.where}|${f.title}`}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(LABEL[f.severity] ?? '?', 5), color: severityTone(f.severity), bold: true },
            { text: fit(f.title, titleW), strong: true },
            { text: ' ' },
            { text: fit(f.where, Math.max(10, inner - titleW - 13)), color: theme.info },
            { text: fit(f.count > 1 ? `×${f.count}` : '', 6, 'right'), color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
