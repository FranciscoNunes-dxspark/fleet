<p align="center"><img src="assets/logo.svg" width="120" alt="Squawk, the Bosun parrot"></p>

# Bosun

Runs a project's processes for you in the terminal, each with its own log, port and health.

A keyboard-driven terminal app, a sibling of Splice and Trawl: the same prompt, help window, mouse,
settings and self-updating builds.

Open it in a project and it starts the project's processes (the API, the web app, a worker), side by
side: each with its state, its port and whether that answers, how long it has been up, and its own
log beside the list. One that crashes turns red, with what went wrong; `r` restarts it, and `w` asks
Claude why it failed. Quitting stops every one of them, and whatever they started, on Windows too.

```bash
bosun                 # the project in this folder
bosun ../shop --profile mock
```

Opened somewhere with nothing to run (a launcher's folder, your home), it opens the project you ran
last instead. `/move` takes it to another project: it stops this one's processes (asking first when
any are running) and starts the other's. The header and the window's title say which project it's in.

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=bosun-v&expanded=true)
and put it on your PATH. It checks for a new version once a day and installs it by itself; the new
version starts the next time you open Bosun.

From a checkout of the [fleet repository](https://github.com/FranciscoNunes-dxspark/fleet) (Node 22 or later), where Bosun is `apps/bosun`:

```bash
npm install                  # at the repository's root: every app and the kit they share
cd apps/bosun
npm start
```

## What it runs

`bosun.json` in the project says what to run:

```json
{
  "procs": {
    "api": { "run": "node server.js", "port": 4280, "health": "/health", "env": { "LOG": "debug" } },
    "web": { "run": "vite", "port": 5173, "after": "api" },
    "worker": "node worker.js"
  },
  "profiles": {
    "mock": { "api": { "args": "--mock" }, "web": { "env": { "VITE_MOCK": "1" } } }
  }
}
```

| Field | |
| --- | --- |
| `run` | The command, through the shell (a process can be just this string) |
| `cwd` | Where it runs, from the project's folder |
| `port` | The port it listens on: shown with ✓ once it answers, `o` opens it |
| `https` | A port to serve it on with TLS too (`4443`), or `true` for the one after `port`: see Local HTTPS |
| `health` | A page on that port that answers 2xx or 3xx when it's well; ✗ otherwise |
| `env` | Settings for it, on top of the terminal's and its env files' |
| `envFile` | A `.env` file (or a list of them) to read settings from, from its `cwd` |
| `group` | A name it's listed under, with the others of that group (`"backend"`); `/start`, `/stop` and `/restart` take it |
| `after` | Another process it starts after: once that one's port answers, or it has run a moment |
| `watch` | Files that restart it when they change: paths or globs from its `cwd`, e.g. `["src", "lib/**/*.js"]` |
| `ignore` | Changes to these don't (`"*.test.js"`, `"src/generated"`) |
| `restart` | `"no"` (the default), `"on-failure"` (when it exits with an error) or `"always"` (whenever it ends by itself) |
| `tunnel` | `"cloudflared"` or `"ngrok"`: the tool `T` opens its tunnel with (see Tunnels). At the top level, for every process |
| `test` | Hail's checks for it: an `.http` file (`"api.http"`), or `{ "file": "api.http", "env": "dev" }`, from its `cwd`. Needs `port` |

`"envFile"` at the top level (from the project's folder) is read for every process, before each one's
own. The files are in the usual dotenv format: `NAME=value` lines, `#` comments, `export ` in front,
single quotes taken as they are, double quotes with `\n` and running over several lines, and `${NAME}`
(or `${NAME:-fallback}`) from the lines above or the terminal's settings. A setting comes from, the
last one winning: the terminal, the top level's env files, the process's own env files in the order
given, its `env`. `/reload` reads them again and restarts the processes whose settings changed.

A process with `watch` restarts once the files it names stop changing for a moment (300 ms), and its
log says what changed (`changed: src/app.js`). A folder counts with everything in it; `*` and `?`
match within a name, `**` any folders, `{a,b}` either. An `ignore` pattern without a `/` matches any
name along the path, as in `.gitignore`; `node_modules` and `.git` are always ignored. Watching starts
when the process first starts and stops when you stop it; a change starts again one that crashed.
Name the folders to watch rather than `**/*.js`, which watches the whole project.

A process that `restart`s is started again after a wait: 1 second, then 2, 4, 8… up to 30 seconds
while it keeps failing, back to 1 second once it has stayed up 30 seconds. The list says
`restarting in 4s` meanwhile, and `s` stops it waiting. One that ends within 10 seconds of starting
5 times in a row is given up on (`gave up` in the list; `s` or `r` starts it again). One you stop is
never restarted.

A process with `test` has its requests checked by [Hail](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/hail)
once its port answers (and its health page is well, when it has one): Bosun runs `hail test <file>
[--env <env>]`, shows `✓ tests` or `✗ 2 failed` beside it in the list, and puts Hail's report in its
log. They run again after each restart. Hail must be on your PATH; Bosun says once when it isn't.

A profile changes some processes: `run` replaces the command, `args` adds to it, `env` adds settings,
`restart` and `group` replace those (`"group": null` takes it out of its group).

Processes with a `group` are listed under its heading, with how many of them run, after the ones
without; `ctrl+g` shows one group at a time, then all of them again. `/start backend`, `/stop backend`
and `/restart backend` act on every process of the group (a process of that name wins), each still
after the one it waits for. `/graph` draws who starts after whom (`after`) as a tree.
`p` or `/profile` picks one (`--profile` starts with it), and the processes it changes restart.

Without a `bosun.json`, Bosun works out what to run from the first of these it finds:

1. A **`Procfile`**: each `name: command` line is a process, as foreman and honcho run them. Each gets
   `PORT`: 5000 for the first, 5100 for the next, and so on (from `PORT` in `.env` or the terminal's
   instead, when either sets it), and one whose command says `$PORT` has that port watched. The
   project's `.env` is read too, as foreman reads it.
2. A **compose file** (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml`):
   each service is a process, `docker compose up --no-deps <service>`, on the first port it publishes,
   started after the first service in its `depends_on`. Stopping one stops its container. Compose
   reads its own `.env`, so Bosun doesn't.
3. **package.json**'s `dev` script (else `start`). When that's a `concurrently` line, each of its
   commands is a process of its own, named as `-n` names them, and other `dev:` scripts split the same
   way become profiles. No `.env` is read of Bosun's own accord: `npm run` doesn't, and the tools it
   runs (Vite, Next.js) read theirs, in their own order.

`/init` writes what was worked out as a `bosun.json`, to add ports, health pages, `watch` and
`restart` to; from then on that's what Bosun reads.

`--no-start` opens without starting anything (`R` starts them all).

### Pre-flight

Before the crew starts, Bosun checks what it needs and says what's wrong in the activity lines (and
the Log view), a line each: `✓` fine, `✗` a problem and what to do about it. It never stops them
starting. `/preflight` runs the checks again any time and shows them in the viewer.

| Check | |
| --- | --- |
| Node | The Node on your PATH against `.nvmrc`, `.node-version` or package.json's `engines.node` (the first there) |
| Docker | `docker info` answers, when the crew has compose services |
| Ports | Each process's port is free (a running one's is its own, and isn't checked) |
| `.env` keys | Every key of a `.env.example` is in the env file beside it that the crew reads (the project's `.env` when none is named) |
| Databases | Each database the project's `appsettings*.json` connection strings or `.env` `DATABASE_URL`-style lines name answers on its port (1433, 5432 or 3306 unless given), within 2 seconds |
| `node_modules` | It's there, and newer than the lock file (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) |

## Keys

| Key | What it does |
| --- | --- |
| `1` `2` / `tab` | Crew, Log (`shift+tab` goes back) |
| `/` or `:` | The command prompt, with completion. Pasting a `/command` (or a `family:v1:` line from a sibling) while the prompt is closed opens it with that line, for you to run with `↵` |
| `!` | Run a shell command, e.g. `!node --version` |
| `esc` | Cancel the running command, or clear the activity lines |
| `,` | Settings |
| `?` | Every key and command |
| `q` / `ctrl+c` | Quit, stopping every process (and what they started) |

### Crew

| Key | What it does |
| --- | --- |
| `r` | Restart it |
| `R` | Restart them all, each after the one it waits for |
| `s` | Stop it, or start it; while it waits to restart, it won't |
| `a` | Every process's log at once, or back to the one |
| `ctrl+g` | One group at a time, then all of them again |
| `ctrl+f` | Search the log beside the list: matches light up as you type, `↵` stops typing, `n` `N` go to the next and the one before, `esc` clears it |
| `e` | Only the lines that read as trouble (errors, exceptions, a port in use), or all of them again |
| `ctrl+l` | Filter the log beside the list (see Structured logs) |
| `↵` | Its whole log, in the viewer |
| `c` | Clear its log |
| `l` | Save its log to a file: `/save-log` in the prompt, with `<name>.log` to change |
| `w` | Ask Claude why it failed, from its log and the project's files |
| `o` | Open its port in the browser |
| `f` | Free its port: stop whatever else is holding it (asks first) |
| `p` | Profiles |
| `y` | Copy its command |
| `t` | Copy its latest trouble line for Sonar or Hail, to paste into their prompt (see The family) |
| `T` | Open its port to the internet, or close its tunnel (see Tunnels) |

Beside each running process, when the list has room, is what it uses: its CPU (as a % of one core, so
a busy process on several cores can pass 100%) and its memory, both counting everything it started
(the shell, `npm`, the node under it, its workers). They're measured every 2 seconds while the Crew
view shows, with one look at the machine for every process: `/proc` on Linux, `ps` on macOS, one
PowerShell call on Windows. The log's title has them too, with a sparkline of the last minute of each,
and `/top` lists every process the busiest first. The Memory alert setting says once, with a
notification, when a process's memory keeps growing past it (a leak, most likely).

The dot before each name is green while it runs, yellow while it starts or stops, red when it crashed,
grey when stopped. One that restarts by itself says when it will (`restarting in 4s`), or `gave up`
when it kept failing as soon as it started. `!` after it means its log said something that reads as an error; a port already
in use is one, and `f` stops what holds it. The wheel over the log scrolls it back, and scrolling to
the bottom follows it again. `w` needs [Claude Code](https://claude.com/claude-code) installed and
signed in; Claude reads the log and may read the project's files, and changes nothing.

### Local HTTPS

A process with `"https": 4443` (or `true`, for its `port` plus one) is served at
`https://localhost:4443` as well, for what needs a secure page (cookies marked Secure, OAuth sign-ins,
service workers on another host name): Bosun ends TLS on that port and passes everything on to the
process's own port, websockets included, adding `X-Forwarded-Proto: https`. The list shows the
address beside the port when it has room (`https:4443` when it has a little), the log says when it's
served, and `o` opens it. The port and health checks still look at the process's own port.

The certificate comes from [mkcert](https://github.com/FiloSottile/mkcert), made once into
`~/.bosun/certs` for `localhost`, `127.0.0.1` and `::1`. The first time, Bosun asks whether to run
`mkcert -install` too, which adds mkcert's certificate authority to this machine's trust stores so
browsers trust the page (it may need your password, in which case run it yourself in a terminal);
without it the page works behind a browser warning. Without mkcert on your PATH, Bosun says how to
install it (`winget install FiloSottile.mkcert`, `brew install mkcert`, your package manager), and
the process runs as before.

### Tunnels

`T` (or `/tunnel <name>`) opens a running process's port to the internet for a while, to show someone
your work or to take a webhook: Bosun asks first, then runs `cloudflared tunnel --url
http://localhost:<port>` (a quick tunnel, no account needed) or `ngrok http <port>`, whichever is on
your PATH, cloudflared first unless `"tunnel": "ngrok"` in `bosun.json` says otherwise. The address it
gets (`https://….trycloudflare.com`, `https://….ngrok-free.app`) is copied and said, shown beside the
process (`⇄`) and in its log's title, and its log says when the tunnel opens and closes. `T` again
closes it. It closes when the process stops, crashes or gives up (a restart with `r`, a watched file
or `"restart"` keeps it) and when Bosun quits. Without either tool, Bosun says how to install one.

### Structured logs

A line that is a JSON object, as pino, bunyan, winston and Serilog's compact JSON write them (or any
object with a level and a message: `level`/`severity`, `msg`/`message`, `time`/`timestamp`/`ts`), is
shown as `14:03:07.120 WARN  slow query ms=812 route=/orders`: the time, the level in its colour
(dim for trace and debug, red for error and fatal), the message, then its other fields as
`key=value` (pid, hostname and the like left out). One at error or worse is the process's trouble.
In the viewer (`↵`), `↵` shows a line's whole object, pretty: the line of the search's match, else the
lowest one on screen.

`ctrl+l` filters the log beside the list. Type terms separated by spaces; a line must hold all of them:

| Term | Keeps |
| --- | --- |
| `level>=warn` | Lines at that level or worse (`<=`, `>`, `<`, `=`, `!=` too); the levels are trace, debug, info, warn, error, fatal, and a plain line counts as error when it reads as trouble |
| `route=/orders` | Lines whose field is that (any case); `req.method=GET` reaches inside |
| `route!=/orders` | Structured lines whose field isn't that |
| `msg~timeout` | Lines whose field holds that |
| `timeout` | Lines that say that (a capital in it makes the case matter); `"in quotes"` keeps spaces |

The log's title says the filter while one is on; `ctrl+l` and an empty line takes it off. It works
together with `e` and the search.

The viewer (`↵`) searches the same way (with `/` or `ctrl+f`), starting from the newest match, and `e` there shows only
the trouble too.

In lists: `j` `k` or the arrows move, `g` `G` go to the top and bottom, `ctrl+d` `ctrl+u` page, `y`
copies, `↵` opens. The mouse works too: click a tab, a row or the prompt, double-click for `↵`, scroll
with the wheel, and drag to select text, which is copied when you let go.

### Replay

Every run of the crew is recorded: what each process said, when, and each change of its state (started,
crashed, its port answering). `/replay` lists this project's recordings, newest first, and `↵` plays
one back: a timeline across the top with each crash marked `✗` and each line that read as trouble `!`,
and under it the crew and the log of the one under the cursor as they were at that moment.

| Key | What it does |
| --- | --- |
| `←` `→` | A second back, on (`shift`: ten) |
| `[` `]` | The crash or trouble line before, after |
| `space` | Play or pause |
| `+` `-` | Faster, slower (1× up to 64×) |
| `j` `k` | The process whose log shows |
| `a` | Every process's log at once |
| `esc` | Back to the list of recordings |

A click on the timeline goes to that moment. The recordings are kept in `~/.bosun/sessions`, a folder
per project, the newest 10 of each; one stops recording at 20 MB. A recording starts with the first
line a process says, so opening Bosun with `--no-start` and leaving leaves nothing. The Record
sessions setting turns it off.

### The command palette

`ctrl+p` opens a list of everything you can do from where you are: the keys of the view you're in,
your own keys and commands, and every slash command. Type to narrow it (the words can come in any
order and needn't be whole), `↑`/`↓` pick, `↵` runs the one picked, `esc` closes it. A key runs as if
you'd pressed it in the view; a command that needs something typed after it goes into the prompt for
you to finish.

### The family

Bosun's siblings ([Splice](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/splice) for git,
[Trawl](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/trawl) for SQL, [Sonar](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/sonar)
for Azure, [Hail](https://github.com/FranciscoNunes-dxspark/fleet/tree/main/apps/hail) for HTTP) never start each other.
What one hands another is a command line, copied for you to paste into the other's prompt and run
there; it never holds a password or a token.

- `/family` lists what this project offers them: the checkout for Splice (`/open <repo>`), each `.http`
  file for Hail (`/open <file>`), and each database the project's `appsettings*.json` or `.env` names
  for Trawl (`/azure-sql <server> [database]` for Azure SQL signed in with Entra, else
  `/add <name> <server> [database] [--kind …] [--user …] [--trust-cert]`; Trawl asks for the password itself). `↵`
  copies one.
- `t` in Crew copies the process's latest trouble line as `/take family:v1:logline:…`, with the
  request id it names (`x-request-id`, `requestId`, `request_id`, `traceparent`'s trace id,
  `operation_Id`), for Sonar or Hail to find that request. Anything that looks like a password or token
  in the line is blanked.
- `/take <line>` takes what a sibling copied (the `family:v1:…` part alone works too): a log line or an
  exception is looked for in the crew's logs, by its request id and then its text, and the lines that
  say it open in the viewer. Anything else is another app's, and Bosun says whose.
- Pasting a `/command` or a `family:v1:` line while a view has the keys opens the prompt with it, to
  run with `↵`.
- `/timeline` shows what the five apps did, newest first, from the log they all add to: Bosun adds a
  process crashing (once, not each time it's restarted) or giving up, your restarts and stops (of a
  process, a group or the crew), tunnels opened and closed, and `/move`; the siblings add their own
  (a push, a write to a database…). It starts with this project's (and what names no project); `p`
  shows every project's, and `↵` one whole. Nothing secret goes in.
- `/wiring` lists what the project points at, by the file that says it: the addresses, hosts, ports
  and connection strings in its `appsettings*.json`, `.env` files and Hail's `http-client.env.json`,
  with passwords and tokens masked, the same in every app.
- The mascots tell each other how they feel: Squawk is worried when a process crashes or its checks
  fail, sad when one gives up, busy while a command runs, happy when the crew is up. When a sibling's
  is worried, sad or happy (within the last 15 minutes), Squawk says so once in a line above the
  activity lines; `esc` puts it away. The Family moods setting turns both off. They're kept in
  `~/.family` (`FAMILY_HOME` moves it), with the activity `/timeline` shows.

### Your own commands and keys

Commands of your own go in the settings file (`~/.bosun/config.json`), under `"commands"`, and keys
under `"keys"`, for every view (`"global"`) or for one:

```json
{
  "commands": {
    "v": "!node --version",
    "both": { "run": ["/settings", "/help"], "desc": "Settings, then help" }
  },
  "keys": {
    "global": { "ctrl+s": "/settings" },
    "crew": { "x": "/why web" }
  }
}
```

A command is a line as you'd type it at the prompt, or a list of them run in order, stopping at the
first that fails or asks a question you answer no to. `$1`, `$2`… are the words typed after it, `$*`
all of them. A key maps to another key (the view does what that one does) or to a command line. What
can't be used is said in the activity lines when Bosun starts. These work as they do in Splice and
Trawl.

## Commands

| Command | What it does |
| --- | --- |
| `/restart [name\|group\|all]` | Restart a process, a group, or all of them |
| `/stop <name\|group\|all>` | Stop a process (or every one of a group) and what it started |
| `/start [name\|group\|all]` | Start a process, a group, or all that aren't running |
| `/graph` | Who starts after whom (`after` in `bosun.json`), as a tree, each with its state, port and group |
| `/log <name>` | Everything a process has said |
| `/save-log <name> [file]` | Write a process's log to a file, from the project's folder (`<name>.log` unless given; asks before writing over one) |
| `/why <name>` | Ask Claude why a process failed |
| `/open <name>` | Open a process's port in the browser |
| `/tunnel <name>` | Open a process's port to the internet through cloudflared or ngrok (asks first; the address is copied), or close its tunnel |
| `/free <port>` | Stop whatever holds a port on this machine (asks first) |
| `/preflight` | Check what the crew needs (Node version, Docker, free ports, `.env` keys, databases, `node_modules`), as a checklist |
| `/top` | Every process's CPU and memory (with what it started), the busiest first, and a sparkline of the last minute of each; `↵` shows its log |
| `/ports` | Every TCP port listening on this machine, with the process holding it (pid and name); the crew's are marked. `f` frees one (asks first), `o` or `↵` opens it in the browser |
| `/profile [name\|none]` | Run the crew with a profile |
| `/reload` | Read `bosun.json` and the env files again: new processes start, changed ones restart |
| `/move [folder]` | Run another project instead: a path, or a folder beside this one (completed as you type); without one, a list of the projects run lately and the folders beside this one. This one's processes stop first |
| `/replay` | Play back a recorded run of this project's crew (see Replay) |
| `/init` | Write a `bosun.json` from what Bosun worked out (a Procfile, a compose file, package.json) |
| `/take <family:v1:…>` | Take what a sibling app copied: a log line or exception is looked for in the crew's logs |
| `/family` | What this project offers Splice, Hail and Trawl, as lines to paste into them; `↵` copies one |
| `/timeline` | What the family's apps did here, newest first (`p`: every project's); `↵` shows one whole |
| `/wiring` | What this project points at (addresses, hosts, ports, connection strings), by file, passwords masked |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Theme, accent colour, mouse, notifications, memory alert, recording, family moods, updates, history |
| `/accent <#rrggbb>` | Change the accent colour (`default` puts it back) |
| `/update` | Look for a new version now and install it |
| `/help` | Keys and commands |
| `/quit` | Exit |

## Settings

`,` or `/settings`. They're kept in `~/.bosun/config.json` (`BOSUN_HOME` moves it).

| Setting | |
| --- | --- |
| Theme | `↵` goes through `dark`, `light` and `auto`, and repaints straight away. `auto`, the default, reads the `COLORFGBG` variable some terminals set (Konsole, rxvt, iTerm2 with its option on) to tell a light background from a dark one, and is dark where it isn't set. The light palette has darker colours, pale backgrounds behind search matches, and a darker coral as the default accent; an accent of your own is used as it is |
| Accent colour | The colour of the cursor, borders and the pet |
| Mouse | Off leaves selecting text to the terminal |
| Notify | On (the default), Bosun rings the terminal's bell and raises a desktop notification when a process crashes (once, not again each time it's restarted; never when you stop it), when one gives up restarting, and when a command (`!`, `w`) that took longer than 10 seconds ends. It's OSC 9, which Windows Terminal, iTerm2, WezTerm and kitty show, or OSC 777 in GNOME Terminal and other VTE terminals. A command you cancel says nothing. `"notifyAfter": 30` in the settings file changes the seconds |
| Memory alert | Off (the default), 512 MB, 1 GB, 2 GB or 4 GB: `↵` goes round them. Once a process (with what it started) is over it and its memory has kept rising for at least 20 seconds, Bosun says so in the activity lines and with a notification (when Notify is on), once each time it starts |
| Record sessions | On (the default), each run's output and states are recorded for `/replay`; off records nothing. Either counts from the next start |
| Family moods | On (the default), Squawk writes how it feels for the sibling apps and says when theirs are worried, sad or happy; off does neither |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Prompt history | Clear it |

## License

MIT, see [LICENSE](LICENSE).
