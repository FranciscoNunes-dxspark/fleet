# Bilge

<img src="assets/logo.svg" alt="Nibs, the Bilge rat" width="96" align="right">

What a project depends on, in the terminal. Bilge reads a folder's npm, Yarn, pnpm and NuGet lock files, asks [OSV](https://osv.dev) which advisories are known against the exact versions in them, and lists the vulnerable packages worst first, with the version that fixes each one and the command that gets you there. It also shows every package's licence and how far behind it is, writes a CycloneDX SBOM, and runs headless in a pipeline (`bilge audit --fail-on high`).

It also flags what in the lock files could run or arrive from somewhere it shouldn't: a package whose name is one slip from a well-known one's, one that runs a script on install, one downloaded from a git repository, a URL or plain http ([Supply chain](#supply-chain), `bilge supply`). And `bilge security` runs all of it at once, with SARIF for GitHub's and Azure DevOps' code scanning.

It also reads the project's own code (`/code`, the Code view, `bilge code`): secrets written into files, code that runs what it's given, protections turned off and risky config, the first things an attacker looks for. It reads the files on this machine and nothing else.

Before an update, it says whether the new version fits the project: a NuGet package built for frameworks the project doesn't target, an npm package that needs a newer Node than the project says, or one whose peers won't take it.

It covers what Snyk, Mend, Socket or FOSSA are bought for in a small team: advisories, licences, outdated packages and an SBOM, from a free, open database, with nothing to sign up for. Only the packages' names and versions leave the machine: to `api.osv.dev`, and for `/outdated` to the npm and NuGet registries (and `/breaking` sends Claude the lines that import a package).

```
bilge                    # this folder and the ones under it
bilge ../shop            # another folder
bilge --demo             # a made-up project, to look around: nothing is read, asked or run
bilge audit --fail-on high          # in a pipeline: the findings, and exit 1 when one is high or worse
bilge sbom -o sbom.cdx.json         # a CycloneDX bill of materials
bilge report -o report.md           # the audit as Markdown
bilge code --fail-on high           # the folder's own files: secrets, risky code and config
bilge supply                        # typosquats, install scripts, packages from outside the registry
bilge security . --sarif bilge.sarif   # all three, and SARIF for code scanning
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

`1` Vulnerabilities · `2` Packages · `3` Manifests · `4` Code · `5` Log (what Bilge has run). `tab` goes round. On opening, Bilge reads the folder and asks OSV (turn that off with `"autoAudit": false`; `/audit` asks then); `ctrl+r` does both again.

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
| `a` | All of them, the direct ones, the outdated ones, the flagged ones (an advisory, a copyleft or denied licence, deprecated, a supply-chain finding), or the supply-chain ones (also `/packages supply`) |
| `u` | Ask npm and NuGet for the direct packages' newest versions and licences (`/outdated all`: every package) |
| `f` | Fix it, when it has advisories |
| `x` | Ignore its supply-chain findings (asks; kept as `supplyIgnore` in the settings) |
| `o` | Its page on npmjs.com or nuget.org |
| `t` | Copy where it is for Splice's blame |
| `y` | Copy `name@version` |
| `esc` | Every manifest's packages again, after `↵` in Manifests |

NuGet's lock files don't record licences: `/outdated` reads them from each package's `.nuspec`.

### Supply chain

What an advisory database doesn't know yet: the ways a malicious or tampered package gets into a project. Bilge reads them from the lock files as it reads the packages, asking nobody, and marks each package in Packages with the worst (`a` or `/packages supply` lists only those; `↵` says what, why and what to do):

| Mark | Rule | | Severity |
|---|---|---|---|
| `typo?` | `typosquat` | A name one slip away from a well-known package it isn't: two letters swapped, one letter changed, added or dropped, or only `-`, `_` or `.` different (`crossenv` for `cross-env`, `lodahs`, `Newtonsoft.Jsom`). Compared with about 250 of npm's and 60 of NuGet's most used names; a scoped package (`@scope/name`) is its publisher's and isn't compared, and a short name only for swapped letters and separators | high |
| `http` | `http-download` | Downloaded over plain `http://` (`resolved` in the lock file) | high |
| `source` | `not-from-registry` | Downloaded from a git repository, a tarball's URL, or a registry other than `registry.npmjs.org` and `registry.yarnpkg.com` (a private registry counts: `x`, or `"supplyIgnore": ["not-from-registry"]`, leaves those out) | medium |
| `script` | `install-script` | Runs a script on `npm install` (`hasInstallScript` in package-lock.json 2 and 3, `requiresBuild` in pnpm's lock files before 9) | low; medium when it's also one of the above |

Yarn's lock files don't say which packages have install scripts, nor does package-lock.json 1 or pnpm's lock file 9; Yarn 2 and newer only say where a package came from when it isn't npm's registry. A git or tarball dependency Bilge doesn't read as a package (Yarn's and pnpm's) is still flagged, and listed under `supply` on its own.

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

### Code

The project's own files, not its packages, read for what an attacker would look for first: `/code` (or `r` in the view) reads them, the findings worst first. It's a static read with patterns, like a first pass of a penetration test's source review: it runs nothing, sends nothing anywhere, and what it finds is for a person to look at, not proof of a hole (SQL put together from an identifier the code chose itself is flagged as much as one from a request).

| Kind | What's found |
|---|---|
| secret | Private keys; AWS, GitHub, Anthropic, OpenAI, Stripe live, Slack, Google and npm keys and tokens; Azure storage account keys and SAS tokens; JSON web tokens; passwords in URLs and connection strings; values named like a secret (`apiKey = "…"`); `ENV`/`ARG` secrets in a Dockerfile; `.pfx`, `.p12` and keystore files; a secret in a variable the bundler sends to the browser (below) |
| code | `eval` and `new Function`; `exec` with a command built from values (JavaScript), `os.system` and `shell=True` (Python); SQL built from values; HTML written from values (`innerHTML`, `dangerouslySetInnerHTML`, `v-html`); unsafe deserialisation (`pickle`, `yaml.load`, `BinaryFormatter`, `TypeNameHandling`); TLS certificate checks off; tokens not checked (`none`, `ValidateLifetime = false`); CORS open to any origin; MD5 and SHA-1; `Math.random` for a token |
| config | A container that runs as root; a base image without a version; `ADD` from a URL; a `.env` git doesn't ignore; `curl … \| sh`; a GitHub workflow putting an issue's or pull request's text into its script, and `pull_request_target`; `strict-ssl=false` |
| i18n | Translation coverage, below: a key used in code with no translation in a language (medium); a translation no code uses, and text in JSX not passed through `t()` (low) |

A secret is never shown whole: the line keeps its first four characters. In tests, fixtures, examples and demos a finding is one step milder. It reads the folder and every one under it, except `node_modules`, `.git`, `bin`, `obj`, `dist`, `build`, `out`, `target`, `vendor`, `coverage` and tools' caches, skipping lock files, binaries, minified files, files over 512 KB and a `.env` git ignores (where secrets belong, so it is read only for browser variables); it stops after 20,000 files.

**Secrets in the browser.** A bundler writes every variable named `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`, `GATSBY_`, `VUE_APP_` or `STORYBOOK_` into the JavaScript each visitor downloads. One holding a secret is a high finding (`frontend-secret`), wherever it is set: a `.env` file (a git-ignored one too, as the build still reads it), Vite's `define`, `next.config`'s `env`, Nuxt's, Astro's and Expo's configs, `package.json`'s scripts, a Dockerfile's `ARG`/`ENV`, compose's build args and environment, a workflow's `env`. A value is a secret when it has a known key's shape, is named like one (`SECRET`, `PRIVATE`, `PASSWORD`, `SERVICE_ROLE`…), comes from one (`${{ secrets.X }}`, `process.env.DB_PASSWORD`) or is random enough to be a key. Keys made for the browser are not: Stripe's and Clerk's publishable `pk_` keys, Firebase web and Google Maps browser keys (restrict them by referrer), Supabase's anon key, Sentry DSNs, Mapbox `pk.` tokens, PostHog project keys, captcha site keys and search-only keys. Locker marks the same variables in its key table.

**Translation coverage.** Where a project has translations (a locale folder: `locales/pt/*.js`, `public/locales/pt/common.json`, `i18n/pt.json`; or `Strings.pt-PT.resx`), the Code view reads its code against them: a key passed to `t()`, `tj()`, `$t()`, `i18n.t()` or .NET's `Localizer["…"]` that a language has no text for (`i18n-missing`, medium; English text as the key, as Keel's web app writes it, needs no English file, and when there is a source-language file its keys are checked against the others'); a translation no string in the code is the key of (`i18n-unused`, low: dead text, or a key built at run time, which you can ignore with `x`); and text in JSX, or a `placeholder`, `title`, `alt` or `aria-label`, never passed through `t()` (`i18n-plain-text`, low; a name such as `Keel` or `Azure DevOps`, a unit or `<code>` is left alone). Only the app that holds the locale folder is read for keys and text (`client/` for `client/src/locales/`), so an English-only app beside it isn't held to it; tests are left out. `"i18n"` in the settings changes the folder names, the functions and the source language (`{ "locales": ["locales"], "functions": ["t"], "source": "en" }`) or, `false`, turns it off. It is not a security finding: `bilge security` leaves it out.

| Key | |
|---|---|
| `↵` or `l` | What it is, the line, why it matters and the fix |
| `r` | Read the folder again |
| `x` | Ignore this rule in this file (asks; kept as `codeIgnore` in the settings, `rule:path`, or a rule's id for every file) |
| `t` | Copy the file and line for Splice, whose blame says who wrote it |
| `y` | Copy `file:line` |

A comment saying `bilge-ignore` on a line, or the line above it, leaves that line out; `bilge-ignore-file` in a file's first lines leaves the file out. Once `/code` has run, `/report` has a Code section (where each finding is, never the line).

## Slash commands

`/scan`, `/code` (above), `/audit [fresh]` (`fresh`: not from the cache), `/outdated [all]`, `/fix <package|advisory>`, `/upgrade` (above), `/breaking <package>` (above), `/why <package>`, `/ignore <advisory|package>`, `/unignore [advisory|all]`, `/deny [licence…|none]` (the licences to flag: SPDX ids, or their start, `GPL-` for every GPL; with an `OR`, only when every choice is), `/packages [all|direct|outdated|flagged|supply]`, `/sbom [file]` (`sbom.cdx.json` in the folder unless named; asks before replacing one), `/sarif [file]` (the audit's advisories, the code's findings, reading the code first if `/code` hasn't, and the supply chain's, as one SARIF file: `bilge.sarif` in the folder unless named; asks before replacing one), `/report [file]` (the audit as Markdown, `alt+y` copies it for a pull request; with a file, writes it, asking before replacing one), `/move <folder>`, `/env [name]` (below), `/take <family:v1:…>` (an image from Wharf, below), `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

## In a pipeline

```
bilge audit [folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
bilge code [folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
bilge supply [folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
bilge security [folder] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file]]
bilge sbom [folder] [-o file]
bilge report [folder] [-o file]
```

`bilge code` prints what the Code view would find, with the fix for each, and exits as `bilge audit` does (`1` when one is as bad as `--fail-on`); it reads the files and asks nobody. Its `--json` (`{ dir, files, truncated, counts, findings }`) leaves the lines out, as build logs are read widely. `codeIgnore` in the settings is left out. `bilge audit` prints each finding with its advisories and where it is, then the counts. It asks OSV afresh, never from the cache. It exits `1` when a finding is as bad as `--fail-on` (`high` by default), `0` otherwise, and `2` when it couldn't run (OSV unreachable, a bad option). `--json` prints `{ dir, packages, manifests, counts, findings }`. The advisories ignored with `/ignore` (in `~/.bilge/config.json`) are left out. `bilge sbom` writes CycloneDX 1.5 JSON: every package with its purl, licence and scope (`optional` for development ones), and the advisories against them. `bilge report` prints the same Markdown as `/report` (or writes it with `-o`).

`bilge supply` prints the [supply chain](#supply-chain)'s findings and exits the same way; `supplyIgnore` in the settings is left out. `bilge security` is the audit, the code and the supply chain together, each without what the settings ignore, OSV asked afresh. The `--json` of both is the one every app of the family prints for a security check, which Fleet's security overview adds up:

```json
{ "app": "bilge", "check": "security", "target": "/path/to/folder", "at": "2026-11-03T10:00:00.000Z",
  "counts": { "critical": 2, "high": 9, "medium": 6, "low": 3, "unknown": 0 },
  "findings": [{ "rule": "GHSA-xvch-5gv4-984h", "severity": "critical", "title": "minimist@1.2.5: Prototype pollution in minimist",
                 "where": "package-lock.json", "line": 48, "why": "…", "fix": "Move minimist to 1.2.6 or later.", "kind": "dependency",
                 "package": "minimist", "version": "1.2.5", "ecosystem": "npm", "aliases": ["CVE-2021-44906"], "fixed": "1.2.6", "url": "…" }] }
```

`kind` is `dependency` (an advisory: `rule` is its id, `where` the lock file and `line` the package's line in it, one finding per advisory), `secret`, `code` or `config` (the Code view's), or `supply`. A code finding's line is never in it.

`--sarif` writes SARIF 2.1.0 for code scanning, from `bilge audit`, `code`, `supply` and `security`: alone (or `--sarif -`) it's all that's printed; with a file (`--sarif bilge.sarif` or `--sarif=bilge.sarif`) the usual output prints as well. Put the folder before it (`bilge audit web --sarif out.sarif`), as what follows `--sarif` is its file. An advisory's rule is its id, at the package's line in its lock file; a code finding at its line, never with the line's text. The exit code is the same.

```yaml
# GitHub Actions: the findings in the repository's Security tab (code scanning)
permissions:
  security-events: write
steps:
  - uses: actions/checkout@v4
  - run: ./bilge security . --sarif bilge.sarif --fail-on none
  - uses: github/codeql-action/upload-sarif@v3
    with:
      sarif_file: bilge.sarif
      category: bilge
```

```yaml
# Azure Pipelines: the SARIF SAST Scans Tab extension shows what's published as CodeAnalysisLogs
- script: ./bilge security . --sarif $(Build.ArtifactStagingDirectory)/CodeAnalysisLogs/bilge.sarif --fail-on high
- task: PublishBuildArtifacts@1
  condition: always()
  inputs:
    PathtoPublish: $(Build.ArtifactStagingDirectory)/CodeAnalysisLogs
    ArtifactName: CodeAnalysisLogs
```

```yaml
# Azure Pipelines or GitHub Actions, after npm ci / dotnet restore
- run: ./bilge audit --fail-on high
- run: ./bilge code --fail-on high
```

## The family

What changes a project (a fix) and what an audit found go to the family's activity log, so `/timeline` in the others shows when the advisories changed; Nibs's mood (worried while there's a critical or high advisory) goes to the others' mascots. `t` hands Splice a `file` context: with a package's line, Splice blames it; for a manifest, its history. Bilge takes an `image` context from Wharf (below); any other it says whose it is. The `familyMoods` setting turns the moods and the activity log off.

## Container images

Wharf hands Bilge an image (`/take family:v1:image:…`, pasted or typed into the prompt; inside Fleet it arrives by itself). Bilge lists the image's operating-system packages without a shell inside it and without running it: `docker create <image>` makes a container that never starts (pulling the image if need be), `docker cp` copies the package database out of it (`/var/lib/dpkg/status` for Debian and Ubuntu, `/lib/apk/db/installed` for Alpine, `/var/lib/dpkg/status.d` for distroless) and `/etc/os-release`, and `docker rm` removes the container again.

The packages are audited like any manifest's, as OSV knows them: by source package (glibc, not libc6) in the distribution's ecosystem (`Debian:12`, `Ubuntu:22.04:LTS`, `Alpine:v3.20`), with dpkg's way of comparing versions for the fixes. The image is a manifest of its own in Manifests (`image <name>`), and stays through `/scan` and `ctrl+r` until Bilge reads another folder. `f` on one of its packages says to rebuild on a newer base or upgrade it in the Dockerfile; `/outdated` and `/upgrade` leave them alone. RPM-based images (Fedora, Red Hat, Rocky) and ones with no package database (scratch, distroless static) give no packages, and say so.

## Environments

A project that names its environments in `.fleet/project.json` (dev, staging, prod: the same file every app of the family reads) shows the chosen one in Bilge's top line. `/env` says which it is, `/env <name>` switches every app to another. While a production one (`"prod": true`) is chosen, the frames are red, and a fix and `/upgrade` ask once more before they change anything.

While Fleet records a runbook, every slash command and `/take` line Bilge's prompt runs goes into it.

## Mouse

Click a tab, a row, or a place in the command box (`/` opens it over the view; a click outside it closes it); double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.bilge/config.json` (`BILGE_HOME` moves it): `theme`, `accent`, `mouse`, `autoAudit`, `ignore` (advisory ids), `codeIgnore` (code findings, `rule:path` or a rule), `i18n` (the translation check's `locales`, `functions` and `source`, or `false`), `supplyIgnore` (supply-chain findings: a rule, a package's name, or `rule:package`), `deny` (licences), `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `bilge-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Active testing of a running app (the Code view reads files; Hail sends requests); Python, Go, Cargo and Maven; RPM-based images; a framework set in `Directory.Build.props` rather than the project file; vulnerability reachability (whether the vulnerable code is called); how new a package or version is, for the supply chain.
