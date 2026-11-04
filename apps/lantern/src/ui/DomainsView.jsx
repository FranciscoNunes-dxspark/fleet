import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { severityTone } from '../rows.js';
import { theme } from '../theme.js';
import { countFindings } from '@fleet/kit/findings.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const SHORT = { critical: 'C', high: 'H', medium: 'M', low: 'L' };

/** The hosts the pages are on: their address, whether https is enforced, the certificate's days left and what was found. */
export function DomainsView({ hosts, domains, ctx, width, height, active }) {
  const list = [...new Set([...hosts, ...Object.keys(domains)])];
  const innerH = height - 2;
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i] });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (input === 'r') return a.domains(ctx);
    if (nav.handle(input, key)) return;
    // The row the cursor is on now, which a key just before may have moved before this drew.
    const sel = list[nav.current()];
    if (!sel) return;
    if (key.return || input === 'l') return domains[sel] ? a.showDomain(ctx, domains[sel]) : a.domains(ctx, sel);
    if (input === 'y') ctx.copy(sel, sel);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const inner = width - 4;
  const hostW = Math.max(16, Math.min(36, Math.max(0, ...list.map((h) => h.length + 2))));
  const addrW = Math.max(14, Math.min(40, inner - hostW - 44));
  const checked = Object.keys(domains).length;
  return (
    <Panel title="Domains" hint={list.length ? `${list.length} host${list.length === 1 ? '' : 's'}${checked ? '' : ' · r checks them'}` : 'none'} width={width} height={height} focused={active}>
      {!list.length ? <Row pointer={false} width={width - 2} segments={[{ text: '  No hosts: the pages\' hosts show here, or /domains <host>.', color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((h, i) => {
        const d = domains[h];
        const counts = d ? countFindings(d.findings) : null;
        const stats = d
          ? [
              { text: `${fit(d.dns.cname[0] ? `→ ${d.dns.cname[0]}` : d.dns.a.join(', ') || 'no address', addrW - 1)} `, color: d.dns.a.length || d.dns.cname.length ? theme.dim : theme.del },
              { text: fit(d.enforced ? 'https enforced' : 'https not enforced', 19), color: d.enforced ? theme.add : theme.del },
              { text: fit(d.days === null ? 'no cert' : `cert ${d.days} days`, 15), color: d.days === null || d.days < 7 ? theme.del : d.days < 30 ? theme.warn : theme.dim },
              ...(d.findings.length ? ['critical', 'high', 'medium', 'low'].filter((s) => counts[s]).map((s) => ({ text: `${counts[s]}${SHORT[s]} `, color: severityTone(s), bold: s === 'critical' || s === 'high' })) : [{ text: 'clean', color: theme.add }]),
            ]
          : [{ text: 'not checked', color: theme.dim }];
        return <Row key={h} width={width - 2} selected={nav.offset + i === nav.index} focused={active} segments={[{ text: fit(h, hostW), strong: true }, ...stats]} />;
      })}
    </Panel>
  );
}
