# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Infrastructure as code in the terminal: what a Terraform (or OpenTofu) plan or an Azure what-if of a Bicep or ARM file would change, resource by resource and attribute by attribute, what drifted, what the state holds; and `chart check` for a pipeline. It only plans: nothing in it applies. Chart is a keyboard-driven terminal app built with Ink (React for the terminal) on Node 22+, a sibling of Splice, Trawl, Sonar, Bosun, Hail, Keel, Wharf, Locker, Mooring and Bilge. Plain JavaScript ES modules with `.jsx` for components; no TypeScript, no linter config. The README is the user-facing spec; when behaviour changes, update it too.

It lives in the fleet repository, in `apps/chart`, and is built on the fleet's shared kit, `@fleet/kit` (`packages/kit`; the root CLAUDE.md has its rules). Import the kit's files as `@fleet/kit/<file>`; Chart keeps no copy of any of them, and a change to one is a change to every app, so run every app's tests (`npm test` at the root). `src/app.js` tells the kit which app this is (`configureApp`: the name `chart`, the title `Chart`, the version a build bakes in); import `VERSION` and `COMPILED` from it. `src/theme.js` fills the kit's `theme` object with Chart's palette (indigo).

## Commands

```bash
npm install                                                    # once, at the repository root: every app and the kit
npm test                                                       # whole suite (node:test), here; npm run test:chart at the root
node --import @fleet/kit/register.js --import ./src/app.js --test test/plan.test.js        # one file
node --import @fleet/kit/register.js --import ./src/app.js --test --test-name-pattern="what-if" test/*.test.js   # tests matching a name
npm start                                                      # run from the checkout on this folder (needs a real TTY)
npm run demo                                                   # run against the in-memory demo infrastructure (needs a real TTY)
node bin/chart.js check --demo                                 # the headless check, on the demo
npm run build                                                  # Bun-compiled executable for this machine → dist/ (the kit's scripts/build.js)
node scripts/logo.js                                           # regenerate assets/ from src/pet.js
```

`--import @fleet/kit/register.js` is required whenever Node loads `.jsx`. The tests also preload `--import ./src/app.js`. CI runs Chart's tests on Linux and Windows whenever `apps/chart` or the kit changes, so paths must work on both (a found file's path is always `/`-separated). Nothing in the suite runs terraform, tofu or az.

Releases are automatic, as every app's: a push to main that changes `apps/chart` (or the kit, `patches/` or the root package files) releases it as `chart-v<version>` (root CLAUDE.md, "Releases"). Compiled builds get the version via `process.env.CHART_VERSION`.

## Architecture

- **The provider** (`src/iac.js`): everything Chart reads and runs goes through one object, `createChart({ run })`: `detect(dir)` (`tfDirs`, `bicep`, `params`, `saved`), `plan(dir, { bin, refreshOnly })` (a plan into a temporary file, `show -json` of it, the file removed), `state`, `init`, `whatIf(dir, { file, resourceGroup | location, params })`, `readFile`, `locate(dir, change)` (`resource "type" "name"` in the `.tf` files: `{ path, line }`). Command lines run through the kit's `run.js` with `-input=false`; `explain()` turns a missing program, a missing `az login` or a missing `init` into a sentence. **Everything put in a command line is checked by `safeArg()`**, and `bin` is one of `BINARIES`: keep that for any new command. **Nothing applies**: don't add `apply` or `az deployment create` without a decision to. `src/demo.js` `demoChart()` has the same interface (`calls` is the tests' handle: `state` is one of the provider's methods).
- **Plans** (`src/plan.js`, `src/diff.js`, pure): `parseTerraformPlan`, `parseTerraformState`, `parseWhatIf`, `parseAny` give one shape: a change is `{ address, type, name, module?, mode, provider, action, reason?, diff, id?, resourceGroup? }`, `action` one of `ACTIONS` (`replace` for a delete and a create). `attributeDiff(before, after, { unknown, beforeSensitive, afterSensitive, forces })` flattens to leaves and compares; **a value Terraform marks sensitive is replaced by `SENSITIVE` here, so it never reaches the screen, the clipboard, a report or the activity log**: keep every new display going through it (`diffLines`, `valueLines`). What-if deltas are flattened, `NoEffect` marked `noise`. `summarize`, `summaryLine`, `ordered` (what loses something first).
- **`src/rows.js`** (pure): marks, words and colours of actions, `changeRows`, `stateRows`, `findChange`, `siteOf` (an App Service app as the family's `site`). **`src/share.js`**: `markdownReport`. **`src/headless.js`**: `chart check` (`runHeadless(args, { provider, config, write })` resolves the exit code; `fails(plan, failOn)`), which `cli.jsx` runs before asking for a terminal.
- **`src/actions.js`**: every user-facing operation, written once; keys and slash commands call these with `ctx`. `whatIfArgs` reads `/whatif`'s arguments, the last ones (the config's `whatIf`) filling the gaps.
- **`src/commands.js`**, **`src/help.js`**: the slash-command table and completion (only a command's first argument completes); the `?` window's sections.
- **`src/ui/App.jsx`**: as Bilge's (its CLAUDE.md), with `data` `{ found, plan, drift, source: { kind: terraform | bicep | file, label, dir? }, state }`: `drift` is the latest plan's or refresh-only plan's, kept apart from `plan` so `/drift` never empties Changes. It only looks at the folder on opening; nothing polls. `ctx.refresh` (ctrl+r) is `again`.
- **`src/ui/ChangesView.jsx`** (Changes, and Drift with `drifted`), **`StateView.jsx`**, **`LogView.jsx`**, **`Viewer.jsx`**: views check `ctx.viewHasKeys()` first; `useListNav` from the kit.
- **The family** (`@fleet/kit/family.js`, shared and never edited here; `src/moods.js`, pure): Chart is in `FAMILY` (role `IAC`, Plot). `t` hands Splice a `file` context (where a resource is declared), `s` hands Locker a `site`. It takes no context. Plans, what-ifs and drift go to the activity log with the folder; Plot's mood to `writeMood`; tests point `FAMILY_HOME` at a temp folder (`tempHome`).
- **Config** (`src/config.js`): `~/.chart/config.json`, overridable with `CHART_HOME`. Change it only through `ctx.setConfig`.
- **Updates, hosted mode, mouse, theme and text**: as Wharf's (its CLAUDE.md).
- **Plot** (`src/pet.js`, `src/ui/Pet.jsx`): the puffin's pixel art and mood. `assets/` is generated from it by `scripts/logo.js`; don't hand-edit those files.

## Tests

`test/app.test.js` and `test/family.test.js` are end-to-end: `<App>` over `demoChart()` with `ink-testing-library`, typing keys and asserting on `lastFrame()` and `provider.calls`. `test/plan.test.js` covers the parsers, the attribute diff (sensitive values never in it), the state and what-if shapes and the rows; `test/iac.test.js` the command lines against a fake `run`, a folder on disk, `locateResource`, `chart check` and the report. Use `until(check, what)` to wait for frames rather than fixed sleeps.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` window's sections in `src/help.js`, the footer `HINTS` in `App.jsx`, and the tables in `README.md`. Commit messages are short sentences describing the change, without type prefixes.
