<p align="center"><img src="assets/logo.svg" width="120" alt="A ship's wheel with six handles, one per app"></p>

# Fleet

The family's terminal apps in one terminal: [Splice](../splice) (git), [Trawl](../trawl) (SQL),
[Sonar](../sonar) (Azure), [Bosun](../bosun) (a project's processes), [Hail](../hail) (HTTP) and
[Keel](../keel)'s terminal app (Azure DevOps). Each runs exactly as it does by itself, with its own
settings, sign-ins and keys; Fleet shows one at a time and switches between them with `ctrl+]`, as
tmux does with its windows. A bar at the bottom shows them all.

```
 1 Splice ●  2 Trawl ●  3 Sonar ○  4 Bosun ○  5 Hail ✕1  6 Keel ○                ctrl+] ? help
```

`●` runs, `○` hasn't started yet, `✕` and a number exited with that code. The app on screen has its
tab in its own colour.

## Install

Download `fleet` for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=fleet-v&expanded=true)
and put it on your PATH. It is one executable with all six apps inside, so it's the only download you
need. It checks for a new version once a day and installs it by itself; the new version starts the
next time you open Fleet. (The apps inside don't update themselves: Fleet updates them together.)

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
Only `ctrl+]` is Fleet's, and the key after it:

| Keys | What they do |
| --- | --- |
| `ctrl+]` `1`–`6` | Switch to that space |
| `ctrl+]` `s` `t` `o` `b` `h` `k` | Switch to Splice, Trawl, Sonar (o), Bosun, Hail, Keel |
| `ctrl+]` `]` or `n` | The next space |
| `ctrl+]` `p` | The previous space |
| `ctrl+]` `ctrl+]` | Send `ctrl+]` to the app |
| `ctrl+]` `q` | Quit Fleet, stopping every app (it asks first when any is running) |
| `ctrl+]` `?` | The keys |

Any other key after `ctrl+]` cancels it. A click on a tab in the bar switches to it, whatever the app on screen does with the mouse: Fleet keeps clicks on for the bar, even for an app with its mouse turned off or one that has exited, and passes clicks on only to an app that wants them. With an app's mouse off, select text the terminal's own way while Fleet runs: most terminals select with shift held down.

## Hand-offs

The apps hand each other things as a line to paste into the other's prompt: Sonar's `T` copies a
`/azure-sql …` line for Trawl, Splice's `Y` a `/take …` for Sonar, and so on. Inside Fleet that's one
step: Fleet switches to the app the line is for (starting it if it isn't running), and types the line
into its prompt. Press `↵` to run it. The line is still copied too. A line that several apps could take
(a log line, which Sonar, Hail and Bosun all read) goes to the first of them that's running, else
stays on the clipboard only.

## Notes

- Fleet keeps the app it opened last in `~/.fleet/host.json` (`FLEET_HOME` moves the folder).
  `FLEET_NO_UPDATE_CHECK=1` turns the update check off.
- Each app keeps its settings where it always does (`~/.splice`, `~/.trawl`, …), so they're the same
  inside Fleet and out.
- Colours follow your terminal's: 24-bit where it has them, else the nearest of 256.
