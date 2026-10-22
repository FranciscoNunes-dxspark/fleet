import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { label } from '../azure/arm.js';
import { componentFor, isProduction } from '../insights.js';
import { resourceRows } from '../tree.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

export const stateColour = (state) => (state === 'Running' ? theme.add : state === 'Stopped' ? theme.del : theme.warn);

/** The subscription's apps by resource group, slots under each, and beside them the one under the cursor. */
export function ResourcesView({ data, ctx, width, height, active, filter, focusId }) {
  const rows = resourceRows(data.apps, data.slots, filter);
  const innerH = height - 2;
  const listW = Math.max(34, Math.floor(width * 0.42));
  // On the app the command line named (focusId), else the first.
  const focusAt = focusId ? rows.findIndex((r) => r.target?.id === focusId) : -1;
  const nav = useListNav(rows.length, innerH, { selectable: (i) => rows[i]?.kind !== 'group', resetKey: `${data.subscription.id}|${filter}|${focusId}`, start: focusAt > 0 ? focusAt : 1 });
  const sel = rows[nav.index]?.target ?? null;
  ctx.selectTarget(sel);
  // The settings say which Application Insights it reports to; read when the cursor stops on it.
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    setSettings(null);
    const t = setTimeout(() => ctx.settingsOf(sel).then((s) => live && setSettings(s), () => live && setSettings({ error: true })), 80);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sel?.id]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return || input === 'a') return a.showSettings(ctx, sel);
    if (input === 'R') return a.restart(ctx, sel);
    if (input === 'S') return a.toggleRunning(ctx, sel);
    if (input === 'W') return a.swap(ctx, sel);
    if (input === 'l') return ctx.logsFor(sel);
    if (input === 'p') return ctx.problemsFor(sel);
    if (input === 'o') return a.openInPortal(ctx, sel);
    if (input === 'b') return a.browse(ctx, sel);
    if (input === 'y') return sel.host ? ctx.copy(sel.host) : undefined;
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const component = settings && !settings.error ? componentFor(settings, data.components) : null;
  const detail = sel
    ? [
        [{ text: label(sel), bold: true }, { text: `  ${sel.kind === 'function' ? 'function app' : 'web app'}${sel.slot ? ' slot' : ''}`, color: theme.dim }],
        [{ text: sel.state, color: stateColour(sel.state), bold: true }, { text: isProduction(sel) ? '  production: changes ask you to type its name' : '', color: theme.warn }],
        [],
        [{ text: 'address   ', color: theme.dim }, { text: sel.host ?? '—' }],
        [{ text: 'group     ', color: theme.dim }, { text: sel.resourceGroup }],
        [{ text: 'where     ', color: theme.dim }, { text: sel.location ?? '' }],
        [{ text: 'plan      ', color: theme.dim }, { text: sel.plan ?? '—' }],
        [{ text: 'runtime   ', color: theme.dim }, { text: sel.runtime ?? '—' }],
        [{ text: 'changed   ', color: theme.dim }, { text: sel.modified ? `${relTime(Date.parse(sel.modified))} ago` : '—' }],
        [{ text: 'insights  ', color: theme.dim }, settings == null ? { text: '…', color: theme.dim } : settings.error ? { text: "can't read its settings", color: theme.del } : { text: component?.name ?? 'none linked', color: component ? undefined : theme.dim }],
        [{ text: 'settings  ', color: theme.dim }, { text: settings && !settings.error ? `${Object.keys(settings).length} (↵ shows them)` : '' }],
        [],
        [{ text: 'R restart · S stop/start · W swap · l logs · p problems · o portal · b browse', color: theme.dim }],
      ]
    : [];

  return (
    <>
      <Panel title={data.subscription.name} hint={filter ? `"${filter}" · ${rows.filter((r) => r.kind === 'app').length}` : `${data.apps.length} apps`} width={listW} height={height} focused={active}>
        {rows.length === 0 ? <Row pointer={false} width={listW - 2} segments={[{ text: filter ? '  Nothing matches.' : '  No web or function apps here. /sub picks another subscription.', color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) =>
          r.kind === 'group' ? (
            <Row key={`g-${r.text}`} pointer={false} width={listW - 2} segments={[{ text: r.text, color: theme.dim, bold: true }]} />
          ) : (
            <Row
              key={r.target.id}
              width={listW - 2}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: r.kind === 'slot' ? '  └ ' : '', color: theme.dim },
                { text: '● ', color: stateColour(r.target.state) },
                { text: fit(r.kind === 'slot' ? r.target.slot : r.target.name, Math.max(8, listW - 18 - (r.kind === 'slot' ? 4 : 0))), strong: true },
                { text: r.target.kind === 'function' ? ' ƒ' : '', color: theme.info },
              ]}
            />
          ),
        )}
      </Panel>
      <Panel title={sel ? label(sel) : ''} width={width - listW} height={height}>
        <Lines lines={detail.map((segs) => [{ text: ' ' }, ...segs])} width={width - listW - 2} height={innerH} />
      </Panel>
    </>
  );
}
