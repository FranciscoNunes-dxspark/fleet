// Push notifications to phones and computers where someone turned them on
// (Settings → Notifications → Push on this device). They're the same events as
// the console's own notifications (domain/changes.js), in the categories that
// person chose, read as them every two minutes whether or not Keel is open.
// Devices live in the data folder (push.json), their push addresses
// encrypted; the server's VAPID key pair is made on first use and kept there.
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { decrypt, encrypt, getKey } from './secrets.js';
import { runnerLock, sharedJson } from './jsonfile.js';
import { translator } from './i18n.js';
import { diffSnapshots } from './domain/changes.js';
import { allowedEndpoint, generateVapidKeys, sendPush } from './webpush.js';

const MIN = 60_000;
const MAX_DEVICES = 10; // per person
const MAX_SINGLE = 3; // more new events than this at once go out as one notification
// The console's notification categories (client/src/notify.js); "other pull request alerts" are off unless chosen.
export const PUSH_CATEGORIES = ['production', 'approval', 'review', 'myPr', 'run', 'pipeline', 'work', 'pr'];
const DEFAULT_OFF = new Set(['pr']);
const bad = (message) => Object.assign(new Error(message), { status: 400 });

/** Is a note in a category this person wants (their console notification choices)? */
export const wanted = (note, categories = {}) => (note.category in categories ? categories[note.category] !== false : !DEFAULT_OFF.has(note.category));

/** Where tapping a notification leads: the page, with the PR or work item open when there is one. */
export function openUrl(target) {
  if (!target) return '/inbox';
  if (target.type === 'production') return '/production';
  if (target.type === 'approval' || (target.type === 'pipeline' && !target.key)) return '/pipelines';
  if (target.type === 'release') return '/pipelines?tab=releases';
  if (target.type === 'person') return '/team';
  return `/inbox?open=${encodeURIComponent(JSON.stringify(target))}`;
}

/** The notifications for a batch of new events: one each, or one summing them up when there are many. */
export function pushMessages(notes, { t, tx }) {
  // Azure DevOps titles (pull requests, work items) and reviewers' names stay as they are.
  const title = (n) => (/^attention:(pr|wi):/.test(n.key || '') ? n.title : tx(n.title));
  const body = (n) => (/^vote:/.test(n.key || '') ? n.body : tx(n.body));
  if (notes.length > MAX_SINGLE) {
    return [{
      title: t('{n} updates in Azure DevOps', { n: notes.length }),
      body: notes.slice(0, MAX_SINGLE).map(title).join(' · '),
      tag: 'keel-batch',
      url: '/inbox',
      urgent: notes.some((n) => n.severity === 'high'),
    }];
  }
  return notes.map((n) => ({ title: title(n), body: body(n) || '', tag: n.key, url: openUrl(n.target), urgent: n.severity === 'high' }));
}

export function createPush({
  dataDir = config.dataDir,
  mock = config.mock,
  // (userId) -> the service that reads Azure DevOps as that person, or null.
  resolveService,
  send = sendPush,
  subject = process.env.PUSH_SUBJECT || (/^https:\/\//.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL.trim() : 'mailto:keel@localhost'),
  every = 2 * MIN,
} = {}) {
  const suffix = mock ? '.mock' : '';
  const store = sharedJson(path.join(dataDir, `push${suffix}.json`), () => ({ devices: [] }));
  const runner = runnerLock(path.join(dataDir, `push-runner${suffix}.json`), 3 * MIN);
  const devices = () => store.get().devices || [];
  // Each person's last snapshot, to tell what's new (in memory: a restart takes a fresh baseline).
  const previous = new Map();

  function vapid() {
    let v = store.get().vapid;
    if (!v) {
      store.update((s) => {
        s.vapid ||= (() => {
          const keys = generateVapidKeys();
          return { publicKey: keys.publicKey, privateKey: encrypt(getKey(), keys.privateKey) };
        })();
      });
      v = store.get().vapid;
    }
    return { publicKey: v.publicKey, privateKey: decrypt(getKey(), v.privateKey) };
  }

  const subscriptionOf = (d) => JSON.parse(decrypt(getKey(), d.sub));
  const note = (id, patch) => store.update((s) => {
    const d = (s.devices || []).find((x) => x.id === id);
    if (d) Object.assign(d, patch);
  });
  const forget = (id) => store.update((s) => {
    s.devices = (s.devices || []).filter((x) => x.id !== id);
  });

  /** Send one message to one device, recording how it went; a device the push service no longer knows is forgotten. */
  async function deliver(d, message, keys = vapid()) {
    try {
      const result = await send(subscriptionOf(d), message, { vapid: keys, subject, urgency: message.urgent ? 'high' : 'normal' });
      if (result?.gone) {
        forget(d.id);
        return 'gone';
      }
      note(d.id, { lastSentAt: new Date().toISOString(), lastError: null });
      return true;
    } catch (err) {
      note(d.id, { lastError: err.message, lastErrorAt: new Date().toISOString() });
      console.warn(`[push] ${d.label}: ${err.message}`);
      return false;
    }
  }

  let busy = false;
  /** One look for everyone with push on: what's new since last time, sent to each of their devices. */
  async function tick() {
    if (busy || !devices().length || !runner.isRunner()) return;
    busy = true;
    try {
      const byUser = new Map();
      for (const d of devices()) byUser.set(d.userId, [...(byUser.get(d.userId) || []), d]);
      for (const userId of previous.keys()) if (!byUser.has(userId)) previous.delete(userId);
      for (const [userId, list] of byUser) {
        let service = null;
        try {
          service = await resolveService(userId === 'local' ? null : userId);
        } catch (err) {
          console.warn(`[push] ${err.message}`);
        }
        if (!service) {
          for (const d of list) note(d.id, { lastError: 'No working Azure DevOps token in Keel for this person.', lastErrorAt: new Date().toISOString() });
          continue;
        }
        let snap;
        try {
          // Fresh from Azure DevOps, as the console's live updates do.
          for (const prefix of ['prs:active', 'pr:', 'wi:', 'builds']) service.invalidate(prefix);
          snap = await service.snapshot();
        } catch (err) {
          console.warn(`[push] couldn't read Azure DevOps: ${err.message}`);
          continue;
        }
        const notes = diffSnapshots(previous.get(userId) || null, snap);
        previous.set(userId, snap);
        if (!notes.length) continue;
        const prefs = (await service.settingsStore.load()).prefs || {};
        const chosen = notes.filter((n) => wanted(n, prefs.notifications?.categories));
        if (!chosen.length) continue;
        const messages = pushMessages(chosen, translator(prefs.language?.lang));
        const keys = vapid();
        for (const d of list) for (const m of messages) await deliver(d, m, keys);
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => tick().catch((err) => console.warn(`[push] ${err.message}`)), every);
  timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 15_000).unref?.();

  const view = (d) => ({ id: d.id, label: d.label, createdAt: d.createdAt, lastSentAt: d.lastSentAt || null, lastError: d.lastError || null, lastErrorAt: d.lastErrorAt || null });
  const idOf = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
  const who = (userId) => userId || 'local';

  return {
    /** This person's devices and the key browsers need to subscribe. */
    info(userId) {
      return { publicKey: vapid().publicKey, devices: devices().filter((d) => d.userId === who(userId)).map(view) };
    },

    /** Turn push on for a device (a PushSubscription from the browser), or refresh it. */
    subscribe(userId, { subscription, label } = {}) {
      const endpoint = allowedEndpoint(subscription?.endpoint);
      if (!endpoint) throw bad("This browser's push service isn't one Keel sends to.");
      const keys = subscription.keys || {};
      if (!/^[\w-]{80,100}$/.test(keys.p256dh || '') || !/^[\w-]{20,24}$/.test(keys.auth || '')) throw bad('This push subscription has no valid keys.');
      const id = idOf(endpoint);
      const mine = devices().filter((d) => d.userId === who(userId) && d.id !== id);
      if (mine.length >= MAX_DEVICES) throw bad(`Up to ${MAX_DEVICES} devices. Remove one first.`);
      const device = {
        id,
        userId: who(userId),
        label: String(label || 'This device').trim().slice(0, 60) || 'This device',
        sub: encrypt(getKey(), JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } })),
        createdAt: new Date().toISOString(),
      };
      // A device belongs to whoever subscribed it last (a shared computer, someone else signing in).
      store.update((s) => {
        s.devices = [...(s.devices || []).filter((d) => d.id !== id), device];
      });
      return view(device);
    },

    /** Turn push off for one of your devices (by id, or by its push address from the browser). */
    unsubscribe(userId, { id, endpoint } = {}) {
      const target = id || (endpoint && allowedEndpoint(endpoint) && idOf(allowedEndpoint(endpoint)));
      const d = devices().find((x) => x.id === target && x.userId === who(userId));
      if (d) forget(d.id);
      return { ok: true };
    },

    /** Send a test notification to one of your devices, or all of them. */
    async test(userId, { id, language } = {}) {
      const mine = devices().filter((d) => d.userId === who(userId) && (!id || d.id === id));
      if (!mine.length) throw Object.assign(new Error('Turn on push on this device first.'), { status: 404 });
      const { t } = translator(language);
      const results = await Promise.all(mine.map((d) => deliver(d, { title: t('Keel notifications are on'), body: t("You'll get the updates you chose, even when Keel is closed."), tag: 'keel-test', url: '/' })));
      if (!results.includes(true)) {
        if (results.includes('gone')) throw Object.assign(new Error("This device's push subscription has expired. Turn push on again on it."), { status: 410 });
        const err = devices().find((d) => d.id === mine[0].id)?.lastError;
        throw Object.assign(new Error(err || "The device didn't accept the notification. Turn push off and on again."), { status: 502 });
      }
      return { ok: true };
    },

    tick,
    close: () => clearInterval(timer),
  };
}
