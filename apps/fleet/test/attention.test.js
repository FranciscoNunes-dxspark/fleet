import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badgeFor, badgeText, familyReader, isNews } from '../src/attention.js';

test('a worried or sad mood since you last looked is a !, an older one or a calm one nothing', () => {
  assert.deepEqual(badgeFor('bosun', { mood: { mood: 'worried', reason: 'api crashed', at: 200 }, seen: 100 }), { alert: true, count: 0, reason: 'api crashed', text: '!' });
  assert.equal(badgeFor('bosun', { mood: { mood: 'sad', reason: 'gave up', at: 200 }, seen: 100 }).text, '!');
  assert.equal(badgeFor('bosun', { mood: { mood: 'worried', at: 50 }, seen: 100 }), null);
  assert.equal(badgeFor('bosun', { mood: { mood: 'happy', at: 200 }, seen: 100 }), null);
  assert.equal(badgeFor('bosun', { mood: null, seen: 100 }), null);
});

test("alerting entries of the space's own app since you looked are counted, the newest the reason", () => {
  const activity = [
    { at: 150, app: 'sonar', kind: 'alert', text: 'watch "5xx" is 12' },
    { at: 160, app: 'sonar', kind: 'alert', text: 'watch "5xx" is 30' },
    { at: 170, app: 'sonar', kind: 'info', text: 'restarted api' },
    { at: 90, app: 'sonar', kind: 'alert', text: 'old' },
    { at: 180, app: 'bosun', kind: 'error', text: 'web crashed' },
  ];
  assert.deepEqual(badgeFor('sonar', { activity, seen: 100 }), { alert: false, count: 2, reason: 'watch "5xx" is 30', text: '2' });
  assert.equal(badgeFor('sonar', { mood: { mood: 'worried', reason: 'r', at: 200 }, activity, seen: 100 }).text, '!2');
  // Any space, by its id: Keel's entries count as anyone's.
  assert.equal(badgeFor('keel', { activity: [{ at: 300, app: 'keel', kind: 'error', text: 'x' }], seen: 100 }).text, '1');
  assert.equal(badgeText({ alert: true, count: 12 }), '!9+');
  assert.equal(badgeText(null), '');
});

test('a badge is news when there was none, or it says more', () => {
  assert.equal(isNews(null, { alert: false, count: 1 }), true);
  assert.equal(isNews({ alert: false, count: 1 }, { alert: false, count: 1 }), false);
  assert.equal(isNews({ alert: false, count: 1 }, { alert: true, count: 1 }), true);
  assert.equal(isNews({ alert: true, count: 1 }, null), false);
});

test("the family's folder is read by each space's id, files read again only when they change", () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-attention-'));
  try {
    const reader = familyReader(dir);
    assert.deepEqual(reader.read(['bosun', 'keel']), { moods: { bosun: null, keel: null }, activity: [] });
    writeFileSync(join(dir, 'keel.mood.json'), JSON.stringify({ app: 'keel', mood: 'worried', reason: 'build failed', at: 5 }));
    appendFileSync(join(dir, 'activity.jsonl'), `${JSON.stringify({ at: 1, app: 'bosun', kind: 'error', text: 'x' })}\nnot json\n`);
    const read = reader.read(['bosun', 'keel']);
    assert.equal(read.moods.keel.reason, 'build failed');
    assert.equal(read.activity.length, 1);
    // Unchanged, the same objects come back.
    assert.equal(reader.read(['bosun', 'keel']).activity, read.activity);
    writeFileSync(join(dir, 'bosun.mood.json'), '{ cut');
    assert.equal(reader.read(['bosun']).moods.bosun, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
