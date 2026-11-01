// The Line and the Control room in the terminal: the web app's two views of the same work, in
// words and colours. Where change stands and what happened come from the web app's own pure rules
// (client/src/line/stages.js and views.js); this only says them in English and picks the colours.
import { relTime } from '@fleet/kit/text.js';
import { monitorState } from './format.js';
import { theme } from './theme.js';

/** Each stage's name, as on the web app's line. */
export const STAGE_NAME = { planned: 'Planned', building: 'Building', review: 'In review', merged: 'Merged', deploying: 'Deploying', live: 'Live' };

/** What each stage holds, in a few words. */
export const STAGE_HINT = { planned: 'not started yet', building: 'being worked on', review: 'pull requests open', merged: 'waiting to ship', deploying: 'on its way out', live: 'in production' };

/** The colour of a stage's tone (stages.js stageTone) or a track's (trackTones), or an event's. */
export function toneColor(tone) {
  return { bad: theme.del, warn: theme.warn, ok: theme.ok, info: theme.info, accent: theme.accent, idle: theme.border }[tone] ?? theme.ok;
}

/** A card's mark in a list: how stuck it is. */
export const STUCK = {
  bad: { icon: '✗', color: theme.del },
  warn: { icon: '!', color: theme.warn },
  none: { icon: '·', color: theme.dim },
};
export const stuckMark = (card) => STUCK[card.stuck] ?? STUCK.none;

const KIND = { pr: 'PR', ship: 'Ship', approval: 'Approval', deploy: 'Deploy', pipeline: 'Pipeline', monitor: 'Monitor' };
/** What a card is, in a word: its work item type, or its kind. */
export const cardKind = (card) => (card.kind === 'workitem' ? card.type || 'Work' : KIND[card.kind] ?? card.kind);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Why a card sits where it does, as a sentence (the web app's Line.jsx reasonText, in English). */
export function reasonText(r) {
  if (!r) return '';
  switch (r.code) {
    case 'p1-waiting': return `P1, not started for ${plural(r.days, 'day')}`;
    case 'blocked': return 'Blocked';
    case 'quiet': return `No update for ${plural(r.days, 'day')}`;
    case 'conflicts': return 'Merge conflicts';
    case 'stale': return `Open ${plural(r.days, 'day')}`;
    case 'pr-in-review': return 'In review';
    case 'pr-approved': return 'Approved';
    case 'pr-waiting-author': return 'Waiting on author';
    case 'pr-rejected': return 'Rejected';
    case 'pr-draft': return 'Draft';
    case 'pr-no-reviewers': return 'No reviewers';
    case 'waiting-changes': return r.n === 1 ? '1 change waiting' : `${r.n} changes waiting`;
    case 'approval-yours': return 'Waiting for your approval';
    case 'approval': return 'Waiting for approval';
    case 'deploying': return 'Deploying';
    case 'red': return r.n === 1 ? 'Red on its last run' : `Red, ${r.n} runs in a row`;
    case 'running': return 'Running';
    case 'monitor-up': return 'Up';
    case 'monitor-down': return 'Down';
    case 'monitor-degraded': return 'Degraded';
    case 'monitor-deploying': return 'Deploying';
    case 'monitor-settling': return 'Just deployed';
    default: return '';
  }
}

/** How long a card has been at its stage: "3d", "now". */
export const cardAge = (card, now = Date.now()) => (card.age ? relTime(now - card.age, now) : '');

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const RUN = { succeeded: ['✓', 'ok'], failed: ['✗', 'del'], partiallySucceeded: ['◐', 'warn'] };

/** Where ↵ takes a card: the tab that has it (App's showPr, showWorkItem, showPipeline), or the one its page maps to. */
export function cardTab(card) {
  if (card.open) return { pr: 'prs', workitem: 'workitems', pipeline: 'pipelines' }[card.open.type] ?? null;
  // Approvals are decided in the Inbox (a, x); what waits to ship and what's live is in Production.
  if (card.kind === 'approval') return 'inbox';
  if (card.link === '/ship' || card.link === '/production') return 'production';
  return null;
}
const TAB_NAME = { prs: 'Pull requests', workitems: 'Work items', pipelines: 'Pipelines', inbox: 'the Inbox', production: 'Production' };

/** A card's pane beside the list, as lines of segments. */
export function cardDetail(card, now = Date.now()) {
  if (!card) return [];
  const mark = stuckMark(card);
  const lines = [
    [{ text: card.title, bold: true }],
    [{ text: card.sub ?? '', color: theme.dim }],
    '',
    [{ text: `${mark.icon} `, color: mark.color }, { text: reasonText(card.reason) || STAGE_NAME[card.stage], color: card.stuck ? mark.color : undefined, bold: !!card.stuck }],
  ];
  if (card.kind !== 'monitor' && card.age) lines.push([{ text: `At this stage for ${cardAge(card, now)}`, color: theme.dim }]);
  if (card.kind === 'monitor') {
    const facts = [card.latency != null ? `${card.latency}ms` : null, card.uptime != null ? `${pct(card.uptime)} up` : null].filter(Boolean).join(' · ');
    if (facts) lines.push([{ text: facts, color: theme.dim }]);
    if (card.state === 'down' && card.age) lines.push([{ text: `Down for ${cardAge(card, now)}`, color: theme.del }]);
  }
  if (card.person?.displayName) lines.push([{ text: card.person.displayName, color: theme.dim }]);
  if (card.state && card.kind === 'workitem') lines.push([{ text: `State: ${card.state}`, color: theme.dim }]);
  if (card.draft) lines.push([{ text: 'Draft', color: theme.draft }]);
  if (card.mine) lines.push([{ text: card.kind === 'pr' ? 'Waiting on your review' : 'Yours to decide', color: theme.accent, bold: true }]);
  if (card.runs?.length) {
    lines.push([{ text: 'Latest runs  ', color: theme.dim }, ...card.runs.map((r) => {
      const [icon, colour] = RUN[r] ?? ['·', 'dim'];
      return { text: icon, color: theme[colour] };
    })]);
  }
  const tab = cardTab(card);
  if (tab) lines.push('', [{ text: `↵ ${card.open ? 'opens it in' : 'goes to'} ${TAB_NAME[tab]}`, color: theme.dim }]);
  return lines;
}

/** What happened, as a sentence (the web app's Control.jsx eventText, in English). */
export function eventText(e) {
  switch (e.code) {
    case 'run': return { succeeded: `${e.name} passed`, failed: `${e.name} failed`, partiallySucceeded: `${e.name} partly passed`, canceled: `${e.name} was canceled` }[e.result] || e.name;
    case 'deploy': return `${e.label} deployed to ${e.name}`;
    case 'down': return `${e.name} went down`;
    case 'regression': return `Failures rose on ${e.name} after ${e.label}`;
    case 'approval': return `${e.name} is waiting for approval`;
    case 'merged': return `Merged: ${e.name}`;
    default: return '';
  }
}

/** An event's small print: the run's number, the repo, who. */
export const eventSub = (e) => [e.code === 'run' ? e.label : null, e.repo, e.by].filter(Boolean).join(' · ');

/** Where ↵ takes an event of the timeline. */
export function eventTab(e) {
  if (e.open) return { pr: 'prs', pipeline: 'pipelines' }[e.open.type] ?? null;
  if (e.code === 'approval') return 'inbox';
  return 'production';
}

/** "14:05": when an event happened, on this computer's clock. */
export const clock = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const ms = (n) => (n == null ? null : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);

/** A service tile (views.js serviceTiles) on one line: its numbers, its latest deploy, what's on its way. */
export function tileFacts(tile, now = Date.now()) {
  return [
    ms(tile.latency),
    tile.uptime != null ? `${pct(tile.uptime)} up` : null,
    tile.deploying ? `deploying ${tile.deploying.label}` : tile.lastDeploy ? `${tile.lastDeploy.label} ${relTime(Date.parse(tile.lastDeploy.at), now)} ago` : null,
    tile.waiting ? `${tile.waiting} waiting` : tile.waiting === 0 ? 'all shipped' : null,
  ].filter(Boolean).join(' · ');
}

/** A tile's state mark, as Production's. */
export const tileState = (tile) => monitorState(tile);
