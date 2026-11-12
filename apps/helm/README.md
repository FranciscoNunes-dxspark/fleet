# Helm

A PowerShell script editor in the terminal, in the spirit of the PowerShell ISE, with two views over one PowerShell session: **Script** (the script on top, the **output** of what ran under it) and **Console** (the whole screen for the session: type commands, with tab completion and history, and read what they print). Variables and functions stay from one run to the next, as in the ISE.

It runs `pwsh` (PowerShell 7) when it is installed, else Windows PowerShell on Windows.

```
helm [script.ps1]
```

## Keys

| Key | What it does |
| --- | --- |
| F5 (or ctrl+r) | Run the whole script |
| F8 (or ctrl+e) | Run the selection, or the current line |
| esc, ctrl+c | Stop a running script (the session starts again, without its variables) |
| ctrl+s / ctrl+o / ctrl+n | Save (asks for a path the first time), open, new script |
| ctrl+t, shift+tab, alt+1 / alt+2 | Move between the Script and Console views |
| ctrl+l | Clear the output |
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
| alt+↑ / alt+↓ | Give the output more / less of the screen |
| mouse | Click to place the cursor, drag to select, the wheel scrolls the script or the output, click a view's tab to switch |

In the Console view: type a command and press ↵; Tab completes it with PowerShell's own completion (commands, parameters, paths, variables; Tab again for the next match); ↑↓ recall earlier ones; PgUp/PgDn scroll. The output is the same as the Script view's, wrapped to the width. Errors are red, warnings yellow, verbose and debug lines dim.

## Not there yet

Several script tabs, breakpoints, a command browser, and an interactive terminal (programs that take over the screen, or `Read-Host`).
