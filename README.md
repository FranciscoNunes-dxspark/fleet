# Fleet

The family of keyboard-driven terminal apps, in one repository:

| App | What it is |
| --- | --- |
| [Splice](apps/splice) | A git client |
| [Trawl](apps/trawl) | A SQL client for SQL Server, PostgreSQL and MySQL |
| [Sonar](apps/sonar) | An Azure console: App Service, Functions, their logs and problems |
| [Bosun](apps/bosun) | Runs a project's processes, each with its own log, port and health |
| [Hail](apps/hail) | An HTTP client over `.http` files |
| [Keel](apps/keel) | A tech lead's console for Azure DevOps: a web app, a terminal app and an Android app |
| [Fleet](apps/fleet) | All six in one terminal, switched with `ctrl+]` like tmux, in one download |

Each app keeps its own folder, README and history. They share one kit, [`packages/kit`](packages/kit) (`@fleet/kit`): text, the Ink parts and hooks, the mouse, the clipboard, the palette, your own keys and commands, the family, the updater and the build.

Each app is released on its own from this repository, tagged `<app>-v<version>`: [Splice](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=splice-v&expanded=true), [Trawl](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=trawl-v&expanded=true), [Sonar](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=sonar-v&expanded=true), [Bosun](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=bosun-v&expanded=true), [Hail](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=hail-v&expanded=true), [Keel](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=keel-v&expanded=true) (its Android app as `keel-android-v…`) and [Fleet](https://github.com/FranciscoNunes-dxspark/fleet/releases?q=fleet-v&expanded=true), which holds the six terminal apps in one executable. The downloaded executables update themselves from them. [Harbor](https://github.com/FranciscoNunes-dxspark/harbor), the Windows launcher, installs and updates them.

## From a checkout

Node 22 or later:

```bash
npm install                # every app and the kit, in one node_modules; applies patches/
npm test                   # every suite (npm run test:<app> for one, test:kit for the kit)
npm start -w apps/splice   # run an app (or cd apps/splice && npm start)
```

[CLAUDE.md](CLAUDE.md) says how the repository is laid out, how the kit works, and how CI and the releases do.
