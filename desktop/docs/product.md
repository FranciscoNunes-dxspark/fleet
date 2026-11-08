# Licence, sign-in and team sync: the design, and what's needed first

Everything in Fleet today is local:

- `~/.fleet` and `~/.family` on each machine
- `.fleet/project.json` in each repository
- each app's own config, and the system's credential store

Selling it, and the team features people would pay for, need something that isn't local: a service. This note sets out the smallest one that does both, and the decisions only you can make.

## What would be sold

| | Free | Team |
|---|---|---|
| Fleet and every app, in a terminal or the window | ✓ | ✓ |
| Runbooks, environments and security, on one machine | ✓ | ✓ |
| Shared runbooks: written once, run by the whole team | | ✓ |
| Shared environments and connections: Trawl's connections, Hail's `.http` collections, Sonar's subscriptions, Mooring's hosts. Never their secrets. | | ✓ |
| A shared activity feed: what changed, across the team, in one timeline | | ✓ |
| Claude's proposals for the team, with who handed each | | ✓ |
| Updates from the update server | ✓ | ✓ |

Keeping the apps free and charging for the team layer follows the pattern Termius uses. It sells best because the free tool spreads by itself.

## The service

One small HTTPS API, with Postgres behind it:

- **Sign-in.** A device code flow: the window or `fleet login` shows a code, and you confirm it in a browser. It signs in with GitHub or Microsoft (the teams this sells to already have one) and gives the machine a token. The token goes in the system's credential store, through the kit's `credentials.js`, as the apps' passwords already do.
- **Licence.** `GET /licence` says the plan and the seats. The window and `fleet` check it at start and once a day, and keep the last answer for 14 days offline. When the licence lapses, the team features go read-only. Nothing breaks.
- **Sync.** Documents per team: runbooks, environments, connection definitions. Each has a version, and the newest wins with history kept. A client sends what changed and gets what changed since its last version. It's polling, not websockets: every few minutes is enough for runbooks.
- **Activity.** The family's activity log (`activity.jsonl`) already has the right shape. A team member's Fleet can send its entries (descriptions, never commands or values, as the family's rules already say), and read the team's into the what-changed timeline.

**Secrets never leave a machine.** A shared connection carries the server and the database, never the password. Each person's password stays in their own credential store, as now.

## Where it hooks in

- **The kit:** `team.js` with `signIn`, `licence`, `pull` and `push`, used by Fleet, not by each app. The apps keep reading their own files.
- **Fleet:** pulls the shared documents into the places the apps already read: `.fleet/runbooks/`, `.fleet/project.json`, and each app's import, such as Trawl's `/import`. It pushes what you choose to share.
- **The window:** a sign-in line in Settings, the plan shown, and "Share" beside a runbook.

## What's needed from you before building it

1. **Free versus paid.** Is the split above right?
2. **Where the service runs.** It's small; Fly.io, Azure Container Apps or Hostinger's Node hosting (as Keel's web app) would all do.
3. **Payments.** Stripe or Paddle. Paddle handles VAT as the seller, which matters selling from the EU.
4. **Sign-in providers.** GitHub, Microsoft or both.
5. **The update address** from `release.md`, since the update server could check the licence too.

Once those are decided, the first slice could be built and tried by one team: sign-in, the licence check, and shared runbooks.
