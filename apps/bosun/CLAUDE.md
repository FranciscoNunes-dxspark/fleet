# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Runs a project's processes for you in the terminal, each with its own log, port and health. Bosun is a keyboard-driven terminal app built with Ink (React for the terminal) on Node 22+. It was started from slipway, and it's a sibling of Splice (a git client) and Trawl (a SQL client). Plain JavaScript ES modules with `.jsx` for components; no TypeScript, no linter config. The README is the user-facing spec; when behaviour changes, update it too.

The shared kit, `scripts/shared-check.js`'s `SHARED` list (`text.js`, `ui/parts.jsx`, `ui/hooks.js`, `mouse.js`, `selection.js`, `clipboard.js`, `jsx-hooks.js`, `register.js`, `version.js`, `help-layout.js`, `ui/HelpView.jsx`, `keymap.js`, `usercommands.js`, `palette.js`, `ui/Palette.jsx`, `run.js`, `credentials.js`, `claude-cli.js`, `scripts/build.js` and itself), is the same as Splice's and Trawl's apart from the apps' names. `node scripts/shared-check.js ../splice [--diff]` reports drift and exits with 1 on it. Keep them the same: a change to one goes into the siblings too, and anything only Bosun needs lives in its own file.

## Commands

```bash
npm test                                                       # whole suite (node:test)
node --import ./src/register.js --test test/units.test.js      # one file
node --import ./src/register.js --test --test-name-pattern="settings" test/*.test.js   # tests matching a name
npm start                                                      # run from the checkout (needs a real TTY)
npm run build                                                  # Bun-compiled executable for this machine → dist/
node scripts/logo.js                                           # regenerate assets/ from src/pet.js
node scripts/shared-check.js ../splice [--diff]                # drift in the files shared with a sibling app
```

`--import ./src/register.js` is required whenever Node loads `.jsx`: it installs a module hook (`src/jsx-hooks.js`) that compiles `.jsx` with esbuild on import. There is no dev build step. CI runs `npm test` on Linux and Windows, so path handling and line endings must work on both (`.gitattributes` forces LF).

`patches/ink+6.8.0.patch` (applied by `patch-package` on `npm install`) keeps Ink's width and tokenize caches from one frame to the next, as in the siblings; it about halves the cost of a keystroke. Upgrading Ink means checking `build/output.js` still has `OutputCaches` and remaking the patch (`npx patch-package ink`).

Releases are automatic: every push to main (except Markdown-only ones) runs the Release workflow, which publishes the latest release's version with the patch raised, or `package.json`'s version when that's higher. Compiled builds get the version via `process.env.BOSUN_VERSION` (defined by `scripts/build.js`), which also sets `COMPILED`; from a checkout `src/version.js` reads `package.json`, and the update check is skipped.

## Architecture

- **`src/crew.js`**: what to run, pure apart from reading files. `loadCrew(dir)` reads `bosun.json` (`readSpec` checks it, saying what's wrong in `problems`), else package.json's `dev` (or `start`) script, split into processes when it's a `concurrently` line (`splitConcurrently`), with `dev:*` scripts that split the same way as profiles. `withProfile` applies one. `readEnvFiles` reads the `envFile`s into each process's `fileEnv` (parsed by `src/dotenv.js`, pure), which the supervisor puts between the terminal's settings and `env`; App's `/reload` restarts a process whose `fileEnv` changed. Also the log-line rules: `stripAnsi`, `isTrouble`, `portInUse`. `App` takes `loadCrew` as the `load` prop.
- **`src/supervisor.js`**: running the crew. `Supervisor` starts each process through the shell in its own process group (detached off Windows), keeps its last 3000 lines, and stops the whole tree (the group off Windows, `taskkill /T` on it), forcing it after a grace period. Objects change in place and `onChange` says so; `App` redraws at most every 80 ms. `startAll` honours `after`. A process that ends by itself is restarted as its `restart` says (`afterExit`, pure: the backoff and giving up, `RESTART_TIMES`, which App's `restartTimes` prop shortens in tests); a stop, `stop`, `setCrew` dropping it and `killAllNow` clear its timer, and nothing restarts once the supervisor is closed. `onEvent` tells App when one ended by itself. `checkPorts` (every 2 s from `App`) connects to each port and fetches the `health` page. Every supervisor registers itself, so `cli.jsx`'s `exit` handler (`killEverything`) stops everything however Bosun ends; keep it that way for anything new that starts a process that keeps running. `pidsOnPort` (lsof, netstat) and `killPids` are `/free`'s, given to `App` as props so tests stub them.
- **`src/projects.js`**: which project Bosun runs, pure apart from looking at folders. `startFolder` (cli.jsx): the folder given, else the current one when it has a crew, else the last project in the config's `projects` (newest first, `remember` keeps eight; App adds one each time a crew with processes is read). `/move` (`actions.js` `move`) resolves a path or a folder beside the project (`resolveFolder`), offers `choices` without one, asks before stopping running processes, then App's `moveTo` stops and disposes the supervisor and reads the new folder as on opening. The project is `dirRef` in App (`ctx.dir` is a getter for it), shown in the header and the window title.
- **`src/run.js`**: where one-off programs are started (`!`); the crew's long-running ones are the supervisor's. Nothing it starts has a terminal, so nothing may wait on a prompt; an abort kills the whole tree (`taskkill /T` on Windows).
- **`src/actions.js`**: every user-facing operation, written once. Keys and slash commands call these with `ctx`. Questions before anything destructive live here (`ctx.confirm({ ..., danger: true })`).
- **`src/commands.js`**: the slash-command table (`name`, `args`, `desc`, optional `complete`, `run(ctx, rest)`) and completion. Args in `[brackets]` are optional, so picking the command runs it at once.
- **`src/ui/App.jsx`**: layout, focus, the prompt, overlays, the activity log and **`ctx`**: a stable object exposing `data` and `config` (getters), `task` (a visible, cancellable job with the spinner), `note`, `confirm`, `askSecret` / `askText` (a masked or plain field in the confirm's place), `prefill`, `showText` (text, or coloured `lines`), `showPicker`, `copy`, `setConfig`. A view that takes keys the app would otherwise use (a search being typed) sets `ctx.claimsKey(input, key)`, and clears it when it unmounts. Read the `Object.assign(ctx, {...})` block before adding an action.
- **Claude** (`w`, `/why`): `actions.js` `why` sends a process's last 400 lines through `claude-cli.js` `ask` with read-only `Read`, `Grep`, `Glob`, in the project's folder. `App` takes `ask` as the `askClaude` prop; tests stub it, as they do `openUrl` (the browser, from `cli.jsx`).
- **`src/ui/*View.jsx`**: one component per tab: Crew (`CrewView.jsx`: the list, and beside it the log of the one under the cursor or, with `a`, all of them merged by time) and Log. Views must check `ctx.viewHasKeys()` (or `ctx.overlayHasKeys()` in overlays) at the start of their `useInput` handlers. `useListNav` in `src/ui/hooks.js` is the shared cursor and scroll logic.
- **Mouse** (`src/mouse.js`, `src/selection.js`; Splice's `docs/mouse.md` has the design): `terminalMouse` strips mouse reports out of stdin before Ink sees them and hands them to `App` as the `mouse` prop; tests pass a fake (`test/clicks.test.js`). Components register with `useMouse(ctx, handler)`; a view's rows start one line under its panel's top border. Views name their `useInput` handler `keys` so a double-click can call `keys('', { return: true })`.
- **Updates** (`src/update.js`): once a day, GitHub's releases API, then `gh api` while the repository is private. A newer release is installed in the background next to the executable, checked against `SHA256SUMS.txt`. Release file names must match `TARGETS` in `scripts/build.js`. `cli.jsx` passes `checkUpdate` and `installUpdate` only in compiled builds.
- **Config** (`src/config.js`): `~/.bosun/config.json`, overridable with `BOSUN_HOME` (tests use it). Change it only through `ctx.setConfig`: `App` saves its whole copy. A new setting is a row in `src/settings.js` plus the README's Settings section.
- **Theme and text**: one palette in `src/theme.js`; use `BULLET` instead of `⏺`, and `src/text.js` (`fit`, `wrap`, `stringWidth`) for width-aware truncation, never `.length`.
- **Squawk** (`src/pet.js`, `src/ui/Pet.jsx`): the mascot's pixel art and mood. `assets/` is generated from it by `scripts/logo.js`; don't hand-edit those files.

## Tests

`test/app.test.js` and `test/clicks.test.js` are end-to-end: they render `<App>` with `ink-testing-library`, type keys into stdin and assert on `lastFrame()`. `test/helpers.js` `start` gives App a quiet crew that never starts unless a test passes `dir` (a folder from `project(spec, files)`, whose processes are small node scripts) or `load`. `test/crew.test.js` covers crew.js and the supervisor with real processes, including that a stopped process lets go of its port. Use `until(check, what)` from `test/helpers.js` to wait for frames rather than fixed sleeps. `test/units.test.js` covers the pure modules.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` window's sections in `src/help.js`, and the tables in `README.md`. Commit messages are short sentences describing the change, without type prefixes.
