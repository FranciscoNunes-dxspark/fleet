// Posts to Microsoft Teams and Slack channels, shared by everyone using this
// Keel server and set up by Admins (Settings → Teams and Slack):
// - inbox entries of the kinds a channel wants, when they're new and urgent
//   (an outage, a red default branch, a deployment waiting on approval…)
// - the weekly summary, on the weekday and hour the channel asks for
// It runs whether or not anyone has Keel open. Azure DevOps is read with the
// token of the person who set the channel up (with sign-in) or the server's
// own (locally), for the projects the channel picked (none picked: the ones
// that person tracks). Channels live in the data folder (channels.json),
// webhook addresses encrypted; one server process does the posting.
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { decrypt, encrypt, getKey } from './secrets.js';
import { runnerLock, sharedJson } from './jsonfile.js';
import { assertPublicUrl } from './monitoring.js';
import { translator } from './i18n.js';
import { CHANNEL_EVENTS, CHANNEL_KINDS, DEFAULT_EVENTS, burstMessage, channelEvents, eventMessage, payloadFor, summaryMessage } from './domain/messages.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const MAX_POSTS = 4; // per channel and look; more than that goes out as one post
const MAX_PROJECTS = 100;
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Weekday (1 = Monday … 7 = Sunday), hour and date in a time zone. */
export function localTime(ms, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  }
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1,
    hour: Number(get('hour')) % 24,
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** Is the weekly summary due now: the right weekday, at or after the hour, and not sent yet today. */
export function weeklyDue(channel, lastWeekly, ms) {
  const w = channel.weekly;
  if (!w?.enabled) return null;
  const now = localTime(ms, channel.timeZone);
  return now.weekday === w.weekday && now.hour >= w.hour && lastWeekly !== now.date ? now.date : null;
}

export function createChannels({
  dataDir = config.dataDir,
  mock = config.mock,
  // (ownerId) -> the service that reads Azure DevOps for this channel, or null.
  resolveService,
  send = defaultSend,
  keelUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || null,
  every = 2 * MIN,
} = {}) {
  const suffix = mock ? '.mock' : '';
  const store = sharedJson(path.join(dataDir, `channels${suffix}.json`), () => ({ channels: [] }));
  // Per channel: { seen: { inbox key: severity }, lastPostAt, lastError, lastWeekly }.
  const state = sharedJson(path.join(dataDir, `channel-state${suffix}.json`), () => ({}));
  const runner = runnerLock(path.join(dataDir, `channel-runner${suffix}.json`), 3 * MIN);
  const all = () => store.get().channels || [];
  const urlOf = (c) => decrypt(getKey(), c.url);
  const note = (id, patch) => state.update((s) => {
    s[id] = { ...(s[id] || {}), ...patch };
  });

  // A channel's view: its owner's service looking at the channel's projects, kept
  // while the owner's service lives so its caches carry over from one look to the next.
  const views = new WeakMap(); // owner's service -> Map(projects key -> service)
  const projectsKey = (c) => [...new Set(c.projects || [])].sort().join(',');
  function viewFor(service, c) {
    const key = projectsKey(c);
    if (!key || !service.withProjects) return service;
    if (!views.has(service)) views.set(service, new Map());
    const byKey = views.get(service);
    if (!byKey.has(key)) byKey.set(key, service.withProjects(key.split(',')));
    return byKey.get(key);
  }

  async function post(c, message, url = urlOf(c)) {
    await assertPublicUrl(url); // checked every time: DNS can change
    await send(url, payloadFor(c.kind, message));
  }

  /** Post `message` to channel `c`, recording how it went. */
  async function deliver(c, message) {
    try {
      await post(c, message);
      note(c.id, { lastPostAt: new Date().toISOString(), lastError: null });
      return true;
    } catch (err) {
      note(c.id, { lastError: err.message, lastErrorAt: new Date().toISOString() });
      console.warn(`[channels] ${c.name}: ${err.message}`);
      return false;
    }
  }

  async function weeklyMessage(c, service, ms = Date.now()) {
    const lastWeek = new Date(ms - 7 * DAY).toISOString().slice(0, 10);
    const summary = await service.summary(lastWeek);
    return summaryMessage(summary, translator(c.language), { timeZone: c.timeZone, keelUrl });
  }

  let busy = false;
  /** One look: new urgent entries for every channel, and weekly summaries that are due. */
  async function tick(ms = Date.now()) {
    if (busy || !all().length || !runner.isRunner()) return;
    busy = true;
    try {
      const byOwner = new Map();
      for (const c of all()) byOwner.set(c.ownerId || '', [...(byOwner.get(c.ownerId || '') || []), c]);
      for (const [ownerId, channels] of byOwner) {
        let service;
        try {
          service = await resolveService(ownerId || null);
        } catch (err) {
          service = null;
          console.warn(`[channels] ${err.message}`);
        }
        if (!service) {
          for (const c of channels) note(c.id, { lastError: 'The person who set up this channel has no working Azure DevOps token in Keel.', lastErrorAt: new Date().toISOString() });
          continue;
        }
        // Channels with the same projects share one read of the inbox.
        const inboxes = new Map(); // projects key -> { items } or { error }
        const inboxFor = async (c) => {
          const key = projectsKey(c);
          if (!inboxes.has(key)) {
            const view = viewFor(service, c);
            try {
              // Fresh from Azure DevOps, as the console's live updates do.
              for (const prefix of ['prs:active', 'wi:', 'builds']) view.invalidate(prefix);
              inboxes.set(key, { items: (await view.attention()).items });
            } catch (err) {
              inboxes.set(key, { error: err.message });
            }
          }
          return inboxes.get(key);
        };
        for (const c of channels) {
          const s = state.get()[c.id] || {};
          const inbox = c.events?.length ? await inboxFor(c) : null;
          if (inbox?.error) note(c.id, { lastError: `Couldn't read Azure DevOps: ${inbox.error}`, lastErrorAt: new Date().toISOString() });
          if (inbox?.items) {
            const { announce, seen } = channelEvents(s.seen || null, inbox.items, c.events);
            note(c.id, { seen });
            const tr = translator(c.language);
            if (announce.length > MAX_POSTS) await deliver(c, burstMessage(announce, tr, keelUrl));
            else for (const item of announce) await deliver(c, eventMessage(item, tr, keelUrl));
          }
          const due = weeklyDue(c, s.lastWeekly, ms);
          if (due) {
            note(c.id, { lastWeekly: due }); // once per day, even if posting fails
            try {
              await deliver(c, await weeklyMessage(c, viewFor(service, c), ms));
            } catch (err) {
              note(c.id, { lastError: `Weekly summary: ${err.message}`, lastErrorAt: new Date().toISOString() });
            }
          }
        }
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => tick().catch((err) => console.warn(`[channels] ${err.message}`)), every);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 20_000).unref?.();

  /** A channel as the settings page sees it: never the webhook address itself. */
  const view = (c) => {
    const s = state.get()[c.id] || {};
    let host = null;
    try {
      host = new URL(urlOf(c)).host;
    } catch {
      host = null;
    }
    const { url, ...rest } = c;
    return { ...rest, hasUrl: !!url, urlHost: host, lastPostAt: s.lastPostAt || null, lastError: s.lastError || null, lastErrorAt: s.lastErrorAt || null, lastWeekly: s.lastWeekly || null };
  };

  async function clean(input, existing, owner) {
    const name = String(input.name || '').trim().slice(0, 80);
    if (!name) throw bad('Give each channel a name.');
    const kind = CHANNEL_KINDS.includes(input.kind) ? input.kind : 'teams';
    let url = existing?.url || null;
    if (input.url) {
      const parsed = await assertPublicUrl(String(input.url).trim());
      if (parsed.protocol !== 'https:') throw bad('Webhook addresses must start with https://');
      url = encrypt(getKey(), parsed.href);
    }
    if (!url) throw bad(`Paste the webhook address for ${name}.`);
    const weekly = input.weekly || {};
    return {
      id: existing?.id || crypto.randomUUID(),
      name,
      kind,
      url,
      events: (Array.isArray(input.events) ? input.events : DEFAULT_EVENTS).filter((e) => CHANNEL_EVENTS.includes(e)),
      weekly: {
        enabled: !!weekly.enabled,
        weekday: Math.min(7, Math.max(1, Math.round(Number(weekly.weekday) || 1))),
        hour: Math.min(23, Math.max(0, Math.round(Number(weekly.hour ?? 9)))),
      },
      timeZone: validZone(input.timeZone) ? input.timeZone : existing?.timeZone || 'UTC',
      language: input.language === 'pt' ? 'pt' : 'en',
      // The projects it's about; none means the ones its owner tracks.
      projects: [...new Set((Array.isArray(input.projects) ? input.projects : existing?.projects || [])
        .filter((id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)))].slice(0, MAX_PROJECTS),
      // Who Keel reads Azure DevOps as for this channel: whoever set it up.
      ownerId: existing?.ownerId ?? owner?.id ?? null,
      ownerName: existing ? existing.ownerName ?? null : owner?.name ?? null,
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
  }

  return {
    list: () => ({ channels: all().map(view), keelUrl, events: CHANNEL_EVENTS, kinds: CHANNEL_KINDS }),

    /** Replace the list. Channels keep their address when none is given; `owner` sets up new ones. */
    async save(list, owner = null) {
      if (!Array.isArray(list)) throw bad('Expected a list of channels.');
      if (list.length > 20) throw bad('Up to 20 channels.');
      const current = all();
      const next = [];
      for (const input of list) next.push(await clean(input, current.find((c) => c.id === input.id), owner));
      store.save({ channels: next });
      // Forget the state of channels that are gone. A channel whose projects changed
      // starts from a fresh baseline, so it doesn't post everything already open in the new ones.
      state.update((s) => {
        for (const id of Object.keys(s)) {
          const c = next.find((x) => x.id === id);
          const before = current.find((x) => x.id === id);
          if (!c) delete s[id];
          else if (before && projectsKey(before) !== projectsKey(c)) delete s[id].seen;
        }
      });
      return this.list();
    },

    /** Send a test post: to a saved channel, or to an address being set up. */
    async test({ id, kind, url, language } = {}) {
      const saved = id ? all().find((c) => c.id === id) : null;
      const target = url ? String(url).trim() : saved ? urlOf(saved) : null;
      if (!target) throw bad('Paste the webhook address first.');
      const { t } = translator(language || saved?.language);
      const parsed = await assertPublicUrl(target);
      if (parsed.protocol !== 'https:') throw bad('Webhook addresses must start with https://');
      await send(parsed.href, payloadFor(CHANNEL_KINDS.includes(kind) ? kind : saved?.kind || 'teams', {
        title: t('Keel is connected'),
        tone: 'ok',
        sections: [{ lines: [t('This channel will get the updates chosen in Keel.')] }],
        links: keelUrl ? [{ label: t('Open in Keel'), url: keelUrl }] : [],
      }));
      return { ok: true };
    },

    /** Post last week's summary now (Admins checking how it looks), read as the channel's owner when possible. */
    async sendWeekly(id, fallback) {
      const c = all().find((x) => x.id === id);
      if (!c) throw Object.assign(new Error('Unknown channel'), { status: 404 });
      const service = (await Promise.resolve(resolveService(c.ownerId || null)).catch(() => null)) || fallback;
      await post(c, await weeklyMessage(c, viewFor(service, c)));
      note(c.id, { lastPostAt: new Date().toISOString(), lastError: null });
      return { ok: true };
    },

    tick,
    close: () => clearInterval(timer),
  };
}

const validZone = (z) => {
  if (typeof z !== 'string' || !z || z.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: z }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
};

/** POST JSON, no redirects (a webhook that redirects isn't one), 10 seconds at most. */
async function defaultSend(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Keel/1.0' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`The channel answered HTTP ${res.status}${text ? `: ${text}` : ''}`);
  }
  res.body?.cancel().catch(() => {});
}
