# Keel

A tech lead's console for Azure DevOps

A local Node.js app for a tech lead who works across several Azure DevOps projects and repos. It shows what needs you right now, such as reviews waiting on you, red pipelines, blocked work and stale PRs. You can act on most of it without opening Azure DevOps.

## Quick start

```bash
npm install
npm run dev:mock        # demo organization, no credentials needed
```

Open http://localhost:5173. Demo mode uses a fake in-memory organization. Votes, comments and state changes work, and they reset when the server restarts.

### Connect your organization

1. Copy `.env.example` to `.env`.
2. Set `AZDO_ORG_URL` (`https://dev.azure.com/<org>`, or your Azure DevOps Server collection URL).
3. Create a [personal access token](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with these scopes:

   | Scope | Why |
   |---|---|
   | Code: Read & write | List PRs, vote, comment, add reviewers, auto-complete, abandon |
   | Work Items: Read & write | Queries, state/assignee/priority changes, comments |
   | Build: Read & execute | Pipeline health, re-run pipelines, YAML approval checks |
   | Release: Read, write, execute & manage | Classic releases: view, create, deploy, approve |
   | Project and Team: Read | Projects, teams, members, current sprint |
   | Identity: Read | Resolve who you are |

   If you only want to look, give read-only scopes. Actions will then fail with a clear error.
4. Run `npm run dev`, then open **Settings** to choose projects, the teams you lead in each one (one or more), and which repos to watch.

### Run it day to day

```bash
npm run build
npm start               # serves UI + API on http://127.0.0.1:4280
```

## What's in it

| Page | For |
|---|---|
| **Dashboard** | The home page, built from widgets: Needs you, Your review queue, Pipelines, Work in progress, Team load, Delivery, Epic progress and My work. **Customize** shows, hides and reorders them, and the layout is saved in your browser. |
| **Inbox** | One ranked list across every tracked project. It covers PRs waiting on your vote (escalated after N hours), PRs with no reviewers, no approvals, rejections, conflicts or stale age, and approved PRs nobody merged. It also covers blocked items, unowned or unstarted P1 bugs, in-progress items with no updates, red default-branch pipelines, and overloaded teammates. You can snooze any entry for a day, 3 days or a week. |
| **Pull requests** | All active PRs across repos. Filter by project, repo or author, or use the toggles: needs my review, mine, conflicts, stale, hide drafts. The detail panel renders the description and comments as Markdown, with @mentions resolved and screenshots loaded through the server. It shows the changed files as a folder tree, and each file opens its diff in Azure DevOps. From the panel you can vote, comment, add reviewers, see policy checks and linked work items, publish drafts, set or cancel auto-complete, and abandon. |
| **New pull request** | From the Pull requests page, or **Create pull request** on a work item. Pick a repo and branches, with recently pushed branches listed first. You see what would merge (commits ahead and behind, files changed) and a warning if a PR for those branches is already open. The repo's PR template fills the description if it has one (`.azuredevops/pull_request_template.md` and the other standard locations). Work items mentioned in the branch name or commits are suggested, and you can add reviewers (required or optional), create it as a draft, or set auto-complete. |
| **Work items** | Open items, with views for sprint, bugs, blocked, untouched for N days, unassigned and mine. You can change state and assignee inline. The detail panel lets you change priority, toggle the blocked tag, comment, and see the hierarchy and linked PRs. |
| **Board** | Each team's real Azure DevOps boards (Backlog items, Features, Epics and custom levels such as Reported Issues), with the same columns, WIP limits, split Doing/Done columns and swimlanes. Shows open work plus anything finished recently, not tied to a sprint, with a toggle for the current sprint. Dragging a card sets its board column and the state that column maps to. Boards hidden for a team in Azure DevOps are hidden here too. |
| **Epics** | Navigate epics, then features, then backlog items. Progress bars roll up from stories, PBIs and bugs, along with point totals and open-bug and blocked counts. Search across the whole tree, and click any item to open it. |
| **Pipelines** | Running pipelines first, then the rest grouped by their Azure DevOps folder. Each pipeline is judged on its repo's default branch, and PR validation runs are ignored. Shows a run strip, pass rate, failure streak, last green run, and re-run. |
| **Releases** (Pipelines tab) | Classic release pipelines, grouped by folder. Each stage shows its latest deployment (release, status, when, who) and anything deploying now. You can create a release from the latest artifacts, or deploy and redeploy any recent release to any stage. Stage approvals and gates still apply. |
| **Approvals** | Pending classic release approvals and YAML environment checks, in one list at the top of Pipelines and in your Inbox. Approve or reject with an optional comment. Buttons only appear where Azure DevOps says you may decide. |
| **Production** | Your production apps next to the deploys that change them. Each monitor checks a URL every minute (up or down, response time, uptime) and can read Application Insights every 5 minutes (failure rate, p95, exceptions, top failing operations). Link a monitor to the release stage or pipeline that deploys it: deploys appear on its charts, and Keel flags it when failures rise after one ("failures up from 0.4% to 6.4% since Release-65"). Outages and regressions go to the Inbox and notifications. |
| **Team** | Each person's in-progress items, sprint points, hours left, open PRs, reviews owed and oldest PR. Counts link to filtered views. |
| **Insights** | Weekly merge throughput, median and 85th-percentile time to merge, open PR age, approvals given (review concentration), merges by author, and per-repo flow. |
| **Release notes** | Merged PRs in a date range, plus the work items they delivered, as Markdown grouped into features, fixes, and PRs by repo. Copy it or download it. |

Thresholds, the blocked tag, auto-complete defaults and the refresh interval are set in **Settings**. Settings are saved to `data/settings.json`.

## Production monitoring

Set it up in **Settings → Production monitors**:

- **URL to check:** your app's home page or a health endpoint. It's checked every minute from the Keel server. Only public addresses are allowed. Set `MONITOR_ALLOW_PRIVATE=1` if you really mean to monitor internal endpoints.
- **Application Insights (optional):** in the Azure portal, open the app's Application Insights → **API Access**. Copy the **Application ID**, then **Create API key** with *Read telemetry*. Paste both into Keel, never into chat or tickets. The key is stored encrypted, and Settings shows only that one is saved.
- **Deploys come from:** the classic release stage or the pipeline that deploys this app. This adds deploy markers and regression detection.

Use **Test** to check a URL and key before saving. Monitors are shared by everyone using the same Keel server. Azure Monitor alert rules aren't included: reading them needs a Microsoft Entra identity (a service principal) rather than an API key.

## Live updates and notifications

While the console is open (a background tab is fine), the server checks Azure DevOps every 30 seconds. You can set 15–600 seconds in Settings. Pages refresh only when something changed. When nobody has the console open, it stops polling.

You get a notification when:
- a deployment approval or a review request is waiting on you
- someone votes on your pull request, or it completes
- a pipeline run you started finishes
- a pipeline or deployment starts failing
- an item becomes blocked, or a P1 bug has no owner

Notifications show as pop-ups in the console. Desktop notifications are optional: turn them on in **Settings → Notifications**, along with which kinds you want. The browser tab title shows the "act now" count, for example `(3) Keel`.

## Security

What the app already does:

- Your PAT stays on the server and never reaches the browser. The server binds to `127.0.0.1`, so other machines can't reach it.
- **DNS-rebinding guard:** requests whose `Host` isn't `localhost` or `127.0.0.1` (or a host you list in `ALLOWED_HOSTS`) are refused, so a malicious website can't point its own domain at your machine and read this API.
- Writes need the `x-keel` header and a same-site `Origin`, so other sites can't trigger votes, comments or pipeline runs from your browser.
- A strict Content-Security-Policy, `X-Frame-Options: DENY`, no-referrer and `no-store` on API responses. PR Markdown is sanitized, and the only images loaded are those from your own organization.

What you should do:

1. **Scope the PAT tightly and give it an expiry.** Use only the scopes in the table above, read-only if you just want to look, and only the organization you need. Rotate it when it expires.
2. **Protect `.env`.** It holds your PAT in plain text. Keep it out of git (`.gitignore` already does) and limit it to your Windows account, for example `icacls .env /inheritance:r /grant:r "%USERNAME%:F"`.
3. **Don't set `HOST=0.0.0.0`** unless you add real authentication. Anyone who can reach the port can act in Azure DevOps as you.

Sharing it with your team needs more than the steps above. Every viewer should act as *themselves*, not through your PAT:
- Put it behind Microsoft Entra ID sign-in (for example App Service Authentication, or oauth2-proxy in front of it).
- Replace the PAT with per-user OAuth tokens for Azure DevOps (an Entra app registration with the Azure DevOps `user_impersonation` scope).
- Serve it over HTTPS, keep secrets in Azure Key Vault, and add request logging.

## Hosting it for your team (Hostinger or any server)

With `AUTH_MODE=login`, Keel has its own accounts. Each person signs in with an email and password, then links **their own** Azure DevOps PAT once, so votes, approvals and comments are recorded under their own name. This needs no Microsoft Entra app registration.

### Accounts and roles

| Role | Can do |
|---|---|
| **Admin** | Everything, plus manage users and production monitors |
| **Developer** | Pull requests (create, vote, comment, complete), work items and boards, run pipelines and releases, approve deployments |
| **PM** | Work items and boards, run pipelines and releases, approve deployments. Pull requests are read-only |

Everyone can see everything. Roles only limit what a person can change, and the server enforces them, not just the screens. Azure DevOps permissions still apply on top: a PM can't approve a deployment that Azure DevOps doesn't let them approve.

- **First admin:** on first start the sign-in page asks for a setup code. Set `ADMIN_SETUP_CODE` in `.env`, or use the one the server prints in its log (`pm2 logs keel`). The first account becomes Admin.
- **Inviting people:** **Users → Invite someone** creates a link for an email address and role. Keel doesn't send email, so copy the link and send it yourself. It works once and expires in 7 days. The person picks their name and password, then links their token.
- **Forgotten passwords:** on **Users**, choose **Reset password** to get a new link. Using it signs that person out everywhere.
- **Managing access:** change a role, disable an account (signs it out at once) or remove it. There's always at least one active Admin.
- **Synced settings:** projects, teams, inbox snoozes, theme, notification choices and the dashboard layout belong to the account, so they follow you to any device.

### What's stored where

- **Passwords** are hashed with scrypt.
- **Tokens:** each PAT is checked against your organization, then stored encrypted (AES-256-GCM) using `SESSION_SECRET`. It's never sent back to a browser. **Settings → Your account** replaces or disconnects it. If Azure DevOps stops accepting a token (expired or revoked), that person is asked for a new one.
- **Browser:** only a random session cookie (HttpOnly, SameSite=Strict, and Secure/`__Host-` behind HTTPS).
- **Sessions** last `SESSION_DAYS` (7 by default, renewed while you use it, 30 days at most). Changing your password signs out your other devices.
- **Rate limits:** after 10 failed sign-ins from one IP, or 5 for one email address, sign-in is blocked for 15 minutes.

To try accounts and roles before deploying, run on demo data with `AUTH_MODE=login` and `AZDO_MOCK=1`. Demo accounts are kept apart from real ones, and any token-shaped value links to the demo organization.

### What you need on Hostinger

The app is a Node.js server, so it needs a **VPS**, or a plan that can run **Node.js apps**. PHP-only shared hosting can't run it. You also need a domain or subdomain (for example `console.yourcompany.com`) with HTTPS.

### Steps (Hostinger VPS, Ubuntu)

1. **Install Node.js 22, nginx and Certbot:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
   ```
2. **Get the code** onto the server (git clone or upload), then build it:
   ```bash
   npm ci && npm run build
   ```
3. **Create `.env`.** Leave out `AZDO_PAT`, because nobody's token lives in config:
   ```ini
   AZDO_ORG_URL=https://dev.azure.com/contoso
   AUTH_MODE=login
   SESSION_SECRET=<output of: openssl rand -hex 32>
   ADMIN_SETUP_CODE=<a code only you know, for creating the first admin>
   ALLOWED_HOSTS=console.yourcompany.com
   TRUST_PROXY=1
   HOST=127.0.0.1
   API_PORT=4280
   ```
4. **Keep it running** with pm2, so it restarts on crash and after reboot:
   ```bash
   sudo npm i -g pm2 && pm2 start server/index.js --name keel && pm2 save && pm2 startup
   ```
5. **Put nginx in front.** Live updates need buffering off on `/api/events`:
   ```nginx
   server {
     server_name console.yourcompany.com;
     location / {
       proxy_pass http://127.0.0.1:4280;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
     location /api/events {
       proxy_pass http://127.0.0.1:4280;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_buffering off;
       proxy_read_timeout 1h;
     }
   }
   ```
   Then turn on HTTPS:
   ```bash
   sudo certbot --nginx -d console.yourcompany.com
   ```
6. **Back up and protect `data/`.** It holds the accounts, everyone's settings and the encrypted tokens. Keep `SESSION_SECRET` safe: without it, stored tokens can't be decrypted and everyone has to link theirs again. Anyone who has both `data/` and the secret can use the stored tokens.
7. **Updating:**
   ```bash
   git pull && npm ci && npm run build && pm2 restart keel
   ```

8. **Create your account:** open the site, enter the setup code, then invite your team from **Users**.

Teammates create their own token from the "How to create a token" steps shown after they first sign in. Ask them to use the scopes listed above and a sensible expiry.

## Appearance

**Settings → Appearance** sets the color mode (System, Dark or Light) and an accent color (Green, Blue, Violet, Teal or Magenta). The browser-tab icon follows the accent. The choice is saved in your browser, and with sign-in it also follows your account to other devices.

## How it works

```
client/          React + Vite UI (dark theme, IBM Plex)
server/
  index.js       Express: /api + built UI from dist/
  routes.js      HTTP layer; writes require the x-keel header
  service.js     Scopes everything to tracked projects/repos, caching
  azdo/          REST client (PAT auth, retries on 429/5xx, paging, concurrency limit) + provider
  mock/          Demo provider with the same interface as azdo/provider.js
  domain/        Pure logic: PR signals, inbox rules, workload, pipeline health, insights, release notes
test/            node:test tests for the domain logic
```

- **Process-agnostic.** "Done" is decided by Azure DevOps *state categories*, not state names, so Agile, Scrum, Basic, CMMI and custom processes all work. Work item queries use category groups (`Microsoft.RequirementCategory` and so on), not hard-coded type names.
- **Security.** The PAT lives only on the server. The server binds to `127.0.0.1`, and every write needs a custom header so other websites can't drive the API from your browser. Don't set `HOST=0.0.0.0` unless you're sure about who can reach the port.
- **Load.** Lists are cached for 60 seconds, and each write clears the related cache. The **Refresh** button clears everything. Requests are capped at 6 in flight and back off on throttling.

## Limits

- The changed-files list has no line counts (+/−) because the Azure DevOps REST API doesn't provide them. Images in PR text load only from your own organization. External images show as a placeholder, so no tracking pixels are fetched.

- Group reviewers (for example "[Project]\Team") are shown, but a PR only counts as "waiting on your review" when you are a direct reviewer.
- Work item queries return up to 1,000 open items per project.
- All read views have been checked against a real Azure DevOps Services org. Write actions (vote, comment, reviewers, auto-complete, abandon, work item updates, re-running pipelines) have only been exercised on demo data so far. Error messages from Azure DevOps are passed through to the UI.
- Azure DevOps reports a team's last iteration as "current" even when it ended long ago or has no dates. The Sprint page shows it with a warning, and the inbox and team pages ignore sprint membership until a dated iteration covers today.
- A work item counts as blocked if it has the blocked tag, a state with the same name (default `Blocked`), or the CMMI Blocked field set.

## Scripts

| Command | |
|---|---|
| `npm run dev` / `npm run dev:mock` | API with auto-restart + Vite dev server on :5173 |
| `npm run build` | Build the UI into `dist/` |
| `npm start` / `npm run start:mock` | Serve the API and built UI on :4280 |
| `npm test` | Domain logic tests |
