import React, { useEffect, useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import * as a from '../actions.js';
import { buildTimeline, serviceTiles } from '../../client/src/line/views.js';
import { clock, eventSub, eventTab, eventText, tileFacts, tileState, toneColor } from '../line.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '@fleet/kit/text.js';
import { useAsync, useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { useLineExtras } from './LineView.jsx';

/**
 * The Control room, as the web app's status wall: a line per production service (its state,
 * response, uptime, latest deploy and what waits to ship to it), and what happened in the last
 * 24 hours, newest first. h/l go between the two, j/k move, ↵ opens what's under the cursor.
 */
export function ControlView({ failed, data, version, ctx, width, height, active }) {
  const extras = useLineExtras(ctx, version);
  // Pull requests merged lately, for the timeline (the web app asks for the same week).
  const closed = useAsync(`closed:7:${version}`, () => ctx.service.closedPullRequests(7), 80);
  const now = Date.now();
  const pending = extras.value?.pending;
  const tiles = useMemo(() => serviceTiles({ production: data.production, pending }, now), [data, pending]);
  const events = useMemo(
    () => buildTimeline({ pipelines: data.pipelines, production: data.production, pending, approvals: extras.value?.approvals, closed: closed.value }, now),
    [data, extras.value, closed.value],
  );
  const [pane, setPane] = useState('services');

  // Side by side when there's room, else the services over the timeline.
  const split = width >= 100;
  const leftW = split ? Math.floor(width * 0.5) : width;
  const rightW = split ? width - leftW : width;
  const servicesH = split ? height : Math.max(4, Math.min(tiles.length + 2, Math.floor(height / 2)));
  const timelineH = split ? height : height - servicesH;
  const tilesNav = useListNav(tiles.length, servicesH - 2, { keyOf: (i) => tiles[i]?.id });
  const eventsNav = useListNav(events.length, timelineH - 2, { keyOf: (i) => events[i]?.key });
  const tile = tiles[tilesNav.index];
  const event = events[eventsNav.index];
  const nav = pane === 'services' ? tilesNav : eventsNav;

  const monitorOf = (t) => data.production?.monitors.find((m) => m.id === t?.id);
  const targetOf = (m) => (m?.targetKey ? pending?.targets?.find((t) => t.key === m.targetKey) ?? null : null);
  useEffect(() => {
    const d = ctx.data;
    if (pane === 'services') {
      ctx.select({ monitor: monitorOf(tile), event: undefined, pr: undefined, pipeline: undefined });
      return;
    }
    const o = event?.open;
    const pr = o?.type === 'pr' ? d.prs?.find((p) => p.projectId === o.projectId && p.repoId === o.repoId && p.id === o.id) : undefined;
    const pipeline = o?.type === 'pipeline' ? d.pipelines?.find((p) => p.key === o.key) : undefined;
    ctx.select({ event, pr, pipeline, monitor: undefined });
  }, [pane, tile, event, data]);

  const open = () => {
    if (pane === 'services') {
      const m = monitorOf(tile);
      return m && ctx.showMonitorFull(m, targetOf(m));
    }
    if (!event) return;
    const o = event.open;
    if (o?.type === 'pr' && ctx.showPr(o)) return;
    if (o?.type === 'pipeline' && ctx.showPipeline(o.key)) return;
    // A merged pull request isn't in the active list: the browser has it.
    if (o?.type === 'pr') return ctx.note('That pull request is closed: o opens it in the browser.');
    ctx.showTab(eventTab(event));
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (key.leftArrow || input === 'h') return setPane('services');
    if (key.rightArrow || input === 'l') return setPane('timeline');
    if (nav.handle(input, key)) return;
    if (key.return) return open();
    if (input === 'S' && pane === 'services' && monitorOf(tile)) a.sonar(ctx, monitorOf(tile));
  };
  useInput(keys, { isActive: active });
  // A click picks a row in either pane (and that pane), a double-click opens it; the wheel scrolls the pane under it.
  useMouse(ctx, (e) => {
    const inServices = split ? e.x < leftW : e.y < servicesH;
    const n = inServices ? tilesNav : eventsNav;
    if (e.wheel) return n.scrollBy(e.wheel * 3);
    setPane(inServices ? 'services' : 'timeline');
    if (n.pick(e.y - (inServices || split ? 0 : servicesH) - 1) && e.double) keys('', { return: true });
  });

  const down = tiles.filter((t) => t.state === 'down' || t.state === 'degraded').length;
  const servicesHint = data.production ? [String(tiles.length), down ? `${down} need you` : 'all well'].join(' · ') : '';
  let servicesEmpty = null;
  if (!data.production) servicesEmpty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!data.production.enabled) servicesEmpty = '  Production monitoring is off on this Keel.';
  else if (!tiles.length) servicesEmpty = '  No production monitors yet. Add them in the web app: Settings → Production monitors.';
  // Names as wide as the longest, up to under half the row; the numbers get the rest.
  const nameW = Math.max(8, Math.min(Math.floor((leftW - 6) * 0.55), Math.max(0, ...tiles.map((t) => stringWidth(t.name)))));

  const servicesPanel = (
    <Panel title="Services" hint={servicesHint} width={leftW} height={servicesH} focused={active && pane === 'services'}>
      {servicesEmpty ? <Row pointer={false} width={leftW - 2} segments={[{ text: servicesEmpty, color: theme.dim }]} /> : null}
      {tiles.slice(tilesNav.offset, tilesNav.offset + servicesH - 2).map((t, i) => {
        const st = tileState(t);
        return (
          <Row
            key={`${t.id}:${tilesNav.offset + i}`}
            width={leftW - 2}
            selected={tilesNav.offset + i === tilesNav.index}
            focused={active && pane === 'services'}
            segments={[
              { text: `${st.icon} `, color: st.color },
              { text: fit(t.name, nameW), strong: true },
              { text: `  ${tileFacts(t, now)}`, color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
  const timelinePanel = (
    <Panel title="Last 24 hours" hint={data.pipelines ? `${events.length} events` : ''} width={rightW} height={timelineH} focused={active && pane === 'timeline'}>
      {data.pipelines && !events.length ? <Row pointer={false} width={rightW - 2} segments={[{ text: '  A quiet day: nothing ran, deployed or merged.', color: theme.dim }]} /> : null}
      {events.slice(eventsNav.offset, eventsNav.offset + timelineH - 2).map((e, i) => {
        const sub = eventSub(e);
        return (
          <Row
            key={`${e.key}:${eventsNav.offset + i}`}
            width={rightW - 2}
            selected={eventsNav.offset + i === eventsNav.index}
            focused={active && pane === 'timeline'}
            segments={[
              { text: `${clock(e.at)} `, color: theme.dim },
              { text: '● ', color: toneColor(e.tone) },
              { text: eventText(e), strong: true },
              { text: e.mine ? '  you' : '', color: theme.accent, bold: true },
              { text: sub ? `  ${sub}` : '', color: theme.dim },
            ]}
          />
        );
      })}
    </Panel>
  );
  return (
    <Box flexDirection={split ? 'row' : 'column'} width={width} height={height}>
      {servicesPanel}
      {timelinePanel}
    </Box>
  );
}
