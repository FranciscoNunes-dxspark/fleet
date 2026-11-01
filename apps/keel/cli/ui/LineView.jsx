import React, { useEffect, useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import { STAGES, buildLine, trackTones } from '../../client/src/line/stages.js';
import { STAGE_HINT, STAGE_NAME, cardAge, cardDetail, cardKind, cardTab, stuckMark, toneColor } from '../line.js';
import { theme } from '../theme.js';
import { fit } from '@fleet/kit/text.js';
import { useAsync, useListNav, useMouse } from '@fleet/kit/ui/hooks.js';
import { Lines, Panel, Row } from '@fleet/kit/ui/parts.jsx';
import { wrapLines } from './wrap.js';

const EMPTY = {
  planned: 'Nothing planned and waiting.',
  building: 'Nothing being worked on.',
  review: 'No pull requests open.',
  merged: 'Everything merged has shipped.',
  deploying: 'Nothing on its way out.',
  live: 'No production monitors yet. Add them in the web app: Settings → Production monitors.',
};

// The stations take the top three lines: the track, the names, the counts.
const STATIONS_H = 3;

/**
 * What Line and Control room both read beside the tabs' own data: what waits to ship (with the
 * deploys under way) and the approvals waiting on someone. Read again with each load, as the
 * version moves; one read serves both views.
 */
export function useLineExtras(ctx, version) {
  return useAsync(`line:${version}`, () => Promise.all([
    ctx.service.undeployed().catch(() => null),
    ctx.service.approvals().catch(() => []),
    // Each project's limits and backlog levels, as the web app's line has them (service.lineSetup).
    ctx.service.lineSetup?.().catch(() => undefined),
  ]).then(([pending, approvals, setup]) => ({ pending, approvals, setup })), 60);
}

/** The station to start on: the most jammed, else the first with anything in it. */
function firstStation(stages) {
  const by = (test) => stages.findIndex(test);
  for (const i of [by((s) => s.tone === 'bad'), by((s) => s.stuck.bad), by((s) => s.stuck.warn), by((s) => s.count)]) if (i >= 0) return i;
  return 0;
}

/**
 * The Line, Keel's home, as the web app's: the path change takes, from planned to live, as six
 * stations with how much each holds and how much is stuck there; under them the selected stage's
 * cards, most stuck first. h/l go between stations, j/k between cards, ↵ opens one in its tab.
 */
export function LineView({ failed, data, version, ctx, width, height, active }) {
  const extras = useLineExtras(ctx, version);
  const now = Date.now();
  const loaded = Boolean(data.workItems || data.prs || data.pipelines || data.production);
  const stages = useMemo(
    () => buildLine({ workitems: data.workItems, prs: { prs: data.prs ?? [] }, pipelines: data.pipelines, production: data.production, pending: extras.value?.pending, approvals: extras.value?.approvals }, now, extras.value?.setup),
    [data, extras.value],
  );
  const tracks = trackTones(stages);
  // Until you move, the line starts on its most jammed station (it may change as more is read).
  const [picked, setPicked] = useState(null);
  const s = picked ?? firstStation(stages);
  const stage = stages[s];
  const cards = stage.cards;

  const split = width >= 100;
  const listW = split ? Math.floor(width * 0.58) : width;
  const sideW = width - listW;
  const panelH = Math.max(3, height - STATIONS_H);
  const innerH = panelH - 2;
  const innerW = listW - 2;
  const nav = useListNav(cards.length, innerH, { resetKey: stage.id, keyOf: (i) => cards[i]?.key });
  const card = cards[nav.index];

  // What slash commands and o act on: the pull request, work item, pipeline or monitor behind the card.
  useEffect(() => {
    const d = ctx.data;
    const o = card?.open;
    const pr = o?.type === 'pr' ? d.prs?.find((p) => p.projectId === o.projectId && p.repoId === o.repoId && p.id === o.id) : undefined;
    const workItem = o?.type === 'workitem' ? d.workItems?.items.find((w) => w.id === o.id && (!o.org || !w.org || w.org === o.org)) : undefined;
    const pipeline = o?.type === 'pipeline' ? d.pipelines?.find((p) => p.key === o.key) : undefined;
    const monitor = card?.kind === 'monitor' ? d.production?.monitors.find((m) => `mon:${m.id}` === card.key) : undefined;
    ctx.select({ card, pr, workItem, pipeline, monitor });
  }, [card, data]);

  const clamp = (i) => Math.max(0, Math.min(STAGES.length - 1, i));
  // Keys typed fast each move one more station from where the last one left it.
  const station = (i) => setPicked(clamp(i));
  const step = (d) => setPicked((p) => clamp((p ?? s) + d));
  const open = (c) => {
    if (!c) return;
    const o = c.open;
    if (o?.type === 'pr' && ctx.showPr(o)) return;
    if (o?.type === 'workitem' && ctx.showWorkItem(o.id, o.org)) return;
    if (o?.type === 'pipeline' && ctx.showPipeline(o.key)) return;
    const tab = cardTab(c);
    if (tab) return ctx.showTab(tab);
    ctx.note(`${c.title} has nowhere to open in the terminal: o opens it in the browser.`);
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (key.leftArrow || input === 'h') return step(-1);
    if (key.rightArrow || input === 'l') return step(1);
    if (nav.handle(input, key)) return;
    if (key.return) open(card);
  };
  useInput(keys, { isActive: active });

  const cellW = Math.floor(width / STAGES.length);
  const widthOf = (i) => (i === STAGES.length - 1 ? width - cellW * (STAGES.length - 1) : cellW);
  // A click on a station picks it; on a card picks it, a double-click opens it; the wheel scrolls the cards.
  useMouse(ctx, (e) => {
    if (e.y < STATIONS_H) {
      if (!e.wheel) station(Math.min(STAGES.length - 1, Math.floor(e.x / cellW)));
      return;
    }
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - STATIONS_H - 1) && e.double) keys('', { return: true });
  });

  // The stations: the track (each stretch as troubled as the stage it leads into), the names, the counts.
  const track = [];
  const names = [];
  const counts = [];
  stages.forEach((st, i) => {
    const w = widthOf(i);
    const colour = st.count ? toneColor(st.tone) : theme.dim;
    const on = i === s;
    track.push({ text: ' ●', color: st.count ? toneColor(st.tone) : theme.border }, { text: i < tracks.length ? '─'.repeat(Math.max(0, w - 2)) : ' '.repeat(Math.max(0, w - 2)), color: i < tracks.length ? toneColor(tracks[i]) : undefined });
    names.push({ text: ' ' }, { text: fit(` ${STAGE_NAME[st.id]} `, w - 2), bg: on ? (active ? theme.accent : theme.selBg) : undefined, color: on && active ? theme.ink : colour, bold: true }, { text: ' ' });
    const stuck = st.stuck.bad + st.stuck.warn;
    counts.push({ text: fit(`  ${loaded ? st.count : '…'}${stuck ? ` · ${stuck} stuck` : ''}`, w), color: stuck ? toneColor(st.stuck.bad ? 'bad' : 'warn') : theme.dim });
  });

  const stuck = stage.stuck.bad + stage.stuck.warn;
  const hint = loaded ? [String(cards.length), stuck ? `${stuck} stuck` : ''].filter(Boolean).join(' · ') : '';
  let empty = null;
  if (!loaded) empty = failed ? "  Couldn't read Azure DevOps (the reason is below). r tries again." : '  Reading Azure DevOps…';
  else if (!cards.length) empty = `  ${EMPTY[stage.id]}`;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Row pointer={false} width={width} segments={track} />
      <Row pointer={false} width={width} segments={names} />
      <Row pointer={false} width={width} segments={counts} />
      <Box width={width} height={panelH}>
        <Panel title={`${STAGE_NAME[stage.id]}: ${STAGE_HINT[stage.id]}`} hint={hint} width={listW} height={panelH} focused={active}>
          {empty ? <Row pointer={false} width={innerW} segments={[{ text: empty, color: theme.dim }]} /> : null}
          {cards.slice(nav.offset, nav.offset + innerH).map((c, i) => {
            const mark = stuckMark(c);
            return (
              <Row
                key={`${c.key}:${nav.offset + i}`}
                width={innerW}
                selected={nav.offset + i === nav.index}
                focused={active}
                segments={[
                  { text: `${mark.icon} `, color: mark.color },
                  { text: `${fit(cardAge(c, now), 4, 'right')}  `, color: c.stuck ? mark.color : theme.dim },
                  { text: fit(cardKind(c), 9), color: theme.dim },
                  { text: c.title, strong: true },
                  { text: c.sub ? `  ${c.sub}` : '', color: theme.dim },
                ]}
              />
            );
          })}
        </Panel>
        {split ? (
          <Panel title={card ? cardKind(card) : 'Card'} hint={card && cardTab(card) ? '↵ open · o browser' : ''} width={sideW} height={panelH}>
            <Lines width={sideW - 2} height={innerH} lines={wrapLines(cardDetail(card, now), sideW - 2)} />
          </Panel>
        ) : null}
      </Box>
    </Box>
  );
}
