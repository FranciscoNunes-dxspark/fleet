# Fleet Desktop

Fleet in a window of its own: an Electron application around `fleet gui` (apps/fleet's README, "In a
window"). Each window runs `fleet gui --print-url` in a folder and shows the page it serves; the
desktop adds an icon, a menu (File → Open Folder, New Window; View → Commands, Split, Runbooks, Follow),
the badges' count on its icon, and every key for the apps. On Windows and Linux its shortcuts are
ctrl+shift combinations and function keys, so plain ctrl+letters stay the apps'.

From a checkout (after `npm install` at the root):

```bash
cd desktop
npm install --no-package-lock     # Electron and electron-builder, pinned in package.json
npx electron . [folder]           # runs apps/fleet from the checkout, with Electron as its Node
```

`FLEET_BIN` points it at another fleet executable. Packaged, it runs the `fleet` executable shipped in
its resources: the Release Fleet Desktop workflow (`.github/workflows/release-desktop.yml`) builds that
with Bun, then the installers with electron-builder (`npx electron-builder --linux AppImage` locally).
It remembers the last folder and the window's size in Electron's userData folder (`state.json`).
`FLEET_DESKTOP_SMOKE=<file.png>` draws the first window to a picture and quits, for checking a build
(under `xvfb-run` on a machine without a display).

This folder isn't one of the root's npm workspaces: Electron's download would weigh down every other
install. So it has no lockfile, and nothing here runs in CI's tests.
