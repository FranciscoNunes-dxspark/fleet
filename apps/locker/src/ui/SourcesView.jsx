import React from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { isShown } from '../load.js';
import { label } from '../azure/arm.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';

const KINDS = { env: '.env file', appsettings: 'appsettings', usersecrets: 'user secrets', http: "Hail's env file", app: 'App Service', vault: 'key vault' };

/** What Locker read: the folder's sources, the app and the vault, each with how many keys and whether it is a column. */
export function SourcesView({ data, ctx, width, height, active }) {
  const innerH = height - 2;
  const list = [
    ...data.local.map((s) => ({ id: s.id, kind: s.kind, label: s.label, count: s.entries.length, where: s.file, problem: s.problem, source: s })),
    ...(data.target ? [{ id: 'app', kind: 'app', label: label(data.target), count: data.app ? Object.keys(data.app.settings).length + Object.keys(data.app.strings).length : null, where: `${data.target.resourceGroup} · ${data.azure?.subscription?.name ?? ''}`, problem: data.appProblem }] : []),
    ...(data.vault ? [{ id: 'vault', kind: 'vault', label: data.vault.name, count: data.vaultData?.secrets?.length ?? null, where: data.vault.uri, problem: data.vaultData?.problem }] : []),
  ];
  const nav = useListNav(list.length, innerH, { keyOf: (i) => list[i]?.id });

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    const sel = list[nav.current()];
    if (!sel) return;
    if (key.return) {
      if (sel.source) return a.showSource(ctx, sel.source);
      return ctx.setView(sel.kind === 'vault' ? 'vault' : 'drift');
    }
    if (input === ' ') ctx.setConfig({ ...ctx.config, columns: { ...(ctx.config.columns ?? {}), [sel.id]: !isShown(sel, ctx.config.columns) } });
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const nameW = Math.max(14, Math.min(34, Math.floor((width - 4) * 0.3)));
  return (
    <Panel title="Sources" hint={`${list.length} · space a column or not · ↵ its keys`} width={width} height={height} focused={active}>
      {!list.length ? <Row pointer={false} width={width - 2} segments={[{ text: `  Nothing found in ${ctx.cwd()}, and no app or vault picked (/app, /vault).`, color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((s, i) => {
        const on = isShown(s, ctx.config.columns);
        return (
          <Row
            key={s.id}
            width={width - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: on ? '[x] ' : '[ ] ', color: theme.accent, bold: true },
              { text: fit(s.label, nameW), strong: true, color: on ? undefined : theme.dim },
              { text: ` ${fit(KINDS[s.kind] ?? s.kind, 15)}`, color: s.kind === 'app' ? theme.info : s.kind === 'vault' ? theme.accent : theme.dim },
              { text: ` ${fit(s.count == null ? '' : `${s.count} key${s.count === 1 ? '' : 's'}`, 9)}`, color: theme.dim },
              { text: ` ${s.problem ?? s.where ?? ''}`, color: s.problem ? theme.warn : theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
}
