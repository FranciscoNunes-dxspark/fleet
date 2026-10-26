<p align="center"><img src="assets/logo.svg" width="120" alt="Ping, the Sonar bat"></p>

# Sonar

An Azure console for the terminal: your App Service and Function apps, their slots and settings, their
logs and their problems, with your container apps, storage accounts and Azure SQL databases beside
them, in one keyboard-driven window. When Keel says production is red, Sonar is
where you find out why.

A sibling of [Splice](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/splice),
[Trawl](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/trawl) and [Hail](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/hail):
the same prompt, help window, mouse, settings and self-updating builds.

Sonar also runs inside [Fleet](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/fleet), which keeps the family's apps in one terminal and switches between them with `ctrl+]`; a line Sonar copies for a sibling goes straight to that app's prompt there.

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=sonar-v&expanded=true)
and put it on your PATH. It checks for a new version once a day and installs it by itself.

Sonar signs in through the [Azure CLI](https://aka.ms/azure-cli): run `az login` once, and it uses that
sign-in's tokens. It never sees a password and keeps no secret. It starts on the subscription `az`
has selected (`az account set`), and remembers the one you pick. A big subscription shows as soon as
its apps are listed; their slots and the SQL servers' databases fill in while the top line says
`reading…`.

```bash
sonar           # your Azure
sonar --demo    # a made-up subscription, to try it without one
```

From a checkout of the [fleet repository](https://github.com/FranciscoNunes-dxspark/fleet) (Node 22 or later): `npm install` at its root, then `npm start -w apps/sonar` (or `cd apps/sonar && npm start -- --demo`).

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
| **Resources** | The subscription's web and function apps (ƒ) by resource group, their slots under them, each with its state (and a slot's share of its app's traffic, `→ 10%`, when it takes some), and in the same groups its container apps, Azure SQL servers (their databases under them), storage accounts, Service Bus namespaces, Cosmos DB accounts and Log Analytics workspaces; each resource group with what it has cost this month so far. Beside them, the one under the cursor: address, its App Service plan (tier, size and instances, its autoscale setting summed up, and the other apps that share it), runtime, when it last changed, which Application Insights it reports to, its cost this month (and its plan's, where an app's cost mostly is), its Key Vault references (an app or slot with one App Service couldn't resolve is flagged ⚠ in the list, and the details say which and why), and its Azure Monitor metrics over the time span as sparklines (CPU time, memory, 5xx errors, response time). For a container app, its address, latest revision, image and environment, and its metrics over the time span (requests, CPU, memory, replicas); for a SQL server or database, its address, SKU, Entra admin (or that there's none) and the server's firewall rules; for a storage account, its kind, SKU, tier and blob address; for a Service Bus namespace, its address and tier, how many messages its queues and subscriptions hold, and which have dead letters; for a Cosmos DB account, its API, address, regions, consistency and whether it's serverless |
| **Logs** | A KQL query over Application Insights (or a Log Analytics workspace) and a grid of what came back. `l` on an app starts with its latest requests. Completion offers tables, columns and operators as you type: a workspace's own tables and columns when Logs queries one |
| **Problems** | Exceptions grouped as Application Insights groups them, most frequent first, with how often each happened over the span as a sparkline, how many users it hit, which app, and when last. `↵` on one shows its latest occurrence end to end: the request, its dependencies, the exception and the traces, in order |
| **Live** | An app's log as it's written: App Service's log stream, through its Kudu site with the same Azure CLI sign-in. `L` on an app opens it; it follows the newest lines until you scroll back, and streams only while Live is on screen. Errors show red and warnings yellow. On Linux, an app writes to the stream only once App Service logs are on (Application logging: File System) |
| **Alerts** | The subscription's metric and log alerts still firing that began in the time span (Azure Monitor's Alerts Management), most severe first: severity, the rule, what it's about, when it fired. Under them, the availability tests of the Application Insights in scope: how many ran from how many places, how many failed and when last. `↵` shows an alert whole, or a test's results in Logs |
| **Log** | Everything that has run, with its output |

Costs come from Cost Management (month to date, actual cost, by resource), read once a day while
Sonar runs. Without permission to read them (Cost Management Reader, or Reader on the subscription),
Sonar says nothing of costs.

Logs and Problems look at the app picked in Resources (by its role name), in the Application Insights
its settings point at. `c` picks another Application Insights, or all the apps in one, or a Log
Analytics workspace: Logs then queries its tables directly (a workspace-based Application Insights
writes `AppRequests`, `AppExceptions`, `AppTraces`… there), with its tables and columns in completion
(from the query API's metadata, or which tables have rows when that can't be read). `t` changes
the time span: the last hour, 24 hours, 7 days or 30 days, for Logs, Problems and the metrics in Resources.

## Changing things

Restart (`R`), stop or start (`S`), swap a slot into production (`W`), and editing settings all ask
first. For production, Sonar asks you to type the app's name, as the portal does for deletes:
production being an app or resource group named with prod, production, prd or live. Every swap asks
for the name, since it changes what production serves, and says how many settings differ between
the two slots before you go ahead.

`/route <app> <slot> <percent>` sends that share of an app's production traffic to one of its slots
(App Service's testing in production): `/route contoso-web staging 10`, and `0` stops it. It says what
production keeps, and asks as any change to production does. The list shows each slot's share beside it,
and the app's details the whole split.

`/scale [app] <instances|tier>` scales the App Service plan an app runs on: `/scale 3` to three
instances, `/scale contoso-web P1v3` to another tier (B1, S1, P1v3, P2mv3, I1v2, EP1…). It says which
other apps share the plan (they scale with it) and, when autoscale is on for it, that it may change the
count again; a plan that runs a production app asks for the app's name. A Consumption plan scales by
itself, so there's nothing to set. Autoscale settings are shown, not changed.

A container app's restart (`R`, which restarts its latest revision) and a SQL firewall rule (`F`)
ask the same way.

Settings (`↵` or `a` on an app or slot) hide the values that look secret (keys, passwords, connection
strings) until `v` shows one (`V` all). A Key Vault reference (`@Microsoft.KeyVault(…)`) shows ✓ when App
Service resolved it, else ✗ and why: no managed identity, no such vault or secret, or the identity may
not read the vault. `e` edits one, `n` adds one, `x` removes one; each change
says what it changes before saving, and Azure restarts the app to take it. `d` compares the settings
with another slot of the same app, which is where the difference between staging and production
usually hides.

### Functions

`f` on a function app (or `/functions [app]`) lists its functions: what triggers each (HTTP and its
methods, a timer's schedule, a queue), whether it's on or off, and from its Application Insights how
many times it ran over the time span, how many of those failed and when it last ran. `↵` shows a
function's latest runs in Logs, `y` copies its name.

`d` turns one off, or on again, the way the portal does: through its `AzureWebJobs.<name>.Disabled`
setting (the `__` spelling Linux plans use is honoured when it's already there), so the app restarts.
`i` invokes one, after a field for what to send: an HTTP function at its own address with its function
key (a body makes it a POST when it takes one, none a GET), any other through the host's admin endpoint
with the master key, as the portal's Test/Run does. The key is read for that request and goes no
further: it's never shown, copied or written to the log. What came back (status, type, body, JSON
indented) shows in the viewer. Both ask first, as every change does.

### Service Bus

`↵` on a namespace lists its queues, topics and subscriptions with their counts (from Azure Resource
Manager). `↵` on a queue or subscription shows its dead letters, oldest first (up to 50): each is read
by locking it and letting it go again, so nothing is taken (its delivery count goes up by one). The
list shows why each was dead-lettered and the start of its body; `↵` shows one whole, its properties
and its body (JSON indented). A body that looks like it holds a secret (a password, a token, a key)
stays hidden until `v` shows it. Bodies are never written to the log.

`R` resubmits the dead letter under the cursor, or those picked with `v`: each is sent again to its
queue (a subscription's to its topic, which hands a copy to every subscription of it) and only then
taken off the dead letters, saying how many moved. `X` purges an entity's dead letters, deleting them
for good. Both ask first, as every change does (a production namespace asks for its name).

Messages are read through Service Bus's own API with your `az` sign-in, which needs a data role on the
namespace: Azure Service Bus Data Receiver to peek, Data Owner to resubmit and purge (Owner and
Contributor don't reach messages). Without one, Sonar says which it needs.

### Charts

A query that ends with `| render timechart` (or `linechart`, `areachart`), `columnchart`, `barchart` or
`piechart` comes back as a chart, and `v` (or `/chart`) turns any result with a column of numbers into one,
or back into the grid. A time series draws a sparkline per series on one time axis, each with its
lowest, highest and last value: one per value of a name column (the eight biggest), or one per column
of numbers. Anything else draws horizontal bars with their values, a pie each one's share too:

```
requests | summarize n = count() by bin(timestamp, 1h), resultCode | render timechart
requests | where success == false | summarize count() by name | render barchart
```

### Asking Claude

`w` on a problem (or `/why`) sends its latest occurrence, end to end, to
[Claude Code](https://claude.com/claude-code) (`claude -p`, signed in as you already are), which says
what most likely went wrong and what to do about it, in the viewer. Claude may read files (Read,
Grep and Glob, nothing else) in the folder Sonar was started in: start Sonar in the app's checkout and
it reads the code the exception went through.

### Incidents

`I` on a problem (or `/incident`) tells it whole, in the viewer: when it was first and last seen, how
often and to how many users, with its sparkline; the app's deployments in the 24 hours before it was
first seen (or the latest before that); the app's Key Vault references as they are now, when it has any (one that doesn't resolve is a likely cause); its latest occurrence end to end; the stack it went through;
the SQL calls that failed in its operations (the server and database, and the command when Application
Insights kept it); and when Sonar was started in the app's git checkout, the commits that touched the
files in its stack in the 14 days before it was first seen. Outside a checkout that part is left out.

| In an incident | |
| --- | --- |
| `Y` | Copy the exception, with its stack and request, for [Splice](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/splice)'s prompt |
| `T` | Its failing SQL: `↵` copies one as a query for Trawl's prompt, `a` its server's line for Trawl (`/azure-sql` for Azure SQL) (through `T`'s checks when the server is in the subscription) |
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

### From the other apps

Splice, Trawl, Bosun and Hail copy things for Sonar as a line for its prompt, `/take family:v1:…`
(the `family:v1:…` part alone, pasted or typed at the prompt, does the same):

| What | What Sonar does with it |
| --- | --- |
| A commit (from Splice) | Reads the deployments of every app and slot in the subscription and lists those that shipped it, by its hash in their id or message; `↵` shows one's log |
| An exception | Problems, showing only those of its type (or with its message), about its app when it's one in the subscription; `x` there shows them all again |
| A log line with a request or operation id (from Bosun) | Everything that request did, in Logs: its request, dependencies, exceptions and traces, in order |

Anything else (a request, rows, a query, a file) is for another app, and Sonar says which.

Whatever Sonar copies for another app works the same way: a line for that app's prompt, said in the
activity lines as "Copied for Splice: paste it into Splice's prompt" with what it holds. Nothing secret
is ever in one. A command (`/…`) or a `family:v1:…` line pasted while a view has the keys goes into
the prompt rather than being taken as keys, to run with `↵`.

`/family` lists what the folder Sonar was started in is to the others: its git checkout (Splice's
`/open`), its processes when Bosun has something to run there (`/move`), each `.http` file (Hail's
`/open`), and each database its `appsettings*.json` or `.env` files name (Trawl's `/azure-sql` for an
Azure SQL server signing in with Entra, else `/add` with its port, its login and `--trust-cert` when the
connection string trusts the server's certificate, but never the password). `↵` copies one.

`/timeline` shows what the five apps did that changed something, newest first, from the family's
activity log in `~/.family`: Splice's pushes, Trawl's writes, Bosun's crashes, Hail's sends, and Sonar's
own changes. Sonar adds one whenever it changes Azure (a restart, stop, start or swap, settings saved, a
firewall rule, a scale, a route, a function turned off or on or invoked, dead letters resubmitted or
purged) and when a watch goes over its threshold: what and where, never a value, a key or a message
body. `p` shows only this project's (the folder Sonar started in) or every one's again, `↵` shows an
entry whole, `y` copies it.

`/wiring` shows what the folder Sonar started in points at, by file: the addresses, hosts, ports and
connection strings in its `appsettings*.json`, `.env` files and Hail's `http-client*.env.json`, with
passwords and keys masked.

Ping tells the others how it feels (worried after something went wrong, busy, pleased, or just
watching) and why, in a small file in `~/.family` (`FAMILY_HOME` moves it), and reads theirs every
30 seconds: when Twig, Glim, Squawk or Hoot has been worried, sad or happy in the last 15 minutes, Ping
says so once, in a line above the activity lines ("Twig says: PR #12 merged"), until `esc`. **Family
moods** in the settings turns both off.

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
| `q` | Quit |
| `ctrl+c` | Copy the text you dragged over (dragging copies it too); it never quits |
| `ctrl+v` | Paste |

| In Resources | |
| --- | --- |
| `↵` / `a` | Its settings: `v` shows a hidden value (`V` all), `e` edits, `n` adds, `x` removes, `d` compares with another slot, `y` copies |
| `R` | Restart it |
| `S` | Stop it, or start it if it's stopped |
| `W` | Swap a slot into production (on an app, pick the slot) |
| `D` | Its deployments: who, when, through what, how it went, which is active; `↵` shows one's log |
| `f` | A function app's functions (below) |
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
| `T` | Copy a command that opens it in [Trawl](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/trawl), to paste into Trawl's prompt (below) |
| `F` | Let this machine's public address through the server's firewall |
| `o` `y` | Open it in the portal · copy its address |

| On a storage account | |
| --- | --- |
| `↵` | Its blob containers; `↵` goes into one, a folder at a time (the `/` in blob names), with each blob's size, when it changed and its tier; `↵` on a blob shows it (text up to 1 MB, JSON indented); `y` copies its address |
| `o` `y` | Open it in the portal · copy its blob address |

Blobs are read through Blob Storage's own API with your `az` sign-in, which needs Storage Blob Data
Reader (or Contributor) on the account: Owner and Contributor on it don't reach the blobs that way. Without
it, Sonar says so. Sonar never writes a blob.

| On a Log Analytics workspace | |
| --- | --- |
| `↵` / `l` | Query it in Logs, starting with which of its tables have rows and how many |
| `o` | Open it in the portal |

| On a Cosmos DB account | |
| --- | --- |
| `↵` | Its databases and their containers (a MongoDB account's collections), with each one's partition key, throughput (its own, or the database's shared, autoscale or not) and time to live; `o` there opens the portal's Data Explorer, `y` copies a name |
| `o` `y` | Open it in the portal · copy its address |

Cosmos DB is listed from Azure Resource Manager, which is all an `az` sign-in reaches by itself: its
documents need a role of Cosmos DB's own (a SQL role assignment such as Cosmos DB Built-in Data Reader,
which Owner and Contributor don't give) and, for queries across partitions, a query plan its REST API
doesn't make for you, so Sonar doesn't query them: the Data Explorer does. Cassandra, Table and Gremlin
accounts show their details only.

| On a Service Bus namespace | |
| --- | --- |
| `↵` | Its queues, topics and subscriptions, each with its active, dead-lettered and scheduled messages (below) |
| `o` `y` | Open it in the portal · copy its address |

| In Logs | |
| --- | --- |
| `e` / `i` | Edit the query: `tab` completes, `↑` `↓` go through the queries run before, `↵` runs it, `esc` stops editing |
| `↵` | Run the query, or show the row under the cursor whole |
| `v` | The result as a chart, or as the grid again (below) |
| `s` | Save the query under a name, for `/queries` |
| `h` `l` / `←` `→` | Across the columns |
| `y` `Y` | Copy the row as JSON · every row, tab-separated |
| `H` | Copy a request row for [Hail](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/hail)'s prompt, to send it again there |
| `F` | Copy a request row as the text of a request in a `.http` file |
| `c` | Which Application Insights (or Log Analytics workspace) to look in |

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
| `Y` | Copy its latest exception, with its stack and the request it failed, for Splice's prompt |
| `x` | Show them all again, after `/take` showed only those like an exception |
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
| `/chart` | Draw the result in Logs as a chart, or as the grid again |
| `/export <file>` | Save the grid in Logs to a `.csv`, `.json` or `.md` (a Markdown table) file |
| `/sub [name]` | Another subscription (a list to pick from if none is named) |
| `/insights [name]` | The Application Insights that Logs and Problems look in, or a Log Analytics workspace for Logs |
| `/find [text]` | Show only the apps whose name or resource group has the text in it |
| `/appsettings [app]` | An app's or slot's settings |
| `/compare [app]` | How a slot's settings differ from another slot's |
| `/restart [app]` | Restart an app or slot |
| `/stop [app]` `/start [app]` | Stop or start one |
| `/swap [app/slot]` | Swap a slot into production |
| `/functions [app]` | A function app's functions: trigger, on or off, runs and failures; `↵` runs in Logs, `i` invokes, `d` turns off or on |
| `/route <app> <slot> <percent>` | Send a share of an app's production traffic to a slot; `0` stops it (above) |
| `/scale [app] <instances\|tier>` | Scale the App Service plan an app runs on (above) |
| `/deployments [app]` | An app's or slot's deployments, and their logs |
| `/trawl [server/db]` | Copy a command that opens a SQL database (or server) in Trawl, for Trawl's prompt |
| `/firewall [server]` | Let this machine's public address through a SQL server's firewall |
| `/portal [app]` | Open one in the Azure portal |
| `/compare-window [deploy\|<time>]` | What changed across the latest deployment of the app in scope, or a time: exceptions, dependencies, failing operations |
| `/watch <name> <threshold> <kql>` | Pin a query whose first value is a number; going over the threshold says so (above) |
| `/watches` | Your watches and what they said last: `↵` runs one in Logs, `x` removes it |
| `/take <context>` | What another app copied for Sonar (above) |
| `/family` | What this folder is to the other apps: a line for each one's prompt, `↵` copies it |
| `/timeline` | What the family's apps changed, newest first: `p` this project only or all, `↵` an entry whole (above) |
| `/wiring` | What this folder points at: addresses, hosts, ports, connection strings, by file, secrets masked |
| `/incident [problem]` | A problem as an incident (the one under the cursor in Problems if none is named); `/incident save <file>` writes its write-up |
| `/why [problem]` | Ask Claude why a problem happens (the one under the cursor in Problems if none is named) |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Theme, accent colour, mouse, updates, notifications, watches, family moods, history |
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
| Family moods | Off neither tells the other apps how Ping feels nor says how theirs do |
| Prompt history | Clear it |

When a job (a query, a restart, anything with the spinner) takes longer than 10 seconds, Sonar rings
the terminal's bell and asks it for a desktop notification saying what finished and how (OSC 9, which
Windows Terminal, iTerm2, WezTerm and kitty show, or OSC 777 in GNOME Terminal and other VTE
terminals), for when you've switched to another window. **Notify when done** turns it off, and
`"notifyAfter": 30` in `config.json` changes the seconds. A job you cancel says nothing.

## Not yet

Key Vault itself (beyond the references in settings), Cosmos DB's documents, and writing blobs.
