import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { matchesHost } from '../proxy.js';
import { theme } from '../theme.js';
import { fit, relTime } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** How a host's HTTPS went, in a word or two. */
function howLine(h, passed) {
  const parts = [];
  if (h.plain) parts.push(`${h.plain} plain http`);
  if (h.intercepted) parts.push(`${h.intercepted} read`);
  if (h.tunnels) parts.push(`${h.tunnels} tunnelled`);
  if (h.refused) parts.push(`${h.refused} refused`);
  if (passed) parts.push('passed through');
  return parts.join(' · ');
}

/** Every host seen, busiest first: ↵ shows its requests, p passes it through. */
export function HostsView({ hosts, passThrough, ctx, width, height, active }) {
  const innerH = height - 2;
  const nav = useListNav(hosts.length, innerH, { keyOf: (i) => hosts[i]?.host });
  const sel = hosts[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'l') a.filter(ctx, `host:${sel.host}`);
    else if (input === 'p') (matchesHost(passThrough, sel.host) ? a.unpass(ctx, sel.host) : a.passHost(ctx, { host: sel.host, kind: sel.refused ? 'refused' : 'host' }));
    else if (input === 'y') ctx.copy(sel.host, sel.host);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const hostW = Math.max(16, Math.min(44, Math.floor(inner * 0.4)));
  return (
    <Panel title="Hosts" hint={`${hosts.length}${passThrough.length ? ` · ${passThrough.length} passed through` : ''}`} width={width} height={height} focused={active}>
      {!hosts.length ? <Row pointer={false} width={width - 2} segments={[{ text: '  No hosts yet.', color: theme.dim }]} /> : null}
      {hosts.slice(nav.offset, nav.offset + innerH).map((h, i) => {
        const passed = matchesHost(passThrough, h.host);
        return (
          <Row
            key={h.host}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(h.host, hostW), color: theme.info, strong: true },
              { text: fit(String(h.count), 6, 'right') },
              { text: fit(h.errors ? `${h.errors} err` : '', 8, 'right'), color: theme.del },
              { text: '  ' },
              { text: fit(howLine(h, passed), Math.max(10, inner - hostW - 30)), color: h.refused && !passed ? theme.del : theme.dim },
              { text: fit(relTime(h.last), 12, 'right'), color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
