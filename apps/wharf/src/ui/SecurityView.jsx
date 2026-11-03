import React, { useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { countFindings, findingPlace, findingsLine } from '@fleet/kit/findings.js';
import { findingDetail, severityTone } from '../security.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { Viewer } from './Viewer.jsx';

const LABEL = { critical: 'CRIT', high: 'HIGH', medium: 'MED', low: 'LOW', unknown: '?' };

/**
 * What /security found (actions.js `security`), over the view, worst first: severity, what, where, what
 * was seen. ↵ opens one with the evidence, why it matters and the fix (a Viewer of its own, esc back to
 * the list); y copies it; r checks again (`arg` is what was checked); esc closes.
 */
export function SecurityView({ title, findings, arg, ctx, width, height, active, onClose }) {
  const innerH = height - 2;
  const [open, setOpen] = useState(null);
  const nav = useListNav(findings.length, innerH, { keyOf: (i) => `${findings[i]?.rule}:${findings[i]?.where}:${findings[i]?.line ?? ''}:${findings[i]?.title}` });
  const sel = findings[nav.index];

  const keys = (input, key) => {
    if (open || !ctx.overlayHasKeys()) return;
    if (key.escape || input === 'q') return onClose();
    if (nav.handle(input, key)) return;
    if (input === 'r') return a.security(ctx, arg);
    if (!sel) return;
    if (key.return || input === 'l') setOpen(sel);
    else if (input === 'y') a.copyFinding(ctx, sel);
  };
  useInput(keys, { isActive: active && !open });
  useMouse(ctx, (e) => {
    if (open) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  if (open) return <Viewer title={`${open.title} · ${findingPlace(open)}`} text={findingDetail(open)} ctx={ctx} width={width} height={height} active={active} onClose={() => queueMicrotask(() => setOpen(null))} />;

  const inner = width - 4;
  // Where takes what its longest needs (a compose file's path and line), up to two fifths; the title next.
  const whereW = Math.max(10, Math.min(Math.floor(inner * 0.4), Math.max(0, ...findings.map((f) => stringWidth(findingPlace(f))))));
  const titleW = Math.max(16, Math.min(46, Math.floor(inner * 0.4)));
  const excerptW = Math.max(0, inner - 5 - titleW - whereW - 3);
  const counts = findingsLine(countFindings(findings));
  return (
    <Panel title={title} hint={`${counts || 'nothing found'} · ↵ detail · y copy · r again · esc close`} width={width} height={height} focused={active}>
      {findings.length === 0 ? <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing found: none of them runs privileged, as root, with the socket, open ports or a password in its environment.', color: theme.dim }]} /> : null}
      {findings.slice(nav.offset, nav.offset + innerH).map((f, i) => (
        <Row
          key={`${f.rule}:${f.where}:${f.line ?? ''}:${f.title}`}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(LABEL[f.severity] ?? '?', 5), color: theme[severityTone(f.severity)], bold: true },
            { text: fit(f.title, titleW), strong: true },
            { text: ` ${fit(findingPlace(f), whereW)}`, color: theme.info },
            ...(excerptW > 6 ? [{ text: `  ${fit(f.excerpt ?? '', excerptW)}`, color: theme.dim }] : []),
          ]}
        />
      ))}
    </Panel>
  );
}
