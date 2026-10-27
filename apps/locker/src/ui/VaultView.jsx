import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { expiryTone, expiryWords, isExpired } from '../expiry.js';
import { expiryDays } from '../config.js';
import { theme } from '../theme.js';
import { fit, relTime } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

/** The rows of a vault's list: a heading, its secrets, a heading, its certificates. */
export function vaultRows(data) {
  const out = [];
  const secrets = data?.secrets ?? [];
  const certs = data?.certificates ?? [];
  out.push({ heading: `Secrets ${secrets.length}` }, ...secrets.map((s) => ({ s })));
  if (certs.length) out.push({ heading: `Certificates ${certs.length}` }, ...certs.map((s) => ({ s })));
  return out;
}

/**
 * A secret or certificate as a row: enabled or not, its name, type, when it changed and when it runs
 * out. Shared with the Expiry view, which adds the vault's name.
 */
export function secretSegments(s, { width, days, vault }) {
  const now = Date.now();
  const off = s.enabled === false;
  const gone = isExpired(s, now);
  const nameW = Math.max(14, Math.min(40, Math.floor(width * 0.34)));
  const showType = width >= 70;
  return [
    { text: '● ', color: off || gone ? theme.del : theme.add },
    { text: fit(s.name, nameW), strong: true, color: off ? theme.dim : undefined },
    ...(vault ? [{ text: ` ${fit(vault, 14)}`, color: theme.dim }] : []),
    { text: ` ${fit(off ? 'disabled' : s.kind === 'certificate' ? 'certificate' : 'enabled', 11)}`, color: off ? theme.del : theme.dim },
    ...(showType ? [{ text: ` ${fit(s.kind === 'certificate' ? '' : s.contentType || '', 12)}`, color: theme.dim }] : []),
    { text: ` ${fit(s.updated ? `${relTime(Date.parse(s.updated))} ago` : '', 9)}`, color: theme.dim },
    { text: ` ${s.expires ? expiryWords(s.expires, now) : ''}`, color: theme[expiryTone(s.expires, days, now)] },
  ];
}

/** The key vault: its secrets and certificates, never a value until v or y. */
export function VaultView({ vault, data, problem, ctx, width, height, active }) {
  const innerH = height - 2;
  const rows = vaultRows(data);
  const keyOf = (i) => (rows[i]?.s ? `${rows[i].s.kind}:${rows[i].s.name}` : `# ${rows[i]?.heading}`);
  const was = ctx.cursor('vault');
  const nav = useListNav(rows.length, innerH, { selectable: (i) => Boolean(rows[i]?.s), keyOf, start: Math.max(0, rows.findIndex((_, i) => keyOf(i) === was)) });
  ctx.cursor('vault', keyOf(nav.index));
  const days = expiryDays(ctx.config);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'n') return a.setSecret(ctx, '');
    if (input === 'o') return vault ? ctx.openUrl(ctx.provider.portalUrl(vault)) : ctx.note('Pick a key vault first: /vault.', 'error');
    const sel = rows[nav.current()]?.s;
    if (!sel) return;
    const secret = sel.kind === 'secret';
    if (key.return) a.showSecret(ctx, vault, sel);
    else if (input === 'v') secret ? a.revealSecret(ctx, vault, sel) : ctx.note('A certificate is not shown here: the portal has it.', 'error');
    else if (input === 'y') secret ? a.copySecret(ctx, vault, sel) : ctx.note('Locker copies secrets, not certificates.', 'error');
    else if (input === 'e') secret ? a.setSecret(ctx, sel.name) : ctx.note('Locker sets secrets, not certificates.', 'error');
    else if (input === 'x') a.toggleSecret(ctx, sel);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const secrets = data?.secrets ?? [];
  const off = secrets.filter((s) => s.enabled === false).length;
  const empty = problem ? `  ${problem}` : !vault ? '  No key vault picked: /vault picks one.' : !data ? '  Reading the vault…' : null;
  return (
    <Panel title={vault ? `Vault ${vault.name}` : 'Vault'} hint={vault && data ? `${secrets.length} secrets${off ? ` · ${off} disabled` : ''} · expiring within ${days} days in yellow` : ''} width={width} height={height} focused={active}>
      {empty ? <Row pointer={false} width={width - 2} segments={[{ text: empty, color: problem ? theme.del : theme.dim }]} /> : null}
      {empty
        ? null
        : rows.slice(nav.offset, nav.offset + innerH).map((r, i) =>
            r.heading ? (
              <Row key={`# ${r.heading}`} pointer={false} width={width - 2} segments={[{ text: ` ${r.heading}`, color: theme.accent, bold: true }]} />
            ) : (
              <Row key={`${r.s.kind}:${r.s.name}`} width={width - 2} selected={nav.offset + i === nav.index} focused={active} segments={secretSegments(r.s, { width: width - 4, days })} />
            ),
          )}
    </Panel>
  );
}
