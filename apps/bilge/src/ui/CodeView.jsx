import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { countLine } from '../audit.js';
import { findingWhere } from '@fleet/kit/codescan.js';
import { SEVERITY_LABEL, severityTone } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const KIND = { secret: 'secret', code: 'code  ', config: 'config' };

/** What /code found in the folder's own files, worst first: severity, kind, what, where, the line (a secret cut short). */
export function CodeView({ code, found, counts, ctx, width, height, active }) {
  const innerH = height - 2;
  const nav = useListNav(found.length, innerH, { keyOf: (i) => found[i]?.key });
  const sel = found[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'r') return a.code(ctx);
    if (!sel) return;
    if (key.return || input === 'l') a.showCodeFinding(ctx, sel);
    else if (input === 'x') a.ignoreCode(ctx, sel);
    else if (input === 't') a.shareCode(ctx, sel);
    else if (input === 'y') ctx.copy(findingWhere(sel), findingWhere(sel));
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const titleW = Math.max(16, Math.min(34, Math.floor(inner * 0.26)));
  const whereW = Math.max(16, Math.min(44, Math.floor(inner * 0.3)));
  const ignored = (code?.findings.length ?? 0) - found.length;
  const hint = code ? [`${code.files} files`, countLine(counts) || 'nothing found', ignored ? `${ignored} ignored` : '', code.truncated ? 'stopped early' : ''].filter(Boolean).join(' · ') : 'not read';
  let empty = null;
  if (!code) empty = '  Not read yet: /code (or r here) reads this folder\'s own files for secrets, risky code and config. Nothing leaves the machine.';
  else if (!found.length) empty = ignored ? `  Nothing but what's ignored (${ignored}) in ${code.files} files.` : `  Nothing found in ${code.files} files.`;
  return (
    <Panel title="Code" hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {found.slice(nav.offset, nav.offset + innerH).map((f, i) => (
        <Row
          key={f.key}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(SEVERITY_LABEL[f.severity], 5), color: severityTone(f.severity), bold: true },
            { text: `${KIND[f.kind]} `, color: f.kind === 'secret' ? theme.del : theme.dim },
            { text: fit(f.title, titleW), strong: true },
            { text: ' ' },
            { text: fit(findingWhere(f), whereW), color: theme.info },
            { text: ' ' },
            { text: fit(f.excerpt, Math.max(10, inner - titleW - whereW - 15)), color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
