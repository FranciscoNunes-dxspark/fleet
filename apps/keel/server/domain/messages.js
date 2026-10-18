// Posts for Microsoft Teams and Slack channels: which inbox entries are worth
// a post, and how a post is written for each kind of webhook. Pure, so the
// rules and payloads are easy to test (the sending is in channels.js).

export const CHANNEL_KINDS = ['teams', 'slack', 'webhook'];
// Inbox kinds a channel can announce. Reviews waiting on someone are personal, so they're not offered.
export const CHANNEL_EVENTS = ['production', 'pipeline', 'approval', 'work', 'pr'];
export const DEFAULT_EVENTS = ['production', 'pipeline', 'approval'];
// Keel writes these titles (translated); the others are Azure DevOps titles, posted as they are.
const KEEL_TITLES = new Set(['production', 'approval', 'pipeline', 'team']);
const MAX_LINES = 25;

/**
 * Which inbox entries to post: of the kinds the channel wants, those that are
 * new and urgent, or became urgent since the last look (and deployment
 * approvals as soon as they appear). `seen` is { key: severity } from the
 * last look, or null on the first one, which only takes a baseline.
 */
export function channelEvents(seen, items, events = DEFAULT_EVENTS) {
  const wanted = new Set(events);
  const next = {};
  const announce = [];
  for (const i of items) {
    if (!wanted.has(i.kind)) continue;
    const id = identity(i.key);
    if (id in next) continue;
    next[id] = i.severity;
    if (!seen) continue;
    const before = seen[id];
    if ((i.severity === 'high' && before !== 'high') || (i.kind === 'approval' && !before)) announce.push(i);
  }
  return { announce, seen: next };
}

/**
 * What an inbox entry is about, for posting once: a red pipeline's key names
 * its latest run and a monitor's its current issues, and neither should post
 * again while it stays red (getting worse still does, through its severity).
 */
export const identity = (key) => String(key).replace(/^(build:[^:]+:[^:]+):[^:]*$/, '$1').replace(/^(prod:[^:]+):.*$/, '$1');

/** A post about one inbox entry: { title, tone, sections, links }. */
export function eventMessage(item, { t, tx }, keelUrl = null) {
  const title = KEEL_TITLES.has(item.kind) ? tx(item.title) : item.title;
  const lines = [...item.reasons.map((r) => tx(r.text)), item.context ? tx(item.context) : null].filter(Boolean);
  const links = [
    item.webUrl ? { label: item.kind === 'production' ? t('Open the site') : t('Open in Azure DevOps'), url: item.webUrl } : null,
    keelUrl ? { label: t('Open in Keel'), url: `${keelUrl}/${item.kind === 'production' ? 'production' : 'inbox'}` } : null,
  ].filter(Boolean);
  return { title, tone: item.severity === 'high' ? 'bad' : 'warn', sections: [{ lines }], links };
}

/** One post for a burst: the first few entries, and how many more there are. */
export function burstMessage(items, tr, keelUrl = null) {
  const { t, tx } = tr;
  return {
    title: t('{n} things need attention', { n: items.length }),
    tone: 'bad',
    sections: [{ lines: items.slice(0, 8).map((i) => `${KEEL_TITLES.has(i.kind) ? tx(i.title) : i.title}: ${tx(i.reasons[0]?.text || '')}`) }],
    links: keelUrl ? [{ label: t('Open inbox'), url: `${keelUrl}/inbox` }] : [],
  };
}

/** The weekly summary (domain/summary.js) as a post, like "Copy as text" on the page. */
export function summaryMessage(s, { t, locale }, { timeZone, keelUrl = null } = {}) {
  const day = (iso, extra = {}) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC', ...extra });
  const when = (iso) => new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  const tot = s.totals;
  const item = (w) => `${w.title} (${w.projectName}, ${w.type} #${w.id}${w.assignedTo ? `, ${w.assignedTo}` : ''})`;
  const sections = [{
    lines: [
      `${t(tot.finished === 1 ? '{n} item finished' : '{n} items finished', { n: tot.finished })} (${t('{features} features and stories, {bugs} bugs fixed', { features: tot.features, bugs: tot.bugs })})`,
      t(tot.merged === 1 ? '{n} pull request merged' : '{n} pull requests merged', { n: tot.merged }),
      `${t(tot.deploys === 1 ? '{n} deploy to production' : '{n} deploys to production', { n: tot.deploys })}${tot.failedDeploys ? ` (${t('{n} failed', { n: tot.failedDeploys })})` : ''}`,
      t(tot.blocked === 1 ? '{n} item blocked right now' : '{n} items blocked right now', { n: tot.blocked }),
    ],
  }];
  const list = (heading, items) => items.length && sections.push({ heading, lines: items.map(item) });
  list(t('Finished'), s.features);
  list(t('Bugs fixed'), s.bugs);
  if (s.deploys.length) {
    const byTarget = new Map();
    for (const d of s.deploys) byTarget.set(d.target, [...(byTarget.get(d.target) || []), d]);
    sections.push({
      heading: t('Deployed to production'),
      lines: [...byTarget.entries()].map(([target, list]) => {
        const ok = list.filter((d) => d.status === 'succeeded').length;
        const failed = list.length - ok;
        return `${target}: ${t(ok === 1 ? '{n} deploy' : '{n} deploys', { n: ok })}${failed ? `, ${t('{n} failed', { n: failed })}` : ''} (${t('latest {label}, {date}', { label: list[0].label, date: when(list[0].at) })})`;
      }),
    });
  }
  list(t('Blocked right now'), s.blocked);
  return {
    title: t('Week of {from} – {to}', { from: day(s.from), to: day(s.to, { year: 'numeric' }) }),
    tone: 'info',
    sections,
    links: keelUrl ? [{ label: t('Weekly summary'), url: `${keelUrl}/summary?week=${s.week}` }] : [],
  };
}

const clip = (lines) => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `… +${lines.length - MAX_LINES + 1}`] : lines);
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const TEAMS_COLOR = { bad: 'Attention', warn: 'Warning', info: 'Accent', ok: 'Good' };

/** The JSON body a webhook of `kind` expects for message `m`. */
export function payloadFor(kind, m) {
  const sections = m.sections.filter((s) => s.lines.length).map((s) => ({ ...s, lines: clip(s.lines) }));
  const plain = [m.title, ...sections.flatMap((s) => [s.heading, ...s.lines.map((l) => `• ${l}`)].filter(Boolean))].join('\n');
  if (kind === 'slack') {
    return {
      text: m.title, // the notification and the fallback
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(m.title)}*` } },
        ...sections.map((s) => ({
          type: 'section',
          text: { type: 'mrkdwn', text: [s.heading ? `*${slackEscape(s.heading)}*` : null, ...s.lines.map((l) => `• ${slackEscape(l)}`)].filter(Boolean).join('\n').slice(0, 2900) },
        })),
        ...(m.links.length ? [{ type: 'actions', elements: m.links.map((l) => ({ type: 'button', text: { type: 'plain_text', text: l.label }, url: l.url })) }] : []),
      ],
    };
  }
  if (kind === 'teams') {
    // An Adaptive Card: what Teams Workflows ("Post to a channel when a webhook request is received") and the older connectors accept.
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          msteams: { width: 'Full' },
          body: [
            { type: 'TextBlock', text: m.title, weight: 'Bolder', size: 'Medium', wrap: true, color: TEAMS_COLOR[m.tone] || 'Default' },
            ...sections.flatMap((s) => [
              ...(s.heading ? [{ type: 'TextBlock', text: s.heading, weight: 'Bolder', wrap: true, spacing: 'Medium' }] : []),
              { type: 'TextBlock', text: s.lines.map((l) => `- ${l}`).join('\n'), wrap: true, spacing: 'Small' },
            ]),
          ],
          actions: m.links.map((l) => ({ type: 'Action.OpenUrl', title: l.label, url: l.url })),
        },
      }],
    };
  }
  // Anything else that takes JSON (Mattermost and Discord read `text` and `content`).
  return { title: m.title, text: plain, content: plain.slice(0, 2000), sections, links: m.links };
}
