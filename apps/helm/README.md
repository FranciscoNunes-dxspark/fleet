# Helm

A PowerShell script editor in the terminal, in the spirit of the PowerShell ISE, with two views over one PowerShell session: **Script** (the script on top, the **console** under it, where what ran prints) and **Console** (the whole screen for PowerShell itself, with a terminal of its own, as Mooring's Console is for a server's shell: you type straight into it). Variables and functions stay from one run to the next, as in the ISE.

It runs `pwsh` (PowerShell 7) when it is installed, else Windows PowerShell on Windows.

```
helm [script.ps1]
```

## Keys

| Key | What it does |
| --- | --- |
| F5 (or ctrl+r) | Run the whole script |
| F8 (or ctrl+e) | Run the selection, or the current line |
| esc, ctrl+c | Stop a running script (ctrl+c to PowerShell: its variables stay) |
| ctrl+s / ctrl+o / ctrl+n | Save (asks for a path the first time), open, new script |
| ctrl+t, shift+tab, alt+1 / alt+2 | Move between the Script and Console views (in the Console, ctrl+t or ctrl+\\ goes back) |
| ctrl+l | Clear the console |
| F1 (or alt+h) | The keys, on screen |
| ctrl+q | Quit (asks twice when the script has unsaved changes) |

In the Script view: arrows, Home (first character, then the line start), End, PgUp/PgDn, Backspace, ctrl+d (delete forward), Tab (two spaces). A new line keeps the indent, and goes one deeper after `{` or `(`. The bracket at the cursor and its partner are marked. Syntax is coloured: comments, strings, `$variables`, `-parameters`, `Verb-Noun` commands and keywords.

| Key | What it does |
| --- | --- |
| shift+arrows, shift+Home/End/PgUp/PgDn | Select; typing replaces the selection, esc drops it |
| ctrl+a | Select all |
| ctrl+c / ctrl+x / ctrl+v | Copy the selection (while nothing runs), cut, paste |
| ctrl+z / ctrl+y | Undo / redo (typing in one go is one step) |
| ctrl+f / ctrl+g | Find (case blind, wrapping; the match is selected), find the next one |
| alt+↑ / alt+↓ | Give the console more / less of the screen |
| mouse | Click to place the cursor, drag to select, the wheel scrolls the script or the console, click a view's tab to switch |

F5 types the script into the console as one dot-sourced file (`. 'C:\scripts\a.ps1'`): a saved script without changes runs from where it is, so `$PSScriptRoot` is its folder; one with changes runs from a copy in a temporary folder. F8 types the line as it is, or a selection of several lines as a file. The console shows each run as PowerShell does, in its colours, and the top line says *running* until PowerShell's prompt comes back.

In the Console view every key goes to PowerShell as it came, so it's PowerShell's own line editor (PSReadLine): Tab completes, ↑↓ recall, ctrl+r searches, ctrl+c stops what runs, and programs that ask (`Read-Host`, a confirmation) or take the screen work. Only these stay Helm's: F5 and F8 run, ctrl+t or ctrl+\ goes back to the script, ctrl+q quits, and shift+PgUp/PgDn (or the wheel) look back through what scrolled away. When PowerShell ends (`exit`), ↵ in the Console starts it again.

The console is a real terminal: on Linux and macOS through `script` (part of the system), which gives PowerShell a pty; on Windows through a pseudo console (ConPTY, Windows 10 1809 or later), opened by a small relay that PowerShell compiles the first time (kept in the temp folder as `helm-pty-*.dll`). Your PowerShell profile loads as in any console. Helm learns how each command went from the prompt, which it wraps to print an invisible mark first; where an older Windows drops the mark, runs still work, but Helm can't tell when one is over.

## Spoke

Helm's mascot is Spoke, a ship's cat: its face in the top line and the status line looks about, then happy or worried after a run (a script that wrote an error, or was stopped, worries it), and says so when another app's mascot is worried, sad or happy (esc clears it). Each run is told to the other apps as *which script* ran and whether it failed, never its code or output.

## Not there yet

Several script tabs, breakpoints and a command browser.
