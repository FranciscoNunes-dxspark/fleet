# Locker

<img src="assets/logo.svg" alt="Hush, the Locker octopus" width="96" align="right">

Secrets and configuration in the terminal. Locker puts a project's own settings (its `.env` files, `appsettings*.json`, .NET user secrets and Hail's env files) side by side with an Azure App Service app's settings and a key vault's secrets, one row per key, and marks what is missing and what differs, without showing a value. It checks the app's Key Vault references (is the secret there, enabled, not expired), lists what is about to expire, and adds, copies, sets and disables what you ask it to, asking first.

Values stay hidden: they are compared by a keyed hash made fresh each run, and shown only when you press `v`, until `esc`. Nothing Locker logs, hands to another app or writes to its settings has a value in it.

```
locker           # this folder, and the App Service app and vault you pick
locker --demo    # a made-up project and Azure, to look around: nothing is touched
```

Press `?` inside for every key and command, `/` for the commands, `ctrl+p` for the palette.

Azure is read with the Azure CLI's sign-in (`az login`; Locker asks it for tokens, as Sonar does), so it sees what your account may see; the subscription is the one `az` has selected, or `/sub`. Locker is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/locker` in the project's folder), or download the executable from the releases.

## Sources

From the folder Locker started in:

- `.env`, `.env.local`, `.env.development` … (`.env.example`, `.sample`, `.template` say which keys a project expects: their values are only examples, so the matrix says `● set` there and never compares them)
- `appsettings.json` and each `appsettings.<Environment>.json`, flattened as .NET reads them: `Logging:LogLevel:Default`, `ConnectionStrings:Default`, `Hosts:0`
- .NET user secrets, for a `.csproj` (in the folder or the two below it) with a `UserSecretsId`: `secrets.json` under `%APPDATA%\Microsoft\UserSecrets` on Windows, `~/.microsoft/usersecrets` elsewhere
- Hail's `http-client.env.json` and `http-client.private.env.json`, one source per environment (hidden by default: their keys name requests' variables, not settings)

From Azure:

- an App Service app or slot (`/app`): its application settings and connection strings (as `ConnectionStrings:<name>`), and what App Service says of its Key Vault references. When you haven't picked one, Locker takes the only app there is, or the one named as the folder.
- a key vault (`/vault`): its secrets (name, enabled, content type, when it changed, when it expires; never the value until you ask) and certificates. When you haven't picked one, Locker takes the vault the app's references point at, or the only one there is.

A key is one setting however a source spells it: `Db:Password` in appsettings, `Db__Password` in `.env` and App Service, `Db--Password` in Key Vault, in any case.

## Views

`1` Drift · `2` Vault · `3` Expiry · `4` Sources · `5` Log. `tab` goes round.

### Drift

A row per key, a column per source: the folder's first, then the app's and the vault's, which stay at the right when the folder's columns scroll (`h` `l`). In a cell:

| | |
|---|---|
| `= A` | A value. The same letter is the same value: green when every source agrees, yellow when they don't |
| `→ vault` | A Key Vault reference that resolves (or that Locker couldn't check: it can't list that vault) |
| `✗ broken` | A reference that doesn't: no such secret, disabled, expired, or App Service says it failed; or a vault secret that is disabled or has expired |
| `● set` | In the vault (its value isn't read to compare), or named in an example file |
| `· missing` | The source doesn't have it |

A vault secret an app setting refers to sits in that setting's row. A key the vault lacks isn't missing there: a vault holds the secrets, not every setting.

| Key | |
|---|---|
| `↵` | Where it is and what each source says of it, no values |
| `v` | Its values, every source's, the vault's read now, until `esc` |
| `y` | Copy one source's value (a list when several have one; asks first). The clipboard is emptied again after 30 s (`/clear-after`) and when Locker quits, unless something else was copied since |
| `a` | Add it to `.env` (or the first `.env` file that lacks it, never an example) with the value from another source, asking first: `Db:Password` is written `Db__Password` |
| `d` | Only the rows whose values differ or that are broken, or all of them |
| `m` | Only the rows a source lacks, or all of them |
| `c` | Which sources are columns (remembered) |
| `h` `l` or `←` `→` | Scroll the folder's columns when they don't all fit |
| `t` | Copy the app for Sonar: `/appsettings <app>` there |
| `o` | The app in the Azure portal |

### Vault

The key vault's secrets, then its certificates. Red when disabled or expired; the expiry is red within a week, yellow within the expiry window.

| Key | |
|---|---|
| `↵` | What Key Vault says of it, and which settings refer to it |
| `v` | Its value, until `esc` |
| `y` | Copy its value (asks first; cleared after 30 s) |
| `e` | A new value, typed hidden, saved as a new version after asking (the old one stays as a version; the new one has no expiry date) |
| `n` | A new secret: its name, then its value, hidden |
| `x` | Disable it after asking (it says which settings refer to it), or enable a disabled one |
| `o` | The vault in the Azure portal |

### Expiry

The secrets and certificates of every vault Locker has read that have expired or expire within 30 days (`/expiry <days>`), soonest first. On start, when there are any, Locker says so in the activity line and raises the terminal's notification once (`"notify": false` turns that off), and Hush is worried. `↵` shows one, `e` sets a secret's new value.

### Sources

What Locker read, with how many keys each has and where it is. `↵` lists a source's keys (values masked), `space` makes it a column or not.

## Slash commands

`/app [app|app/slot|none]`, `/vault [name|none]` and `/sub [name]` pick what to compare (a list without a name). `/columns` is `c`. `/only all|diff|missing` filters the drift view. `/set [secret]` sets a secret (a new one when the vault has none by that name), `/disable <secret>` disables or enables one. `/expiry [days]` and `/clear-after [seconds]` change the windows. `/sonar` is `t`. `/take <line>` takes what a sibling copied. `/family`, `/wiring`, `/timeline` (below). `/run <command>` is `!`. `/last` shows the last command's whole output (never a value). `/refresh` (`ctrl+r`) reads everything again. `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

Your own commands and keys go in the settings file, as in the siblings: `"commands": { "prod": "/app shop-api" }`, `"keys": { "drift": { "ctrl+o": "/app" } }`.

## The family

Locker is one of the apps that hand each other what is under their cursor, as lines to paste into the other's prompt, and never a secret.

- `t` copies the app for Sonar as `/appsettings <app>`; Sonar shows its settings, logs and problems. In Fleet, the other app opens with it in its prompt.
- `/take <line>` takes an app or slot a sibling copied (a `site` context; Sonar's `alt+k` on an app in Resources copies one): Locker compares its settings in the drift view.
- `/family` lists what the folder is to the other apps (its checkout for Splice, what Bosun runs, Hail's `.http` files, the databases its settings name for Trawl, the app for Sonar), `↵` copying the line for one's prompt. `/wiring` lists what the folder points at (addresses, hosts, ports, connection strings), secrets masked. `/timeline` shows what the family's apps changed, newest first.
- What Locker sets, disables, adds to `.env` or copies goes in the family's activity log, by name and never with the value. Hush writes its mood (worried when something expires soon, a reference is broken or the sources differ) for the others to remark on, and remarks on theirs; `"familyMoods": false` turns both off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, copied when you let go (`ctrl+c` copies it again and never quits); `ctrl+v` pastes. `/mouse off` leaves the mouse to the terminal.

## Settings

Kept in `~/.locker/config.json` (`LOCKER_HOME` moves it), which holds which app and vault you picked and never a value: `target`, `vault`, `subscription`, `columns`, `expiryDays` (30), `clearClipboard` (seconds, 30; 0 leaves a copied value there), `notify`, `theme` (`dark`, `light`, `auto`), `accent` (`#rrggbb`), `familyMoods`, `mouse`, `checkForUpdates`, `autoUpdate`, `commands`, `keys`, `history`. `/settings` (`,`) shows them.

## Updates

Once a day the downloaded executable looks for a newer `locker-v…` release and installs it in the background; `/update` asks now. Inside Fleet, Fleet updates as a whole.

## Not yet

Changing an App Service app's settings (Sonar does that, `/appsettings` there), Key Vault keys, a certificate's renewal, and other stores (AWS, GCP, HashiCorp Vault, Doppler).
