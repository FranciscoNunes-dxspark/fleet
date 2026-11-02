# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Helm is a PowerShell script editor in the terminal, like the ISE: a script pane, an output pane and a console prompt over one long-lived PowerShell session. Keyboard-driven, built with Ink on Node 22+, plain JavaScript ES modules with `.jsx` for components. The README is the user-facing spec; when behaviour changes, update it too. It lives in `apps/helm` and uses the shared kit (`@fleet/kit`; the root CLAUDE.md has its rules); `src/app.js` tells the kit the app's name, and `src/theme.js` fills the kit's theme.

## Commands

```bash
npm test                      # here; npm run test:helm at the root
npm start                     # needs a real TTY
node --import @fleet/kit/register.js --import ./src/app.js --test test/buffer.test.js   # one file
```

## Architecture

- **`src/powershell.js`**: `createSession({ bin })`. One process runs a loop that reads a base64 line per run, dot-sources it, merges every stream, and prints a marker line when done; errors come back prefixed with `ERROR_MARK`. `stop()` kills the process (the only way to interrupt), so the next run starts a fresh session. `locate()` finds `pwsh`, else `powershell` on Windows. The test that uses a real PowerShell skips when there is none.
- **`src/buffer.js`** (pure): the script text as `{ lines, row, col }`, every edit returning a new one. **`src/highlight.js`** (pure): colours one line, puts the cursor in it, scrolls it sideways.
- **`src/ui/App.jsx`**: the screen and all keys. Ink doesn't report function keys (F5 arrives as an empty key), so `useKeyTranslation` turns F5 and F8 into ctrl+r and ctrl+e. The text and prompt live in refs updated synchronously as well as in state: keys can arrive faster than React renders.
- In the family (`family.js`: role PWSH, mascot Tiller) and in Fleet the host (letter `e`, the tenth space, so no digit). Its mascot has no art or mood of its own yet.

## Tests

`test/app.test.js` renders `<App>` over a fake session with `ink-testing-library`, typing keys and asserting on frames (wait with `until`, never fixed sleeps, except to let typed text settle before a key that reads it).
