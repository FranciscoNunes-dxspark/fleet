# A tool of your own in Fleet

Fleet runs the family's apps as tabs, and it can run yours beside them. Add each tool to `~/.fleet/host.json`:

```json
{
  "spaces": [
    { "id": "deploys", "title": "Deploys", "command": ["node", "/opt/tools/deploys.js"], "accent": "#9aa5b8" }
  ]
}
```

The fields:

- **`id`:** a short lower-case name.
- **`command`:** the program and its arguments, as a list.
- **`title`:** what the tab says. Optional; the `id` otherwise.
- **`accent`:** the tab's colour. Optional; one is picked otherwise.

Fleet says at start when an entry isn't right, and leaves that entry out.

Every letter after the prefix already belongs to an app or to Fleet. So your tool is reached by its number on the bar (`ctrl+b 7`), a click on its tab, or, in the desktop window, its tab and the palette.

`examples/hello-tool.js` is a complete tool in sixty lines of Node with no dependencies. Start from it.

## What Fleet gives a tool

Fleet doesn't give your tool a terminal. It starts the tool as a child process with pipes, because Fleet's single-file build can't carry a pseudo-terminal library. Your tool gets:

| | |
|---|---|
| **stdin** | The keys as they are typed, already raw: escape sequences, ctrl keys, pastes, mouse reports. Mouse reports come only after your tool turns the mouse on. |
| **stdout** | What your tool draws, as escape sequences, as it would draw in a terminal. Fleet passes it through and keeps the modes it sets (the mouse, the cursor, bracketed paste) for when the tool comes back on screen. |
| **stderr** | Kept: Fleet shows its last lines if the tool exits. |
| **fd 3** | Fleet's control pipe: newline-delimited JSON, from Fleet to the tool. |
| **`FLEET_HOSTED=1`** | Set, so the tool knows it's hosted. |
| **`FLEET_COLUMNS`, `FLEET_ROWS`** | The size to draw at first. |
| **`FORCE_COLOR`** | The terminal's colour depth (3 is 24-bit), since a pipe looks colourless to colour libraries. |
| **The working directory** | The fleet's folder, which moves when you move the fleet (the tool is started again there). |

Because stdout is a pipe, `process.stdout.isTTY` is false and there is no `columns`/`rows` on it. A tool built with a library that insists on a terminal must be told the size, from `FLEET_COLUMNS`/`FLEET_ROWS` and then the control pipe. The family's apps do this through the kit's `appTerminal()` (`packages/kit/hosted.js`). A Node tool built on Ink can use that directly, so Ink sees a terminal.

## The control pipe (fd 3)

One JSON object per line, from Fleet:

- `{ "resize": { "columns": 120, "rows": 39 } }`
  - **A new size:** draw at it.
  - **The same size again:** draw your whole screen again. Fleet sends this after switching back to your tab, because it doesn't keep your screen for you.

When the pipe ends, Fleet has quit, or is moving the fleet to another folder. Exit then: Fleet kills a tool that's still there three seconds later.

## Messages to Fleet

These go inside stdout, as `ESC ] 5379 ; <json> BEL`. Fleet takes them out of what it draws, on screen or not.

- `{ "ready": true }`: the tool reads keys now. A line handed to it waits for this.
- `{ "handoff": "trawl", "line": "/connect prod" }`: switch to that app (or the first running of a list) and type the line into its prompt.
- `{ "move": "/abs/folder" }`: ask to move the fleet there. Fleet asks the person first.
- `{ "update": true }`: ask Fleet to look for a new version of itself now.

## Drawing

- **Rows:** draw full-screen from the top left corner. You get every row but Fleet's bar, and in the desktop window every row.
- **Alternate screen and title:** Fleet drops the alternate screen and the title stack from what your tool writes, since the screen is shared, so writing them does no harm.
- **Synchronised updates** (`CSI ? 2026 h` … `l`): Fleet draws its bar inside them, so a frame never shows without it.
- **The bell, OSC 52 (copy) and OSC 9 (notify):** passed on to the terminal.

## The family's own apps

They follow the same protocol with more of it. The family's activity log and moods (`~/.family`, the kit's `family.js`) give a tab its badge, and contexts let a line be handed between apps. A tool of yours can write a mood file too:

```
~/.family/<id>.mood.json
{ "app": "<id>", "mood": "worried", "reason": "2 deploys failed", "at": 1731100000000 }
```

Fleet then badges the tool's tab while it's off screen and says why: in the bar's notice in a terminal, and as a toast in the desktop window.
