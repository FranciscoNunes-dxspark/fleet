# Drill

<img src="assets/logo.svg" alt="Peck, the Drill woodpecker" width="96" align="right">

A project's tests in the terminal, failures first. Drill runs a project's tests and shows what broke before anything else: the assertion, the diff of expected and actual, and the stack cut down to the project's own frames, with `↵` on a frame opening the file at that line in your editor. It covers the loop between saving a file and knowing whether it broke something: `c` runs only the tests touching what changed, `w` does that on every save, `r` runs the one under the cursor again.

It runs Vitest, Jest, `node --test`, Playwright and `dotnet test` (xUnit, NUnit and MSTest), each through the report it writes for machines, read with a parser pinned to the runner's version. The runner's own output, colours and progress lines included, is kept beside it in the Output view. Tests that pass and fail from one run to the next are kept apart as flaky.

```
drill                    # this folder: find the tests and run them
drill ../shop            # another folder
drill --demo             # a made-up project, to look around: nothing is read or run
drill run                # without the screen: the failures, the counts; exit 0 passed, 1 failed, 2 couldn't run
drill run --json         # the same as JSON, for a pipeline or an agent (fleet mcp)
drill run --changed      # only the tests touching what git says changed
drill list               # the suites found
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder.

Drill is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/drill`), or download the executable from the releases.

## What it runs

| Runner | Found from | Run as | Read from |
|---|---|---|---|
| Vitest 1, 2, 3 | `vitest` in package.json's dependencies or scripts, a `vitest.config.*` | `npx vitest run --reporter=default --reporter=json --outputFile.json=<temp>` | its JSON report |
| Jest 29, 30 | `jest` in dependencies or scripts, a `jest.config.*`, a `"jest"` section | `npx jest --json --outputFile=<temp> --testLocationInResults` | its JSON report |
| `node --test` (Node 22) | a script running `node --test` (its files and folders are kept) | `node --test --test-reporter=spec … --test-reporter=tap --test-reporter-destination=<temp>` | its TAP (spec output can be read too) |
| Playwright 1.40 and on | `@playwright/test` in dependencies, `playwright test` in a script, a `playwright.config.*` | `npx playwright test --reporter=list,json` (`PLAYWRIGHT_JSON_OUTPUT_NAME`) | its JSON report, retries and attachments too |
| `dotnet test` | a `.csproj`, `.fsproj` or `.vbproj` referencing `Microsoft.NET.Test.Sdk`, xUnit, NUnit or MSTest (one suite per test project) | `dotnet test <project> --logger "trx;LogFileName=drill.trx" --results-directory <temp>` | the TRX file |

`npx --no` becomes `pnpm exec` beside a `pnpm-lock.yaml` and `yarn` beside a `yarn.lock`; package.json files are looked for three folders down, test projects five, never in `node_modules`, `bin`, `obj`, build output or hidden folders. The version comes from the runner's own package in `node_modules` (`node --version` for node). A version Drill hasn't been checked against is read as the nearest one it has, and Drill says so (`/runners` shows which).

Every report goes to a temporary folder, deleted after the run; what the runner prints for people goes to the Output view, through a virtual terminal, so colours and progress lines read as they would in a terminal (`FORCE_COLOR=1` is set).

### drill.json

A `drill.json` in the folder names the runners instead of looking for them:

```json
{
  "runners": [
    { "runner": "vitest", "cwd": "web", "args": ["--project=unit"] },
    { "runner": "playwright", "cwd": "web", "command": "pnpm exec playwright test" },
    { "runner": "dotnet", "cwd": "api/Api.Tests", "target": "Api.Tests.csproj" }
  ],
  "e2e": { "url": "http://localhost:3000" },
  "watch": { "ignore": ["generated/"] }
}
```

`runner` is one of `vitest`, `jest`, `node`, `playwright`, `dotnet`; `cwd` its folder; `command` what starts it (Drill adds its reporter); `args` more options or files. `e2e.url` is where the end-to-end tests' app answers. `watch.ignore` lists folders `w` doesn't watch.

## Views

`1` Failures · `2` Tree · `3` Flaky · `4` Output · `5` Log. `tab` goes round. On opening, Drill finds the tests and runs them all (`"runOnStart": false` in the settings leaves that to you); `ctrl+r` does both again.

### Failures

Every failed test, and under the list the one the cursor is on: what failed and where, the message, expected and actual as a diff (`-` expected in red, `+` what came instead in green; Jest's and Vitest's own diff when they wrote one), and the stack cut to the project's frames (inside the folder, out of `node_modules` and Node's own; all of them, dimmed, when none is). A Playwright failure also lists its screenshot, video and trace.

| Key | |
|---|---|
| `↵` or `l` | Into the failure: `j` `k` go from frame to frame |
| `↵` on a frame | Open its file at its line in your editor |
| `↵` on an attachment | The trace opens in the trace viewer; a screenshot's or video's path is copied |
| `h` or `esc` | Back to the list |
| `r` | Run this test again |
| `o` | Open a Playwright failure's trace (`npx playwright show-trace <trace.zip>`) |
| `t` | Copy the failure for Splice (below) |
| `y` | Copy the failure as text |

The editor is `/editor`'s, else `DRILL_EDITOR`, `VISUAL` or `EDITOR`. VS Code, Cursor and their kin get `-g file:line:column`, Sublime and Zed `file:line`, JetBrains IDEs `--line`, Notepad++ `-n`. A terminal editor (vim, nvim, nano, emacs, helix…) would need the terminal Drill is drawing on, so its command (`nvim +12 src/cart.ts`) is copied for you to run in another.

### Tree

Every file, the suites in it and their tests: `✗` failed, `✓` passed, `○` skipped, `↻` passed on a retry; a file and a suite say how many of each and how long they took. A .NET test's "file" is its class.

| Key | |
|---|---|
| `↵` or `l` `h` | Fold or unfold a file or suite; on a test, its failure (or what it is) |
| `f` | Failures only, or everything |
| `r` | Run the test, the suite or the file again |
| `t` | Copy a test for Splice |
| `y` | Copy its name |

### Flaky

Tests that both passed and failed in their last ten runs, the most often failing first, with their runs oldest first (`✓✗✓✓✗`). A Playwright test that failed and then passed on a retry counts as both. The history is kept per project in `~/.drill/history/` (thirty runs). `↵` says more, `r` runs it, `t` copies it for Splice.

### Output

What the runners wrote as they ran, drawn by a virtual terminal (the kit's `vt.js`), the last run's: `↑` `↓` or `j` `k` look back, `g` the start, `G` (alt+g) the end, `y` copies what's on screen.

### Log

What Drill has run, newest at the bottom; `↵` shows all of an entry's output.

## Running less

| Key | |
|---|---|
| `r` | The test (or file, or suite) under the cursor |
| `R` (alt+r) | Every test that failed last time |
| `c` | Only the tests touching what changed: the files git lists as changed (`git status --porcelain`, what Splice shows), mapped to tests by name (`cart.ts` and `cart.test.ts`, `Price.cs` and `PriceTests.cs`), by import (a test importing `./cart`), and in C# by a test using the class |
| `w` | Watch: each saved file runs the tests touching it (the header says `● watching`); `w` again stops |
| `ctrl+r` | Find the tests again and run all of them |

A test file goes to the suite that ran it last; one not run yet to the suite its place says (a `.cs` file to the test project holding it, `e2e/` or a `.spec.` file to Playwright when there's one, the rest to the nearest other suite). A re-run's tests take the place of the ones they ran again; the rest stay as they were.

## End-to-end tests and Bosun

Bosun runs the project's dev server, and Drill never starts a copy of its own. Before Playwright's tests run, Drill asks the app's address with a plain request (`drill.json`'s `e2e.url`, else the Playwright config's `baseURL`, else its `webServer`'s `url` or `port`); any answer, a 404 or a 500 too, counts as up. When nothing answers, those tests don't run, and Drill says so with what Bosun's mood says ("Bosun is neutral: nothing running"): start the app in Bosun and run them again. Set `reuseExistingServer: true` on the config's `webServer`, so Playwright uses the app Bosun runs.

## The family

| | |
|---|---|
| `t` on a failure | A `test` context (its file and the line it broke at, its name, the first line of its message) copied for Splice, which blames the file at that line. Inside Fleet, Fleet switches to Splice and types it in |
| `/take <test context>` | Drill runs that test again: by name among the last run's, else its file |
| Activity | Each run goes in the family's activity log: "Ran 120 tests in shop: 3 failed · 117 passed" |
| Mood | Peck is worried while tests fail, happy when they all pass, and says so when a sibling is worried |
| `/env` | The project's environment (`.fleet/project.json`), shared with every app |

## Commands

| Command | |
|---|---|
| `/run [all\|failed\|changed\|<file>\|<words>]` | Every test, the failed ones, the ones touching changes, a file's, or the ones whose names have the words |
| `/failed`, `/changed` | As `R` and `c` |
| `/watch [on\|off]` | As `w` |
| `/flaky`, `/output` | Those views |
| `/runners` | The suites found, their versions, their parsers and how each last ran |
| `/find` | Look for the tests again, without running them |
| `/editor [command]` | The editor `↵` opens files in; `default` goes back to `EDITOR` |
| `/move [folder]` | Test another folder |
| `/env [name]` | The project's environment |
| `/take <family:v1:…>` | What a sibling copied |
| `/shell <command>`, `!` | A shell command in the folder |
| `/last` | All of the last command's output |
| `/settings`, `/theme`, `/accent`, `/mouse` | Settings |
| `/update`, `/help`, `/quit` | |

## In a pipeline, or for an agent

`drill run [folder]` runs everything without the screen and prints the failures first, then each runner's counts. Its exit code is the family's: `0` every test passed, `1` a test failed, `2` it couldn't run (no tests found, a runner wrote no report, the end-to-end tests' app wasn't up).

| Option | |
|---|---|
| `--json` | `{ app, dir, ok, counts, duration, runners: [{ suite, runner, dir, version, pin, command, ran, error?, counts }], failures: [{ id, runner, file, line, suite, name, fqn?, message, expected?, actual?, diff?, frames: [{ file, line, method? }], attachments? }], flaky: [{ id, runner, file, name, passes, fails, marks }] }` |
| `--all` | With `--json`, every test too (`tests`) |
| `--fail-on any\|not-flaky\|none` | Which failures make it exit 1: any (the default), the ones not known to be flaky, or none |
| `--runner <name>` | Only that runner (again for more) |
| `--changed` | Only the tests touching what git says changed |

`drill list [folder] [--json]` says which suites it found, their versions and where it found them. `drill run` adds to the flaky history as the app does.

## Settings

`~/.drill/config.json` (`DRILL_HOME` moves it): `theme`, `accent`, `mouse`, `editor`, `runOnStart`, `familyMoods`, `checkForUpdates`, `autoUpdate`. `/settings` shows them.
