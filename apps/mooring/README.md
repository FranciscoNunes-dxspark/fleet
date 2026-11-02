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

Mooring runs `ssh` without a terminal, so it can't show ssh's own prompts. It signs in one of two ways:

- **A key or your ssh agent** (the default): `/add … key=<file>`, or a key `ssh-add` has loaded. A key with a passphrase needs the agent, as Mooring can't ask for the passphrase. `/keygen [name] [host]` makes one (below).
- **A password**, for a host saved with the word `password`: `/add web me@web password`. Mooring asks for it, masked, **every time it connects** (`/connect`, `↵` in Hosts). It is never saved: the settings file records only that the host asks for one. It is handed to ssh through that ssh's environment (OpenSSH's `SSH_ASKPASS` with a two-line helper script Mooring writes to a private temporary folder and removes on exit), never on a command line, and it is let go of when you disconnect. OpenSSH 8.4 or newer is needed (Windows 10 and 11, current Macs and Linux have it). A wrong password fails once with ssh's own message, not three times.

When sign-in fails, ssh's own words come back with what to do.

### A host ssh doesn't know yet

The first time you connect to a host that has no entry in `known_hosts`, Mooring asks the question ssh would, since it can't be answered inside ssh here: it looks up the key the host offers (`ssh-keyscan`), shows its fingerprint, and asks whether to trust it.

```
ssh doesn't know ci@build.example.com yet. Trust its key (compare the fingerprint)?
ED25519 SHA256:Z0AF8IP8Iwiqv46UQIMY2Y/QRWSt/Wwz+rOsPbRaK9Y
  1. Trust it and connect
  2. Cancel
```

**Compare that fingerprint with one you already know** (from the server's administrator, the provider's panel, or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server): a key fetched over the network can't vouch for itself, and trusting a wrong one is how a machine in the middle gets in. On a yes, exactly the key you saw is added to the `known_hosts` file ssh reads (`ssh -G` says which; `~/.ssh/known_hosts` as a rule), the trust is noted in the Log and the family's activity log (host and fingerprint, which are public), and the connection goes on. On a no, nothing is written.

A host whose key has *changed* is never offered: that is ssh's `REMOTE HOST IDENTIFICATION HAS CHANGED`, shown as it is. Find out why before you replace the old entry yourself (`ssh-keygen -R <host>`). If the lookup can't be made (no `ssh-keyscan`, or the host doesn't answer) nothing is asked and ssh's own error comes back. The same goes for password hosts and key hosts.

## Hosts

`/add <name> <user@host[:port]> [key=<file>] [folder=<remote folder>] [password]` saves a host (and changes the one of that name); `/keygen [name] [host]` makes an ed25519 key in `~/.ssh` (default name `id_ed25519_mooring`) with OpenSSH's `ssh-keygen`, asking first and never replacing a key that is there. It has **no passphrase** (Mooring can't ask for one, and a passphrase in an argument would be readable by other processes), so keep the file private. The public half is copied and shown with the line to add to the server's `~/.ssh/authorized_keys` (`ssh-copy-id -i <key>.pub user@host`); with a saved host's name, that host is changed to sign in with the new key. Only the key's path is saved. `/forget <host>` takes it out, asking first; `/connect <host>` opens it (a list to pick from without a name), `/disconnect` closes it. The Hosts view (`4`) does the same with keys: `↵` connects, `a` adds, `e` changes the one under the cursor, `x` forgets it. A host's `folder` is where the right pane starts; without one it starts in the home folder.

```
/add web me@web.example.com key=~/.ssh/id_web folder=/var/www
/add build ci@10.0.0.7:2222
/add old admin@192.168.1.5 password
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

### Syncing a folder

`/sync [down|up|both]` makes the left pane's folder and the right pane's match. It compares every file under both (by size and modification time), shows the plan, each file with what happens to it and why (*new*, *changed*, *newer here*, *only on the server*), asks, and sends the transfers through the queue. `up` makes the server like this machine, `down` this machine like the server, and `both` (the default) carries each side's changes to the other. After a sync Mooring keeps what each file was (its size and time, nothing of its contents, in `~/.mooring/sync.json`), so the next `both` can tell which side changed a file: changed on both sides is a **conflict**, shown and left alone until `/sync up` or `/sync down` settles it, and a file gone from one side was deleted there. Before the first sync the newer copy wins.

| Option | |
|---|---|
| `--checksum` | Files of the same size whose times differ are compared by sha256 (`sha256sum` on the server, in one `ssh` call), and left alone when they are the same |
| `--delete` | What the plan finds only on one side (or deleted on the other) is deleted, after the question; without it such files are listed and kept |

`.git` and `node_modules` are never synced, nor what the local folder's `.mooringignore` names, a pattern a line (`*.log`, `/dist`, `cache/tmp`; `#` for a comment): a name without a slash matches anywhere, one with a slash from the folder's top.

`/watch` keeps uploading what changes in the left pane's folder to the right pane's, as it changes (a moment after the last write, so a save is one upload), with the same ignore list, until `/watch off`; the header says `⟳ watching <folder>`. Deletions aren't carried over: `/sync up --delete` does that.

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

A shell on the server, with a terminal. Opening Console (`3`) opens one in the folder the right pane shows, and from then on **every key goes to it** as you press it: `ls`, `cd`, tab completion, `ctrl+c`, a pager, `vim`, `top`, a `sudo` asking for a password. **`ctrl+\` leaves it** (the keys are Mooring's again: `1`–`5` switch tab, `/` opens the prompt); `↵` goes back in. `$ <command>` at the prompt (or `/ssh <command>`) types that command into the shell and goes there. The shell is yours to end: `exit` shows "shell ended" and `↵` starts another. It closes with the connection.

It is `ssh -tt` (ssh makes the terminal on the server although this side has none) with its output drawn through the kit's virtual terminal, so colours, cursor movement and full-screen programs work, and what scrolls off the top is kept (2000 lines) to look back through. **Resizing** follows the window: the screen here changes at once, and when the size has stopped changing for a moment a second, short `ssh` runs `stty` on the shell's tty (which the shell reported when it started), so the server signals vim, `top` and the shell and they redraw. That second `ssh` signs in as the shell did (a password host's password is still only in memory). A server without `stty` or a tty path keeps the size it started at. A host that asks for a password signs in as always, for the shell too, and nothing typed in the shell is kept by Mooring.

| Key | |
|---|---|
| `↵` `$` `i` | Type in the shell (everything you press goes to it; `ctrl+\` leaves) |
| `↑` `↓` `j` `k` `pgup` `pgdn` `space` | Look back through what scrolled away (also the wheel) |
| `y` | Copy the screen |

### The server's health

`/health` (or `alt+h` anywhere) runs one `ssh` command on the server and shows what it says in a panel: each disk's use (`df -P`), memory and swap (`/proc/meminfo`, or `free -m`), the load beside the number of CPUs, the uptime, the five busiest processes by CPU and by memory (`ps`), and the systemd units that have failed (where there is `systemctl`). A disk over 90% full and a failed unit are in red at the top, and Tug is worried about them (the family hears why) until a read shows them gone or you disconnect. `r` reads it again, `esc` closes it.

### Hosts, Log

Hosts is above. Log is everything the activity lines have said, `↵` for one whole.

## Anywhere

| | |
|---|---|
| `/` or `:` | Command prompt, with completion (host names, and the names in the panes for `/get` and `/put`); where there is nothing to complete, the command's parameters stay shown under the prompt |
| `!` | A shell command on this machine, e.g. `!ssh-add -l` (its output is in the activity line; `/last` has all of it) |
| `$` | A command on the server (above) |
| `alt+h` | The server's health (`/health`, below) |
| `ctrl+p` | The command palette |
| `esc` | Cancel what is running, or clear the activity lines |
| `ctrl+r` | Read both folders again |
| `,` | Settings |
| `q` | Quit |

The mouse: click a tab, a pane, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, copied when you let go. `/mouse off` leaves it to the terminal.

Your own commands and keys (`"commands"` and `"keys"` in the settings file) work as in the other apps.

## Settings

`~/.mooring/config.json` (`MOORING_HOME` names another folder): the saved hosts (where each is, the key file or that it asks for a password: never a password or passphrase), `showHidden`, `transfers` (how many run at once, 2), `theme` (`dark`, `light`, `auto`), `accent` (`#rrggbb`), `mouse`, `checkForUpdates`, `autoUpdate`, `familyMoods`, your `commands` and `keys`. `/settings` shows them; `/theme`, `/accent`, `/mouse` and `/hidden` change them.

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
