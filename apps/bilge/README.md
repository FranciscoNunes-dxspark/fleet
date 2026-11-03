# Bilge

<img src="assets/logo.svg" alt="Nibs, the Bilge rat" width="96" align="right">

What a project depends on, in the terminal. Bilge reads a folder's npm, Yarn, pnpm and NuGet lock files, asks [OSV](https://osv.dev) which advisories are known against the exact versions in them, and lists the vulnerable packages worst first, with the version that fixes each one and the command that gets you there. It also shows every package's licence and how far behind it is, writes a CycloneDX SBOM, and runs headless in a pipeline (`bilge audit --fail-on high`).

Before an update, it says whether the new version fits the project: a NuGet package built for frameworks the project doesn't target, an npm package that needs a newer Node than the project says, or one whose peers won't take it.

It covers what Snyk, Mend, Socket or FOSSA are bought for in a small team: advisories, licences, outdated packages and an SBOM, from a free, open database, with nothing to sign up for. Only the packages' names and versions leave the machine: to `api.osv.dev`, and for `/outdated` to the npm and NuGet registries (and `/breaking` sends Claude the lines that import a package).

```
bilge                    # this folder and the ones under it
bilge ../shop            # another folder
bilge --demo             # a made-up project, to look around: nothing is read, asked or run
bilge audit --fail-on high          # in a pipeline: the findings, and exit 1 when one is high or worse
bilge sbom -o sbom.cdx.json         # a CycloneDX bill of materials
bilge report -o report.md           # the audit as Markdown
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder (`!npm ls lodash`).

Bilge is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/bilge`), or download the executable from the releases.

## What it reads

| File | What Bilge takes from it |
|---|---|
| `package-lock.json`, `npm-shrinkwrap.json` (lock file 1, 2 or 3) | Every installed package, the root's and the workspaces' own dependencies marked direct, the development ones marked `dev`, the licence npm wrote down |
| `yarn.lock` (Yarn 1, and Yarn 2 or newer) | Every package from npm's registry (a workspace, a patch, a git or file dependency left out), the ones the `package.json` beside it and its workspaces' ask for marked direct, the ones only their `devDependencies` lead to marked `dev`; Yarn 2's required peers |
| `pnpm-lock.yaml` (lock file 6 to 9) | Every package from npm's registry, the project's and its workspaces' own dependencies marked direct (an alias as the package it is), the development ones marked `dev`, the required peers |
| `packages.lock.json` (NuGet) | Every package of every target framework, the project's own references marked direct, and the frameworks it was restored for |
| `.csproj`, `.fsproj`, `.vbproj` without a `packages.lock.json` | Only its `PackageReference`s with an exact version (from `Directory.Packages.props` under central package management), and its `TargetFramework` or `TargetFrameworks`. Set `RestorePackagesWithLockFile` to `true` and build to give Bilge everything |
| `package.json` without a lock file | Nothing (its ranges aren't versions): it's listed, saying so |
| `package.json` beside a lock file, `.nvmrc`, `.node-version` | The Node the project runs on: `engines.node`, else the version in `.nvmrc` or `.node-version` (in its folder or one above) |
| A container image Wharf hands over (`/take`) | Its Debian, Ubuntu or Alpine system packages, by source package, read out of it with `docker` without running it ([Container images](#container-images)) |

It looks six folders deep, and never in `node_modules`, `bin`, `obj`, `dist`, `build`, `out`, `target`, `vendor`, `coverage` or a hidden folder. A workspace's `package.json` is covered by its root's lock file. A folder with more than one lock file is read for the first of `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` and `pnpm-lock.yaml`.

## Views

`1` Vulnerabilities · `2` Packages · `3` Manifests · `4` Log (what Bilge has run). `tab` goes round. On opening, Bilge reads the folder and asks OSV (turn that off with `"autoAudit": false`; `/audit` asks then); `ctrl+r` does both again.

OSV's answers are kept between runs in `~/.bilge/cache/osv.json`: which advisories a package's version has for six hours, an advisory's record for a day. Opening Bilge and `/audit` ask OSV only about what isn't kept (the activity line says how many came from the cache); `ctrl+r` and `/audit fresh` ask about everything again. `bilge audit` in a pipeline always asks afresh.

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
| Yarn, direct | `yarn add <name>@^<fixed>` (`--dev` for a development one) |
| Yarn, brought in by another | `yarn up -R <name>` on Yarn 2 or newer; Yarn 1 has no command for it, so Bilge says which `resolutions` entry to add to package.json |
| pnpm, direct | `pnpm add <name>@^<fixed>` (`--save-dev` for a development one) |
| pnpm, brought in by another | `pnpm update <name>`; where that isn't enough, Bilge says which `pnpm.overrides` entry to add to package.json |
| NuGet | `dotnet add "<project>" package <Name> --version <fixed>` (for one brought in, a direct reference pins it, as NuGet advises) |

Before it asks, Bilge asks the registry what the fixed version needs, and checks it against the project as in [Will it fit?](#will-it-fit). If something may not fit, the question is red and says what, and offers to show all of it. The question also offers to copy the command instead. Only a package name and version as the registry would have them, and a plain project file name, go into a command line.

Once the fix has run, Bilge reads and audits again, then checks that the project still holds together: `npm ls <name>` (it fails on a peer or range the new version breaks; `yarn why <name>` or `pnpm why <name>` for theirs) or `dotnet restore "<project>"` (it fails on NU1202, a package not built for the project's framework). If the check fails, Bilge says so, and `/last` shows what the check printed.

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

### Will it fit?

`/outdated` also asks what each newest version needs, and marks it with `!` when it won't fit the project. `↵` says why, and gives the newest version that does fit:

| | Bilge compares |
|---|---|
| NuGet | The frameworks the new version is built for (its `.nuspec`'s dependency groups) with the ones the project targets, as NuGet would: `net6.0` runs `netstandard2.0` and `net6.0` builds, not `net8.0` ones; `net48` runs `netstandard2.0`, not `2.1` |
| npm: Node | The new version's `engines.node` with the lowest Node the project's `engines.node` allows (or the version `.nvmrc` names; `20` there is any 20.x) |
| npm: its peers | The new version's `peerDependencies` (not the optional ones) with the versions installed beside it |
| npm: others' peers | The installed packages whose `peerDependencies` name it (react-redux 8 asking for react ^18 when react 19 is the newest) |

For the newest version that fits, npm's registry gives every version's needs in one answer. NuGet's are tried one at a time: the newest of each major version, at most six. When Bilge can't tell, it doesn't warn. That covers a project that says no Node, a package whose `.nuspec` names no frameworks or one Bilge doesn't know (Xamarin, UWP), and a range it can't read.

### Breaking changes

`/breaking <package>`, for a package whose newest version is a major one up, asks Claude what changes between the installed version and the newest that matters for this code. Bilge searches the project's source for the lines that import it (`import`, `require`, `import()`; for NuGet `using`, `open`, `Imports`; up to 80 lines from 4,000 files, never in `node_modules`, `bin` or `obj`), and gives Claude those, both versions, the package's registry page and its repository. Claude may read the project's files and fetch a page (its release notes or changelog), and changes nothing. The answer shows in the viewer: how much work the move is, each breaking change that touches this code with the lines and what to change, then the ones that don't. It needs Claude Code (`claude`) installed and signed in, and says so when it isn't; the lines it sends go to Claude as your own session would send them.

### Upgrading

`/upgrade` updates every direct package that has a newer version fitting the project: the newest one, or where that won't fit (as in [Will it fit?](#will-it-fit)), the newest one that does. It takes what the last `/outdated` said, asking it first when it hasn't been asked. One question lists them all; it also offers to copy the commands, or to see them. Then, in order:

1. The git working tree must be clean, or Bilge stops and says so, changing nothing.
2. A branch of its own: `bilge/updates-<yyyy-mm-dd>` (`-2`, `-3`… when the day's is taken).
3. Each update's command, with the exact version, in the folder of each manifest that asks for the package: `npm install <name>@<version>` (`yarn add`, `pnpm add`; `--save-dev` or `--dev` for a development one), `dotnet add "<project>" package <Name> --version <version>`.
4. The project's tests, where it has some: `npm test` (`yarn test`, `pnpm test`) where the package.json has a test script, `dotnet test` on the nearest `.sln` at or above a changed project, else on the project.
5. A commit, "Update N packages", and a line for Splice that checks the branch out there, to push it and open its pull request.

A window says how each step went. A step that fails stops it there, saying which; the branch stays, uncommitted, for you to finish or drop.

### Manifests

The lock files and projects found: their ecosystem, kind, how many packages, how many direct, how many vulnerable, and a note where one gives less than everything.

| Key | |
|---|---|
| `↵` or `l` | Its packages, in the Packages view |
| `t` | Copy it for Splice, whose history says who changed it |
| `y` | Copy its path |

## Slash commands

`/scan`, `/audit [fresh]` (`fresh`: not from the cache), `/outdated [all]`, `/fix <package|advisory>`, `/upgrade` (above), `/breaking <package>` (above), `/why <package>`, `/ignore <advisory|package>`, `/unignore [advisory|all]`, `/deny [licence…|none]` (the licences to flag: SPDX ids, or their start, `GPL-` for every GPL; with an `OR`, only when every choice is), `/packages [all|direct|outdated|flagged]`, `/sbom [file]` (`sbom.cdx.json` in the folder unless named; asks before replacing one), `/report [file]` (the audit as Markdown, `alt+y` copies it for a pull request; with a file, writes it, asking before replacing one), `/move <folder>`, `/env [name]` (below), `/take <family:v1:…>` (an image from Wharf, below), `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

## In a pipeline

```
bilge audit [folder] [--fail-on critical|high|medium|low|none] [--json]
bilge sbom [folder] [-o file]
bilge report [folder] [-o file]
```

`bilge audit` prints each finding with its advisories and where it is, then the counts. It asks OSV afresh, never from the cache. It exits `1` when a finding is as bad as `--fail-on` (`high` by default), `0` otherwise, and `2` when it couldn't run (OSV unreachable, a bad option). `--json` prints `{ dir, packages, manifests, counts, findings }`. The advisories ignored with `/ignore` (in `~/.bilge/config.json`) are left out. `bilge sbom` writes CycloneDX 1.5 JSON: every package with its purl, licence and scope (`optional` for development ones), and the advisories against them. `bilge report` prints the same Markdown as `/report` (or writes it with `-o`).

```yaml
# Azure Pipelines or GitHub Actions, after npm ci / dotnet restore
- run: ./bilge audit --fail-on high
```

## The family

What changes a project (a fix) and what an audit found go to the family's activity log, so `/timeline` in the others shows when the advisories changed; Nibs's mood (worried while there's a critical or high advisory) goes to the others' mascots. `t` hands Splice a `file` context: with a package's line, Splice blames it; for a manifest, its history. Bilge takes an `image` context from Wharf (below); any other it says whose it is. The `familyMoods` setting turns the moods and the activity log off.

## Container images

Wharf hands Bilge an image (`/take family:v1:image:…`, pasted or typed into the prompt; inside Fleet it arrives by itself). Bilge lists the image's operating-system packages without a shell inside it and without running it: `docker create <image>` makes a container that never starts (pulling the image if need be), `docker cp` copies the package database out of it (`/var/lib/dpkg/status` for Debian and Ubuntu, `/lib/apk/db/installed` for Alpine, `/var/lib/dpkg/status.d` for distroless) and `/etc/os-release`, and `docker rm` removes the container again.

The packages are audited like any manifest's, as OSV knows them: by source package (glibc, not libc6) in the distribution's ecosystem (`Debian:12`, `Ubuntu:22.04:LTS`, `Alpine:v3.20`), with dpkg's way of comparing versions for the fixes. The image is a manifest of its own in Manifests (`image <name>`), and stays through `/scan` and `ctrl+r` until Bilge reads another folder. `f` on one of its packages says to rebuild on a newer base or upgrade it in the Dockerfile; `/outdated` and `/upgrade` leave them alone. RPM-based images (Fedora, Red Hat, Rocky) and ones with no package database (scratch, distroless static) give no packages, and say so.

## Environments

A project that names its environments in `.fleet/project.json` (dev, staging, prod: the same file every app of the family reads) shows the chosen one in Bilge's header. `/env` says which it is, `/env <name>` switches every app to another. While a production one (`"prod": true`) is chosen, the frames are red, and a fix and `/upgrade` ask once more before they change anything.

While Fleet records a runbook, every slash command and `/take` line Bilge's prompt runs goes into it.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.bilge/config.json` (`BILGE_HOME` moves it): `theme`, `accent`, `mouse`, `autoAudit`, `ignore` (advisory ids), `deny` (licences), `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `bilge-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Python, Go, Cargo and Maven; RPM-based images; a framework set in `Directory.Build.props` rather than the project file; vulnerability reachability (whether the vulnerable code is called).
