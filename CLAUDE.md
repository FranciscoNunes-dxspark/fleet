# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Fleet is the family of keyboard-driven terminal apps in one repository: Splice (git), Trawl (SQL), Sonar (Azure), Bosun (a project's processes), Hail (HTTP), Keel (Azure DevOps: a web app, a terminal app and an Android app), Wharf (containers), Locker (secrets and configuration) and Mooring (files and commands on a server over SSH), the kit they share, and Fleet the host (`apps/fleet`), which runs them in one terminal. Each app keeps its own CLAUDE.md (read it before changing the app: it has the app's architecture, tests and rules) and README (the user-facing spec: when behaviour changes, update it too). This file is what holds across them.

## Layout

```
package.json            private root: npm workspaces ["packages/*", "apps/*"], Node >= 22, test scripts, postinstall
package-lock.json       the one lockfile
patches/                patch-package's patches, applied to the root node_modules on install (scripts/postinstall.js)
packages/kit/           @fleet/kit: the shared files and their tests
apps/<app>/             splice, trawl, sonar, bosun, hail, keel, wharf, locker, mooring: each its own package, depending on "@fleet/kit": "file:../../packages/kit"
apps/fleet/             the host (@fleet/host, binary fleet): the apps in one terminal, each its own process in hosted mode; fleet gui, the same in a window
desktop/                Fleet Desktop: an Electron window around fleet gui (not a workspace: see below)
.github/workflows/      test.yml, release.yml (+ release-app.yml), release-keel-android.yml, release-desktop.yml
.github/scripts/        changed.mjs: which apps a change touches
```

Plain JavaScript ES modules everywhere, `.jsx` for components; no TypeScript, no linter config, no build step for development. Every app runs on Node 22+ (Keel too). Dependencies are kept at the same versions in every package (ink 6.8.x, react 19.3.x, esbuild 0.28 through the kit); a dependency only one app uses stays in that app's package.json (Trawl's database drivers, Keel's web stack). The root's `overrides` lift a dependency of a dependency past a security advisory when its parent hasn't yet: `@azure/msal-node` ^7.1.1 under tedious's `@azure/identity` (which asks for ^6; Trawl never signs in through it, but the advisory flags the install). Drop an override once the parent asks for the fixed version itself.

## Commands

```bash
npm install                    # at the root: every package, linked; applies patches/
npm test                       # every package's suite, one after another
npm run test:<app>             # one app (test:kit for the kit), the same as npm test -w apps/<app>
npm start -w apps/<app>        # run an app from the checkout (or cd apps/<app> && npm start); needs a real TTY
cd apps/<app> && npm run build # its executable for this machine (Bun 1.4.2 via npx), the kit's scripts/build.js
```

Inside an app, its own CLAUDE.md lists the rest (one test file, a name pattern, its scripts). Tests that make git repositories need no git identity: CI has none, so run them with `GIT_CONFIG_GLOBAL` pointing at an empty file to be sure.

## The kit (`packages/kit`, `@fleet/kit`)

What the apps used to copy between them (and checked with a `shared-check.js` script) is one package now: `text.js`, `ui/parts.jsx`, `ui/hooks.js`, `ui/HelpView.jsx`, `ui/Palette.jsx`, `mouse.js`, `selection.js`, `search.js` (a viewer's search), `datatree.js` and `ui/DataViewer.jsx` (a JSON or CSV body or result set as a tree or table, with a path query: Hail's `d` and Trawl's `w`), `ui/GuiView.jsx` (a region drawn natively in Fleet's window, as text elsewhere: Sonar's and Trawl's charts), `clipboard.js` (also ctrl+v's paste where the terminal sends it on as a key), `glyphs.js` (in Windows' own console, characters its font lacks swapped for ones it has), `jsx-hooks.js` and `register.js` (the `.jsx` loader), `help-layout.js`, `keymap.js`, `usercommands.js`, `palette.js`, `run.js`, `credentials.js`, `claude-cli.js`, `family.js`, `folders.js` (an app's `/move`: the folder a name means, the ones beside it, the list it remembers; Bosun's, Locker's and Hail's), `update.js` (the updater), `theme.js` (the colour object the kit's parts draw with), `app.js` and `version.js`, `hosted.js` (hosted mode, below), `mcp.js` (an MCP server over stdio, hand-rolled: `trawl mcp` and `fleet mcp`), and `scripts/build.js` (the Bun build). Apps import them by path, `@fleet/kit/text.js`, each listed in the kit's package.json `exports`. Its tests are in `packages/kit/test` (`npm run test:kit`).

Rules:

- **No copies.** A shared file exists once, in the kit; an app never keeps its own version of one, and never imports another app's files (Fleet is the one exception: its `src/main.js` imports each app's cli to run it, and its `src/mcp/`, `fleet mcp`, reads each app's world through that app's own modules). What only one app needs lives in that app (Splice's `ui/diffstyle.js`, Keel's `cli/ui/wrap.js`). A change to a kit file changes every app: run every suite (`npm test`), and keep the kit's API backward compatible or change every caller in the same commit. Prefer an option with the old behaviour as its default (`Spinner`'s `hint`, `PromptBox`'s `bang`) to a fork.
- **The app's name.** A few things carry it: the credential store's entries (`Trawl:<name>`, service `Trawl`: changing it loses saved passwords), the version baked into a build (`TRAWL_VERSION`), the release files (`trawl-linux-x64`) and tags (`trawl-v1.2.3`), the update's work folder and messages. The kit learns it once: each app's `src/app.js` (Keel: `cli/app.js`) calls `configureApp({ name, title, version: process.env.<APP>_VERSION, packageUrl })` and exports `APP`, `VERSION` and `COMPILED`. The entry point (`cli.jsx`) imports it first, everything that wants the version imports it from there, and the test scripts preload it (`--import ./src/app.js`), so it has always run before the kit asks (`app()` throws if not). `version` must be written as that literal `process.env` expression: the build defines it. Each app's `test/names.test.js` checks its names.
- **Colours.** The kit's parts read `theme` from `@fleet/kit/theme.js`; each app's own `theme.js` fills that same object (`Object.assign(kitTheme, DARK, …)`) and exports it, so the app and the kit always draw with the same palette. Read colours while drawing, never copied at import.
- **The family.** `family.js` is the protocol between the apps (contexts, moods, activity): shared, and never edited for one app's convenience. Every app is in `FAMILY`, `ROLES`, `APP_NAMES` and `PET_NAMES`; a new kind of context goes in `CONTEXT_KINDS`, `TAKEN_BY` and `describeContext` together (`site`, an App Service app or slot, is Locker's). Nothing secret goes in a context, a mood or the activity log: Mooring logs which host a folder or file went to, never a command; Locker logs which secret it set or copied, never its value.
- **Hosted mode.** Fleet (`apps/fleet`) runs each app as a child process with pipes, not a terminal, and `FLEET_HOSTED=1`. Every app's cli must keep working there: it takes its streams from the kit's `appTerminal()` (`hosted.js`: process.stdin/stdout outside the host, made to look like a terminal inside it; either way ctrl+v pastes, and outside it Windows' own console gets `glyphs.js`'s characters) and gives them to its TTY check, `terminalMouse` and Ink's `render({ stdin, stdout })`, and turns its self-update off when `hosted` (Fleet updates as one). It draws full-screen on the alternate screen, as now, and writes nothing to the real terminal any other way. Hand-offs to a sibling go through `family.js` `copiedNote`, which tells the host. `apps/fleet/CLAUDE.md` has the protocol. Under `fleet gui` the apps are hosted the same way, with `FLEET_GUI=1` too: nothing changes for them, except that a `GuiView` (`hosted.js` `inWindow`) leaves its box blank and asks the window to draw it natively.

## Installing, and Keel on Hostinger

`npm install` (or `npm ci`) at the root installs every package into the root `node_modules`, with `@fleet/kit` linked, and `scripts/postinstall.js` applies `patches/` there (an install without dev dependencies has no patch-package and skips it). Run in an app's folder, npm still finds the root (`apps/*` is a workspace of it) and installs that app's dependencies into the root `node_modules` from the root lockfile. So Hostinger deploys Keel's web app from the repository's root, not `apps/keel` (a deploy of that folder alone has no `node_modules`, and Keel can't start), with the entry file `apps/keel/server/index.js`. It runs only `npm install`, with no build command to set, so `scripts/postinstall.js` also builds Keel's web app (`apps/keel/dist`) whenever it hasn't been built: every deploy there, which is a fresh clone, and a checkout's first install (`npm run build` at the root, which passes to Keel, refreshes it; the root's `start` does the same for `npm start`). A failed build there leaves the install standing, and Keel says "UI not built". Vite and what Keel's web app imports are Keel's `dependencies`, not dev ones, so an install without dev dependencies builds it too. There is no lockfile inside an app; the root's is the only one, so a change to any package.json means running `npm install` at the root and committing `package-lock.json`. Keel's own `postinstall` (`patch-package --patch-dir ../../patches || exit 0`) only matters when Ink lands in `apps/keel/node_modules`, and never fails an install.

`patches/ink+6.8.0.patch` keeps Ink's width and tokenize caches from one frame to the next rather than starting each frame empty, bounds its measure and wrap caches, measures text through `build/text-width.js` (printable ASCII and characters that never join, colour codes or not, without string-width), leaves a line inside a clip uncut, and turns a row into a string without diffing the styles of characters styled alike: a 160×50 frame of coloured rows goes from about 17 ms to 3. `packages/kit/test/ink-patch.test.js` checks Ink still draws what it did. Upgrading Ink means checking `build/output.js` still has `OutputCaches` and remaking the patch (`npx patch-package ink` at the root), or dropping it once Ink does this itself.

## CI

`.github/workflows/test.yml` runs on pull requests and pushes to main. `.github/scripts/changed.mjs` works out what a change touches from `git diff` against the base: an app's folder is that app (and Fleet, which is built from every app); `packages/kit`, `patches/`, the root `package.json`/`package-lock.json`, `.github/` and the root `scripts/` are the kit and every app; Markdown is nothing. Each of those runs on ubuntu-latest and windows-latest: `npm ci` at the root, then `npm test -w <workspace>`, and for Keel also `npm run build -w apps/keel` (the web app Hostinger builds). Apps a change leaves alone don't run, so keep a change to one app inside its folder. CI has no git identity, and paths and line endings must work on Windows too (`.gitattributes` forces LF).

## Releases

Every push to main (except Markdown-only ones) runs `release.yml`, which releases each app the change touched (the same rules as the tests, without `.github/` and `scripts/`: an app's folder, and Fleet with it, or all of them for the kit, `patches/` or the root package files). "Run workflow" releases one app, or `all`, by hand. Per app, in `release-app.yml`, one at a time per app (`concurrency: release-<app>`):

1. The version: the newest release in this repository whose tag starts `<app>-v`, with the patch raised, or the app's package.json version when that's higher (bump it there for a minor or major version). Nothing is committed back, so package.json on main lags behind the releases.
2. The app's tests on ubuntu.
3. The executables with Bun 1.4.2, from the app's folder (`bun ../../packages/kit/scripts/build.js <targets>`): the Windows one on windows-latest (only there does Bun embed the icon), Linux and macOS on ubuntu. The build reads the app's package.json (`version`, and an optional `"fleet"` section: Keel's `entry` is `cli/cli.jsx`, `app` `cli/app.js`, `out` `release`, and `compile` turns off Bun's .env and bunfig loading; Fleet's `includes` lists the apps built into it, whose versions are defined too, each from its own package.json) and names the files `<app>-windows-x64.exe`, `<app>-linux-x64`, `-linux-arm64`, `<app>-macos-x64`, `-macos-arm64` (`buildTargets` in the kit's `update.js`, which the updater uses too).
4. `gh release create <app>-v<version>` with the files (Fleet's also `fleet-windows-x64-setup.exe`, its Windows installer: `apps/fleet/installer`, and `fleet.ico`, its shortcuts' icon, which an updating Fleet replaces beside itself) and `SHA256SUMS.txt`, its notes starting from the app's previous release.

Fleet Desktop is released by hand too (`release-desktop.yml`, `fleet-desktop-v…`, not marked latest), with the fleet executable built inside it. `desktop/` is outside the workspaces on purpose: Electron's download would weigh down every `npm ci` (CI, Hostinger), so it pins its two tools (electron, electron-builder) in its own package.json and installs them with `--no-package-lock` only there; it has no lockfile and no tests in CI. Its tags start `fleet-desktop-v`, which Fleet's updater (`fleet-v…`) never takes.

Keel's Android app is released by hand (`release-keel-android.yml`) as `keel-android-v<run number + 100>`, not marked latest.

The apps update themselves from these releases (the kit's `update.js`, only in compiled builds): once a day they list `GET /repos/FranciscoNunes-dxspark/fleet/releases?per_page=100` (through `gh api` when that fails, as the repository is private), take the newest release whose tag starts `<app>-v` that isn't a draft or a pre-release, download `releases/download/<app>-v<version>/<file>` next to the executable and check it against `SHA256SUMS.txt` before swapping it in. GitHub's own "latest release" means nothing here: it is whichever app released last.

## Conventions

- Commit messages are short sentences describing the change, without type prefixes; one commit per logical change.
- Comments explain why and read as plain sentences; match the surrounding density.
- Adding or changing a key or command: the handler, the app's `commands.js`, its `help.js`, and its README's tables (each app's CLAUDE.md says where).
- Keel's web app has English and European Portuguese (`t()`, `locales/pt/`); its terminal app is English only.
