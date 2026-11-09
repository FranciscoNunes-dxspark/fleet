// The shell look (look.js): its top line and status line (ui/shell.jsx), and how Panel and PromptBox
// draw in it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { theme } from '../theme.js';
import { look, setLook, shellLook } from '../look.js';
import { Panel, PromptBox, paneRows, promptHeight } from '../ui/parts.jsx';
import { parseKeys, statusLine, topLine } from '../ui/shell.jsx';
import { stringWidth } from '../text.js';

Object.assign(theme, { accent: '#5fd787', border: '#5f5f5f', dim: '#8a8a8a', ink: '#121212', del: '#ff5f5f', warn: '#ffd75f', mode: 'dark' });

afterEach(() => setLook('classic'));

const text = (segs) => segs.map((s) => s.text).join('');
const frame = (el) => {
  const app = render(el);
  const out = app.lastFrame().split('\n').map((l) => l.trimEnd());
  app.unmount();
  return out;
};

test('the look is classic unless an app chooses shell, and no other', () => {
  assert.equal(look(), 'classic');
  assert.equal(shellLook(), false);
  setLook('shell');
  assert.equal(shellLook(), true);
  assert.throws(() => setLook('fancy'), /No look called "fancy"/);
});

test('topLine puts the face, the name and the views on the left and the context at the right', () => {
  const views = [
    { id: 'c', key: 1, label: 'Containers' },
    { id: 'i', key: 2, label: 'Images', count: 3 },
  ];
  const { segments, tabs } = topLine({ face: '(o)', title: 'Wharf', views, view: 'c', context: [{ text: '6/8 running' }], width: 60 });
  const line = text(segments);
  assert.equal(stringWidth(line), 60);
  assert.ok(line.startsWith('(o) Wharf   1 Containers   2 Images 3'), line);
  assert.ok(line.endsWith('6/8 running'), line);
  // The view shown on the accent, padded by a space either side taken from the gaps: the text is where it was.
  const on = segments.find((s) => s.text === ' 1 Containers ');
  assert.equal(on.bg, theme.accent);
  assert.equal(on.color, theme.ink);
  assert.deepEqual(tabs, [
    { id: 'c', x: 11, width: 14 },
    { id: 'i', x: 27, width: 10 },
  ]);
  assert.equal(line.slice(tabs[1].x, tabs[1].x + tabs[1].width), '2 Images 3');
});

test('topLine lets the context go before the views when the line is narrow', () => {
  const { segments } = topLine({ title: 'Wharf', views: [{ id: 'a', label: 'Containers' }], view: 'a', context: [{ text: 'a long context here' }], width: 24 });
  assert.equal(text(segments).trimEnd(), 'Wharf   Containers');
});

test('parseKeys reads a hint as keys and what they do', () => {
  assert.deepEqual(parseKeys('↵ log · e shell · alt+r restart · …'), [
    { key: '↵', label: 'log' },
    { key: 'e', label: 'shell' },
    { key: 'alt+r', label: 'restart' },
    { key: '', label: '…' },
  ]);
  assert.deepEqual(parseKeys(''), []);
});

test('statusLine fills the line, keeps the right side whole and cuts the keys to whole ones', () => {
  const segs = statusLine({ face: '(o)', message: '2 not well', keys: '↵ log · e shell · s stop · r restart · x remove', right: '/ commands · ? help', width: 60 });
  const line = text(segs);
  assert.equal(stringWidth(line), 60);
  assert.ok(line.startsWith(' (o)  2 not well │ ↵ log'), line);
  assert.ok(line.endsWith('/ commands  ? help '), line);
  assert.match(line, /…/);
  assert.ok(segs.every((s) => s.bg), 'every segment has a background');
  assert.equal(segs[0].bg, theme.accent);
  assert.equal(statusLine({ face: '(o)', tone: 'danger', width: 20 })[0].bg, theme.del);
  const crowded = text(statusLine({ face: '(o)', message: 'a message that takes the room', keys: 'alt+r restart', width: 44 }));
  assert.ok(!crowded.includes('│'), 'no divider when no key fits after it');
});

test('in the shell look Panel is a title row and a rule, and its children get one more row', () => {
  setLook('shell');
  const out = frame(React.createElement(Panel, { title: 'Containers', hint: '8', width: 30, height: 4, focused: true }, React.createElement('ink-text', null, 'a\nb\nc')));
  assert.equal(out[0], `│ Containers${' '.repeat(15)}8`);
  assert.deepEqual(out.slice(1), ['│a', '│b', '│c']);
});

test('in the shell look the prompt is one row', () => {
  setLook('shell');
  assert.equal(promptHeight(), 1);
  const out = frame(React.createElement(PromptBox, { value: '', cursor: 0, focused: false, width: 40, placeholder: '/ for commands' }));
  assert.deepEqual(out, [' » / for commands']);
  setLook('classic');
  assert.equal(promptHeight(), 3);
});

test('topLine with compact gives up the digits, then the other views, before the context it needs', () => {
  const views = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `v${i}`, key: i, label: `View${i}` }));
  const context = [{ text: 'PROD', need: true }, { text: '  ' }, { text: 'shop-db', need: true }, { text: '  ' }, { text: '/a/long/file.sql' }];
  const at = (width) => topLine({ title: 'Trawl', views, view: 'v2', context, width, compact: true });
  const wide = at(140);
  assert.equal(wide.compact, 'none');
  assert.ok(text(wide.segments).includes('1 View1') && text(wide.segments).endsWith('/a/long/file.sql'));
  const keys = at(75);
  assert.equal(keys.compact, 'keys');
  assert.ok(text(keys.segments).includes('View1   View2') && !text(keys.segments).includes('1 View1'));
  assert.ok(text(keys.segments).endsWith('PROD  shop-db'), 'the optional part went, the needed ones stayed');
  const one = at(40);
  assert.equal(one.compact, 'views');
  assert.ok(text(one.segments).startsWith('Trawl   View2') && text(one.segments).trimEnd().endsWith('PROD  shop-db'));
  assert.deepEqual(one.tabs.map((t) => t.id), ['v2'], 'the click map is the views shown');
  // Without compact, the context goes first, as it always did.
  assert.equal(topLine({ title: 'Trawl', views, view: 'v2', context, width: 80 }).compact, 'none');
  // Nothing marked: the views never give way, and the context drops from its end as it always did.
  const plain = topLine({ title: 'T', views, view: 'v1', context: [{ text: 'x'.repeat(30) }], width: 90, compact: true });
  assert.equal(plain.compact, 'none');
  // A needed part in the middle stays while the optional ones around it go, gaps and all.
  const middle = topLine({ title: 'T', views: views.slice(0, 1), view: 'v1', context: [{ text: 'plan -1 +5' }, { text: '  ' }, { text: '1 drifted', need: true }, { text: '  ' }, { text: 'infra' }], width: 30, compact: true });
  assert.ok(text(middle.segments).endsWith('1 drifted'), text(middle.segments));
});

test('faceColor colours the face on both lines', () => {
  assert.equal(topLine({ face: '(o)', faceColor: '#ffd75f', title: 'T', width: 20 }).segments[0].color, '#ffd75f');
  assert.equal(statusLine({ face: '(o)', faceColor: '#ffd75f', width: 20 })[0].bg, '#ffd75f');
});

test('statusLine while typing says only news, and at rest keeps room for minKeys keys', () => {
  const keys = 'enter run · tab complete · esc back';
  const resting = 'Glim the anglerfish here, down in ClubA on demo, and very happy about it all.';
  assert.ok(!text(statusLine({ face: '(o)', message: resting, keys, typing: true, width: 70 })).includes('Glim'));
  assert.ok(text(statusLine({ face: '(o)', message: 'Copied 3 lines', news: true, keys, typing: true, width: 70 })).includes('Copied 3 lines'));
  const crowded = text(statusLine({ face: '(o)', message: resting, keys, width: 70 }));
  assert.ok(!crowded.includes('enter run'), 'without minKeys the message takes the room');
  const kept = text(statusLine({ face: '(o)', message: resting, keys, minKeys: 2, width: 70 }));
  assert.ok(kept.includes('enter run  tab complete'), kept);
  assert.ok(kept.includes('Glim'), 'the message keeps what is left');
  // News isn't held back by minKeys.
  assert.ok(text(statusLine({ face: '(o)', message: resting, news: true, keys, minKeys: 2, width: 70 })).includes('very happy'));
});

test('paneRows is the rows a Panel gives its children in either look', () => {
  assert.equal(paneRows(10), 8);
  setLook('shell');
  assert.equal(paneRows(10), 9);
});
