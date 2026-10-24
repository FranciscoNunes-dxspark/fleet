import React, { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import * as a from '../actions.js';
import { label } from '../azure/arm.js';
import { componentFor, isProduction } from '../insights.js';
import { metricRows } from '../metrics.js';
import { costOf, groupCost, money } from '../cost.js';
import { resourceRows } from '../tree.js';
import { referenceWords, unresolved } from '../keyvault.js';
import { theme } from '../theme.js';
import { fit, relTime, stringWidth } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/** Green for running (or ready, online, available), red for stopped, yellow for anything in between. */
export const stateColour = (state) => (/^(Running|Ready|Online|Available|Succeeded)$/i.test(state) ? theme.add : /^(Stopped|Paused|Disabled|Offline|Failed)$/i.test(state) ? theme.del : theme.warn);

// What each kind of row shows after its name, in dim.
const TAGS = { container: 'container', sqlserver: 'sql server', storage: 'storage' };

// The keys each kind of resource takes, as the details' last line says them.
const KEY_HINTS = {
  web: 'R restart · S stop/start · W swap · D deployments · l logs · p problems · L live log · o portal · b browse',
  container: 'R restart its revision · l its logs · o portal · b browse · y copy its address',
  storage: 'o portal · y copy its blob address',
  sqlserver: 'T open in Trawl · F let this machine through the firewall · o portal · y copy its address',
  sqldb: 'T open in Trawl · F let this machine through the firewall · o portal · y copy its address',
};

// How long the cursor rests on a resource before what's beside it is read: longer than the gap
// between steps through the list, so stepping past reads nothing (a settings read is a POST, which
// ARM counts with the writes).
const SETTLE = 150;

const delayed = (fn, ms = SETTLE) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

/** The subscription's resources by resource group, slots and databases under theirs, and beside them the one under the cursor. */
export function ResourcesView({ data, extras = {}, span, ctx, width, height, active, filter, focusId }) {
  // Worked out again only when the subscription or the filter changes, not on every key.
  const rows = useMemo(() => resourceRows(data.apps, data.slots, filter, data), [data, filter]);
  const innerH = height - 2;
  const listW = Math.max(34, Math.floor(width * 0.42));
  // On the app the command line named (focusId), else the first.
  const focusAt = focusId ? rows.findIndex((r) => r.target?.id === focusId) : -1;
  // When the subscription fills in or is read again, the cursor stays on what it was on, wherever
  // that row has gone (slots coming in above it, say): keyOf.
  const nav = useListNav(rows.length, innerH, {
    selectable: (i) => rows[i]?.kind !== 'group',
    resetKey: `${data.subscription.id}|${filter}|${focusId}`,
    start: focusAt > 0 ? focusAt : 1,
    keyOf: (i) => rows[i]?.target?.id,
  });
  const sel = rows[nav.index]?.target ?? null;
  const web = sel && !sel.type ? sel : null;
  const server = sel?.type === 'sqldb' ? (data.sqlServers ?? []).find((s) => s.id === sel.serverId) : sel?.type === 'sqlserver' ? sel : null;
  ctx.selectTarget(sel);
  // The settings say which Application Insights it reports to; read when the cursor stops on it.
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    if (!web) return;
    let live = true;
    setSettings(null);
    const stop = delayed(() => ctx.settingsOf(web).then((s) => live && setSettings(s), () => live && setSettings({ error: true })));
    return () => {
      live = false;
      stop();
    };
  }, [sel?.id]);

  // Its Key Vault references: the background scan's, or read now when it hasn't come to it yet.
  const [refs, setRefs] = useState(null);
  useEffect(() => {
    if (!web) return;
    let live = true;
    setRefs(null);
    const stop = delayed(() => ctx.referencesOf(web).then((r) => live && setRefs({ list: r }), (e) => live && setRefs({ error: e.message.split('\n')[0] })));
    return () => {
      live = false;
      stop();
    };
  }, [sel?.id]);

  // Its metrics over the span, likewise, once the cursor has settled.
  const [metrics, setMetrics] = useState(null);
  useEffect(() => {
    if (!web) return;
    let live = true;
    setMetrics(null);
    const stop = delayed(() => ctx.metricsOf(web).then((m) => live && setMetrics({ series: m }), (e) => live && setMetrics({ error: e.message.split('\n')[0] })));
    return () => {
      live = false;
      stop();
    };
  }, [sel?.id, span?.iso]);

  // This month's costs, once a day; nothing is said of them when they can't be read.
  const [costs, setCosts] = useState(null);
  useEffect(() => {
    let live = true;
    setCosts(null);
    ctx.costsOf(data.subscription.id).then((c) => live && setCosts(c));
    return () => {
      live = false;
    };
  }, [data.subscription.id]);
  const costLine = (t, plan) => {
    const own = costOf(costs, t.id);
    const planCost = plan ? costOf(costs, plan) : null;
    if (own == null && planCost == null) return [];
    return [[{ text: 'cost      ', color: theme.dim }, { text: own != null ? `${money(own, costs.currency)} this month` : '' }, { text: planCost != null ? `${own != null ? ' · ' : ''}its plan ${money(planCost, costs.currency)}` : '', color: theme.dim }]];
  };

  // A SQL server's firewall rules (a database's server's), again once the cursor has settled.
  const [rules, setRules] = useState(null);
  const [rulesTick, setRulesTick] = useState(0);
  useEffect(() => {
    if (!server) return;
    let live = true;
    setRules(null);
    const stop = delayed(() => ctx.firewallOf(server).then((r) => live && setRules({ list: r }), (e) => live && setRules({ error: e.message.split('\n')[0] })));
    return () => {
      live = false;
      stop();
    };
  }, [server?.id, rulesTick]);

  // Its Entra admin, which the listing doesn't carry.
  const [admin, setAdmin] = useState(null);
  useEffect(() => {
    if (!server) return;
    let live = true;
    setAdmin(server.admin ? { value: server.admin } : null);
    if (server.admin) return;
    const stop = delayed(() => ctx.adminOf(server).then((v) => live && setAdmin({ value: v })));
    return () => {
      live = false;
      stop();
    };
  }, [server?.id]);

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (input === 'o') return a.openInPortal(ctx, sel);
    if (input === 'y') return sel.host ? ctx.copy(sel.host) : undefined;
    if (sel.type === 'container') {
      if (key.return || input === 'l') return a.containerLogs(ctx, sel);
      if (input === 'R') return a.restartContainer(ctx, sel);
      if (input === 'b') return a.browse(ctx, sel);
      return;
    }
    if (sel.type === 'sqlserver' || sel.type === 'sqldb') {
      if (input === 'T') return a.openInTrawl(ctx, sel);
      if (input === 'F') return a.firewall(ctx, sel).then(() => setRulesTick((n) => n + 1));
      return;
    }
    if (sel.type) return;
    if (key.return || input === 'a') return a.showSettings(ctx, sel);
    if (input === 'R') return a.restart(ctx, sel);
    if (input === 'S') return a.toggleRunning(ctx, sel);
    if (input === 'W') return a.swap(ctx, sel);
    if (input === 'l') return ctx.logsFor(sel);
    if (input === 'p') return ctx.problemsFor(sel);
    if (input === 'L') return ctx.liveFor(sel);
    if (input === 'D') return a.deployments(ctx, sel);
    if (input === 'b') return a.browse(ctx, sel);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const component = settings && !settings.error ? componentFor(settings, data.components) : null;
  const sparkW = Math.max(6, Math.min(24, width - listW - 40));
  const field = (name, value, color) => [{ text: name.padEnd(10), color: theme.dim }, { text: value ?? '—', color }];
  const prod = (t) => [{ text: t.state, color: stateColour(t.state), bold: true }, { text: isProduction(t) ? '  production: changes ask you to type its name' : '', color: theme.warn }];
  const firewallLines = () => [
    [],
    [{ text: 'firewall', color: theme.dim, bold: true }, { text: rules ? '' : '  reading it…', color: theme.dim }],
    ...(rules?.error
      ? [[{ text: rules.error, color: theme.del }]]
      : (rules?.list ?? []).length
        ? rules.list.map((r) => [
            { text: fit(r.name, 26), color: theme.dim },
            { text: r.start === '0.0.0.0' && r.end === '0.0.0.0' ? 'Azure services' : r.start === r.end ? r.start : `${r.start} – ${r.end}` },
          ])
        : rules
          ? [[{ text: 'no rules: nothing outside Azure gets in', color: theme.dim }]]
          : []),
  ];
  // Its Key Vault references: how many resolved, and each that didn't, in words.
  const vaultLines = (r) => {
    if (!r) return [];
    if (r.error) return [[{ text: 'key vault ', color: theme.dim }, { text: `can't say: ${r.error}`, color: theme.dim }]];
    if (!r.list.length) return [];
    const bad = unresolved(r.list);
    return [
      [{ text: 'key vault ', color: theme.dim }, { text: `${r.list.length} reference${r.list.length === 1 ? '' : 's'}, ${r.list.length - bad.length} resolved`, color: bad.length ? theme.warn : theme.add }],
      ...bad.map((x) => [{ text: '  ⚠ ', color: theme.warn }, { text: `${x.name}: `, bold: true }, { text: referenceWords(x), color: theme.del }]),
    ];
  };
  let detail = [];
  if (sel && !sel.type) {
    detail = [
      [{ text: label(sel), bold: true }, { text: `  ${sel.kind === 'function' ? 'function app' : 'web app'}${sel.slot ? ' slot' : ''}`, color: theme.dim }],
      prod(sel),
      [],
      field('address', sel.host),
      field('group', sel.resourceGroup),
      field('where', sel.location ?? ''),
      field('plan', sel.plan),
      field('runtime', sel.runtime),
      field('changed', sel.modified ? `${relTime(Date.parse(sel.modified))} ago` : null),
      [{ text: 'insights  ', color: theme.dim }, settings == null ? { text: '…', color: theme.dim } : settings.error ? { text: "can't read its settings", color: theme.del } : { text: component?.name ?? 'none linked', color: component ? undefined : theme.dim }],
      [{ text: 'settings  ', color: theme.dim }, { text: settings && !settings.error ? `${Object.keys(settings).length} (↵ shows them)` : '' }],
      ...vaultLines(refs),
      ...(sel.slot ? [] : costLine(sel, sel.planId)),
      [],
      [{ text: `the last ${span?.label ?? ''}`, color: theme.dim, bold: true }, { text: metrics ? '' : '  reading its metrics…', color: theme.dim }],
      ...(metrics?.error
        ? [[{ text: "can't read its metrics: ", color: theme.del }, { text: metrics.error, color: theme.dim }]]
        : metricRows(metrics?.series ?? [], { width: sparkW }).map((m) => [
            { text: m.label.padEnd(10), color: theme.dim },
            { text: m.spark.padStart(sparkW), color: theme.warn },
            { text: metrics ? `  ${m.summary}` : '', color: m.summary === 'no data' ? theme.dim : undefined },
          ])),
      [],
      [{ text: KEY_HINTS.web, color: theme.dim }],
    ];
  } else if (sel?.type === 'container') {
    detail = [
      [{ text: sel.name, bold: true }, { text: '  container app', color: theme.dim }],
      prod(sel),
      [],
      field('address', sel.host),
      field('group', sel.resourceGroup),
      field('where', sel.location ?? ''),
      field('revision', sel.latestRevision ? `${sel.latestRevision}${sel.readyRevision && sel.readyRevision !== sel.latestRevision ? ` (ready: ${sel.readyRevision})` : ''}` : null),
      field('image', sel.image),
      field('environ.', sel.environmentId?.split('/').pop()),
      ...costLine(sel),
      [],
      [{ text: KEY_HINTS.container, color: theme.dim }],
    ];
  } else if (sel?.type === 'storage') {
    detail = [
      [{ text: sel.name, bold: true }, { text: '  storage account', color: theme.dim }],
      prod(sel),
      [],
      field('blobs', sel.host),
      field('group', sel.resourceGroup),
      field('where', sel.location ?? ''),
      field('kind', sel.kind),
      field('sku', sel.sku),
      field('tier', sel.tier),
      ...costLine(sel),
      [],
      [{ text: KEY_HINTS.storage, color: theme.dim }],
    ];
  } else if (server) {
    const db = sel.type === 'sqldb' ? sel : null;
    detail = [
      [{ text: db ? label(db) : server.name, bold: true }, { text: db ? '  SQL database' : '  SQL server', color: theme.dim }],
      prod(db ? { ...db, name: server.name } : server),
      [],
      field('address', server.fqdn),
      field('group', server.resourceGroup),
      field('where', server.location ?? ''),
      ...(db ? [field('sku', [db.sku, db.tier].filter(Boolean).join(' · ')), ...costLine(db)] : [field('version', server.version), field('databases', String(server.databases?.length ?? 0))]),
      [{ text: 'entra     ', color: theme.dim }, !admin ? { text: '…', color: theme.dim } : admin.value ? { text: `${admin.value.login}${admin.value.type ? ` (${admin.value.type.toLowerCase()})` : ''}${admin.value.only ? ', Entra sign-in only' : ''}` } : { text: 'no Entra admin set: only SQL logins', color: theme.warn }],
      ...firewallLines(),
      [],
      [{ text: KEY_HINTS[sel.type], color: theme.dim }],
    ];
  }

  return (
    <>
      <Panel title={data.subscription.name} hint={filter ? `"${filter}" · ${rows.filter((r) => r.kind !== 'group' && r.kind !== 'slot' && r.kind !== 'sqldb').length}` : `${data.apps.length} apps`} width={listW} height={height} focused={active}>
        {rows.length === 0 ? <Row pointer={false} width={listW - 2} segments={[{ text: filter ? '  Nothing matches.' : '  Nothing here. /sub picks another subscription.', color: theme.dim }]} /> : null}
        {rows.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          if (r.kind === 'group') {
            const cost = groupCost(costs, data.subscription.id, r.text);
            const said = cost != null ? money(cost, costs.currency) : '';
            return <Row key={`g-${r.text}`} pointer={false} width={listW - 2} segments={[{ text: fit(r.text, Math.max(8, listW - 3 - stringWidth(said))), color: theme.dim, bold: true }, { text: said ? ` ${said}` : '', color: theme.dim }]} />;
          }
          const t = r.target;
          const under = r.kind === 'slot' || r.kind === 'sqldb';
          const name = r.kind === 'slot' ? t.slot : t.name;
          const tag = r.kind === 'sqldb' ? t.tier || t.sku : TAGS[t.type] ?? '';
          return (
            <Row
              key={t.id}
              width={listW - 2}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: under ? '  └ ' : '', color: theme.dim },
                { text: '● ', color: stateColour(t.state) },
                { text: fit(name, Math.max(8, listW - 18 - (under ? 4 : 0))), strong: true },
                { text: t.kind === 'function' && !t.type ? ' ƒ' : '', color: theme.info },
                { text: unresolved(extras[t.id]?.refs).length ? ' ⚠' : '', color: theme.warn },
                { text: tag ? ` ${tag}` : '', color: theme.dim },
              ]}
            />
          );
        })}
      </Panel>
      <Panel title={sel ? label(sel) : ''} width={width - listW} height={height}>
        <Lines lines={detail.map((segs) => [{ text: ' ' }, ...segs])} width={width - listW - 2} height={innerH} />
      </Panel>
    </>
  );
}
