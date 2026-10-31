# Bilge

<img src="assets/logo.svg" alt="Nibs, the Bilge rat" width="96" align="right">

What a project depends on, in the terminal. Bilge reads a folder's npm and NuGet lock files, asks [OSV](https://osv.dev) which advisories are known against the exact versions in them, and lists the vulnerable packages worst first, with the version that fixes each one and the command that gets you there. It also shows every package's licence and how far behind it is, writes a CycloneDX SBOM, and runs headless in a pipeline (`bilge audit --fail-on high`).

It covers what Snyk, Mend, Socket or FOSSA are bought for in a small team: advisories, licences, outdated packages and an SBOM, from a free, open database, with nothing to sign up for. Only the packages' names and versions leave the machine: to `api.osv.dev`, and for `/outdated` to the npm and NuGet registries.

```
bilge                    # this folder and the ones under it
bilge ../shop            # another folder
bilge --demo             # a made-up project, to look around: nothing is read, asked or run
bilge audit --fail-on high          # in a pipeline: the findings, and exit 1 when one is high or worse
bilge sbom -o sbom.cdx.json         # a CycloneDX bill of materials
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder (`!npm ls lodash`).

Bilge is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/bilge`), or download the executable from the releases.

## What it reads

| File | What Bilge takes from it |
|---|---|
| `package-lock.json`, `npm-shrinkwrap.json` (lock file 1, 2 or 3) | Every installed package, the root's and the workspaces' own dependencies marked direct, the development ones marked `dev`, the licence npm wrote down |
| `packages.lock.json` (NuGet) | Every package of every target framework, the project's own references marked direct |
| `.csproj`, `.fsproj`, `.vbproj` without a `packages.lock.json` | Only its `PackageReference`s with an exact version (from `Directory.Packages.props` under central package management). Set `RestorePackagesWithLockFile` to `true` and build to give Bilge everything |
| `package.json` without a lock file | Nothing (its ranges aren't versions): it's listed, saying so |

It looks six folders deep, and never in `node_modules`, `bin`, `obj`, `dist`, `build`, `out`, `target`, `vendor`, `coverage` or a hidden folder. A workspace's `package.json` is covered by its root's lock file.

## Views

`1` Vulnerabilities · `2` Packages · `3` Manifests · `4` Log (what Bilge has run). `tab` goes round. On opening, Bilge reads the folder and asks OSV (turn that off with `"autoAudit": false`; `/audit` asks then); `ctrl+r` does both again.

### Vulnerabilities

Each package with a known advisory against its version: the worst advisory's severity (CRIT and HIGH red, MED yellow, LOW blue: GitHub's own word where it has one, else the CVSS 3 score's band), `via` when another package brings it in, `dev` when only development needs it, the version that fixes all its advisories (`no fix` when one has none yet), and the first one's summary.

| Key | |
|---|---|
| `↵` or `l` | Its advisories (ids, CVEs, scores, the fix of each, links), where it is, and how to fix it |
| `f` | Fix it (below) |
| `o` | Open the advisory in the browser |
| `x` | Ignore its advisories (asks; kept in the settings, left out of the counts and `bilge audit`) |
| `t` | Copy where it is in its lock file for Splice, whose blame says who brought it in and when |
| `d` | Show or hide the packages only development needs |
| `y` | Copy its advisories' ids |

### Fixing

`f` (or `/fix <package|advisory>`) asks, then runs the ecosystem's own command in the folder of the manifest it was found in, and reads and audits again:

| The package | The command |
|---|---|
| npm, direct | `npm install <name>@^<fixed>` (`--save-dev` for a development one) |
| npm, brought in by another | `npm update <name>`, which moves it within what its parents ask for; where that isn't enough, Bilge says which `overrides` entry to add to package.json |
| NuGet | `dotnet add "<project>" package <Name> --version <fixed>` (for one brought in, a direct reference pins it, as NuGet advises) |

The question also offers to copy the command instead. Only a package name and version as the registry would have them, and a plain project file name, go into a command line.

### Packages

Every package, the direct ones first: its version, the newest one (once asked: `u` or `/outdated`; a major version behind red, minor yellow, patch blue; `deprecated` in red), its licence (copyleft red, weak copyleft such as LGPL or MPL yellow, unknown grey, one your `/deny` list names red), its ecosystem, `dev`, and its worst advisory.

| Key | |
|---|---|
| `↵` or `l` | Its licence, newest version, advisories, where it is, its registry page |
| `a` | All of them, the direct ones, the outdated ones, or the flagged ones (an advisory, a copyleft or denied licence, deprecated) |
| `u` | Ask npm and NuGet for the direct packages' newest versions and licences (`/outdated all`: every package) |
| `f` | Fix it, when it has advisories |
| `o` | Its page on npmjs.com or nuget.org |
| `t` | Copy where it is for Splice's blame |
| `y` | Copy `name@version` |
| `esc` | Every manifest's packages again, after `↵` in Manifests |

NuGet's lock files don't record licences: `/outdated` reads them from each package's `.nuspec`.

### Manifests

The lock files and projects found: their ecosystem, kind, how many packages, how many direct, how many vulnerable, and a note where one gives less than everything.

| Key | |
|---|---|
| `↵` or `l` | Its packages, in the Packages view |
| `t` | Copy it for Splice, whose history says who changed it |
| `y` | Copy its path |

## Slash commands

`/scan`, `/audit`, `/outdated [all]`, `/fix <package|advisory>`, `/why <package>`, `/ignore <advisory|package>`, `/unignore [advisory|all]`, `/deny [licence…|none]` (the licences to flag: SPDX ids, or their start, `GPL-` for every GPL; with an `OR`, only when every choice is), `/packages [all|direct|outdated|flagged]`, `/sbom [file]` (`sbom.cdx.json` in the folder unless named; asks before replacing one), `/report` (the audit as Markdown, `alt+y` copies it for a pull request), `/move <folder>`, `/take`, `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

## In a pipeline

```
bilge audit [folder] [--fail-on critical|high|medium|low|none] [--json]
bilge sbom [folder] [-o file]
```

`bilge audit` prints each finding with its advisories and where it is, then the counts. It exits `1` when a finding is as bad as `--fail-on` (`high` by default), `0` otherwise, and `2` when it couldn't run (OSV unreachable, a bad option). `--json` prints `{ dir, packages, manifests, counts, findings }`. The advisories ignored with `/ignore` (in `~/.bilge/config.json`) are left out. `bilge sbom` writes CycloneDX 1.5 JSON: every package with its purl, licence and scope (`optional` for development ones), and the advisories against them.

```yaml
# Azure Pipelines or GitHub Actions, after npm ci / dotnet restore
- run: ./bilge audit --fail-on high
```

## The family

What changes a project (a fix) and what an audit found go to the family's activity log, so `/timeline` in the others shows when the advisories changed; Nibs's mood (worried while there's a critical or high advisory) goes to the others' mascots. `t` hands Splice a `file` context: with a package's line, Splice blames it; for a manifest, its history. Bilge takes no sibling's context yet. The `familyMoods` setting turns the moods and the activity log off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.bilge/config.json` (`BILGE_HOME` moves it): `theme`, `accent`, `mouse`, `autoAudit`, `ignore` (advisory ids), `deny` (licences), `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `bilge-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Yarn and pnpm lock files, Python, Go, Cargo and Maven; vulnerability reachability (whether the vulnerable code is called); a cache of OSV's answers between runs.
