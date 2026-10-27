// The kit's GuiView: its children everywhere but Fleet's window, and where its box is on the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { GuiView, rectOf } from '../ui/GuiView.jsx';
import { inWindow, showInWindow } from '../hosted.js';

test('outside the window GuiView draws its children, and tells no one', () => {
  assert.equal(inWindow({ FLEET_GUI: '1' }), false, 'not hosted: no window');
  assert.equal(showInWindow({ key: 'k', kind: 'chart' }), false);
  const app = render(React.createElement(GuiView, { kind: 'chart', data: { type: 'bars' }, width: 10, height: 1 }, React.createElement(Text, null, 'the text')));
  assert.equal(app.lastFrame(), 'the text');
  app.unmount();
});

test("rectOf adds up Yoga's layout from the box to the root", () => {
  let node;
  const Probe = () => {
    const ref = React.useRef(null);
    React.useEffect(() => {
      node = ref.current;
    });
    return React.createElement(Box, { flexDirection: 'column', width: 30 }, React.createElement(Text, null, 'a'), React.createElement(Box, { marginLeft: 3 }, React.createElement(Box, { ref, width: 7, height: 2 }, React.createElement(Text, null, 'x'))));
  };
  const app = render(React.createElement(Probe));
  assert.deepEqual(rectOf(node), { x: 3, y: 1, width: 7, height: 2 });
  assert.equal(rectOf(null), null);
  app.unmount();
});
