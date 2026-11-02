# Helm

A PowerShell script editor in the terminal, in the spirit of the PowerShell ISE: a **script pane** on top, the **output** of what ran under it, and a **console prompt** under that, all over one PowerShell session. Variables and functions stay from one run to the next, as in the ISE.

It runs `pwsh` (PowerShell 7) when it is installed, else Windows PowerShell on Windows.

```
helm [script.ps1]
```

## Keys

| Key | What it does |
| --- | --- |
| F5 (or ctrl+r) | Run the whole script |
| F8 (or ctrl+e) | Run the current line |
| esc, ctrl+c | Stop a running script (the session starts again, without its variables) |
| ctrl+s | Save (asks for a path the first time) |
| ctrl+o | Open a script (asks for a path) |
| ctrl+n | New, empty script |
| ctrl+t, shift+tab | Move between the script pane and the console |
| ctrl+l | Clear the output |
| ctrl+q | Quit (asks twice when the script has unsaved changes) |

In the script pane: arrows, Home (first character, then the line start), End, PgUp/PgDn, Backspace, ctrl+d (delete forward), Tab (two spaces). A new line keeps the indent, and goes one deeper after `{` or `(`. Syntax is coloured: comments, strings, `$variables`, `-parameters`, `Verb-Noun` commands and keywords.

In the console: type a command and press ↵; ↑↓ recall earlier ones; PgUp/PgDn scroll the output. Errors are shown in red.

## Not there yet

Selecting text (F8 runs the current line, not a selection), undo, several script tabs, breakpoints and a command browser.
