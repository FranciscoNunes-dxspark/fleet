<p align="center"><img src="assets/logo.svg" width="120" alt="Squawk, the Bosun parrot"></p>

# Bosun

Runs a project's processes for you in the terminal, each with its own log, port and health.

A keyboard-driven terminal app, a sibling of Splice and Trawl: the same prompt, help window, mouse,
settings and self-updating builds.

> Started from [slipway](https://github.com/FranciscoNunes-dxspark/slipway). The Items view and its data
> (`src/source.js`) are placeholders, there to be replaced by what Bosun is really for.

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/bosun/releases/latest)
and put it on your PATH. It checks for a new version once a day and installs it by itself; the new
version starts the next time you open Bosun.

From a checkout (Node 22 or later):

```bash
npm install
npm start
```

## Keys

| Key | What it does |
| --- | --- |
| `1` `2` / `tab` | Items, Log (`shift+tab` goes back) |
| `/` or `:` | The command prompt, with completion |
| `!` | Run a shell command, e.g. `!node --version` |
| `r` | Refresh |
| `esc` | Cancel the running command, or clear the activity lines |
| `,` | Settings |
| `?` | Every key and command |
| `q` / `ctrl+c` | Quit |

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
    "global": { "ctrl+s": "/settings" }
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
| `/show <item>` | Show an item |
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
