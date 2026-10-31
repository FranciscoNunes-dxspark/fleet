import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { stateRows } from '../rows.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** Every resource in the state, under its module's heading. */
export function StateView({ state, ctx, width, height, active }) {
  const innerH = height - 2;
  const rows = state ? stateRows(state.resources) : [];
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.resource), keyOf: (i) => rows[i]?.resource?.address ?? rows[i]?.heading });
  const sel = rows[nav.index]?.resource;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') a.showResource(ctx, sel);
    else if (input === 't') a.shareDeclaration(ctx, sel);
    else if (input === 'y') ctx.copy(sel.address);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const addrW = Math.max(24, Math.min(70, Math.floor(inner * 0.55)));
  return (
    <Panel title="State" hint={state ? `${state.resources.length} resources${state.version ? ` · Terraform ${state.version}` : ''}` : '/state reads it'} width={width} height={height} focused={active}>
      {!rows.length ? <Row pointer={false} width={width - 2} segments={[{ text: state ? '  The state is empty.' : '  /state reads what Terraform keeps track of here (or /open a saved one).', color: theme.dim }]} /> : null}
      {rows.slice(nav.offset, nav.offset + innerH).map((r, i) =>
        r.heading ? (
          <Row key={`h:${r.heading}`} pointer={false} width={width - 2} segments={[{ text: `${r.heading}`, color: theme.accent, bold: true }, { text: `  ${r.count}`, color: theme.dim }]} />
        ) : (
          <Row
            key={r.resource.address}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(r.resource.module ? r.resource.address.slice(r.resource.module.length + 1) : r.resource.address, addrW), strong: true, color: r.resource.mode === 'data' ? theme.dim : undefined },
              { text: ` ${fit(r.resource.provider.replace(/^hashicorp\//, ''), 16)}`, color: theme.dim },
              { text: ` ${r.resource.values?.name ?? ''}`, color: theme.info },
            ]}
          />
        ),
      )}
    </Panel>
  );
}
