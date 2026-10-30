<p align="center"><img src="assets/logo.svg" width="120" alt="A container ship, its bridge at the stern and a stack of steel boxes forward"></p>

# Fleet

The family's terminal apps in one terminal: [Splice](../splice) (git), [Trawl](../trawl) (SQL),
[Sonar](../sonar) (Azure), [Bosun](../bosun) (a project's processes), [Hail](../hail) (HTTP),
[Keel](../keel)'s terminal app (Azure DevOps), [Wharf](../wharf) (containers) [Locker](../locker) (secrets and configuration) and [Mooring](../mooring) (files and commands on a server over SSH). Each runs exactly as it does by itself, with its own
settings, sign-ins and keys; Fleet shows one at a time and switches between them with `ctrl+b`, as
tmux does with its windows. A bar at the bottom shows them all.

```
 1 Splice ●  2 Trawl ●  3 Sonar ○  4 Bosun ○  5 Hail ✕1  6 Keel ○  7 Wharf ○  8 Locker ○  9 Mooring ○   ctrl+b ? help
```

`●` runs, `○` hasn't started yet, `✕` and a number exited with that code. The app on screen has its
tab in its own colour.

A tab off screen gets a badge when its app needs you: `!` when it has become worried or sad since you
last looked at it (Bosun's process crashed or gave up, Hail's checks failed, Wharf's container exited
with an error, Sonar ran into trouble), and a count of the alerts it logged since (Sonar's watches going
over their threshold, Bosun's crashes). The bar says why for a moment and the terminal's bell rings once
as a badge appears; looking at the space clears it. Fleet reads what the apps tell each other (their
moods and the family's activity log, in `~/.family` or `FAMILY_HOME`) every few seconds, so an app
whose moods are turned off in its settings never gets a `!`.

```
 1 Splice ●  2 Trawl ●  3 Sonar ● 2  4 Bosun ● !  5 Hail ○  6 Keel ○  7 Wharf ○  8 Locker ○  9 Mooring ○   Bosun: api crashed
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
and put it on your PATH. It is one executable with all nine apps inside, so it's the only download you
need. It checks for a new version once a day and installs it by itself; the new version starts the
next time you open Fleet. (The apps inside don't update themselves: Fleet updates them together. `/update` in any of them asks Fleet to look for a new version now and install it.)

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
fleet keel --demo   # opens Keel, started with --demo
fleet hail api.http # anything after the app's name is that app's own arguments
```

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
| `ctrl+b` `1`–`8` | Switch to that space |
| `ctrl+b` `s` `t` `o` `b` `h` `k` `w` `l` `u` | Switch to Splice, Trawl, Sonar (o), Bosun, Hail, Keel, Wharf, Locker, Mooring (u) |
| `ctrl+b` `]` or `n` | The next space |
| `ctrl+b` `p` | The previous space |
| `ctrl+b` `\|` or `\` | Split the screen: the app on screen and the one before it side by side (`\|` again puts it back) |
| `ctrl+b` `tab`, `←` or `→` | Split, the other pane |
| `ctrl+b` `x` | Split, back to one app on screen: the one with the keys |
| `ctrl+b` `m` | Move the fleet to another folder: a list of the ones moved to lately and those beside this one, or one typed; every running app starts again there |
| `ctrl+b` `ctrl+b` | Send `ctrl+b` to the app (the prefix twice is the prefix for the app; `ctrl+]` `ctrl+]` sends `ctrl+]`) |
| `ctrl+b` `r` | The runbooks: the one you were in, else the list ([Runbooks](#runbooks)) |
| `ctrl+b` `f` | Follow a request across the apps ([Following a request](#following-a-request)) |
| `ctrl+b` `q` | Quit Fleet, stopping every app (it asks first when any is running) |
| `ctrl+b` `?` | The keys |

Any other key after `ctrl+b` cancels it. A click on a tab in the bar switches to it, whatever the app on screen does with the mouse: Fleet keeps clicks on for the bar, even for an app with its mouse turned off or one that has exited, and passes clicks on only to an app that wants them. With an app's mouse off, select text the terminal's own way while Fleet runs: most terminals select with shift held down.

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
where you start it. The window (`fleet gui`) has the same list in its Move dialog, a click on one
moving there.

## Hand-offs

The apps hand each other things as a line to paste into the other's prompt: Sonar's `T` copies a
`/azure-sql …` line for Trawl, Splice's `Y` a `/take …` for Sonar or Keel, Keel's `Y` a pull request or a
failed run for Splice, and so on. Inside Fleet that's one
step: Fleet switches to the app the line is for (starting it if it isn't running), and types the line
into its prompt. Press `↵` to run it. The line is still copied too. A line that several apps could take
(a log line, which Sonar, Hail and Bosun all read; a commit, for Sonar or Keel) goes to the first of them that's running, else
stays on the clipboard only.

## Runbooks

A runbook is a Markdown file whose steps run in the apps: each step is a line for one app's prompt (a
slash command, or a `family:v1:` line an app copied), in a fenced code block named after the app:
` ```trawl `, ` ```sonar `, ` ```hail `, ` ```bosun `, ` ```splice `, ` ```wharf `, ` ```keel `, ` ```locker ` or ` ```mooring `. Each
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

## Following a request

`ctrl+b` `f` asks for a request, operation or trace id (offering the last one a hand-off carried, as
Bosun's `t` copies a log line with its request), then asks every running app that reads log lines
(Sonar, Hail, Bosun and Wharf) to look for it: Fleet types a `/take` of a log line carrying the id into
each one's prompt, without switching to it. The panel lists the apps it asked; `↵` on one switches
there, and `↵` in its prompt runs the search (Sonar in Application Insights, Hail in its history, Bosun
in its crew's logs, Wharf in the running containers'). Fleet never presses `↵` for an app: one might
have a question open that a stray `↵` would answer.

Below them, the panel shows what Fleet finds itself, oldest first: the family's activity log entries
that mention the id, and the lines of Bosun's recorded sessions of the last day (`~/.bosun/sessions`,
`BOSUN_HOME` moves it) that do, each with its app and where it came from. `f` asks for another id,
`esc` closes.

## In a window: fleet gui

```bash
fleet gui                  # the fleet in a window, Splice first
fleet gui sonar --demo     # Sonar first, with its own arguments
fleet gui --no-open        # print the address, don't open it
```

`fleet gui` runs every app exactly as in the terminal, each its own process, but draws them in a
window: an app window of Chrome, Edge or Chromium when one is installed (without tabs or an address
bar, so the apps get ctrl+w and ctrl+t too), else the default browser. Each app draws into a screen
Fleet keeps for it, and the window draws that screen as text in your font, at your window's size:
panels with really round corners, the mascots' pixel art without gaps, selectable text. Keys, pastes
and the mouse reach the app as a terminal would send them, so every key in every app's README works
here too.

Around the apps, Fleet's tools are the window's own:

- **The rail** on the left: each app with its logo, whether it runs, and its badge (the same `!` and
  counts as the bar's); the window's title counts the badges, and with notifications on (the window
  offers once) an app that needs you says so even with the window in the background.
- **Two apps side by side**: Split in the rail, `ctrl+b` `|`, or ctrl-click an app; a click on a pane
  gives it the keys, and ✕ in its header shows the other alone.
- **Runbooks** and **Follow** as drawers on the right, with a button per step; **Commands**
  (`ctrl+shift+p`) for everything, apps included; the folder at the bottom of the rail moves the
  fleet, with tab completing a folder's name.
- An app that exits says so in its pane, with the end of what it wrote to stderr, and a button to
  start it again.
- What an app copies (OSC 52) goes to the clipboard; its notifications become the system's.

Fleet's keys are the terminal's: `alt+1`–`alt+9`, and `ctrl+b` then the same keys as in the
[table above](#keys) (`space` opens Commands there). An app with the mouse off leaves it to the
window, where dragging selects text (`ctrl+shift+c` copies it).

**Native views.** Where an app draws a chart in text, the window draws a real one in its place, with
a read-out of the values under the pointer: Sonar's charts in Logs (`| render timechart`, `v`) and
Trawl's `/chart`. The text version stays what the terminal shows.

**Safety.** It listens on `127.0.0.1` only, on a free port (`--port` picks one). The address it prints
carries a key, which the window keeps as a cookie: nothing is served without it, nothing changes
without a header no other site can send, and a request under another host name is turned away, so a
web page can't reach the apps. `ctrl+c` where `fleet gui` runs stops every app.

### Fleet Desktop

[Fleet Desktop](../../desktop) is the same window as an application of its own: a Start menu entry,
dock icon and menu, the badges' count on its icon, every key for the apps, and **File → Open Folder**
to run the fleet in another folder (**New Window** for a second fleet beside it). It runs `fleet gui`
for each window and keeps nothing of its own but the folder and the window's size. Its builds come
from the **Release Fleet Desktop** workflow, run by hand (`fleet-desktop-v…`: a Windows setup, a
macOS disk image, a Linux AppImage and .deb), with the `fleet` executable inside. They aren't signed
yet: Windows asks once, and macOS needs right-click → Open the first time.

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
| `keel_inbox`, `keel_prs`, `keel_pipelines`, `keel_pipeline_runs` | Azure DevOps (and GitHub) through Keel, as it's set up on this computer: the Inbox, active pull requests, pipelines and their health, one pipeline's runs |
| `wharf_containers`, `wharf_container_logs`, `wharf_pods`, `wharf_pod_logs` | Docker's containers and kubectl's pods, and the end of their logs |
| `trawl_list_connections`, `trawl_list_tables`, `trawl_describe_table`, `trawl_run_query` | Trawl's own MCP tools (`trawl mcp`, below the surface), with every rule they have: your saved connections, each one's Claude access level, writes refused, every query rolled back, all of it in Trawl's History |
| `family_timeline`, `family_moods`, `family_wiring` | What the apps did that changed something (this project's, or every project's), how their mascots feel and why (a quick read of what's wrong now), and what the project points at (addresses and connection strings, masked) |

- **It only reads.** No tool changes anything: no git command that writes, no restart, no request
  sent, no query but reads (Trawl refuses writes and rolls back; Application Insights' query API
  can't change anything, and a control command is refused).
- **Never a secret**, as everywhere in the family: everything a tool answers goes through the same
  masking as the activity log and `/wiring` (passwords in connection strings and URLs, bearer tokens,
  values whose names say they're secret come back as `••••`), and Hail's history never kept the
  secrets a request used or the headers that carry credentials.
- Answers are bounded (40,000 characters at most, less by default for diffs and logs); a cut one
  says so, and how to ask for less.
- Sonar and Keel sign in as they do themselves, with nothing to configure here. When they can't (no
  `az login`, Keel not set up on this computer), the tool says what to do: usually, open the app once.
- Keel's tools run in a process of Fleet's own, and Trawl's are `trawl mcp` itself, started by Fleet
  when Claude first lists or calls them; when Trawl can't start, its tools are left out.
- `fleet mcp --demo` puts Sonar, Keel, Wharf and Trawl on their demo data, to try it.

## Notes

- Fleet keeps the app it opened last in `~/.fleet/host.json` (`FLEET_HOME` moves the folder).
  `FLEET_NO_UPDATE_CHECK=1` turns the update check off. `FLEET_NO_BELL=1` (or `"bell": false` in
  `host.json`) keeps the bell quiet when a badge appears.
- Each app keeps its settings where it always does (`~/.splice`, `~/.trawl`, …), so they're the same
  inside Fleet and out.
- Colours follow your terminal's: 24-bit where it has them, else the nearest of 256.
