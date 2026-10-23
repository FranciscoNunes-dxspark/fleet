<p align="center"><img src="assets/logo.svg" width="120" alt="Ping, the Sonar bat"></p>

# Sonar

An Azure console for the terminal: your App Service and Function apps, their slots and settings, their
logs and their problems, in one keyboard-driven window. When Keel says production is red, Sonar is
where you find out why.

A sibling of [Splice](https://github.com/FranciscoNunes-dxspark/splice),
[Trawl](https://github.com/FranciscoNunes-dxspark/trawl) and [Hail](https://github.com/FranciscoNunes-dxspark/hail):
the same prompt, help window, mouse, settings and self-updating builds.

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/sonar/releases/latest)
and put it on your PATH. It checks for a new version once a day and installs it by itself.

Sonar signs in through the [Azure CLI](https://aka.ms/azure-cli): run `az login` once, and it uses that
sign-in's tokens. It never sees a password and keeps no secret. It starts on the subscription `az`
has selected (`az account set`), and remembers the one you pick.

```bash
sonar           # your Azure
sonar --demo    # a made-up subscription, to try it without one
```

From a checkout (Node 22 or later): `npm install`, then `npm start` (or `npm start -- --demo`).

### Starting somewhere

```bash
sonar --url https://shop.contoso.com/health --problems     # the app behind an address, its problems
sonar --app contoso-api --logs                             # an app's latest requests
sonar --sub "Contoso Production" --app contoso-web/staging --logs --kql "exceptions | take 20"
sonar --insights <AppId> --problems                        # everything in one Application Insights
```

`--url` finds the app that serves an address, by its own host name or one of its custom domains.
Keel's terminal app opens Sonar this way from a production monitor (`S` in its Production view):
in a new tab when it runs in Windows Terminal, or by copying the command to run.

## The views

| | |
| --- | --- |
| **Resources** | The subscription's web and function apps (ƒ) by resource group, their slots under them, each with its state. Beside them, the one under the cursor: address, plan, runtime, when it last changed, and which Application Insights it reports to |
| **Logs** | A KQL query over Application Insights and a grid of what came back. `l` on an app starts with its latest requests. Completion offers tables, columns and operators as you type |
| **Problems** | Exceptions grouped as Application Insights groups them, most frequent first, with how often each happened over the span as a sparkline, how many users it hit, which app, and when last. `↵` on one shows its latest occurrence end to end: the request, its dependencies, the exception and the traces, in order |
| **Live** | An app's log as it's written: App Service's log stream, through its Kudu site with the same Azure CLI sign-in. `L` on an app opens it; it follows the newest lines until you scroll back, and streams only while Live is on screen. Errors show red and warnings yellow. On Linux, an app writes to the stream only once App Service logs are on (Application logging: File System) |
| **Log** | Everything that has run, with its output |

Logs and Problems look at the app picked in Resources (by its role name), in the Application Insights
its settings point at. `c` picks another Application Insights, or all the apps in one. `t` changes
the time span: the last hour, 24 hours, 7 days or 30 days.

## Changing things

Restart (`R`), stop or start (`S`), swap a slot into production (`W`), and editing settings all ask
first. For production, Sonar asks you to type the app's name, as the portal does for deletes:
production being an app or resource group named with prod, production, prd or live. Every swap asks
for the name, since it changes what production serves, and says how many settings differ between
the two slots before you go ahead.

Settings (`↵` or `a` on an app or slot) hide the values that look secret (keys, passwords, connection
strings) until `v` shows one (`V` all). `e` edits one, `n` adds one, `x` removes one; each change
says what it changes before saving, and Azure restarts the app to take it. `d` compares the settings
with another slot of the same app, which is where the difference between staging and production
usually hides.

### Asking Claude

`w` on a problem (or `/why`) sends its latest occurrence, end to end, to
[Claude Code](https://claude.com/claude-code) (`claude -p`, signed in as you already are), which says
what most likely went wrong and what to do about it, in the viewer. Claude may read files (Read,
Grep and Glob, nothing else) in the folder Sonar was started in: start Sonar in the app's checkout and
it reads the code the exception went through.

## Keys

| Key | What it does |
| --- | --- |
| `1`–`5` / `tab` | Resources, Logs, Problems, Live, Log (`shift+tab` goes back) |
| `t` | The time span: 1h, 24h, 7d, 30d |
| `r` | Read the subscription again |
| `/` or `:` | The command prompt, with completion |
| `!` | Run a shell command, e.g. `!az account show` |
| `esc` | Cancel what's running, or clear the activity lines |
| `,` | Settings |
| `?` | Every key and command |
| `q` / `ctrl+c` | Quit |

| In Resources | |
| --- | --- |
| `↵` / `a` | Its settings: `v` shows a hidden value (`V` all), `e` edits, `n` adds, `x` removes, `d` compares with another slot, `y` copies |
| `R` | Restart it |
| `S` | Stop it, or start it if it's stopped |
| `W` | Swap a slot into production (on an app, pick the slot) |
| `l` `p` | Its logs · its problems |
| `L` | Its log as it's written, in Live |
| `o` `b` | Open it in the Azure portal · open its site |
| `y` | Copy its address |

| In Logs | |
| --- | --- |
| `e` / `i` | Edit the query: `tab` completes, `↑` `↓` go through the queries run before, `↵` runs it, `esc` stops editing |
| `↵` | Run the query, or show the row under the cursor whole |
| `h` `l` / `←` `→` | Across the columns |
| `y` `Y` | Copy the row as JSON · every row, tab-separated |
| `H` | Copy a request row as a request for [Hail](https://github.com/FranciscoNunes-dxspark/hail), to paste into a `.http` file and send again |
| `c` | Which Application Insights to look in |

| In Live | |
| --- | --- |
| `j` `k` `g` `G` | Scroll back · `G` follows the end again |
| `p` | Pause, or go on |
| `c` `R` | Clear · Reconnect |
| `y` | Copy what's there |

| In Problems | |
| --- | --- |
| `↵` | Its latest occurrence, end to end |
| `w` | Ask Claude why it happens |
| `l` | Its exceptions in Logs |
| `y` | Copy the message |
| `c` | Which Application Insights to look in |

In lists: `j` `k` or the arrows move, `g` `G` go to the top and bottom, `ctrl+d` `ctrl+u` page. The
mouse works too: click a tab, a row or the prompt, double-click for `↵`, scroll with the wheel, and
drag to select text, which is copied when you let go.

### The command palette

`ctrl+p` opens a list of everything you can do from where you are: the keys of the view you're in,
your own keys and commands, and every slash command. Type to narrow it (the words can come in any
order and needn't be whole), `↑`/`↓` pick, `↵` runs the one picked, `esc` closes it. A key runs as if
you'd pressed it in the view; a command that needs something typed after it goes into the prompt for
you to finish.

### Your own commands and keys

Commands of your own go in the settings file (`~/.sonar/config.json`), under `"commands"`, and keys
under `"keys"`, for every view (`"global"`) or for one (resources, logs, problems, live, log):

```json
{
  "commands": { "prod": "/sub Contoso Production", "errors": "/kql exceptions | order by timestamp desc | take 50" },
  "keys": { "global": { "ctrl+e": "/kql exceptions | take 50" }, "resources": { "x": "R" } }
}
```

A command is a line as you'd type it at the prompt, or a list of them run in order, stopping at the
first that fails or asks a question you answer no to. `$1`, `$2`… are the words typed after it, `$*`
all of them. A key maps to another key (the view does what that one does) or to a command line. What
can't be used is said in the activity lines when Sonar starts. These work as they do in Splice
and Trawl.

## Commands

| Command | What it does |
| --- | --- |
| `/kql <query>` | Run a query in Logs |
| `/sub [name]` | Another subscription (a list to pick from if none is named) |
| `/insights [name]` | The Application Insights that Logs and Problems look in |
| `/find [text]` | Show only the apps whose name or resource group has the text in it |
| `/appsettings [app]` | An app's or slot's settings |
| `/compare [app]` | How a slot's settings differ from another slot's |
| `/restart [app]` | Restart an app or slot |
| `/stop [app]` `/start [app]` | Stop or start one |
| `/swap [app/slot]` | Swap a slot into production |
| `/portal [app]` | Open one in the Azure portal |
| `/why [problem]` | Ask Claude why a problem happens (the one under the cursor in Problems if none is named) |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Theme, accent colour, mouse, updates, notifications, history |
| `/accent <#rrggbb>` | Change the accent colour (`default` puts it back) |
| `/update` | Look for a new version now and install it |
| `/help` | Keys and commands |
| `/quit` | Exit |

Apps are named as in the list: `contoso-web`, or `contoso-web/staging` for a slot. With no name,
the one under the cursor in Resources.

## Settings

`,` or `/settings`. They're kept in `~/.sonar/config.json` (`SONAR_HOME` moves it), with the
subscription last open, the time span, and the queries run lately.

| Setting | |
| --- | --- |
| Theme | Dark, light, or auto: auto goes by the terminal's background where it says (`COLORFGBG`), else dark |
| Accent colour | The colour of the cursor, borders and Ping (each theme has its own default) |
| Mouse | Off leaves selecting text to the terminal |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Notify when done | When a job with the spinner takes over 10 seconds, ring the terminal's bell and ask it for a desktop notification |
| Prompt history | Clear it |

When a job (a query, a restart, anything with the spinner) takes longer than 10 seconds, Sonar rings
the terminal's bell and asks it for a desktop notification saying what finished and how (OSC 9, which
Windows Terminal, iTerm2, WezTerm and kitty show, or OSC 777 in GNOME Terminal and other VTE
terminals), for when you've switched to another window. **Notify when done** turns it off, and
`"notifyAfter": 30` in `config.json` changes the seconds. A job you cancel says nothing.

## Not yet

Other kinds of resource (SQL, Storage, Container Apps), and Log Analytics workspaces queried
directly.
