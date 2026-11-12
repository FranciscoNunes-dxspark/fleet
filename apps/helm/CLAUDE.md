# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Helm is a PowerShell script editor in the terminal, like the ISE: two views (Script: the script over its output; Console: a full-height transcript with a prompt) over one long-lived PowerShell session. Keyboard-driven, built with Ink on Node 22+, plain JavaScript ES modules with `.jsx` for components. The README is the user-facing spec; when behaviour changes, update it too. It lives in `apps/helm` and uses the shared kit (`@fleet/kit`; the root CLAUDE.md has its rules); `src/app.js` tells the kit the app's name, and `src/theme.js` fills the kit's theme. Helm draws in the kit's shell look (`look: 'shell'` in `src/app.js`, the kit's `look.js`): the top line (`topLine`: the name, and `headerContext` at the right: the file, `*` while unsaved, the PowerShell), the views' tabs, the panes, a one-row prompt (Console view, or while a path or a find is asked) and the status line (`StatusLine`: the keys, or what a path prompt asks for).

## Commands

```bash
npm test                      # here; npm run test:helm at the root
npm start                     # needs a real TTY
node --import @fleet/kit/register.js --import ./src/app.js --test test/buffer.test.js   # one file
```

## Architecture

- **`src/powershell.js`**: `createSession({ bin })`. One process runs a loop that reads a base64 line per run, dot-sources it, merges every stream, and prints a marker line when done; errors come back prefixed with `ERROR_MARK`, warnings with `WARN_MARK` and verbose/debug with `VERBOSE_MARK`. `stop()` kills the process (the only way to interrupt), so the next run starts a fresh session. `locate()` finds `pwsh`, else `powershell` on Windows. The test that uses a real PowerShell skips when there is none.
- **`src/buffer.js`** (pure): the script text as `{ lines, row, col, anchor? }` (`anchor` is where a selection began), every edit returning a new one; selection, `extend`, `find`. **`src/help.js`**: what F1 lists. **`src/highlight.js`** (pure): colours one line, puts the cursor in it, scrolls it sideways.
- **`src/ui/App.jsx`**: the screen and all keys. Ink doesn't report function keys (F5 arrives as an empty key), so `useKeyTranslation` turns F5 and F8 into ctrl+r and ctrl+e. Undo is a stack of buffers (edits within 500 ms share a step); Tab in the Console asks the session's `TabExpansion2`. The text, prompt, focus and path mode live in refs updated synchronously as well as in state: keys can arrive faster than React renders.
- **Mouse**: `cli.jsx` takes `terminalMouse` and hands it to App as `mouse`; App maps clicks, drags (`claimDrags`, so the app selects for itself) and the wheel onto the layout it drew (`geo`: the top line is row 0, a pane's title row is next, the code starts at column `2 + GUTTER`).
- **The family** (`@fleet/kit/family.js`): Helm is in `FAMILY`, `ROLES` (PS), `APP_NAMES` and `PET_NAMES` (Spoke, a ship's cat). `src/pet.js` is only the one-line `FACES` and `moodFor` (running: looking; a run that failed or was stopped: worried for 8 s; one that went well: happy for 4 s); `src/moods.js` is `familyMood` and `reactionTo` (a worried, sad or happy sibling, one line in the status line until esc). App writes its mood, polls `readMoods` every `moodEvery` ms and logs each run to the activity log as *which script* (`Ran a.ps1`, `Ran a selection`, `Ran a command`), and whether it failed: never the code, the output or an error's words. `family={false}` (every test but the family one) keeps it out of `~/.family`. Helm has no slash prompt, so Fleet's proposals (`PROMPT_APPS`) leave it out. Fleet hosts Helm (`i`).

## Tests

`test/app.test.js` renders `<App>` over a fake session with `ink-testing-library`, typing keys and asserting on frames (wait with `until`, never fixed sleeps, except to let typed text settle before a key that reads it).
