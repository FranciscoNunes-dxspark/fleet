// The shared parts (src/ui/parts.jsx), drawn on their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { Lines, Panel } from '../ui/parts.jsx';

const draw = (props) => {
  const app = render(React.createElement(Box, { flexDirection: 'column', width: 20 }, React.createElement(Lines, { width: 20, ...props })));
  const out = app.lastFrame().split('\n').map((l) => l.trimEnd());
  app.unmount();
  return out;
};

test('Lines draws the rows from offset, from an array or a getter asked for those rows only', () => {
  const all = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
  assert.deepEqual(draw({ lines: all, height: 3, offset: 10 }), ['line 10', 'line 11', 'line 12']);
  const asked = [];
  const get = (i) => (asked.push(i), [{ text: `line ${i}` }]);
  assert.deepEqual(draw({ lines: get, count: all.length, height: 3, offset: 10 }), ['line 10', 'line 11', 'line 12']);
  assert.deepEqual(asked, [10, 11, 12]);
  asked.length = 0;
  assert.deepEqual(draw({ lines: get, count: 12, height: 3, offset: 10 }), ['line 10', 'line 11'], 'no further than count');
  assert.deepEqual(asked, [10, 11]);
  assert.deepEqual(draw({ lines: ['a', [{ text: 'b' }]], height: 5 }), ['a', 'b']);
});

test('Panel cuts a hint too long for its top border to the parts that fit, never past the corner', () => {
  const top = (width, hint, title = 'Blame f.txt') => {
    const app = render(React.createElement(Panel, { title, hint, width, height: 3 }, null));
    const line = app.lastFrame().split('\n')[0];
    app.unmount();
    return line;
  };
  const hint = '2 selected · ↵ diff · alt+h history · v/alt+l lines’ history · e why · alt+f PRs · esc close';
  assert.equal(top(120, hint), `╭─ Blame f.txt ${'─'.repeat(120 - 4 - 13 - hint.length - 2)} ${hint} ─╮`);
  assert.equal(top(60, hint), '╭─ Blame f.txt ── 2 selected · ↵ diff · alt+h history · … ─╮');
  assert.equal(top(40, hint), '╭─ Blame f.txt ─────── 2 selected · … ─╮');
  // Room for not even one part: the first, cut; for not even that, nothing.
  assert.equal(top(28, hint), '╭─ Blame f.txt  2 select… ─╮');
  assert.equal(top(22, hint), '╭─ Blame f.txt ──────╮');
});
