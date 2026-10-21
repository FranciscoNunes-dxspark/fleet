// Clicks and the wheel in the terminal app, driven through the real UI on demo data with a stand-in
// for the terminal's mouse (mouse.js's terminalMouse()).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'keel-cli-mouse-'));
process.env.AZDO_MOCK = '1';
process.env.DATA_DIR = dataDir;

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { openKeel } = await import('../cli/service.js');
const { App } = await import('../cli/ui/App.jsx');

let keel;
before(() => {
  keel = openKeel();
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

let lastApp = null;
const frame = () => lastApp.lastFrame() ?? '';
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${frame()}`);
}

/** terminalMouse() without a terminal: records `enable` and sends made-up events. */
function fakeMouse() {
  const listeners = new Set();
  const send = (e) => listeners.forEach((fn) => fn({ button: 'left', release: false, drag: false, shift: false, ...e }));
  return {
    enabled: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enable(on) {
      this.enabled.push(on);
    },
    click: (x, y) => send({ x, y }),
    wheel: (x, y, wheel) => send({ x, y, button: 'wheel', wheel }),
    copy: (text) => listeners.forEach((fn) => fn({ type: 'copy', text })),
  };
}

// Where the frame shows `text`: { x, y } of its first character. What's drawn before these labels is
// one column a character, so a string index is a column.
const at = (text) => {
  const lines = frame().split('\n');
  const y = lines.findIndex((l) => l.includes(text));
  assert.ok(y >= 0, `"${text}" isn't on screen:\n${frame()}`);
  return { x: lines[y].indexOf(text), y };
};
// The list row showing `text`: the list's half of each line, not the pane beside it, which may name the same thing.
const rowOf = (text) => frame().split('\n').map((l) => l.split('││')[0]).find((l) => l.includes(text) && !l.includes('╭')) ?? '';

function start() {
  const mouse = fakeMouse();
  lastApp = render(React.createElement(App, { keel, poll: false, openUrl: () => {}, mouse }));
  lastApp.mouse = mouse;
  return lastApp;
}

test('a click on a tab opens it; a click on a row picks it, a double-click opens it as ↵ does', async () => {
  const { mouse } = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  assert.deepEqual(mouse.enabled, [true], 'the mouse is on unless Settings turned it off');

  // The tab's label goes short when the row of tabs doesn't fit.
  const tab = at(frame().includes('2 Pull requests') ? '2 Pull requests' : '2 PRs');
  mouse.click(tab.x + 2, tab.y);
  await until(() => frame().includes('Waiting on your review'), 'the Pull requests tab');

  // The second pull request in the list: a click puts the cursor on it.
  const rows = frame().split('\n').filter((l) => /│[ ❯] [^ ] !\d+/.test(l));
  const second = rows[1].match(/!(\d+)/)[1];
  const p = at(`!${second} `);
  mouse.click(p.x, p.y);
  await until(() => rowOf(`!${second} `).includes('❯'), 'the cursor on the clicked row');

  // A double-click: what ↵ does, the pull request in full.
  mouse.click(p.x, p.y);
  mouse.click(p.x, p.y);
  await until(() => frame().includes('esc close') && frame().includes(`!${second} `), 'the pull request in full');
  lastApp.unmount();
});

test('the wheel scrolls a list and the viewer, leaving the cursor where it was', async () => {
  const { mouse } = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  const first = at('Implement refund endpoint');
  mouse.wheel(first.x, first.y, 1);
  // The list scrolls; the pane beside it still shows the item under the cursor.
  await until(() => !frame().includes('PR       Implement refund endpoint'), 'the list to scroll past the first rows');
  assert.match(frame(), /Commerce \/ storefront-web · !817/);
  // A key moves the cursor again, and the list follows it back.
  lastApp.stdin.write('j');
  lastApp.stdin.write('k');
  await until(() => rowOf('PR       Implement refund endpoint').includes('❯'), 'the cursor back in view');

  lastApp.stdin.write('?');
  await until(() => frame().includes('Keyboard shortcuts') && frame().includes('❯ Inbox'), 'the help');
  // Over the sections the wheel moves through them, and a click picks one.
  const list = at('Anywhere');
  mouse.wheel(list.x, list.y, 1);
  await until(() => frame().includes('❯ Pull requests'), 'the next section');
  const mouseRow = at('Mouse');
  mouse.click(mouseRow.x, mouseRow.y);
  await until(() => frame().includes('❯ Mouse') && frame().includes('Select text on screen'), 'the Mouse section');
  lastApp.unmount();
});

test('a click on the prompt types there; a selection copied says so in the bottom line', async () => {
  const { mouse } = start();
  await until(() => frame().includes('Implement refund endpoint'), 'the Inbox');
  const prompt = at('Press / for commands');
  mouse.click(prompt.x, prompt.y);
  await until(() => frame().includes('enter run'), 'the prompt focused');
  lastApp.stdin.write('/hel');
  await until(() => frame().includes('/help'), 'the suggestion');
  lastApp.stdin.write('\x1b');
  mouse.copy('one\ntwo\nthree');
  await until(() => frame().includes('Copied 3 lines'), 'the copy said');
  lastApp.unmount();
});
