// The window in a real browser: the page over the server and a session of fake apps, driven with
// Playwright's Chromium, when this machine has it (the development containers do; CI doesn't install
// it, and there the test is skipped). Keys typed into the page reach the app, the screen is drawn from
// its frames, two apps go side by side, and an exited app starts again from its pane.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GuiSession } from '../src/gui/session.js';
import { guiServer, loadClient } from '../src/gui/server.js';
import { appSpawner } from '../src/launch.js';
import { FAKE, quietEnv } from './helpers.js';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  // No Playwright here: the test says so and is skipped.
}

const SPACES = [
  { id: 'one', title: 'One', letter: 'o', accent: '#5fd787' },
  { id: 'two', title: 'Two', letter: 'w', accent: '#5fafff' },
];

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

test('the window: keys in, the screen drawn, side by side, and an exited app started again', { skip: !chromium && 'Playwright is not installed here' }, async () => {
  const family = mkdtempSync(join(tmpdir(), 'fleet-gui-browser-'));
  const session = new GuiSession({ spawn: appSpawner({ env: quietEnv({ FLEET_GUI: '1' }), command: (id, args) => [process.execPath, [FAKE, id, ...args]] }), spaces: SPACES, familyHome: family });
  const server = guiServer(session, { files: await loadClient() });
  const url = await server.listen(0);
  const browser = await chromium.launch();
  cleanups.push(async () => {
    await browser.close();
    session.stop();
    for (const s of session.spaces) s.child?.kill(true);
    await server.close();
    rmSync(family, { recursive: true, force: true });
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  // The first app is shown and draws at its pane's size.
  const pane = (id) => page.locator(`.pane:has(header b:text-is("${id}"))`);
  await page.waitForFunction(() => /^one \d+x\d+$/.test(document.querySelector('.pane .row')?.textContent ?? ''));
  assert.equal(await page.locator('.space').count(), 2);
  assert.match(await page.locator('.space.on').innerText(), /One/);
  await page.waitForFunction(() => document.activeElement?.id === 'keys');
  await page.keyboard.type('hey');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane .row')].some((r) => r.textContent === 'keys: "hey"'));
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane .row')].some((r) => r.textContent.includes('\\u001b[A')));

  // A native view the app asks for is drawn under its text, with a read-out under the pointer.
  await page.keyboard.type('G');
  await page.locator('.view svg rect[data-i="1"]').waitFor();
  const bar = await page.locator('.view svg rect[data-i="1"]').boundingBox();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + 2);
  await page.waitForFunction(() => !document.querySelector('.tip').hidden && /5/.test(document.querySelector('.tip').textContent));
  await page.keyboard.type('g');
  await page.locator('.view').waitFor({ state: 'detached' });

  // ctrl+] | puts the other app beside it, at half the width each.
  await page.keyboard.press('Control+]');
  await page.keyboard.press('|');
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 2);
  // Each app redraws at its half once the window has measured its pane and told it.
  await page.waitForFunction(() => {
    const widths = [...document.querySelectorAll('.pane')].map((p) => Number(/^\w+ (\d+)x\d+$/.exec(p.querySelector('.row')?.textContent ?? '')?.[1]));
    return widths.length === 2 && widths.every(Boolean) && Math.abs(widths[0] - widths[1]) <= 2;
  });
  await pane('Two').locator('.screen').click();
  await page.waitForFunction(() => document.querySelector('.pane.active header b')?.textContent === 'Two');
  await page.keyboard.type('x');
  await page.waitForFunction(() => [...document.querySelectorAll('.pane.active .row')].some((r) => r.textContent === 'keys: "x"'));

  // An app that exits says so in its pane, and the button starts it again.
  await page.keyboard.type('X');
  await pane('Two').locator('.cover button').waitFor();
  assert.match(await pane('Two').locator('.cover h2').innerText(), /Two exited with 3/);
  await pane('Two').locator('.cover button').click();
  await pane('Two').locator('.cover').waitFor({ state: 'detached' });
  await page.waitForFunction(() => [...document.querySelectorAll('.pane.active .row')].some((r) => r.textContent === 'keys: ""'));

  // The palette finds a command and runs it: one app on screen again.
  await page.keyboard.press('Control+Shift+P');
  await page.locator('#modal input').fill('one app');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.pane').length === 1);
  assert.deepEqual(errors, []);
});
