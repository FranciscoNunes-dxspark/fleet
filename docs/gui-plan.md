# A GUI for the fleet: a plan

The apps are terminal apps on purpose: keyboard first, one binary each, at home over SSH and in Windows
Terminal. A GUI version should add what a window does better (real pixels for graphs and grids, native
notifications, drag and drop, many panes at once, no font quirks) without forking what each app knows.
This plan gets there in steps, each of which ships on its own.

## Where it stands

- **Phases 0 and 2, done another way.** `fleet gui` (apps/fleet/src/gui, apps/fleet/gui) runs every app as the
  terminal host does and draws each one's screen in the window as HTML, from a virtual terminal Fleet
  keeps per app: real fonts, CSS-drawn borders and pixel art, selectable text, the window's own rail,
  split, drawers and palette. That needed no change to any app and no second renderer for Ink, so phase 1
  (moving state out of the `App.jsx` components) is no longer in the way of a window; it's still worth
  doing for phase 3's richer views.
- **Fleet Desktop** (desktop/): Electron around `fleet gui`, with the fleet executable inside, released by
  hand (`release-desktop.yml`). Electron was the choice, as recommended below.
- **Phase 3, started.** The kit's `ui/GuiView.jsx` lets an app hand the window a region to draw natively;
  Sonar's KQL charts and Trawl's `/chart` are the first. Next candidates are the table below's.

## What we already have to build on

- **The domain code is already apart from the screens.** Each app's `src/*.js` (Splice's `git.js`,
  `graph.js`, `rebase.js`; Trawl's drivers; Sonar's `azure/`; Hail's `send.js`, `runner.js`) knows the
  work; `src/ui/*.jsx` draws it with Ink. Only `ui/` is terminal-bound.
- **Ink is React, and its layout is flexbox.** The views use a small part of Ink: `Box`, `Text`,
  `useInput`, `useStdin`, `useApp`, `render` (counted across `apps/*/src`: `useInput` 56, `Box` 31,
  `Text` 16). `Box`'s props are Yoga's, which map almost one to one onto CSS flexbox.
- **Ink already runs in a browser.** Keel's web app has "Below deck" (`apps/keel/client/src/cli`): the
  whole terminal app, Ink and all, bundled by Vite with shims for `process`, `fs`, streams and the
  clipboard, drawn into xterm.js, talking to the server's `/api`.
- **Commands are data.** Every app has `commands.js`, `help.js`, the kit's `palette.js`, `keymap.js` and
  `usercommands.js`: the same list could fill menus, a command palette and toolbar buttons.
- **The family protocol is already process to process.** Hand-offs (`family.js`), moods and activity
  (`~/.family`), and Fleet's control pipe (`hosted.js`) don't care what draws the apps.
- **The hard part is the state, not the drawing.** Each `ui/App.jsx` is 750 to 1800 lines (8,356 in
  all) of state, effects and one big `useInput`. That's what a second front end has to share, and
  where most of the work below goes.

## The shape we're aiming for

```
 ┌───────────── front ends ─────────────┐
 │ Terminal (Ink)   Window (DOM, React)  │   same React state, two renderers
 └──────────────┬───────────────────────┘
                │ useModel(): state + actions, no Ink
 ┌──────────────┴───────────────────────┐
 │ app core: src/*.js (git, SQL, Azure…) │   unchanged
 └──────────────┬───────────────────────┘
                │ Node: child processes, drivers, credentials
```

The GUI runs the apps' Node code in Node, as now, never in the page: git, database drivers, the OS
credential store and `az` stay where they work today, and secrets never reach the renderer.

## Runtime: Electron, with a browser mode for free

| | Electron | Tauri | Local server + browser |
| --- | --- | --- | --- |
| Runs the apps' Node code as is | yes, in the main or a utility process | no: Rust, with Node as a sidecar | yes |
| A real PTY (Wharf's shell, `!` commands) | node-pty | through the sidecar | node-pty |
| Native menus, tray, notifications, badges | yes | yes | browser notifications only |
| Size | ~100 MB | ~10 MB + Node | none |
| Updates | electron-updater from our GitHub releases | its updater | none needed |

**Pick Electron** for the desktop app. The apps are Node, and Electron runs them without a sidecar.
Build the front end as plain web code behind one message channel, so the same build also runs as
**`fleet gui`**, a local server opened in the browser: a `127.0.0.1` port with a random token in the URL,
as Jupyter does. It can later run behind Keel's server for a team. Tauri stays an option for later, if
the size matters more than the sidecar does.

## Phases

### Phase 0: Fleet Desktop, a window around the terminal (2 to 3 weeks)

An Electron window running `fleet` in xterm.js over node-pty, with WebGL rendering and a bundled
font. That fixes Windows' console glyphs and font choice for good, gives Wharf's shell a real PTY
inside Fleet, and adds:

- the bar's attention badges as the dock or taskbar badge and native notifications;
- a menu built from each app's `commands.js` (each item types the command into the app's prompt,
  as hand-offs already do);
- drag a `.http`, `.sql` or a folder onto the window to open it in Hail, Trawl or as the fleet's folder
  (`ctrl+] m`);
- `ctrl+]` stays, and `cmd/ctrl+1…8` switch spaces.

Nothing in the apps changes. This proves packaging, signing, updates and the release pipeline before
any app is redrawn.

### Phase 1: models apart from views (4 to 6 weeks, app by app)

Split each `ui/App.jsx` into:

- `src/model/` with `useModel()`: the state, effects and actions (`stage(path)`, `checkout(ref)`,
  `runQuery(sql)`), React hooks that import nothing from Ink;
- `ui/` (Ink): layout, plus a `useInput` that maps keys to model actions through `keymap.js`.

Keys become the terminal's binding of actions, not where the logic lives. That unlocks menus, buttons
and the GUI's own shortcuts. The work is behaviour-neutral and each app's tests stay green throughout;
it also makes the apps easier to test (models get unit tests without `ink-testing-library`). Start with
Wharf (764 lines, newest), then Bosun and Splice; Trawl (1,808) goes last.

### Phase 2: `@fleet/gui`, Ink's primitives in the DOM (3 to 4 weeks)

A package that exports `Box`, `Text`, `useInput`, `useApp`, `useStdin` and `render` with Ink's API,
drawing HTML:

- `Box` becomes a `div` with flexbox from the same props. Widths and heights in cells become `ch` and
  line-height units, so existing layouts keep their proportions; the borders (`round`, `single`) become CSS
  borders with the title in the top edge.
- `Text`: a `span` with `color`, `bold`, `dimColor`, `inverse` and `wrap` as CSS. The `theme.js` colours
  become CSS variables, with light and dark from the system.
- `useInput`: keyboard events turned into Ink's `(input, key)` shape. Mouse and selection are native,
  so `mouse.js` and `selection.js` step aside.

Aliased in at build time (Vite `resolve.alias: { ink: '@fleet/gui' }`), every app gets a first GUI at
once. It looks like the terminal app but renders crisply, with native scrolling, text selection and
resizable windows. The kit's parts (`HelpView`, `Palette`, `DataViewer`, `PromptBox`) get DOM versions
where cells don't fit.

### Phase 3: native views where pixels win (ongoing, one view at a time)

With models shared, replace views one by one where a GUI is clearly better, and keep the keys.

| App | View | GUI version |
| --- | --- | --- |
| Splice | Graph, diffs, rebase | SVG commit lanes; side-by-side diff with syntax highlighting and word changes; drag and drop to reorder in interactive rebase; staging lines with the mouse |
| Trawl | Results, plans, diagrams | A virtualised grid (100k rows) with inline editing and column resize; graphical query plans; ER diagrams you can pan |
| Sonar | Charts, incidents | Real time-series charts with zoom and brush; the incident write-up as rich Markdown |
| Hail | Responses | JSON tree, image and HTML previews, a side-by-side response diff for `/replay` |
| Bosun | Crew, replay | Log panes in a grid, all processes at once; CPU and memory graphs; a scrubbable replay timeline |
| Wharf | Containers, shells | A real terminal tab per shell (xterm.js); live stats |
| Keel | everything | Reuse the web app's pages (`apps/keel/client/src/pages`) directly |
| Locker | Drift | A keys × sources matrix with sticky headers and filters |
| Fleet | The host | Tabs or tiling for any number of apps; runbooks as a side panel; `/trace` as a swim-lane timeline |

### Phase 4: the fleet in one window

Fleet Desktop's spaces become GUI apps in tabs and split panes. A runbook side panel's steps run in
place, and one command palette (`ctrl+k`) searches every app's commands and recent things.
Hand-offs become drags: a commit onto Sonar, a log line onto Hail.

## How it's built and released

- **Layout.** New packages: `apps/desktop` (Electron main, preload, packaging) and `packages/gui` (the
  DOM renderer and the kit's GUI parts). Each app gets `src/model/`, and `gui/` only where it outgrows
  phase 2.
- **Process model.** One Electron utility process per app, like Fleet's children today: crash isolation
  and per-process `configureApp` stay as they are. The renderer talks to them over a `MessagePort`
  carrying model state patches and actions, the same channel `fleet gui` carries over a WebSocket.
- **Security.** `contextIsolation` on and `nodeIntegration` off; a preload that exposes only the
  message port; no secret ever in a model's state sent to the renderer (Locker sends masks and asks the
  main process to copy). `fleet gui` binds to loopback only, with a per-run token.
- **CI.** `changed.mjs` adds `desktop` when `apps/desktop`, `packages/gui` or any app changes;
  Playwright (`_electron`) end-to-end tests on Ubuntu and Windows; the phase 2 renderer gets visual
  snapshot tests against the Ink output of the same component.
- **Releases.** `release-desktop.yml` builds with electron-builder: `fleet-desktop-windows-x64-setup.exe`
  (signed), `.dmg` (notarized), `.AppImage` and `.deb`, tagged `fleet-desktop-v…` beside the rest, with
  electron-updater reading the same GitHub releases. Code-signing certificates are the one new cost.

## Risks, and what keeps them small

- **Two front ends to keep in step.** Phase 1's models make a feature mostly model work; a view in
  each front end is the small part. Rule: a new action goes into the model, its key into `keymap.js`,
  and its menu entry comes from `commands.js` for free.
- **Keyboard-first feel lost in a GUI.** Every action keeps its key; the GUI shows them in menus and
  tooltips; the help window stays.
- **Size and start-up time.** Electron is ~100 MB and starts in about a second. The terminal builds stay
  the light option, and nothing about them changes.
- **Big refactors of the App components.** Phase 1 goes one app at a time, behaviour-neutral, tests
  green at every commit, and it can stop after any app.

## Decisions needed before starting

1. Electron for the desktop, with `fleet gui` in the browser: agree, or prefer Tauri's size?
2. Is phase 2 (the terminal look in a window) worth shipping on its own, or go straight from phase 0
   to native views?
3. The first app to go native in phase 3: Splice (the most visual win) or Trawl (the most daily use)?
4. Code-signing certificates for Windows and an Apple developer account for macOS.
