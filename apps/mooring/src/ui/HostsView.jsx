import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { theme } from '../theme.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** The saved hosts: ↵ connects, a adds one, e changes the one under the cursor, x forgets it. */
export function HostsView({ hosts, conn, ctx, width, height, active }) {
  const innerH = height - 2;
  const nav = useListNav(hosts.length, innerH, { keyOf: (i) => hosts[i]?.name });
  const sel = hosts[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'a') return ctx.prefill('/add ');
    if (!sel) return;
    if (key.return || input === 'c') return ctx.connect(sel);
    if (input === 'e') return ctx.prefill(`/add ${sel.name} ${sel.user ? `${sel.user}@` : ''}${sel.host}${sel.port ? `:${sel.port}` : ''}${sel.key ? ` key=${sel.key}` : ''}${sel.folder ? ` folder=${sel.folder}` : ''}${sel.password ? ' password' : ''}`);
    if (input === 'x' || input === 'd') return a.forgetHost(ctx, sel.name);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  return (
    <Panel title="Hosts" hint={`${hosts.length} · ↵ connect · a add · e change · x forget`} width={width} height={height} focused={active}>
      {!hosts.length ? (
        <>
          <Row pointer={false} width={width - 2} segments={[{ text: '  No saved hosts. a (or /add) saves one:', color: theme.dim }]} />
          <Row pointer={false} width={width - 2} segments={[{ text: '    /add web me@web.example.com:22 key=~/.ssh/id_ed25519 folder=/var/www', color: theme.info }]} />
          <Row pointer={false} width={width - 2} segments={[{ text: '  Mooring signs in with that key or your ssh agent: there is no password prompt.', color: theme.dim }]} />
        </>
      ) : null}
      {hosts.slice(nav.offset, nav.offset + innerH).map((h, i) => (
        <Row key={h.name} width={width - 2} selected={nav.offset + i === nav.index} focused={active} segments={a.hostSegments(h, conn.host)} />
      ))}
    </Panel>
  );
}
