# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Keel is a tech lead's console for Azure DevOps: an Express API (`server/`) plus a React 19 + Vite UI (`client/`), plain JavaScript ESM, Node >= 20.12. No TypeScript, no linter, no bundler for the server. The README is the user-facing spec for every feature. When behaviour changes, update the matching README row or section too.

## Commands

```bash
npm run dev:mock     # demo org, no credentials: API (auto-restart) + Vite on http://localhost:5173
npm run dev          # same, against the org in .env (AZDO_ORG_URL + AZDO_PAT)
npm run build        # UI into dist/
npm start            # API + built UI on http://127.0.0.1:4280 (start:mock for demo data)
npm test             # node:test over test/**/*.test.js (with cli/register.js, so .jsx loads)
npm run cli:demo     # the terminal app (cli/) on demo data; needs a real terminal
npm run build:cli    # the terminal app as a standalone executable in release/ (Bun); pushes to main release it (.github/workflows/release-cli.yml)
npm run build:android -- --keystore keel.keystore   # the Android app (a Trusted Web Activity of keel.example.com, Bubblewrap) in release/; needs JDK 17 + Android SDK; .github/workflows/release-android.yml runs it by hand
node --test test/flow.test.js                          # one test file
node --import ./cli/register.js --test test/cli.test.js   # a test file that loads the terminal app's .jsx
node --test --test-name-pattern="Manual validation" test/deploying-stage.test.js   # one test
node scripts/check-syntax.mjs client/src/pages/Board.jsx   # parse-check client files without a build; also flags t()/tx()/tj() used without importing from i18n.js
node scripts/missing-pt.mjs client/src/pages/Totals.jsx    # list t()/tj() strings with no Portuguese translation
node scripts/logo.mjs                                     # regenerate the favicon, app icons and assets/ from client/src/pinch.js
```

To try accounts and roles on demo data, set `AUTH_MODE=login` and `AZDO_MOCK=1`. Demo accounts are kept apart from real ones (`.mock`-suffixed data files).

## Architecture

**Request path.** `server/index.js` builds one of two contexts and puts it on `req.ctx` (`{ service, watcher, role, user }`) before `routes.js`:
- **Local mode** (default): one person, using the `.env` PAT for every organization, with role `admin`.
- **Login mode** (`AUTH_MODE=login`): `auth.js` holds the accounts. Each user links their own encrypted PAT per organization, and `auth.serviceFor(userId)` builds that user's service. Background jobs (`schedules.js`, `channels.js`, `push.js`) take a `resolveService(ownerId)` callback, so they act in Azure DevOps as the person who set them up.

**Layers** (server):
- `routes.js`: HTTP only. Every non-GET needs the `x-keel: 1` header (the CSRF guard; `client/src/api.js` sends it). Role checks go through `need('<perm>')`, with permissions defined in `accounts.js` `PERMISSIONS`.
- `multiorg.js`: `createMultiService(entries)` wraps one service per organization behind the same interface. Lists are concatenated and tagged with `org`. Project-addressed calls go to the org that owns the project. Work item ids are only unique per org, so calls by id take an org key. A failing secondary org is dropped; a failing primary fails the request. **Any new service method must also be added here**, or it breaks once there is more than one org.
- `service.js`: composes provider, `cache.js` (60s TTL, invalidated by key prefix on writes), and settings. Everything is scoped to the *tracked* projects, teams and repos.
- `azdo/provider.js` (real REST, through `azdo/client.js`: PAT auth, retries, paging, concurrency cap) and `mock/provider.js` (in-memory demo org, mutable until restart) **share one interface**. A new provider method needs both, and `github/provider.js` too. `mock/variant.js` derives a second demo org ("fabrikam-demo") with deliberately colliding work item and build numbers, to exercise multi-org code.
- **GitHub owners** are organizations of `kind: 'github'` (`orgs.js`): `github/provider.js` maps pull requests (GraphQL) and Actions (REST) onto the same interface, with the pure mapping in `github/normalize.js`, and answers empty for work items, boards and classic releases. Its project is the owner itself (id = org key, `gh-<owner>`); repo ids are repo names. Reviews map to votes (approved 10, changes requested -5, requested 0), jobs to Stage/Job/Task timeline records, environment reviews to `Checkpoint.Approval`. `mock/github.js` is a fake GitHub API (REST + GraphQL) handed to the real provider, so demo data and tests run the real mapping. `providers.js` `providerFor(org, …)` builds any org's provider; auth is `GITHUB_TOKEN` or `gh auth token` (`github/ghcli.js`) locally, the person's token in login mode. The service's work-item paths use `workProjects()`, which leaves GitHub out.
- `domain/`: pure functions (PR signals, inbox rules, pipeline health, DORA delivery, flow, production regressions, etc.). Most tests target these directly with hand-built fixtures, so put logic here when it can be tested without a provider.
- `watcher.js`: polls only while a browser holds `/api/events` (SSE) open, diffs snapshots (`domain/changes.js`), and emits `changed` / `notify` / `status`.
- `monitoring.js` + `platform.js`: production URL and App Insights checks, shared server-wide. `platform.js` handles the ISM sites' `platform/v1` `/health` + `/totals` envelope.

**Persistence.** JSON files in the data folder (`config.js` `dataDirFor`: `DATA_DIR`, else `keel-data` next to Hostinger's `hbuilds/`, else `data/`). Use `jsonfile.js` `sharedJson` for anything several processes share: the host may run more than one copy, so it re-reads the file when it changes on disk. Background jobs (monitors, channels, push) elect a single runner across copies. Secrets (PATs, App Insights keys, webhooks, push keys) are encrypted with `secrets.js`, keyed from `SESSION_SECRET`.

**Domain rules that recur everywhere:**
- Process-agnostic: "done" and similar states come from Azure DevOps *state categories* and category groups (`Microsoft.RequirementCategory`), never from state or type names.
- A declined approval (classic stage rejected, YAML approval check or Manual validation rejected or timed out) counts as **declined**, not failed. It is excluded from health, pass rate, streaks, alerts, deploys and DORA (`domain/pipelines.js` `wasDeclined`).
- Production environments are the stages or pipelines that production monitors link to, plus classic stages matching `/prod|production|prd|live/`.

**Client.** `App.jsx` handles routes and the app shell. `context.js` `useApi(path)` refetches whenever the app-wide `refreshKey` changes (after writes, SSE `changed`, or Refresh). `prefs.js` holds account-synced preferences (theme, language, notifications, dashboard, saved views), with a localStorage copy; the server copy wins at startup. Pages live in `client/src/pages/`. Pinch, the crab in the logo, is pixel art in `pinch.js`; the favicon, app icons and `assets/` are generated from it by `scripts/logo.mjs`, so don't hand-edit them. Shared UI is in `ui.jsx`, `charts.jsx`, `views.jsx` and `palette.jsx` (Ctrl+K search).

**Terminal app** (`cli/`, started by `bin/keel.js`, built with Ink like Tiller and Trawl). Two ways to run: `cli/service.js` builds the same service as local mode in `server/index.js` (one per organization, through `multiorg.js`, same data folder), in-process with no server; or, with `KEEL_SERVER` + `KEEL_TOKEN` in `.env` (from `keel login`, a device-code sign-in through the browser: `server/terminals.js`, the web page `pages/TerminalSignIn.jsx`), `cli/remote.js` gives the App the same `keel` shape over a sign-in-mode server's `/api` with a bearer token, and live updates from its `/api/events`. A service method the terminal app calls needs a route, and an entry in `remoteService`. `cli.jsx` sets the environment *before* importing it, because `config.js` reads it on import: `--demo` sets `AZDO_MOCK`, and no PAT sets `AZDO_AUTH=az` (`server/azdo/azcli.js`, the Azure CLI's token). With no `AZDO_ORG_URL` in a terminal, `cli/setup.js` asks for it first (plain readline, before Ink and before config.js loads) and saves it to that `.env`. `cli/sonar.js` opens Sonar (the family's Azure console) on a production monitor, `S`: a new Windows Terminal tab, else the command copied; App takes it as the `openSonar` prop. `cli/actions.js` holds every operation, called by keys and slash commands (`commands.js`) with `ctx` from `ui/App.jsx`; views check `ctx.viewHasKeys()` first. Live checks repeat the watcher's: drop the live cache prefixes, `snapshot()`, `diffSnapshots`. The server's `console.warn`s go to `/log` (`cli/log.js`), never the terminal. `text.js`, `ui/parts.jsx`, `ui/hooks.js` and the jsx loader are Trawl's, and should stay recognisably the same; `help-layout.js` and `ui/HelpView.jsx` (the `?` window) are Trawl's and Splice's too, and should stay identical. `help.js` is the window's sections as data (`[keys, what they do]` rows, `views` saying which view opens on each); the slash commands section comes from `commands.js` by itself. Its text is English only (no `t()`). `test/cli.test.js` drives it end to end with `ink-testing-library` on demo data.

**Terminal app speed.** `patches/ink+6.8.0.patch` (applied by `patch-package` on `npm install`, so CI and the release builds get it; `postinstall` tolerates it being absent, as on a production-only install) keeps Ink's width and tokenize caches from one frame to the next, which more than halves the cost of a keystroke. Upgrading Ink means checking `build/output.js` still has `OutputCaches` and remaking the patch (`npx patch-package ink`). `text.js` measures printable ASCII by length and only calls string-width for the rest.

**Terminal app mouse** (`cli/mouse.js`, `cli/selection.js`, `cli/clipboard.js`, shared with Trawl and Splice, whose `docs/mouse.md` has the design; keep them the same). `terminalMouse` strips SGR mouse reports out of `stdin.read` before Ink sees them and hands them to `App` as the `mouse` prop; tests pass a fake (`test/cli-mouse.test.js`). Ink draws through `mouse.stdout`, which keeps the last frame so a drag can be painted and copied. `App` hit-tests the tabs, prompt and suggestions and gives the main area's events (`y` relative to it, `double` on a double-click) to the component on screen, which registers with `useMouse(ctx, handler)` from `ui/hooks.js`. Views name their `useInput` handler `keys` so a double-click can call `keys('', { return: true })`; `useListNav` has `pick(row)` and `scrollBy(n)`. A view's rows start one line under its panel's top border, and in a split view `x >= listW` is the pane beside the list. `KEEL_MOUSE=0` turns it off. On Windows the console reports the mouse only in VT input mode: Node 22.17+ sets it with raw mode, the Bun builds through `bun:ffi`.

**Terminal app settings.** `,` or `/settings` opens `ui/SettingsView.jsx` as an overlay (`overlay.settings` in App.jsx; esc closes it, `ctx.settingsHasKeys()` gates its keys). Its rows and the patches they save are pure, in `cli/settings.js`; saves go through `service.saveSettings` (the web app's settings) and `actions.js` `saveSettings`, organizations through `orgs.js`, and this computer's choices into `.env` (`setup.js` `saveEnvSettings`).

**Terminal app updates.** The downloaded executable (`COMPILED` in `cli/open.js`) updates itself with `cli/update.js`, Tiller's updater with Keel's names: cli.jsx passes `checkUpdate`/`installUpdate` to the App only then, so tests pass stubs and never go online.

## i18n (English + European Portuguese)

- English source text is the key: `t('Save changes')`, `t('{n} items', { n })`, `tj(...)` when React elements go in placeholders, and `tx(text)` for strings the server sent (exact match first, then `{placeholder}` templates).
- Portuguese lives in `client/src/locales/pt/<area>.js`, merged in `locales/pt.js` (later files win on duplicates). Server-sent sentences go in `locales/pt/server.js`; only those are used as `tx()` templates.
- The server reuses the same dictionaries via `server/i18n.js` for Teams and Slack posts.
- Every new or changed UI string needs its pt-PT entry. Check with `scripts/missing-pt.mjs`.

## Conventions

- Comments explain *why* and read as plain sentences. JSDoc one-liners sit on exported helpers. Match the surrounding density.
- Commit subjects are short, plain-language descriptions of the user-visible change (e.g. "Cancel a queued or running pipeline run"), one commit per change.
- `.gitattributes` forces LF line endings (the server runs on Linux).
