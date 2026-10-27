import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { expiryDays } from '../config.js';
import { theme } from '../theme.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { secretSegments } from './VaultView.jsx';

/** What runs out: the secrets and certificates of every vault read, gone or within the setting's days, soonest first. */
export function ExpiryView({ items, ctx, width, height, active, loading }) {
  const innerH = height - 2;
  const nav = useListNav(items.length, innerH, { keyOf: (i) => (items[i] ? `${items[i].vault.name}/${items[i].s.name}` : null) });
  const days = expiryDays(ctx.config);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    const sel = items[nav.current()];
    if (!sel) return;
    if (key.return) a.showSecret(ctx, sel.vault, sel.s);
    else if (input === 'e') sel.s.kind === 'secret' ? a.setSecret(ctx, sel.s.name, { vault: sel.vault }) : ctx.note('A certificate is renewed in the portal, or by its issuer.', 'error');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const empty = loading ? '  Reading the vaults…' : !ctx.data.vault && !items.length ? '  No key vault picked: /vault picks one.' : !items.length ? `  Nothing runs out within ${days} days. /expiry <days> looks further ahead.` : null;
  return (
    <Panel title="Expiry" hint={`within ${days} days · soonest first`} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: theme.dim }]} /> : null}
      {items.slice(nav.offset, nav.offset + innerH).map((it, i) => (
        <Row key={`${it.vault.name}/${it.s.kind}/${it.s.name}`} width={width - 2} selected={nav.offset + i === nav.index} focused={active} segments={secretSegments(it.s, { width: width - 4, days, vault: it.vault.name })} />
      ))}
    </Panel>
  );
}
