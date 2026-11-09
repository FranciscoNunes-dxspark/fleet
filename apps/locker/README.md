# Locker

<img src="assets/logo.svg" alt="Hush, the Locker octopus" width="96" align="right">

Secrets and configuration in the terminal. Locker puts a project's own settings (its `.env` files, `appsettings*.json`, .NET user secrets and Hail's env files) side by side with an Azure App Service app's settings and a key vault's secrets, one row per key, and marks what is missing and what differs, without showing a value. It checks the app's Key Vault references (is the secret there, enabled, not expired), lists what is about to expire, and adds, copies, sets and disables what you ask it to, asking first.

Values stay hidden: they are compared by a keyed hash made fresh each run, and shown only when you press `v`, until `esc`. Nothing Locker logs, hands to another app or writes to its settings has a value in it.

```
locker           # this folder, and the App Service app and vault you pick
locker --demo    # a made-up project and Azure, to look around: nothing is touched
locker security  # the secret hygiene check, without the screen (for a pipeline; below)
```

Press `?` inside for every key and command, `/` for the commands, `ctrl+p` for the palette.

Azure is read with the Azure CLI's sign-in (`az login`; Locker asks it for tokens, as Sonar does), so it sees what your account may see; the subscription is the one `az` has selected, or `/sub`. Locker is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/locker` in the project's folder), or download the executable from the releases.

## Sources

From the folder Locker started in (the top line names it; `/move` reads another one: a path, or a
folder beside this one, completed as you type; alone, a list of the folders read lately, then the
ones beside this one, those with settings in bold. Its sources take this folder's place, and the App
Service app named as the new folder, when there is one, becomes the one compared):

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

A key marked `!` (in red, and counted in the panel's title) is a variable the bundler writes into the browser's code (`VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`, `GATSBY_`, `VUE_APP_`, `STORYBOOK_`) whose value in a `.env` file looks like a secret: a known key's shape, a name such as `SECRET`, `PRIVATE` or `PASSWORD`, or random enough to be a key. Every visitor of the built site can read it. `↵` says what it looked like and in which files, never the value. Keys made for the browser aren't marked: Stripe's publishable `pk_` keys, Firebase web and Google Maps browser keys, Supabase's anon key, Sentry DSNs and the like (the same judge as Bilge's Code view).

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
| `r` | Rotate it end to end (below) |
| `o` | The vault in the Azure portal |

### Rotating a secret

`/rotate <secret>` (or `r` on one in the Vault view) does a rotation as one checklist, each step marked as
it runs; `esc` stops it there (what is done stays done, and the checklist says where it stopped):

1. **A new value**: generated (32 random bytes, base64url) unless you paste one (a new API key a provider gave you), typed hidden.
2. **A new version** of the secret, after asking, as `e` sets one.
3. **The apps that read it**: every App Service app and slot in the subscription whose settings or connection strings are Key Vault references to it. Those that read its latest version are restarted after asking, so they read the new value now rather than within the day App Service takes on its own. Those pinned to a version are listed with what their setting should say (`@Microsoft.KeyVault(SecretUri=…/secrets/<name>/<new version>)`), and once the checklist is done the line that opens the first one's settings in Sonar is copied (Sonar changes app settings; Locker doesn't).
4. **The restarted apps answer again**: each one's default address with the environment's `healthPath` (`/` without one, see Environments) is asked every 3 s until it answers 2xx, for up to two minutes.
5. **The previous version disabled**, after asking, once every restarted app answered (it says which pinned settings still read it).

Every step goes in the family's activity log by name; the value goes only to Key Vault.

### Expiry

The secrets and certificates of every vault Locker has read that have expired or expire within 30 days (`/expiry <days>`), soonest first. On start, when there are any, Locker says so in the activity line and raises the terminal's notification once (`"notify": false` turns that off), and Hush is worried. `↵` shows one, `e` sets a secret's new value.

### Sources

What Locker read, with how many keys each has and where it is. `↵` lists a source's keys (values masked), `space` makes it a column or not.

## Leaked secrets in git

`/leaks [commits|since]` looks through the checkout for values that look like secrets: the files git
would commit (what `.gitignore` leaves out isn't read), then what the history added, the last 200
commits by default, a number of them (`/leaks 50`) or since a date git takes (`/leaks 2026-01-31`,
`/leaks 2 weeks ago`). It reads a batch of commits at a time and lists what it finds as it goes; `esc`
stops it. What counts:

- a key Locker knows to hold a secret given a literal value: the folder's keys whose names say so (`Password`, `Secret`, `Token`, `ApiKey` …), the app's settings that are Key Vault references, the vault's secrets (`Db__Password=…` in a script, `"Password": "…"` in JSON; never an example file's, nor a placeholder like `${DB_PASSWORD}` or a reference)
- the shapes secrets have: a storage account's `AccountKey=`, `Password=` or `Pwd=` in a connection string, a private key's `-----BEGIN … PRIVATE KEY-----`, a JWT, GitHub tokens (`ghp_…`, `github_pat_…`), Azure DevOps tokens, AWS access and secret keys, a SAS token's `sig=`

Each finding says the file and line, the commit (or `worktree`), its author and date, and the key or
shape, with the value masked; nothing Locker shows or keeps has the value. `↵` shows one, `t` copies
its commit for Splice (`/take commit`, its diff there; the file and line, `/take file`, for one not
committed yet), `r` rotates it when it is a secret of the vault (`/rotate`). Taking a secret out of
git's history needs a rewrite (git filter-repo, and a force push everyone takes), and every copy made
before keeps it: rotating it is the fix.

## Secret hygiene

`/hygiene` checks how the secrets Locker reads are kept, and lists what is wrong worst first. It
judges from what Key Vault and App Service say of them (names, dates, flags) and from the shape of
values Locker holds already; it never reads a vault secret's value to judge it, and never shows one.
It reads the app being compared with its slots, the vault picked and those their settings refer to,
and the folder; `/hygiene all` reads every app, slot and vault in the subscription (their listings).

| Finding | Severity |
|---|---|
| A certificate that has expired while in use (a setting refers to it, or an app loads it with `WEBSITE_LOAD_CERTIFICATES`) | critical |
| A secret or certificate that has expired; one that expires within 7 days | high |
| A disabled secret a setting still refers to | high |
| An app setting or connection string holding a secret as plain text, not a Key Vault reference (named like one, `Password`, `Secret`, `Token`, `…Key`, or shaped like one: `Password=` in a connection string, a storage key, a token) | high |
| A secret in a file git tracks (a `.env`, `appsettings*.json`, Hail's env file; never an example file). User secrets and files git ignores are where secrets belong | high |
| A secret in a `.env` variable the bundler sends to the browser (`VITE_…`, `NEXT_PUBLIC_…`, the `!` keys in Drift), tracked by git or not | high |
| Expires within 30 days; not changed in over a year | medium |
| A setting one slot reads from Key Vault and another holds as plain text | medium |
| The same secret in production and another environment (compared by a keyed hash: `.env` and user secrets are development, `.env.<name>` and `appsettings.<Name>.json` that environment, the app production and a slot its name) | medium (low between two others) |
| Purge protection off on a vault | medium |
| A secret with no expiry date; not changed in over 180 days | low |
| A vault open to every network with no rules | low |

Each finding says where (`kv-shop/old-token`, `shop-api/Redis__Password`, `appsettings.json:14`),
why, and the fix: often the `az` command to run yourself (moving a setting to a Key Vault reference
says both commands); Locker runs none of them. What it saw is cut to its first characters.

| Key | |
|---|---|
| `↵` | The finding, why it matters and its fix |
| `y` | Copy its name: the secret, the setting or the file |
| `f` | Copy its fix |
| `s` | Show it in its view: a vault's secret or certificate in Vault, a setting's row in Drift |
| `r` | Rotate it, when it is a secret of the vault (`/rotate`) |

`"hygieneIgnore"` in the settings leaves findings out: a rule's id (`kv-no-expiry`) or a rule on one
thing (`kv-no-expiry:kv-shop/Shared--Salt`). Key Vault keys aren't read (nor, so, judged); a
vault's posture in depth is Sonar's.

### In a pipeline

```
locker security [folder] [--app app|app/slot] [--vault name] [--all] [--fail-on critical|high|medium|low|none] [--json|--sarif]
```

The same check without the screen, from the folder (the current one by default), the app named as it
(or the one saved, or `--app`) and its slots, and their vaults (signed in with `az login`; without
it, only the folder is read, and it says so). It prints the findings, never a value, and exits 1 when
one is as bad as `--fail-on` (high by default), 2 when it couldn't run. `--json` prints the fleet's
security JSON (`{ app, check, target, at, counts, site, sites, vaults, problems, findings }`, without
even the shortened excerpts), `--sarif` SARIF 2.1.0 for GitHub's or Azure DevOps' code scanning.
`locker security --demo` runs it over the demo.

## Slash commands

`/app [app|app/slot|none]`, `/vault [name|none]` and `/sub [name]` pick what to compare (a list without a name). `/columns` is `c`. `/only all|diff|missing` filters the drift view. `/set [secret]` sets a secret (a new one when the vault has none by that name), `/rotate <secret>` rotates one end to end (`r`), `/disable <secret>` disables or enables one. `/leaks [commits|since]` looks for secrets in git (above). `/hygiene [all]` checks how secrets are kept (above). `/env [name]` chooses the project's environment (below). `/expiry [days]` and `/clear-after [seconds]` change the windows. `/sonar` is `t`. `/take <line>` takes what a sibling copied. `/family`, `/wiring`, `/timeline` (below). `/run <command>` is `!`. `/last` shows the last command's whole output (never a value). `/refresh` (`ctrl+r`) reads everything again. `/move [folder]` reads another folder (see Sources). `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

Your own commands and keys go in the settings file, as in the siblings: `"commands": { "prod": "/app shop-api" }`, `"keys": { "drift": { "ctrl+o": "/app" } }`.

## Environments

A project names its environments once, for every app in the family, in `.fleet/project.json` (in its
folder or one above, up to its checkout's root). `/env` says which one is chosen; `/env <name>`
chooses another for every app (Fleet's `ctrl+b e` too), and the top line names it. Locker's section of
an environment says what to compare there, by name and never with a value:

```json
{
  "default": "dev",
  "environments": {
    "dev":  { "locker": { "vault": "kv-shop-dev", "app": "shop-api", "slot": "staging" } },
    "prod": { "prod": true, "locker": { "vault": "kv-shop", "app": "shop-api", "resourceGroup": "rg-shop", "healthPath": "/healthz" } }
  }
}
```

| Field | |
|---|---|
| `vault` | The key vault to compare and list |
| `app`, `slot` | The App Service app (and slot) whose settings are compared |
| `resourceGroup` | Which `app` is meant when two share a name |
| `healthPath` | Where `/rotate` checks that a restarted app answers (`/` when it isn't set) |

When the environment changes, here or in another app, Locker picks what its section names. In an
environment marked `"prod": true` the frames are red, and every change (setting, copying, disabling a
secret, adding one to `.env`, restarting an app) is asked about once more, after Locker's own question.

While Fleet records a runbook, each slash command Locker's prompt runs (and each `/take`) is added to it.

## The family

Locker is one of the apps that hand each other what is under their cursor, as lines to paste into the other's prompt, and never a secret.

- `t` copies the app for Sonar as `/appsettings <app>`; Sonar shows its settings, logs and problems. In Fleet, the other app opens with it in its prompt.
- In `/leaks`, `t` copies a finding's commit for Splice (`/take commit`), or its file and line when it isn't committed (`/take file`).
- `/take <line>` takes an app or slot a sibling copied (a `site` context; Sonar's `alt+k` on an app in Resources copies one): Locker compares its settings in the drift view.
- `/family` lists what the folder is to the other apps (its checkout for Splice, what Bosun runs, Hail's `.http` files, the databases its settings name for Trawl, the app for Sonar), `↵` copying the line for one's prompt. `/wiring` lists what the folder points at (addresses, hosts, ports, connection strings), secrets masked. `/timeline` shows what the family's apps changed, newest first.
- What Locker sets, disables, adds to `.env` or copies goes in the family's activity log, by name and never with the value. Hush writes its mood (worried when something expires soon, a reference is broken or the sources differ) for the others to remark on, and remarks on theirs; `"familyMoods": false` turns both off.

## Mouse

Click a tab, a row, or a place in the command box (`/` opens it over the view; a click outside it closes it); double-click does `↵`; the wheel scrolls. Drag to select text, copied when you let go (`ctrl+c` copies it again and never quits); `ctrl+v` pastes. `/mouse off` leaves the mouse to the terminal.

## Settings

Kept in `~/.locker/config.json` (`LOCKER_HOME` moves it), which holds which app and vault you picked and never a value: `target`, `vault`, `subscription`, `columns`, `expiryDays` (30), `clearClipboard` (seconds, 30; 0 leaves a copied value there), `notify`, `theme` (`dark`, `light`, `auto`), `accent` (`#rrggbb`), `familyMoods`, `mouse`, `checkForUpdates`, `autoUpdate`, `hygieneIgnore`, `commands`, `keys`, `history`. `/settings` (`,`) shows them.

## Updates

Once a day the downloaded executable looks for a newer `locker-v…` release and installs it in the background; `/update` asks now. Inside Fleet, Fleet updates as a whole.

## Not yet

Changing an App Service app's settings (Sonar does that, `/appsettings` there; `/rotate` says what to change), Key Vault keys, a certificate's renewal, and other stores (AWS, GCP, HashiCorp Vault, Doppler).
