<p align="center"><img src="assets/logo.svg" width="120" alt="Fleet's mark: two chevrons and a bar, a prompt and its cursor, each cut across like a waterline"></p>

# Fleet

The family's terminal apps in one terminal: [Splice](../splice) (git), [Trawl](../trawl) (SQL),
[Sonar](../sonar) (Azure), [Bosun](../bosun) (a project's processes), [Hail](../hail) (HTTP),
[Locker](../locker) (secrets and configuration), [Mooring](../mooring) (files and commands on a server over SSH), [Bilge](../bilge) (a project's dependencies: advisories, licences, what's behind), [Chart](../chart) (infrastructure as code: a Terraform plan or a Bicep what-if, drift, state), [Wharf](../wharf) (containers), [Keel](../keel) (Azure DevOps, its terminal app), [Helm](../helm) (PowerShell scripts), [Lantern](../lantern) (a web page audited in a headless Chrome, and its domains), [Drill](../drill) (a project's tests, failures first), [Ballast](../ballast) (what a production build ships and weighs) and [Lookout](../lookout) (the HTTP and HTTPS traffic a browser or a server sends). Each runs exactly as it does by itself, with its own
settings, sign-ins and keys; Fleet shows one at a time and switches between them with `ctrl+b`, as
tmux does with its windows. A bar at the bottom shows the ones you choose ([Choosing the apps](#choosing-the-apps)): every one, until you choose.

```
 1 Splice ●  2 Trawl ●  3 Sonar ○  4 Bosun ○  5 Hail ✕1  6 Locker ○  7 Mooring ○  8 Bilge ○  9 Chart ○   ctrl+b ? help
```

`●` runs, `○` hasn't started yet, `✕` and a number exited with that code. The app on screen has its
tab in its own colour.

A tab off screen gets a badge when its app needs you: `!` when it has become worried or sad since you
last looked at it (Bosun's process crashed or gave up, Hail's checks failed,
Sonar ran into trouble), and a count of the alerts it logged since (Sonar's watches going
over their threshold, Bosun's crashes). The badge is orange, and red when what it counts includes an
error or a crash. The bar says why for a moment and the terminal's bell rings once
as a badge appears; looking at the space clears it. Fleet reads what the apps tell each other (their
moods and the family's activity log, in `~/.family` or `FAMILY_HOME`) every few seconds, so an app
whose moods are turned off in its settings never gets a `!`.

```
 1 Splice ●  2 Trawl ●  3 Sonar ● 2  4 Bosun ● !  5 Hail ○  6 Locker ○  7 Mooring ○  8 Bilge ○  9 Chart ○   Bosun: api crashed
```

At the right of the bar, before the hint, Fleet says what it's doing itself: `◆2 proposed` when Claude
left lines for you ([Claude proposes](#claude-proposes-you-press-)), a red `● REC` while a runbook is
being recorded ([Recording a runbook](#recording-a-runbook)), and the project's environment, white on
red when it's production ([Environments](#environments)). The tabs give way to it on a narrow screen.

```
 1 Splice ●  2 Trawl ●  3 Sonar ●  4 Bosun ●  5 Hail ○  6 Locker ○  7 Mooring ○  8 Bilge ○  9 Chart ○   ◆1 proposed ● REC prod ctrl+b ? help
```

## Install

**On Windows**, download `fleet-windows-x64-setup.exe` from the [latest release](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=fleet-v&expanded=true)
and run it. It installs Fleet for you (no administrator needed), with a Windows Terminal of its own to
open in, and adds **Fleet** to the Start menu. It asks which folder Fleet should open in: the one that
holds your repositories and projects. That terminal has a font with every character the apps draw
(Maple Mono NF CN when you have it installed, else Cascadia Mono), and ctrl+c and ctrl+v copy and paste. Run
the setup again to pick another folder; your changes to the terminal's settings
(`%LOCALAPPDATA%\Programs\Fleet\terminal\settings\settings.json`) are kept.

Started some other way on Windows, as the bare `fleet-windows-x64.exe` opens in Windows' own console,
whose one font lacks many of the apps' characters: Fleet draws lookalikes in their place there.

**Elsewhere**, or for the bare executable, download `fleet` for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=fleet-v&expanded=true)
and put it on your PATH. It is one executable with all sixteen apps inside, so it's the only download you
need. It checks for a new version once a day and installs it by itself; the new version starts the
next time you open Fleet. (The apps inside don't update themselves: Fleet updates them together. `/update` in any of them asks Fleet to look for a new version now and install it, saying "Installing Fleet <version>…" in the bar while it does.)

From a checkout of the [fleet repository](https://github.com/FranciscoNunes-dxspark/fleet) (Node 22 or later):

```bash
npm install                  # at the repository's root
cd apps/fleet
npm start                    # or: node bin/fleet.js splice
```

From a checkout, Fleet runs each app from its own folder in the checkout.

## Use

```bash
fleet               # opens the app you used last (Splice the first time)
fleet trawl         # opens Trawl
fleet hail --demo   # opens Hail, started with --demo
fleet hail api.http # anything after the app's name is that app's own arguments
fleet query.sql     # a file opens in the app for it: .sql in Trawl, .http in Hail
```

The Windows setup can add Fleet to Explorer's "Open with" for `.sql` and `.http` files (a task,
ticked by default); it runs `fleet <file>` in Fleet's terminal.

An app starts the first time you switch to it, in the folder you started Fleet in, and keeps running
when you switch away. Quitting one (its own `q`) leaves its space saying so: `↵` starts
it again.

## Keys

Everything you type goes to the app on screen, as it would by itself: keys, pastes and the mouse.
Only Fleet's prefix is Fleet's, `ctrl+b` (as tmux's), and the key after it. `ctrl+]`, the prefix
Fleet had first, works as well: it's hard to type on many keyboards (`AltGr`+`9` and more on a
Portuguese one), hence `ctrl+b`. Another key can be the prefix: `"prefix": "ctrl+a"` in
`~/.fleet/host.json`, or `FLEET_PREFIX=ctrl+a`; any `ctrl` and a letter but those a terminal keeps for
itself (`c`, `h`, `i`, `j`, `m`, `q`, `s`, `z`), or `ctrl+]`, `ctrl+\`, `ctrl+^`, `ctrl+_`,
`ctrl+space`. One Fleet can't use is said in the bar, and `ctrl+b` is the prefix. The tables below
say `ctrl+b`; read yours there.

| Keys | What they do |
| --- | --- |
| `alt+1`–`alt+9` | Switch to that space (no prefix; terminals don't send `ctrl+alt` with a digit) |
| `ctrl+b` `1`–`9` | Switch to that space, counting the ones the bar shows |
| `ctrl+b` `s` `t` `o` `b` `h` `l` `u` `g` `c` `d` `k` `i` `j` `v` `z` `y` | Switch to Splice, Trawl, Sonar (o), Bosun, Hail, Locker, Mooring (u), Bilge (g), Chart (c), Wharf (d), Keel (k), Helm (i), Lantern (j), Drill (v), Ballast (z), Lookout (y): any app, shown in the bar or not |
| `ctrl+b` `a` | Choose which apps the bar shows ([Choosing the apps](#choosing-the-apps)) |
| `ctrl+b` `]` or `n` | The next space |
| `ctrl+b` `p` | The previous space |
| `ctrl+b` `\|` or `\` | Split the screen: the app on screen and the one before it side by side (`\|` again puts it back) |
| `ctrl+b` `tab`, `←` or `→` | Split, the other pane |
| `ctrl+b` `x` | Split, back to one app on screen: the one with the keys |
| `ctrl+b` `m` | Move the fleet to another folder: a list of the ones moved to lately and those beside this one, or one typed; every running app starts again there |
| `ctrl+b` `ctrl+b` | Send `ctrl+b` to the app (the prefix twice is the prefix for the app; `ctrl+]` `ctrl+]` sends `ctrl+]`) |
| `ctrl+b` `r` | The runbooks: the one you were in, else the list ([Runbooks](#runbooks)) |
| `ctrl+b` `R` | Start recording a runbook from what the apps run; again, stop and open it ([Recording a runbook](#recording-a-runbook)) |
| `ctrl+b` `f` | Follow a request across the apps ([Following a request](#following-a-request)) |
| `ctrl+b` `e` | The project's environment, for every app at once ([Environments](#environments)) |
| `ctrl+b` `w` | What changed lately, and Claude's take on why something broke ([What changed?](#what-changed)) |
| `ctrl+b` `P` | Claude's proposals: lines for an app's prompt, handed over with `↵` ([Claude proposes](#claude-proposes-you-press-)) |
| `ctrl+b` `S` | Security: every app's check for the project, as one overview ([Security](#security)) |
| `ctrl+b` `q` | Quit Fleet, stopping every app (it asks first when any is running) |
| `ctrl+b` `?` | The keys |

`P`, `R` and `S` are capitals: `p` is the previous space, `r` the runbooks and `s` Splice. Any other key after `ctrl+b` cancels it. A click on a tab in the bar switches to it, whatever the app on screen does with the mouse: Fleet keeps clicks on for the bar, even for an app with its mouse turned off or one that has exited, and passes clicks on only to an app that wants them. With an app's mouse off, select text the terminal's own way while Fleet runs: most terminals select with shift held down.

## In its own window

`desktop/` at the repository's root is a prototype of Fleet in a window of its own (a Tauri app, its README says how to run it). There the bar isn't a row of the terminal: the window draws it as tabs along the top, with the environment, `● REC` and the proposals beside them, and a strip along the bottom that carries the notices, the prefix's keys, the folder being asked for and the quit question, with buttons for what changed, following a request, the runbooks, security, the environment, the split and the help. A click on any of them types the prefix and its key, so everything the keys do still works. The panels (the environment, what changed, the runbooks, the proposals, security, the apps, a request followed) and the help open as the window's own overlays rather than boxes in the terminal: a click on a row moves to it, a double click opens it as `↵` would, and each key in the panel's hint is a button. The apps get the terminal's every row.

The window adds more of its own:

- **Toasts and notifications:** when an app off screen needs you, a toast, and the system's notification when the window is in the background.
- **Badges that say why:** "Bosun ! api crashed".
- **A palette** (ctrl+k) over every app's slash commands and Fleet's actions.
- **Charts** on what changed, a request followed and security.
- **Side panels:** projects to move the fleet to, and Claude to ask about a symptom.
- **Settings.**

The window's README has the details.

## Your own tools

A tool of your team's can be a tab too, configured in `~/.fleet/host.json`:

```json
"spaces": [{ "id": "deploys", "title": "Deploys", "command": ["node", "/opt/tools/deploys.js"] }]
```

It runs as the family's apps do. Its number on the bar reaches it (`ctrl+b 7`), and so does a click on its tab. Every letter is already taken by an app or by Fleet, so a tool gets none.

- **What it must do:** Fleet gives it pipes, not a terminal. [docs/hosted-apps.md](docs/hosted-apps.md) says what the tool must do there.
- **Badges:** a mood file of its own gives its tab badges and toasts, as the apps' do.
- **Example:** [examples/hello-tool.js](examples/hello-tool.js) is a whole tool in sixty lines of Node with no dependencies.

## Choosing the apps

`ctrl+b` `a` lists every app with a box beside it: `space` or `↵` shows or hides the one under the cursor in the bar, and the choice is kept in `~/.fleet/host.json` (`"apps": ["splice", "bilge", …]`). The numbers `1`–`9` and `n` `p` go through the apps shown, in their order. A hidden app is still there: its letter (`ctrl+b` `k` for Keel), a sibling handing it something, a runbook's step or `fleet keel` opens it, and it shows in the bar while it runs. One app at least stays in the bar.

```
 1 Splice ●  2 Bilge ○  3 Hail ○  4 Keel ●   ctrl+b ? help
```

## Split

`ctrl+b |` shows two apps side by side, each in half the width (less a column for the divider between
them): the app on screen on the left, and the one you were in before it on the right (the next one
when there was none). Each draws as it would on a screen of that size. The keys go to one of them, the
pane with the divider in its colour and its tab filled in the bar; the other's tab is underlined.
`ctrl+b tab` (or `←`, `→`) or a click in the other pane moves the keys there, and the mouse works in
either pane for an app that uses it. Switching to an app while split (`ctrl+b 3`, a click on its tab)
puts it in the pane with the keys, or moves the keys to it when it's in the other one already; a line
handed to an app in neither pane opens it in the other pane, so the one it came from stays in sight.
`ctrl+b x` (or `|` again) goes back to the app with the keys on the whole screen.

The screen splits only when it's at least 40 columns wide, and goes back whole when it's made narrower
than that.

## Moving the fleet

The apps start in the folder you started Fleet in. `ctrl+b m` moves them all to another one: a list
of the folders the fleet moved to lately (marked `lately`, the newest under the cursor) and then the
ones beside this one, those that look like projects (a git checkout, a `package.json`, a solution, a
`.http` file…) in bold; `j` `k` move, `↵` moves there. Its first row, **Type a folder…**, asks for one
in the bar instead, with the folder they're in filled in (`tab` completes a folder's name, `~` is your
home folder, and a relative path is from the folder they're in now). On `↵` every app that runs is stopped,
as its own `q` would, and started again in the new folder; the ones that haven't started yet start
there when they do, and an exited one when you press `↵` in it. `esc` leaves everything where it is.
An app can ask for a move too (the kit's `askHostToMove`): the bar then asks the same question with
that app's folder filled in, and nothing moves until you press `↵`. Fleet keeps the last eight folders
for the list (`"folders"` in `~/.fleet/host.json`), but not where it was: the next `fleet` starts
where you start it.

## Hand-offs

The apps hand each other things as a line to paste into the other's prompt: Sonar's `T` copies a
`/azure-sql …` line for Trawl, Splice's `Y` a `/take …` for Sonar, and so on. Inside Fleet that's one
step: Fleet switches to the app the line is for (starting it if it isn't running), and types the line
into its prompt. Press `↵` to run it. The line is still copied too. A line that several apps could take
(a log line, which Sonar, Hail and Bosun all read; a commit, for Sonar) goes to the first of them that's running, else
stays on the clipboard only.

## Runbooks

A runbook is a Markdown file whose steps run in the apps: each step is a line for one app's prompt (a
slash command, or a `family:v1:` line an app copied), in a fenced code block named after the app:
` ```trawl `, ` ```sonar `, ` ```hail `, ` ```bosun `, ` ```splice `, ` ```locker ` or ` ```mooring `. Each
line in the block is a step of its own. The text before a block explains its first step; the first
`#` heading is the runbook's title (else its file name). Other code blocks are just text.

````markdown
# Is the API healthy?

Start the API and wait for its port to open.

```bosun
/start api
```

Ask its health page, then look for the last hour's failed requests in Application Insights.

```hail
/send health
```

```sonar
/kql requests | where timestamp > ago(1h) and success == false
```
````

Fleet reads them from `.fleet/runbooks/*.md` in the folder you started it in and in that folder's git
checkout, and from `~/.fleet/runbooks/` (`FLEET_HOME` moves it). `ctrl+b` `r` lists them (over the app
on screen, which carries on behind it); `↵` opens one: its steps with their text, the cursor on the
next one. `↵` hands that step to its app as a [hand-off](#hand-offs): Fleet switches to the app, starting
it if need be, and types the line into its prompt, where `↵` runs it. The step is marked `✓`, and
`ctrl+b` `r` brings you back to the runbook where you left it, the cursor on the next step; Fleet keeps
each runbook's progress until it quits.

| Keys | In the runbooks |
| --- | --- |
| `↑` `↓` or `j` `k` | Move |
| `↵` | Open the runbook; in one, hand the step to its app |
| `l` or `⌫` | Back to the list |
| `n` | In the list: draft a runbook from the last hour |
| `esc` | Close |

`n` writes `.fleet/runbooks/<date>-draft.md` in the folder Fleet started in, from what the apps did in
the last hour (the family's activity log: pushes, restarts, writes to a database, crashes). The log says
what happened in words, not the commands that did it, so the draft lists what happened and leaves an
empty step for you to fill in.

### Recording a runbook

`ctrl+b` `R` starts recording, and the bar shows a red `● REC`: from then on every app keeps the
commands you run in it (the slash commands and the `/take` lines it's handed; never a `!` shell, SQL or
git line, and secrets masked). `ctrl+b` `R` again stops, and writes them as
`.fleet/runbooks/<yyyy-mm-dd-hhmm>-recorded.md` in the fleet's folder: a title, then the steps, the
commands one app ran in a row in one block named after it, each block after a line saying when it ran.
Fleet opens it in the runbooks, ready to run again step by step; edit it to say what each step is for.
When no app ran anything, Fleet says so and writes nothing.

````markdown
# Recorded 2026-11-02 14:05

Recorded by Fleet from 14:05 to 14:20: the commands the apps ran, in order. Edit it to say what each step is for.

At 14:05:09, in Bosun:

```bosun
/start api
```

At 14:06:30, in Hail:

```hail
/send health
```
````

## Environments

A project names its environments once, for every app, in `.fleet/project.json` (in the folder Fleet runs
in, or one above it up to its checkout's root): what dev, staging or prod means to each app, as a Trawl
connection, Hail's env, a Sonar app or a key vault. `ctrl+b` `e` lists them, the one chosen marked `●`
and production in red; `↵` chooses another, and every app moves to it by itself (they watch the choice,
kept per project in `~/.family/env.json`). The bar shows the one chosen, white on red for production,
where every app draws red and asks before it changes anything. With no file, the panel shows how to
write one:

```json
{
  "default": "dev",
  "environments": {
    "dev":  { "trawl": { "connection": "Shop (dev)" }, "hail": { "env": "dev" } },
    "prod": { "prod": true, "sonar": { "app": "shop-api" }, "locker": { "vault": "kv-shop" } }
  }
}
```

What each app reads from its section is in its own README. Nothing secret goes in the file: it names
things, never a password.

## What changed?

`ctrl+b` `w` answers "it broke: what changed?" for the project: one timeline of the last 6 hours, newest
first, of what the apps did (the family's activity log: pushes, writes to a database, restarts,
environment switches), the repository's commits and merges, and the crashes and restarts in Bosun's
recordings. Above it, the symptoms: the apps that are worried now, and why. `-` and `+` narrow and widen
it (1 hour, 6, 24), `j` `k` move.

`c` asks Claude (Claude Code's `claude`, signed in as you are; nothing is sent anywhere else) to rank the
likely causes of the symptom, given the timeline: the worried apps' reasons to start from, or one you
type. Its answer shows in the panel. Without `claude` on your PATH, the panel says so. `esc` closes.

| Keys | In what changed |
| --- | --- |
| `-` `+` | A narrower or wider window: 1h, 6h, 24h |
| `↑` `↓` or `j` `k` | Move through the timeline |
| `c` | Ask Claude for the likely causes; `↵` asks, `esc` goes back |
| `esc` | Close |

## Claude proposes, you press ↵

Claude Code, through `fleet mcp`'s `propose` tool, can leave a line for one app's prompt with why: a
query for Trawl, a search for Sonar, a restart for Bosun. It never runs it. The bar shows `◆1 proposed`
(and says so once), and `ctrl+b` `P` lists them, each with its app, its line and why. `↵` hands one to
its app as a runbook step is: Fleet switches to the app, starting it if need be, and types the line into
its prompt, where your own `↵` runs it (Fleet never presses it for an app). `x` dismisses one. Either
is written back, so Claude can ask what became of it (`proposal_status`). A proposal nobody acts on
drops off after an hour.

| Keys | In the proposals |
| --- | --- |
| `↑` `↓` or `j` `k` | Move |
| `↵` | Hand the line to its app (typed into its prompt, not run) |
| `x` | Dismiss it |
| `esc` | Close |

## Security

Each app checks what it knows for security problems, and Fleet adds them up for the project: `ctrl+b` `S` shows the last overview (`r` runs the checks again, in the background; `↵` on a finding says why it matters and how to fix it), and `fleet security` does the same without the screen, for a pipeline.

| App | What it checks | Runs |
|---|---|---|
| Bilge | Known vulnerabilities in the dependencies, secrets and risky code in the project's files, the supply chain (typosquats, install scripts, packages from outside the registry) | always |
| Splice | Secrets ever committed, in the git history | always |
| Chart | Insecure infrastructure in `.tf` and `.bicep` files (public storage, open ports, TLS) | always |
| Hail | The running web app: TLS, headers, cookies, CORS, exposed paths, endpoints answering without their credentials. Only for an app you own or may test | `"hail": "https://…"` or a `.http` file |
| Sonar | The Azure subscription's setup: storage, NSGs, App Service, SQL, Key Vault, Redis, registries, Defender | `"sonar": { "subscription": "…", "resourceGroup": "…" }` |
| Locker | Expiring and stale vault secrets, plain-text secrets in app settings, secrets in files git tracks | `"locker": true` or `{ "app", "vault" }` |
| Mooring | A server over SSH: public ports, sshd, updates, firewall, accounts, end of life | `"mooring": ["web1", "deploy@db1"]` |
| Wharf | Containers as they run: privileged, the Docker socket mounted, public databases, secrets in their environment | `"wharf": true` or `{ "compose": "compose.yaml" }` |
| Keel | Azure DevOps: plain-text secret variables, branches without policies, connections open to every pipeline | `"keel": "Project"` |
| Lantern | The web app's pages from outside (security headers, cookies, the certificate, mixed content, source maps served) and its domains (DNS and CAA, redirects to HTTPS) | `"lantern": true` (the pages in `lantern.json` and the environments' `"lantern"` sections) or `"https://…"` |
| Ballast | The production build: source maps shipped, secrets in the built files | a build output (`dist/`, `build/`, `out/`) or `ballast.json` in the project, else `"ballast": true` |
| Lookout | The traffic it captured: tokens over plain HTTP, cookies without `Secure`, credentials in query strings | `"lookout": true` (its last session) or `"capture.har"` |

What runs comes from a `"security"` section in `.fleet/project.json`, and the chosen environment's own `"security"` over it (so `prod` can name another address for Hail); `"skip": ["chart"]` leaves a check out. Every check only reads; Hail's sends the requests a scan needs (GET, HEAD, OPTIONS, TRACE), and refuses a production environment headless unless its section says `"production": true`.

```json
{
  "environments": { "dev": {}, "prod": { "prod": true, "security": { "hail": "https://shop.example.com" } } },
  "security": { "hail": "https://dev.shop.example.com", "sonar": { "subscription": "Contoso" }, "mooring": ["web1"] }
}
```

```
fleet security [folder] [--only bilge,splice] [--json] [--sarif [file]] [--fail-on critical|high|medium|low|none] [--demo]
```

It prints a line per check and the findings worst first, and exits `1` when one is as bad as `--fail-on` (`high` by default), `2` when a check couldn't run (each one says why: not signed in, no answer). `--json` is `{ project, environment, at, checks, left, counts, findings }`, each finding with its `app`; `--sarif` is one file with a run per app, for GitHub's or Azure DevOps' code scanning. `--demo` runs each app on its demo data. The last overview is kept in `~/.fleet/security/`, for `ctrl+b` `S` and `fleet mcp`'s `security_overview`. Each app also has its own check (`bilge security`, `splice security`, `hail security`, … and a view or command inside it); their READMEs say more.

## Following a request

`ctrl+b` `f` asks for a request, operation or trace id (offering the last one a hand-off carried, as
Bosun's `t` copies a log line with its request), then asks every running app that reads log lines
(Sonar, Hail and Bosun) to look for it: Fleet types a `/take` of a log line carrying the id into
each one's prompt, without switching to it. The panel lists the apps it asked; `↵` on one switches
there, and `↵` in its prompt runs the search (Sonar in Application Insights, Hail in its history, Bosun
in its crew's logs). Fleet never presses `↵` for an app: one might
have a question open that a stray `↵` would answer.

Below them, the panel shows what Fleet finds itself, oldest first: the family's activity log entries
that mention the id, and the lines of Bosun's recorded sessions of the last day (`~/.bosun/sessions`,
`BOSUN_HOME` moves it) that do, each with its app and where it came from. `f` asks for another id,
`esc` closes.

## Claude Code reads the whole fleet (MCP)

`fleet mcp` runs Fleet as an MCP server, so Claude Code, working in a repository, can see what the
apps see there: the git history, the processes Bosun ran, Hail's requests and the answers they got,
Application Insights, Azure DevOps, containers and pods, the databases, and what the apps did lately.
Register it once:

```bash
claude mcp add --scope user fleet -- fleet mcp
```

(From a checkout: `claude mcp add --scope user fleet -- node C:\Team\fleet\apps\fleet\bin\fleet.js mcp`.)
It reads for the folder Claude Code starts it in; `fleet mcp --project <dir>` names another.

| Tools | What Claude can read |
| --- | --- |
| `git_status`, `git_log`, `git_show`, `git_diff`, `git_blame`, `git_branches` | The repository, through Splice's own git (never a prompt, never the index lock): the branch and changes, commits (`graph` draws them), one commit's diff, the working tree's diff, who changed a range of lines, the branches and tags |
| `bosun_crew`, `bosun_log`, `bosun_search` | The project's processes as Bosun ran them, from its recordings (`~/.bosun/sessions`; the run going on now is recorded as it happens): each one's state, port, health and trouble, the last lines of one, lines by text or by request id |
| `hail_requests`, `hail_history` | The requests in the project's `.http` files, their `{{variables}}` left as written, and the responses Hail kept for them |
| `sonar_components`, `sonar_problems`, `sonar_incident`, `sonar_query` | Application Insights, through your `az login`, in Sonar's last subscription: the problems, one told whole (its stack, its operation, the SQL that failed), and any KQL query |
| `trawl_list_connections`, `trawl_list_tables`, `trawl_describe_table`, `trawl_run_query` | Trawl's own MCP tools (`trawl mcp`, below the surface), with every rule they have: your saved connections, each one's Claude access level, writes refused, every query rolled back, all of it in Trawl's History |
| `family_timeline`, `family_moods`, `family_wiring` | What the apps did that changed something (this project's, or every project's), how their mascots feel and why (a quick read of what's wrong now), and what the project points at (addresses and connection strings, masked) |
| `drill_tests` | What the tests did in [Drill](../drill)'s last runs: passed and failed counts, the tests that failed (runner, file and line, name) and the flaky ones. It runs nothing |
| `security_overview` | The last [security overview](#security): each app's check with its counts, then the findings worst first with their fix (`app`, `severity` and `limit` narrow it). It doesn't run the checks |
| `what_changed` | [What changed?](#what-changed) as text: the worried apps on top, then the activity log, commits and merges, and Bosun's crashes and restarts of the last `hours` (6 by default, a week at most), newest first |
| `propose`, `proposal_status` | A line for one app's prompt, with why, for you to hand over in Fleet or dismiss ([Claude proposes](#claude-proposes-you-press-)); and what became of it |

- **It only reads**, but for `propose`. No other tool changes anything: no git command that writes, no
  restart, no request sent, no query but reads (Trawl refuses writes and rolls back; Application
  Insights' query API can't change anything, and a control command is refused). `propose` writes a
  proposal, one small file in the family's folder, and what it writes changes nothing by itself: it is
  one slash command of a family app (never a `!` shell, SQL or git line, one line of at most 500
  characters, secrets masked) that waits for you to press `↵` in Fleet, which types it into the app's
  prompt, and `↵` again in the app, which runs it.
- **Never a secret**, as everywhere in the family: everything a tool answers goes through the same
  masking as the activity log and `/wiring` (passwords in connection strings and URLs, bearer tokens,
  values whose names say they're secret come back as `••••`), and Hail's history never kept the
  secrets a request used or the headers that carry credentials.
- Answers are bounded (40,000 characters at most, less by default for diffs and logs); a cut one
  says so, and how to ask for less.
- Sonar signs in as it does itself, with nothing to configure here. When it can't (no
  `az login`), the tool says what to do: usually, open the app once.
- Trawl's tools are `trawl mcp` itself, started by Fleet
  when Claude first lists or calls them; when Trawl can't start, its tools are left out.
- `fleet mcp --demo` puts Sonar and Trawl on their demo data, to try it.

## Notes

- Fleet keeps the app it opened last in `~/.fleet/host.json` (`FLEET_HOME` moves the folder).
  `FLEET_NO_UPDATE_CHECK=1` turns the update check off. `FLEET_NO_BELL=1` (or `"bell": false` in
  `host.json`) keeps the bell quiet when a badge appears.
- Each app keeps its settings where it always does (`~/.splice`, `~/.trawl`, …), so they're the same
  inside Fleet and out.
- Colours follow your terminal's: 24-bit where it has them, else the nearest of 256.
