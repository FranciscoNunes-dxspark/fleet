import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { countLine } from '../audit.js';
import { SEVERITY_LABEL, findingRows, severityTone } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** Every vulnerable package, worst first: its severity, name and version, how many advisories, and the version that fixes them. */
export function VulnsView({ data, found, counts, ignored, showDev, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = findingRows(found, { dev: showDev });
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.key });
  const sel = list[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'd') return ctx.toggleDev();
    if (!sel) return;
    if (key.return || input === 'l') a.showFinding(ctx, sel);
    else if (input === 'f') a.fix(ctx, sel);
    else if (input === 'o') a.open(ctx, sel);
    else if (input === 'x') a.ignore(ctx, sel);
    else if (input === 't') a.shareWhere(ctx, sel.pkg);
    else if (input === 'y') ctx.copy(sel.advisories.map((x) => x.id).join(' '), `${sel.pkg.name}'s advisories`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const nameW = Math.max(18, Math.min(42, Math.floor(inner * 0.32)));
  const hidden = found.length - list.length;
  const hint = [countLine(counts) || (data?.audit ? 'nothing known' : 'not audited'), hidden ? `${hidden} dev only hidden (d)` : '', ignored ? `${ignored} ignored` : ''].filter(Boolean).join(' · ');
  let empty = null;
  if (!data) empty = '  Reading the lock files…';
  else if (!data.manifests.length) empty = '  No package-lock.json, packages.lock.json or .NET project here. /move to a project.';
  else if (!data.audit) empty = '  Not audited yet: /audit asks OSV about these packages (their names and versions only).';
  else if (!list.length) empty = found.length ? '  Only development packages have advisories: d shows them.' : `  Nothing known against these ${data.packages.length} packages.`;
  return (
    <Panel title="Vulnerabilities" hint={hint} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((f, i) => (
        <Row
          key={f.key}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(SEVERITY_LABEL[f.severity], 5), color: severityTone(f.severity), bold: true },
            { text: fit(`${f.pkg.name}@${f.pkg.version}`, nameW), strong: true },
            { text: f.pkg.direct ? '      ' : ' via  ', color: theme.dim },
            { text: f.pkg.dev ? 'dev ' : '    ', color: theme.dim },
            { text: fit(f.fixed ? `→ ${f.fixed}` : 'no fix', 12), color: f.fixed ? theme.add : theme.warn },
            { text: fit(`${f.advisories.length > 1 ? `${f.advisories.length}× ` : ''}${f.advisories[0].summary}`, Math.max(10, inner - nameW - 30)), color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
