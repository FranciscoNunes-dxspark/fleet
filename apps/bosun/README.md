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

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/bosun/releases/latest)
and put it on your PATH. It checks for a new version once a day and installs it by itself; the new
version starts the next time you open Bosun.

From a checkout (Node 22 or later):

```bash
npm install
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
| `health` | A page on that port that answers 2xx or 3xx when it's well; ✗ otherwise |
| `env` | Settings for it, on top of the terminal's |
| `after` | Another process it starts after: once that one's port answers, or it has run a moment |

A profile changes some processes: `run` replaces the command, `args` adds to it, `env` adds settings.
`p` or `/profile` picks one (`--profile` starts with it), and the processes it changes restart.

Without a `bosun.json`, Bosun runs package.json's `dev` script (else `start`). When that's a
`concurrently` line, each of its commands is a process of its own, named as `-n` names them, and other
`dev:` scripts split the same way become profiles. `/init` writes that out as a `bosun.json`, to add
ports and health pages to.

`--no-start` opens without starting anything (`R` starts them all).

## Keys

| Key | What it does |
| --- | --- |
| `1` `2` / `tab` | Crew, Log (`shift+tab` goes back) |
| `/` or `:` | The command prompt, with completion |
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
| `s` | Stop it, or start it |
| `a` | Every process's log at once, or back to the one |
| `↵` | Its whole log, in the viewer |
| `w` | Ask Claude why it failed, from its log and the project's files |
| `o` | Open its port in the browser |
| `f` | Free its port: stop whatever else is holding it (asks first) |
| `p` | Profiles |
| `y` | Copy its command |

The dot before each name is green while it runs, yellow while it starts or stops, red when it crashed,
grey when stopped. `!` after it means its log said something that reads as an error; a port already
in use is one, and `f` stops what holds it. The wheel over the log scrolls it back, and scrolling to
the bottom follows it again. `w` needs [Claude Code](https://claude.com/claude-code) installed and
signed in; Claude reads the log and may read the project's files, and changes nothing.

In lists: `j` `k` or the arrows move, `g` `G` go to the top and bottom, `ctrl+d` `ctrl+u` page, `y`
copies, `↵` opens. The mouse works too: click a tab, a row or the prompt, double-click for `↵`, scroll
with the wheel, and drag to select text, which is copied when you let go.

### The command palette

`ctrl+p` opens a list of everything you can do from where you are: the keys of the view you're in,
your own keys and commands, and every slash command. Type to narrow it (the words can come in any
order and needn't be whole), `↑`/`↓` pick, `↵` runs the one picked, `esc` closes it. A key runs as if
you'd pressed it in the view; a command that needs something typed after it goes into the prompt for
you to finish.

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
| `/restart [name\|all]` | Restart a process, or all of them |
| `/stop <name\|all>` | Stop a process and what it started |
| `/start [name\|all]` | Start a process, or all that aren't running |
| `/log <name>` | Everything a process has said |
| `/why <name>` | Ask Claude why a process failed |
| `/open <name>` | Open a process's port in the browser |
| `/free <port>` | Stop whatever holds a port on this machine (asks first) |
| `/profile [name\|none]` | Run the crew with a profile |
| `/reload` | Read `bosun.json` again: new processes start, changed ones restart |
| `/init` | Write a `bosun.json` from what Bosun worked out |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Accent colour, mouse, updates, history |
| `/accent <#rrggbb>` | Change the accent colour (`default` puts it back) |
| `/update` | Look for a new version now and install it |
| `/help` | Keys and commands |
| `/quit` | Exit |

## Settings

`,` or `/settings`. They're kept in `~/.bosun/config.json` (`BOSUN_HOME` moves it).

| Setting | |
| --- | --- |
| Accent colour | The colour of the cursor, borders and the pet |
| Mouse | Off leaves selecting text to the terminal |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Prompt history | Clear it |
