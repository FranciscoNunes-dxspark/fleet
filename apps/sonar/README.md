<p align="center"><img src="assets/logo.svg" width="120" alt="Ping, the Sonar bat"></p>

# Sonar

An Azure console for the terminal: your App Service and Function apps, their slots and settings, their
logs and their problems, with your container apps, storage accounts and Azure SQL databases beside
them, in one keyboard-driven window. When Keel says production is red, Sonar is
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
| **Resources** | The subscription's web and function apps (ƒ) by resource group, their slots under them, each with its state, and in the same groups its container apps, Azure SQL servers (their databases under them) and storage accounts; each resource group with what it has cost this month so far. Beside them, the one under the cursor: address, plan, runtime, when it last changed, which Application Insights it reports to, its cost this month (and its plan's, where an app's cost mostly is), and its Azure Monitor metrics over the time span as sparklines (CPU time, memory, 5xx errors, response time). For a container app, its address, latest revision, image and environment; for a SQL server or database, its address, SKU, Entra admin (or that there's none) and the server's firewall rules; for a storage account, its kind, SKU, tier and blob address |
| **Logs** | A KQL query over Application Insights and a grid of what came back. `l` on an app starts with its latest requests. Completion offers tables, columns and operators as you type |
| **Problems** | Exceptions grouped as Application Insights groups them, most frequent first, with how often each happened over the span as a sparkline, how many users it hit, which app, and when last. `↵` on one shows its latest occurrence end to end: the request, its dependencies, the exception and the traces, in order |
| **Live** | An app's log as it's written: App Service's log stream, through its Kudu site with the same Azure CLI sign-in. `L` on an app opens it; it follows the newest lines until you scroll back, and streams only while Live is on screen. Errors show red and warnings yellow. On Linux, an app writes to the stream only once App Service logs are on (Application logging: File System) |
| **Alerts** | The subscription's metric and log alerts still firing that began in the time span (Azure Monitor's Alerts Management), most severe first: severity, the rule, what it's about, when it fired. Under them, the availability tests of the Application Insights in scope: how many ran from how many places, how many failed and when last. `↵` shows an alert whole, or a test's results in Logs |
| **Log** | Everything that has run, with its output |

Costs come from Cost Management (month to date, actual cost, by resource), read once a day while
Sonar runs. Without permission to read them (Cost Management Reader, or Reader on the subscription),
Sonar says nothing of costs.

Logs and Problems look at the app picked in Resources (by its role name), in the Application Insights
its settings point at. `c` picks another Application Insights, or all the apps in one. `t` changes
the time span: the last hour, 24 hours, 7 days or 30 days, for Logs, Problems and the metrics in Resources.

## Changing things

Restart (`R`), stop or start (`S`), swap a slot into production (`W`), and editing settings all ask
first. For production, Sonar asks you to type the app's name, as the portal does for deletes:
production being an app or resource group named with prod, production, prd or live. Every swap asks
for the name, since it changes what production serves, and says how many settings differ between
the two slots before you go ahead.

A container app's restart (`R`, which restarts its latest revision) and a SQL firewall rule (`F`)
ask the same way.

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

### Incidents

`I` on a problem (or `/incident`) tells it whole, in the viewer: when it was first and last seen, how
often and to how many users, with its sparkline; the app's deployments in the 24 hours before it was
first seen (or the latest before that); its latest occurrence end to end; the stack it went through;
the SQL calls that failed in its operations (the server and database, and the command when Application
Insights kept it); and when Sonar was started in the app's git checkout, the commits that touched the
files in its stack in the 14 days before it was first seen. Outside a checkout that part is left out.

| In an incident | |
| --- | --- |
| `Y` | Copy the exception, with its stack and request, for [Splice](https://github.com/FranciscoNunes-dxspark/splice)'s prompt |
| `T` | Its failing SQL: `↵` copies one as a query for Trawl's prompt, `a` its server's `/azure-sql` line (through `T`'s checks when the server is in the subscription) |
| `H` | Copy the failing request for Hail's prompt |
| `w` | Ask Claude for a draft write-up in Markdown: summary, impact, timeline, likely cause, next steps (it may read the code, as `w` in Problems does) |
| `s` | Save the write-up (or the incident itself, before there's one) to a Markdown file; `/incident save <file>` does it too |
| `y` | Copy the incident as Markdown |

### Before and after

`K` in Problems (or `/compare-window`) takes two equal windows either side of a point and says what
changed across it: exception types that are new, gone, or at least twice as frequent; dependencies
whose 95th percentile duration moved by a tenth or more; operations whose rate of 5xx answers rose.
The point is the latest successful deployment of the app in scope, or without one the middle of the
time span; `/compare-window 2026-10-20T14:00Z` puts it at a time of yours, and `/compare-window deploy`
insists on the deployment. Each window is as long as the time since the point, up to seven days.

### Watches

`/watch <name> <threshold> <kql>` pins a query whose answer starts with a number (the first column of
the first row), such as

```
/watch failures 20 requests | where timestamp > ago(10m) and success == false | count
```

It runs against the Application Insights in scope when you made it (kept with it), at once and then
every five minutes while Sonar runs (**Run watches every** in the settings), over the last 24 hours
unless the query says otherwise. When its number goes over the threshold, Sonar says so in the activity
lines and rings the bell with a desktop notification (as **Notify when done** does, and off with it);
staying over says nothing more, and it says so again only after it has been back under. `/watches`
lists them with what each said last: `↵` runs one in Logs, `x` removes it, `y` copies its query. They're
kept in `config.json` under `"watches"`.

## Keys

| Key | What it does |
| --- | --- |
| `1`–`6` / `tab` | Resources, Logs, Problems, Live, Alerts, Log (`shift+tab` goes back) |
| `t` | The time span: 1h, 24h, 7d, 30d (Logs, Problems, and the metrics in Resources) |
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
| `D` | Its deployments: who, when, through what, how it went, which is active; `↵` shows one's log |
| `l` `p` | Its logs · its problems |
| `L` | Its log as it's written, in Live |
| `o` `b` | Open it in the Azure portal · open its site |
| `y` | Copy its address |

| On a container app | |
| --- | --- |
| `R` | Restart its latest revision |
| `l` / `↵` | Its console log in Logs, from the Log Analytics workspace its environment writes to |
| `o` `b` `y` | Open it in the portal · open its address · copy its address |

| On a SQL server or database | |
| --- | --- |
| `T` | Copy a command that opens it in [Trawl](https://github.com/FranciscoNunes-dxspark/trawl), to paste into Trawl's prompt (below) |
| `F` | Let this machine's public address through the server's firewall |
| `o` `y` | Open it in the portal · copy its address |

A storage account takes `o` (the portal) and `y` (copy its blob address).

| In Logs | |
| --- | --- |
| `e` / `i` | Edit the query: `tab` completes, `↑` `↓` go through the queries run before, `↵` runs it, `esc` stops editing |
| `↵` | Run the query, or show the row under the cursor whole |
| `s` | Save the query under a name, for `/queries` |
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

| In Alerts | |
| --- | --- |
| `↵` | An alert whole; on an availability test, its results in Logs |
| `o` | An alert's target in the Azure portal |
| `y` | Copy its name |
| `c` | Which Application Insights the availability tests come from |

| In Problems | |
| --- | --- |
| `↵` | Its latest occurrence, end to end |
| `w` | Ask Claude why it happens |
| `I` | The incident: the problem told whole (below) |
| `K` | Before and after: what changed across the app's latest deployment (below) |
| `l` | Its exceptions in Logs |
| `y` | Copy the message |
| `c` | Which Application Insights to look in |

In lists: `j` `k` or the arrows move, `g` `G` go to the top and bottom, `ctrl+d` `ctrl+u` page. The
mouse works too: click a tab, a row or the prompt, double-click for `↵`, scroll with the wheel, and
drag to select text, which is copied when you let go.

### SQL databases in Trawl

`T` on a SQL database (or server), or `/trawl server/database`, copies a slash command for Trawl's
prompt, such as

```
/azure-sql contoso-sql-prod.database.windows.net contoso --name contoso-sql-prod-contoso --user contoso_app --password-from contoso-prod/contoso-api --subscription <id> --prod
```

Paste it into Trawl's prompt and Trawl saves the connection and opens it. Sonar looks through the
apps' connection strings and settings for one pointing at that server and database: when one signs in
with a SQL login, the command names the login and the app it's in, and Trawl reads the password from
that app through the Azure CLI, so it never passes through Sonar, the clipboard or the log (which says
which app it comes from). When the app signs in with Entra (`Authentication=Active Directory…`), or no
app has one, there's no `--user` and Trawl signs in with your `az` sign-in. `--prod` is there for
production, as Sonar tells it (the server's name or resource group).

Before copying, Sonar checks the server's firewall lets this machine's public address in (the "Allow
Azure services" rule doesn't count: it's for Azure, not you), and if not, offers to add a rule for it,
`sonar-<address>`, asking as every change does. `F` (or `/firewall`) adds one on its own.

### The command palette

`ctrl+p` opens a list of everything you can do from where you are: the keys of the view you're in,
your own keys and commands, and every slash command. Type to narrow it (the words can come in any
order and needn't be whole), `↑`/`↓` pick, `↵` runs the one picked, `esc` closes it. A key runs as if
you'd pressed it in the view; a command that needs something typed after it goes into the prompt for
you to finish.

### Your own commands and keys

Commands of your own go in the settings file (`~/.sonar/config.json`), under `"commands"`, and keys
under `"keys"`, for every view (`"global"`) or for one (resources, logs, problems, live, alerts, log):

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
| `/queries [name]` | Your saved queries: pick one to run (`x` forgets it), or name it |
| `/export <file>` | Save the grid in Logs to a `.csv`, `.json` or `.md` (a Markdown table) file |
| `/sub [name]` | Another subscription (a list to pick from if none is named) |
| `/insights [name]` | The Application Insights that Logs and Problems look in |
| `/find [text]` | Show only the apps whose name or resource group has the text in it |
| `/appsettings [app]` | An app's or slot's settings |
| `/compare [app]` | How a slot's settings differ from another slot's |
| `/restart [app]` | Restart an app or slot |
| `/stop [app]` `/start [app]` | Stop or start one |
| `/swap [app/slot]` | Swap a slot into production |
| `/deployments [app]` | An app's or slot's deployments, and their logs |
| `/trawl [server/db]` | Copy a command that opens a SQL database (or server) in Trawl, for Trawl's prompt |
| `/firewall [server]` | Let this machine's public address through a SQL server's firewall |
| `/portal [app]` | Open one in the Azure portal |
| `/compare-window [deploy\|<time>]` | What changed across the latest deployment of the app in scope, or a time: exceptions, dependencies, failing operations |
| `/watch <name> <threshold> <kql>` | Pin a query whose first value is a number; going over the threshold says so (above) |
| `/watches` | Your watches and what they said last: `↵` runs one in Logs, `x` removes it |
| `/incident [problem]` | A problem as an incident (the one under the cursor in Problems if none is named); `/incident save <file>` writes its write-up |
| `/why [problem]` | Ask Claude why a problem happens (the one under the cursor in Problems if none is named) |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Theme, accent colour, mouse, updates, notifications, watches, history |
| `/accent <#rrggbb>` | Change the accent colour (`default` puts it back) |
| `/update` | Look for a new version now and install it |
| `/help` | Keys and commands |
| `/quit` | Exit |

Apps are named as in the list: `contoso-web`, or `contoso-web/staging` for a slot. With no name,
the one under the cursor in Resources.

## Settings

`,` or `/settings`. They're kept in `~/.sonar/config.json` (`SONAR_HOME` moves it), with the
subscription last open, the time span, the queries run lately, the ones you saved (`"savedQueries"`),
and your watches (`"watches"`).

| Setting | |
| --- | --- |
| Theme | Dark, light, or auto: auto goes by the terminal's background where it says (`COLORFGBG`), else dark |
| Accent colour | The colour of the cursor, borders and Ping (each theme has its own default) |
| Mouse | Off leaves selecting text to the terminal |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Notify when done | When a job with the spinner takes over 10 seconds, ring the terminal's bell and ask it for a desktop notification |
| Run watches every | 1, 5 (the default), 15, 30 or 60 minutes |
| Prompt history | Clear it |

When a job (a query, a restart, anything with the spinner) takes longer than 10 seconds, Sonar rings
the terminal's bell and asks it for a desktop notification saying what finished and how (OSC 9, which
Windows Terminal, iTerm2, WezTerm and kitty show, or OSC 777 in GNOME Terminal and other VTE
terminals), for when you've switched to another window. **Notify when done** turns it off, and
`"notifyAfter": 30` in `config.json` changes the seconds. A job you cancel says nothing.

## Not yet

Storage beyond the list (its containers and blobs), other kinds of resource (Service Bus, Key Vault,
Cosmos DB), container apps' metrics, and Log Analytics workspaces queried directly, other than a
container app's logs.
