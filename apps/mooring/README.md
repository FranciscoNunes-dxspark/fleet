# Mooring

<img src="assets/logo.svg" alt="Tug, the Mooring sea otter" width="96" align="right">

Files and commands on a server, in the terminal. Mooring puts this machine's folder beside a server's, copies what you mark in either direction through a queue that shows each transfer's progress, renames, makes and deletes, and runs a command on the server with its output in a view of its own. It is a keyboard-driven answer to FileZilla and PuTTY, over the `ssh` your machine already has: SFTP for the files, `ssh` for the commands.

```
mooring            # this folder; /connect (or a host's name here) opens a saved host
mooring build      # the saved host "build", opened at start
mooring --demo     # a made-up host and machine, to look around: nothing is touched
```

Press `?` inside for every key and command, `/` for the commands, `ctrl+p` for the palette.

Mooring is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/mooring`), or download the executable from the releases. It needs `ssh` on the PATH (OpenSSH, which Windows 10 and 11 and every Mac and Linux machine have).

## Signing in

Mooring runs `ssh` without a terminal (it can't draw a password prompt inside its own screen), so it signs in with **a key or your ssh agent**, and the host must already be in `known_hosts`. When that isn't so, ssh's own words come back with what to do: give the host a key (`/add … key=<file>`), `ssh-add` it, or connect once with plain `ssh` to trust the host. Nothing secret is kept: the settings file holds where each host is and which key file signs in to it, never a password or a passphrase.

## Hosts

`/add <name> <user@host[:port]> [key=<file>] [folder=<remote folder>]` saves a host (and changes the one of that name); `/forget <host>` takes it out, asking first; `/connect <host>` opens it (a list to pick from without a name), `/disconnect` closes it. The Hosts view (`4`) does the same with keys: `↵` connects, `a` adds, `e` changes the one under the cursor, `x` forgets it. A host's `folder` is where the right pane starts; without one it starts in the home folder.

```
/add web me@web.example.com key=~/.ssh/id_web folder=/var/www
/add build ci@10.0.0.7:2222
```

The files go over one SFTP connection that stays open: there is one sign-in for the whole session, the right pane and the queue use it at once, and a cancelled transfer leaves it as it was. If the connection drops, the next thing you do opens it again (a call cut off in the middle fails rather than being repeated: it may have been done). Commands run through `ssh` once each.

## Views

`1` Files · `2` Transfers · `3` Console · `4` Hosts · `5` Log. `tab` goes round.

### Files

This machine's folder on the left, the server's on the right; the focused pane has the bright border (`←` `→`, or `h` `l`, or a click).

| Key | |
|---|---|
| `↵` | Open a folder; on a file, what is known of it |
| `backspace` `-` | The folder above, the cursor on the one you left |
| `~` | Home |
| `space` | Mark the entry and move on; `c`, `d` and `x` act on everything marked |
| `c` | Copy what is marked (or under the cursor) to the other pane's folder, through the queue: uploads from the left, downloads from the right. A file that is there already asks first (replace, replace this and every other, skip, stop) |
| `m` | A new folder |
| `r` | Rename |
| `d` `x` | Delete what is marked or under the cursor, asking first; a folder goes with all that is in it. Links are removed as links, never followed |
| `i` | Size, mode, time and, for a link, where it points |
| `.` | Show files that start with a dot, or not (`/hidden`) |

`/cd <folder>` and `/lcd <folder>` go to a typed path on the server and on this machine (`..`, `~`, relative or absolute); `/get <name>` and `/put <name>` queue one named entry; `/mkdir [name]` makes a folder in the focused pane.

Folders are copied whole, file by file; links and special files in them are skipped, never followed (a link out of the folder would copy what isn't in it). A copy keeps each file's modification time.

### Transfers

The queue: what waits, what is moving (two at a time, over the one connection), what is done and what failed, each with a bar, a percentage, the rate and the time left. A failed one says why (`↵` for the whole message).

| Key | |
|---|---|
| `↵` | Where it goes from and to, and why it failed |
| `x` | Cancel it; what had reached the other side is removed |
| `r` | Try a failed or cancelled one again |
| `d` | Take it off the list |
| `c` | Clear the ones that are done |

The panes read again by themselves when a transfer finishes, and the header counts what is moving.

### Console

`$ <command>` at the prompt (or `/ssh <command>`) runs a command on the server, in the folder the right pane shows, and its output comes into Console as it arrives, with the exit code and what it said on standard error marked. `cd <folder>` moves the right pane instead (a command run alone could not stay in a folder). One command runs at a time.

There is no terminal: nothing full-screen (`vim`, `top`) or interactive (a `sudo` asking for a password) works here, and the commands assume a POSIX shell on the server. What a program prints is cleaned before it is drawn (colours, cursor moves, titles and links are dropped), so a server can't repaint or retitle your terminal.

| Key | |
|---|---|
| `↵` `$` `i` | Type a command (the prompt opens with `$`) |
| `x` | Cancel the command that is running |
| `y` | Copy the output of the command under the cursor |
| `c` | Clear the console |

### Hosts, Log

Hosts is above. Log is everything the activity lines have said, `↵` for one whole.

## Anywhere

| | |
|---|---|
| `/` or `:` | Command prompt, with completion (host names, and the names in the panes for `/get` and `/put`) |
| `!` | A shell command on this machine, e.g. `!ssh-add -l` (its output is in the activity line; `/last` has all of it) |
| `$` | A command on the server (above) |
| `ctrl+p` | The command palette |
| `esc` | Cancel what is running, or clear the activity lines |
| `ctrl+r` | Read both folders again |
| `,` | Settings |
| `q` | Quit |

The mouse: click a tab, a pane, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, copied when you let go. `/mouse off` leaves it to the terminal.

Your own commands and keys (`"commands"` and `"keys"` in the settings file) work as in the other apps.

## Settings

`~/.mooring/config.json` (`MOORING_HOME` names another folder): the saved hosts, `showHidden`, `transfers` (how many run at once, 2), `theme` (`dark`, `light`, `auto`), `accent` (`#rrggbb`), `mouse`, `checkForUpdates`, `autoUpdate`, `familyMoods`, your `commands` and `keys`. `/settings` shows them; `/theme`, `/accent`, `/mouse` and `/hidden` change them.

## In the fleet

Mooring is the ninth space in [Fleet](../fleet) (`alt+9`, `ctrl+b u`). It writes Tug's mood for its siblings (a transfer that failed or a connection that didn't open, worried), and what it changed goes in the family's activity log: *deleted notes.txt on build*, *uploaded site to web*, never a command or a file's contents. Tug answers a worried sibling with a line of its own.

## Development

```
npm install                 # at the repository root
npm test -w apps/mooring    # the suite (node:test); nothing in it needs a server
npm run demo -w apps/mooring
node scripts/logo.js        # regenerate assets/ from src/pet.js
```

CLAUDE.md has the architecture.
