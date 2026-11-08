# Ballast

<img src="assets/logo.svg" alt="Plod, the Ballast tortoise" width="96" align="right">

Ballast shows what a production build ships and what it weighs, so a heavy dependency is caught in review rather than in a slow page. It reads a bundler's stats (esbuild's metafile, the data `rollup-plugin-visualizer` writes for Vite and Rollup, webpack's stats) or, without any, the output folder and its source maps, and shows every file raw, gzip and brotli, what is inside each one (packages grouped, biggest first), the packages bundled twice, and the change against the last build or main's: "+42.1 kB gzip, from date-fns 4 now imported whole".

In a pipeline, `ballast check` holds the build to budgets kept in the repository and fails when a file is over its own or the build grew too much; `ballast compare --base main --markdown` prints the table for the pull request; `ballast security` reports source maps shipped with the build and secrets that ended up in the bundled code.

```
ballast                    # this folder's build
ballast ../shop            # another folder
ballast --demo             # a made-up project, to look around: nothing is read, built or asked
ballast check --budget 'dist/assets/index-*.js=180kB' --fail-on 'growth>5%'
ballast compare --base main --markdown > size.md
ballast security --json    # for Fleet's security overview
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder (`!npm run build`).

Ballast is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/ballast`), or download the executable from the releases.

## What it reads

| Source | Where Ballast looks | What it gives |
|---|---|---|
| esbuild's metafile (`--metafile=meta.json`, `metafile: true`) | | Each output file, and the bytes each input put in it, after minifying |
| `rollup-plugin-visualizer`'s data (Vite, Rollup): `template: 'raw-data'` (JSON), or the `stats.html` of its other templates | `stats.json`, `meta.json`, `metafile.json`, `esbuild-meta.json`, `webpack-stats.json`, `bundle-stats.json`, `compilation-stats.json`, `stats.html`, in the project's folder, `.ballast/`, `dist/`, `build/`, `out/` or `reports/`; the newest wins, or `/read <file>`, `--stats <file>`, `"stats"` in ballast.json | Each output file, and the bytes each module rendered into it |
| webpack's stats (`webpack --json stats.json`, `stats.toJson()`), webpack 5 | | Each asset, the chunks' modules (a concatenated module opened up), a stylesheet's modules apart |
| The output folder, without stats | `dist/`, `build/`, `.next/static/`, `out/` | Every file's size; with a source map beside a file (or named in it), what's inside, counted by the characters each source maps to |

Sizes are from the files on the disk: raw, gzip (level 9) and brotli (quality 11; 9 above 4 MB), with `node:zlib`, as a server or a CDN sends them; images and fonts aren't compressed. A file the stats name that isn't on the disk shows the stats' size, raw only. A module's size is its share of its file: the stats' bytes (webpack and the visualizer count before minifying) scaled so a file's modules add up to it; its gzip and brotli are estimated at its file's ratio, and marked `≈`.

A module under `node_modules` belongs to the package its path names, installed where its path says (`node_modules/react-datepicker/node_modules/date-fns` is a second copy). The version comes from the path where pnpm's store or Yarn's cache puts it there, else from `package-lock.json` (in the project or up to three folders above it) by install path, else from the installed package's own `package.json`. The licence is the lock file's, or the package's own.

When there is nothing to read, Ballast asks to build the project once with stats on (`/build` asks again):

| The project | What runs |
|---|---|
| Vite (`vite` in its dependencies, a `vite.config.*`) | `npx vite build --sourcemap --emptyOutDir --outDir <a folder of Ballast's own>`: your `dist/` is left alone, and the maps say what each file holds; the files are named as they would be in `dist/` |
| webpack | `npx webpack --mode production --json <a folder of Ballast's own>/stats.json` |
| A build script that is a plain `esbuild …` call | the same command with `--metafile=<a folder of Ballast's own>/meta.json` |
| Any other build script (Next.js, Angular, …) | `npm run build` (`yarn`, `pnpm` by the lock file), then a look at the output folder |

Ballast's own folder is in the system's temporary folder and removed afterwards.

## Views

`1` Chunks · `2` Modules · `3` Duplicates · `4` Compare · `5` Log (what Ballast has run). `tab` goes round. On opening, Ballast reads the build and compares it with the last one; `ctrl+r` does both again.

### Chunks

Every file the build ships, biggest first: its path, raw, gzip and brotli (the measure in bold), a bar of its share of the whole, `entry` for what a page loads first, and `OVER <limit>` in red for a file over its budget.

| Key | |
|---|---|
| `↵` or `l` | What is inside it, in Modules |
| `s` | Sort by size or by name |
| `c` | The budgets and the growth, as `ballast check` sees them |
| `y` | Copy its path |

### Modules

What is inside one file, or every file: a node per package (`node_modules` grouped by package, its copies under it when it has more than one, yellow), then the project's own files by folder (a folder with one folder in it reads as one, `src/pages/`), biggest first at each level, with the size in the measure (estimated), raw, the share, and how many modules a node holds.

| Key | |
|---|---|
| `↵`, `l` or `→` | Open or close a package or folder; on a file, where it is and what it weighs |
| `←` or `h` | Close it, or go up to the node it is in |
| `c` / `alt+c` | The next file, the one before (all of them first) |
| `p` | The package: its size, its copies and what brings each in, its licence and its advisories |
| `w` | Copy `/why <package>` for Bilge |
| `t` | Copy a file of the project's own for Splice, whose history says who made it heavy |
| `y` | Copy its path |

### Duplicates

Packages bundled more than once, the most to win first: at two versions or more (yellow: a dependency asks for a range the project's version isn't in), or one version from two install paths (blue: `npm dedupe` usually folds them), with what all but the biggest copy weigh.

| Key | |
|---|---|
| `↵` or `l` | Each copy: its version, size, the files it is in, what brings it in, and how to keep one |
| `p` | The package: licence and advisories |
| `w` | Copy `/why <package>` for Bilge |
| `y` | Copy its name |

### Compare

This build against its base: the headline ("+51.5 kB gzip, from date-fns 4 now imported whole"), every file that changed (matched by its name without the content hash: `index-[hash].js`), and every package that changed, each with why: `newly bundled`, `no longer bundled`, `now imported whole` (three times the modules it had, ten at least: an `import *` or a barrel file), a version change, or how much it grew. The headline names the package that explains a quarter of the change or more. A package's size is its share of the files it is in.

| Key | |
|---|---|
| `b` | Against the last build, or main |
| `m` | The comparison as Markdown, for a pull request (`alt+y` copies it all) |
| `↵` or `l` | A file's or package's sizes before and after, versions and modules |
| `p` | The package: licence and advisories |
| `w` | Copy `/why <package>` for Bilge |
| `y` | Copy the headline |

Every build Ballast reads is kept as a summary (each file's sizes, each package's) in `~/.ballast/runs/`, per project and by commit (`+dirty` for a working tree with changes; `BALLAST_HOME` moves it). **The last build** is the newest one kept that isn't this one. **main** (or any ref: `/compare v1.4.0`) is the build kept for the commit it names (`main`, else `origin/main`, `master`). When there is none, Ballast asks to build it: in a git worktree of its own (`git worktree add --detach`), its packages installed as its lock file says (`npm ci`, `yarn install --frozen-lockfile` or `--immutable`, `pnpm install --frozen-lockfile`), built with stats as above, then the worktree removed (`git worktree remove --force`). It is kept, so that happens once per commit of main.

### The package

`p` (or `/why <package>`) shows a bundled package: its size, each copy's version, install path, files and what brings it in, the licence of each version (the lock file's), and the advisories OSV knows against each version (the same database Bilge asks, through the kit's `osv.js`; only the names and versions leave the machine, asked once a session). Ballast takes no part in fixing them: `w` copies `/why <package>` for Bilge, which says which manifest brings it in and moves it.

## Budgets

In `ballast.json`, or under `"ballast"` in the `"fleet"` section of `package.json`:

```json
{
  "budgets": { "dist/assets/index-*.js": "180kB", "dist/assets/*.css": "30kB", "total": "450kB" },
  "failOn": ["budget", "growth>5%"],
  "measure": "gzip",
  "stats": "dist/stats.json"
}
```

A path is a glob over the files as Ballast names them (relative to the project, `/` between folders): `*` within a folder, `**` across them, `?` one character; each file it matches is held to the size on its own. `total` is all the files together. A size is `180kB` (1000 bytes a kB, as build tools print them), `1.5MB`, `200KiB` or bytes. `budgets` may also be a list of `{ "path", "max" }`. `failOn` is what `ballast check` fails on: `budget` (a file over its budget), `growth>5%` or `growth>10kB` (against the base), `none`; `budget` when not said. `measure` is `gzip` (what a browser downloads, by default), `brotli` or `raw`. A budget whose glob matches nothing is said, never a failure. `/budgets` shows them and what didn't read.

## Slash commands

`/read [stats file]`, `/build` (above), `/chunks`, `/modules [file]`, `/duplicates`, `/compare [last|main|<ref>]`, `/markdown`, `/check`, `/budgets`, `/why <package>`, `/security` (below), `/measure [gzip|brotli|raw]`, `/move <folder>`, `/env [name]` (below), `/take <family:v1:…>` (Ballast takes none, and says whose it is), `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

## In a pipeline

```
ballast check [folder] [--budget <glob>=<size>]… [--fail-on budget|growth>5%|growth>10kB|none]… [--base last|main|<ref>]
              [--base-stats file] [--stats file] [--measure gzip|brotli|raw] [--build] [--json]
ballast compare [folder] [--base last|main|<ref>] [--base-stats file] [--stats file] [--build] [--markdown | --json] [-o file]
ballast security [folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
```

`ballast check` reads the build (`--stats`, else what the folder has), holds it to the budgets (ballast.json's, with `--budget` replacing one for the same glob or adding one) and, when `--fail-on` (or `failOn`) has a growth condition or `--base` is given, compares it with its base. It prints a line a budget (`OVER`, `ok`, or `none` for a glob that matched nothing), the comparison, a line a growth condition (`FAIL`, `ok`, or `----` when there was nothing to compare with, which never fails), and exits `1` when something fails, `0` otherwise, `2` when it couldn't run. `--json`:

```json
{ "dir": "/path/to/shop", "source": "rollup-plugin-visualizer data, dist/stats.json", "measure": "gzip",
  "total": { "raw": 625797, "gzip": 189968, "brotli": 165281 },
  "budgets": [{ "pattern": "dist/assets/index-*.js", "limit": 100000, "size": 112691, "over": true, "matched": true,
                "files": [{ "file": "dist/assets/index-B7xk2Lq9.js", "size": 112691, "over": true }] }],
  "base": { "name": "main", "key": "a1b2c3d…", "commit": "a1b2c3d…", "branch": "main", "at": "2026-11-01T…", "total": { … } },
  "growth": { "before": 138474, "after": 189968, "delta": 51494, "percent": 37.2, "headline": "+51.5 kB gzip, from date-fns 4 now imported whole" },
  "failOn": ["budget", "growth>10%"], "failing": ["budget dist/assets/index-*.js", "growth>10%"] }
```

`ballast compare` prints the change against `--base` (`last` by default): the headline, the files that changed, the packages; `--markdown` the table for a pull request; `--json` `{ dir, base, head, measure, total, headline, chunks, packages }`; `-o` writes it to a file. It exits `2` when there's nothing to compare with.

Both keep the build they read in `~/.ballast` (by commit), as the app does. A pipeline's home is usually new each run, so for `--base main` either keep `~/.ballast` between runs (a cache keyed by the branch), hand it main's stats with `--base-stats` (an artifact of main's own pipeline), or let `--build` build main in a git worktree (the checkout needs main's history: `fetch-depth: 0`). Neither command builds anything without `--build`: with nothing to read, they exit `2` and say what `--build` would run.

```yaml
# GitHub Actions: a pull request's size, against main, as a comment
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- run: npm ci && npm run build
- run: ./ballast check --fail-on budget
- run: ./ballast compare --base main --build --markdown -o size.md
- run: gh pr comment ${{ github.event.pull_request.number }} --body-file size.md --edit-last || gh pr comment ${{ github.event.pull_request.number }} --body-file size.md
  env: { GH_TOKEN: ${{ github.token }} }
```

`ballast security` reads the output folders (`dist/`, `build/`, `.next/static/`, `out/`) for what the build gives away to everyone who loads the page, in the shape every app's security check prints, which Fleet's security overview adds up:

| Rule | Severity | |
|---|---|---|
| `source-map` | medium with the source in them (`sourcesContent`), low with only its layout | Source maps shipped in an output folder: one finding a folder |
| the kit's secret rules (`aws-key`, `stripe-key`, `github-token`, `google-key`, `jwt`, `hardcoded-secret`, …) | as the rule says | A key or password in a built file (`.js`, `.css`, `.html`, `.json`, …): sent to every visitor. A minified line is read in pieces, the finding at the file's line; the excerpt is redacted, and left out of `--json` |

```json
{ "app": "ballast", "check": "security", "target": "/path/to/shop", "at": "2026-11-03T10:00:00.000Z",
  "counts": { "critical": 1, "high": 0, "medium": 1, "low": 0, "unknown": 0 }, "dirs": ["dist"], "files": 8,
  "findings": [{ "rule": "stripe-key", "severity": "critical", "title": "Stripe live key in the bundle", "where": "dist/assets/index-B7xk2Lq9.js", "line": 1, "why": "…", "fix": "…", "kind": "secret" },
               { "rule": "source-map", "severity": "medium", "title": "Source maps shipped in dist (3)", "where": "dist", "why": "…", "fix": "…", "kind": "config" }] }
```

It exits `1` when a finding is as bad as `--fail-on` (`high` by default). `--sarif` writes SARIF 2.1.0 for code scanning, alone (or `--sarif -`) to the output, or with a file beside the usual output. `securityIgnore` in the settings (a rule, or `rule:where`) is left out. `/security` shows the same inside.

## The family

`t` hands Splice a `file` context for a file of the project's own (a module in Modules), whose history says who made it heavy and when. A package goes to Bilge as a line of its own command, `/why <package>` (`w`), as Bilge takes no package context. Ballast takes no context itself; `/take` of one says whose it is. Reading a build, building one and `/security` go to the family's activity log with the folder (sizes and counts only, nothing from inside the bundle); Plod's mood (worried while a file is over its budget) goes to the others' mascots. The `familyMoods` setting turns both off.

## Environments

A project that names its environments in `.fleet/project.json` shows the chosen one in Ballast's top line, red for a production one. `/env` says which it is, `/env <name>` switches every app to another. While Fleet records a runbook, every slash command Ballast's prompt runs goes into it.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.ballast/config.json` (`BALLAST_HOME` moves it, and the runs with it): `theme`, `accent`, `mouse`, `measure` (over the project's own), `compareWith` (what Compare starts against: `last`, the default, or `main`), `securityIgnore`, `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `ballast-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Parcel's and Turbopack's own stats; Next.js's per-route weights (its build manifest); which import made a package whole (the visualizer's `importedBy`, read but not shown); a treemap; budgets written from inside the app; compressing as the deployment's server does (its level, or zstd).
