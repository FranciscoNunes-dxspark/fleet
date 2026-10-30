# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

What a project depends on, in the terminal: the packages in a folder's npm and NuGet lock files, the advisories OSV knows against them, their licences, how far behind they are, a fix for each, and an SBOM; and `bilge audit` for a pipeline. Bilge is a keyboard-driven terminal app built with Ink (React for the terminal) on Node 22+, a sibling of Splice, Trawl, Sonar, Bosun, Hail, Keel, Wharf, Locker and Mooring. Plain JavaScript ES modules with `.jsx` for components; no TypeScript, no linter config. The README is the user-facing spec; when behaviour changes, update it too.

It lives in the fleet repository, in `apps/bilge`, and is built on the fleet's shared kit, `@fleet/kit` (`packages/kit`; the root CLAUDE.md has its rules). Import the kit's files as `@fleet/kit/<file>`; Bilge keeps no copy of any of them, and a change to one is a change to every app, so run every app's tests (`npm test` at the root). `src/app.js` tells the kit which app this is (`configureApp`: the name `bilge`, the title `Bilge`, the version a build bakes in); import `VERSION` and `COMPILED` from it. `src/theme.js` fills the kit's `theme` object with Bilge's palette (green).

## Commands

```bash
npm install                                                    # once, at the repository root: every app and the kit
npm test                                                       # whole suite (node:test), here; npm run test:bilge at the root
node --import @fleet/kit/register.js --import ./src/app.js --test test/lockfiles.test.js   # one file
node --import @fleet/kit/register.js --import ./src/app.js --test --test-name-pattern="fix" test/*.test.js   # tests matching a name
npm start                                                      # run from the checkout on this folder (needs a real TTY)
npm run demo                                                   # run against the in-memory demo project (needs a real TTY)
node bin/bilge.js audit --demo                                 # the headless audit, on the demo
npm run build                                                  # Bun-compiled executable for this machine → dist/ (the kit's scripts/build.js)
node scripts/logo.js                                           # regenerate assets/ from src/pet.js
```

`--import @fleet/kit/register.js` is required whenever Node loads `.jsx`. The tests also preload `--import ./src/app.js`, so the kit knows the app before any test file loads. CI runs Bilge's tests on Linux and Windows whenever `apps/bilge` or the kit changes, so paths must work on both (a manifest's `path` is always `/`-separated). Nothing in the suite reaches the network or runs npm or dotnet.

Releases are automatic, as every app's: a push to main that changes `apps/bilge` (or the kit, `patches/` or the root package files) releases it as `bilge-v<version>` (root CLAUDE.md, "Releases"). Compiled builds get the version via `process.env.BILGE_VERSION`.

## Architecture

- **The provider** (`src/provider.js`): everything Bilge reads and does goes through one object, `createBilge({ fetchImpl, run })`: `scan(dir)`, `audit(packages)` → `{ ids, details }`, `latest(packages, { onProgress })`, `run(command, { cwd })`, `writeFile`. `src/demo.js` `demoBilge()` has the same interface for `--demo` and the tests (`state.calls`, `state.written`; a fix's command moves its package on); a new operation needs both, and its test.
- **Lock files** (`src/lockfiles.js`): the parsers (`parseNpmLock`, `parseNugetLock`, `parseProject`, `parseCentralVersions`) take text and are pure; `findManifests` and `scanFolder` read the disk. A package is `{ ecosystem: 'npm'|'NuGet', name, version, direct, dev, license?, key, where: [{ path, line }] }`, merged across manifests by `key` (`keyOf`: NuGet names lower-cased). Only exact versions are kept; npm's aliases, git and file dependencies, and a project's ranges are left out.
- **OSV and the registries** (`src/osv.js`, `src/registry.js`): `/v1/querybatch` a thousand packages a call (with a package's further pages), then `/v1/vulns/<id>` eight at a time, kept for the session; npm's `/<name>/latest`, NuGet's flat container and `.nuspec` for the licence. `getJson` turns a failure into a sentence ("Couldn't reach api.osv.dev: ENOTFOUND", "OSV answered 503"); a cancelled one has `cancelled`. Node's fetch, nothing else: the Bun build must keep working.
- **The audit** (`src/audit.js`, `src/versions.js`, pure): `severityOf` (GitHub's `database_specific.severity`, else `cvss3Score` of the CVSS 3 vector), `fixedIn` (the end of the range the version is in), `findings` (one per vulnerable package, worst first), `licenceKind`, `denied`; `compareVersions` handles npm's and NuGet's versions alike. `rows.js` `withoutIgnored` takes out what the config ignores; App works the shown findings out again only when the audit, the packages or `ignore` change (`derive`), and `ctx.found` / `ctx.counts` read them.
- **Fixes** (`src/fix.js`, pure): `fixPlan(finding, manifest)` → `{ run: { command, cwd }, text }` or `{ text }`. **Everything put in a command line is checked by `safe()`** (a registry's name and version) or the plain-file rule: keep that for any new command.
- **`src/actions.js`**: every user-facing operation, written once; keys and slash commands call these with `ctx`. The questions before running a fix or replacing an SBOM live here.
- **`src/commands.js`**, **`src/help.js`**: the slash-command table and completion; the `?` window's sections. **`src/headless.js`**: `bilge audit` and `bilge sbom` (`runHeadless(args, { provider, config, write })` resolves the exit code), which `cli.jsx` runs before asking for a terminal.
- **`src/ui/App.jsx`**: layout, focus, the prompt, overlays, the activity lines and **`ctx`** (read the `Object.assign(ctx, {...})` block before adding an action): `provider`, `data` (`{ root, manifests, packages, audit: { ids, details, at } | null, latest: Map | null }`), `found`, `counts` and `config` (getters), `cwd()`, `moveTo`, `setData`, `task` (a visible, cancellable job with the spinner; `progress(text)` beside it; `activity` goes to the family's log), `note`, `confirm`, `copy`, `showText`, `showPackages({ filter, manifest })`. It reads the folder on opening; nothing polls.
- **`src/ui/*View.jsx`**: Vulnerabilities, Packages, Manifests, Log. Views must check `ctx.viewHasKeys()` at the start of their `useInput` handlers; `useListNav` from the kit is the cursor. `Viewer.jsx` shows text over the view, with the kit's search.
- **The family** (`@fleet/kit/family.js`, shared and never edited here; `src/share.js`, `src/moods.js`, pure): Bilge is in `FAMILY` (role `DEPS`, Nibs). `t` hands Splice a `file` context (a package's manifest and line, or a manifest). It takes no context (`/take` says whose one is). Fixes (`task`'s `activity`) and audits go to the activity log with the folder; Nibs's mood to `writeMood`; tests point `FAMILY_HOME` at a temp folder (`tempHome`).
- **Config** (`src/config.js`): `~/.bilge/config.json`, overridable with `BILGE_HOME`. Change it only through `ctx.setConfig`.
- **Updates, hosted mode, mouse, theme and text**: as Wharf's (its CLAUDE.md): `appTerminal()` in `cli.jsx`, the update only in compiled builds and never hosted, `useMouse` in views, colours read from `theme` while drawing, `@fleet/kit/text.js` for widths.
- **Nibs** (`src/pet.js`, `src/ui/Pet.jsx`): the rat's pixel art and mood. `assets/` is generated from it by `scripts/logo.js`; don't hand-edit those files.

## Tests

`test/app.test.js` and `test/family.test.js` are end-to-end: `<App>` over `demoBilge()` with `ink-testing-library`, typing keys and asserting on `lastFrame()` and `provider.state`. `test/lockfiles.test.js` covers the parsers and a folder on disk; `test/audit.test.js` scores, fixes, findings, licences, versions and the Packages lists; `test/osv.test.js` OSV and the registries through `fakeFetch` (`test/helpers.js`); `test/fix.test.js` fixes, the SBOM, the report and `bilge audit`. Use `until(check, what)` to wait for frames rather than fixed sleeps.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` window's sections in `src/help.js`, the footer `HINTS` in `App.jsx`, and the tables in `README.md`. Commit messages are short sentences describing the change, without type prefixes.
