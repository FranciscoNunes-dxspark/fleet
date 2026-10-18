import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelEvents, eventMessage, payloadFor, summaryMessage } from '../server/domain/messages.js';
import { createChannels, localTime, weeklyDue } from '../server/channels.js';
import { translator } from '../server/i18n.js';

process.env.MONITOR_ALLOW_PRIVATE = '1'; // no DNS needed for the made-up webhook addresses

const entry = (key, kind, severity, extra = {}) => ({ key, kind, severity, title: `${key} title`, reasons: [{ text: 'Down for 6m: HTTP 503' }], webUrl: 'https://shop.example.com', ...extra });

test('channels: the first look is a baseline; then new or newly urgent entries of the wanted kinds', () => {
  const first = channelEvents(null, [entry('a', 'production', 'high')], ['production', 'approval']);
  assert.deepEqual(first.announce, []);
  const items = [
    entry('a', 'production', 'high'), // already announced
    entry('b', 'pipeline', 'high'), // not wanted
    entry('c', 'approval', 'high'), // new approval
    entry('d', 'production', 'medium'), // new but not urgent
    entry('e', 'production', 'high'), // was medium, now high
  ];
  const next = channelEvents({ ...first.seen, e: 'medium' }, items, ['production', 'approval']);
  assert.deepEqual(next.announce.map((i) => i.key), ['c', 'e']);
  assert.equal(next.seen.d, 'medium');

  // A pipeline that stays red (each failed run a new key) or a monitor whose issues change posts once.
  const red = channelEvents({}, [entry('build:p1:7:100', 'pipeline', 'high'), entry('prod:m1:down', 'production', 'high')], ['pipeline', 'production']);
  assert.equal(red.announce.length, 2);
  const still = channelEvents(red.seen, [entry('build:p1:7:101', 'pipeline', 'high'), entry('prod:m1:down,failures', 'production', 'high')], ['pipeline', 'production']);
  assert.deepEqual(still.announce, []);
  assert.deepEqual(Object.keys(still.seen), ['build:p1:7', 'prod:m1']);
});

test('channels: posts for Teams, Slack and plain JSON, in the channel language', () => {
  const pt = translator('pt');
  const m = eventMessage(entry('prod:1', 'production', 'high', { title: 'Storefront is down' }), pt, 'https://keel.example.com');
  assert.equal(m.title, 'Storefront está em baixo');
  assert.deepEqual(m.links.map((l) => l.url), ['https://shop.example.com', 'https://keel.example.com/production']);

  const slack = payloadFor('slack', m);
  assert.equal(slack.text, 'Storefront está em baixo');
  assert.equal(slack.blocks.at(-1).type, 'actions');
  const teams = payloadFor('teams', m);
  const card = teams.attachments[0].content;
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.body[0].color, 'Attention');
  assert.equal(card.actions.length, 2);
  const plain = payloadFor('webhook', { title: 'A <b>', tone: 'info', sections: [{ lines: ['one'] }], links: [] });
  assert.equal(plain.text, 'A <b>\n• one');
  assert.equal(payloadFor('slack', { title: 'A <b> & c', tone: 'info', sections: [], links: [] }).blocks[0].text.text, '*A &lt;b&gt; &amp; c*');

  const summary = {
    week: '2026-10-05', from: '2026-10-05T00:00:00.000Z', to: '2026-10-11T23:59:59.999Z',
    totals: { finished: 2, features: 1, bugs: 1, merged: 3, deploys: 2, failedDeploys: 0, blocked: 1 },
    features: [{ id: 1, title: 'Guest checkout', type: 'User Story', projectName: 'Shop', assignedTo: 'Ana' }],
    bugs: [{ id: 2, title: 'VAT rounding', type: 'Bug', projectName: 'Shop', assignedTo: null }],
    deploys: [{ target: 'Shop', label: 'R-2', at: '2026-10-09T10:00:00Z', status: 'succeeded' }, { target: 'Shop', label: 'R-1', at: '2026-10-07T10:00:00Z', status: 'succeeded' }],
    blocked: [],
  };
  const w = summaryMessage(summary, translator('en'), { timeZone: 'Europe/Lisbon' });
  assert.equal(w.title, 'Week of 5 Oct – 11 Oct 2026');
  assert.deepEqual(w.sections.map((s) => s.heading || null), [null, 'Finished', 'Bugs fixed', 'Deployed to production']);
  assert.match(w.sections[3].lines[0], /^Shop: 2 deploys \(latest R-2, /);
});

test('channels: the weekly summary is due once, on the weekday and after the hour, in the channel time zone', () => {
  const monday10Lisbon = Date.parse('2026-10-12T09:00:00Z'); // 10:00 in Lisbon (summer time)
  assert.deepEqual(localTime(monday10Lisbon, 'Europe/Lisbon'), { weekday: 1, hour: 10, date: '2026-10-12' });
  const c = { weekly: { enabled: true, weekday: 1, hour: 9 }, timeZone: 'Europe/Lisbon' };
  assert.equal(weeklyDue(c, null, monday10Lisbon), '2026-10-12');
  assert.equal(weeklyDue(c, '2026-10-12', monday10Lisbon), null, 'already sent today');
  assert.equal(weeklyDue({ ...c, weekly: { ...c.weekly, hour: 11 } }, null, monday10Lisbon), null, 'too early');
  assert.equal(weeklyDue({ ...c, weekly: { ...c.weekly, enabled: false } }, null, monday10Lisbon), null);
  assert.equal(weeklyDue(c, null, Date.parse('2026-10-13T09:00:00Z')), null, 'Tuesday');
});

test('channels: save keeps addresses secret, and a look posts what is new', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-channels-'));
  const sent = [];
  let items = [entry('prod:1', 'production', 'high')];
  const service = {
    invalidate: () => {},
    attention: async () => ({ items }),
    summary: async () => { throw new Error('not asked for'); },
  };
  const channels = createChannels({ dataDir: dir, mock: false, resolveService: () => service, send: async (url, body) => sent.push({ url, body }), every: 3_600_000 });
  try {
    await assert.rejects(channels.save([{ name: 'Team', kind: 'slack', url: 'http://hooks.example.test/x' }]), /https/);
    const saved = await channels.save([{ name: 'Team', kind: 'slack', url: 'https://hooks.example.test/services/T/B/x', events: ['production'], weekly: { enabled: false } }], { id: 'u1', name: 'Lead' });
    const c = saved.channels[0];
    assert.equal(c.url, undefined);
    assert.equal(c.hasUrl, true);
    assert.equal(c.urlHost, 'hooks.example.test');
    assert.equal(c.ownerId, 'u1');
    assert.ok(!fs.readFileSync(path.join(dir, 'channels.json'), 'utf8').includes('hooks.example.test'), 'stored encrypted');

    // Saving again without an address keeps the old one.
    await channels.save([{ id: c.id, name: 'Team room', kind: 'slack', events: ['production'] }]);
    assert.equal(channels.list().channels[0].urlHost, 'hooks.example.test');

    await channels.tick(); // baseline
    assert.equal(sent.length, 0);
    items = [...items, entry('prod:2', 'production', 'high', { title: 'API is down' })];
    await channels.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://hooks.example.test/services/T/B/x');
    assert.equal(sent[0].body.text, 'API is down');
    await channels.tick();
    assert.equal(sent.length, 1, 'announced once');
    assert.ok(channels.list().channels[0].lastPostAt);
  } finally {
    channels.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
