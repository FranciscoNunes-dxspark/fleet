<p align="center"><img src="assets/pinch.svg" width="128" alt="Pinch, the Keel crab"></p>

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
   | Code: Read & write | List PRs and commits, vote, comment, add reviewers, auto-complete, abandon |
   | Work Items: Read & write | Queries, state/assignee/priority changes, comments, attachments |
   | Build: Read & execute | Pipeline health, re-run pipelines, YAML approval checks |
   | Release: Read, write, execute & manage | Classic releases: view, create, deploy, approve |
   | Project and Team: Read | Projects, teams, members, current sprint |
   | Identity: Read | Resolve who you are |
   | Graph: Read & manage (optional) | Only to take someone out of a team from the Team page |

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
| **Dashboard** | The home page, built from widgets: Needs you, Waiting to ship, This week, Your review queue, Pipelines, Work in progress, Team load, Delivery, Delivery to production (the DORA measures), Epic progress and My work. **Customize** shows, hides and reorders them, and the layout is saved in your browser. |
| **Inbox** | One ranked list across every tracked project. It covers PRs waiting on your vote (escalated after N hours), PRs with no reviewers, no approvals, rejections, conflicts or stale age, and approved PRs nobody merged. It also covers blocked items, unowned or unstarted P1 bugs, in-progress items with no updates, red default-branch pipelines, and overloaded teammates. You can snooze any entry for a day, 3 days or a week. |
| **Weekly summary** | One week at a glance, for everyone (PMs included): work items finished (features and stories, bugs fixed), pull requests merged per repo, deploys to production per environment, and what's blocked right now. Step back week by week (up to 26 weeks); the week is in the address, so the link can be shared. **Copy as text** gives a plain-text version to paste into an email or chat. |
| **Pull requests** | All active PRs across repos. **Closed** switches to the history: PRs completed or abandoned in the last 7, 30 or 90 days, newest first, with who closed them, how long they were open, the reviewers' votes and the outcome (filter by Completed or Abandoned, and by project, repo, author or text). The choice is in the address, so a link to it opens it. Filter by project, repo or author, or use the toggles: needs my review, mine, conflicts, stale, hide drafts. The detail panel renders the description and comments as Markdown, with @mentions resolved and screenshots loaded through the server. It shows the changed files as a folder tree, and each file opens its diff in Azure DevOps. **Complete at a set time:** in **Complete…**, choose **At** and a date and time (up to 30 days ahead). Keel completes it then, as you, with the merge options you picked, if by then it is approved, its required checks have passed and it has no conflicts; otherwise it doesn't, and tells you why (a pop-up and a push notification, under "Votes on your pull requests"). Policies are never overridden, and a completion more than an hour late (the server was down) isn't done. The PR shows **Completes …** in the list and its panel, where you (or an Admin) can cancel it. It runs on the Keel server whether or not anyone has Keel open (schedules are kept in the data folder, `schedules.json`). The panel's bottom bar shows where the pull request is on its way, **Publish → Approval → Complete** (**Ready for review → Approval → Merge** on GitHub), and what the current step waits on: who still has to approve (required reviewers by name), a rejection or a reviewer waiting for the author, merge conflicts, blocking checks that haven't passed, or nothing ("ready to complete"). That step's button leads: **Publish draft** on a draft, **Approve** while it waits for approval (when you're a reviewer who hasn't approved), **Complete…** once approved; Complete stays there while it waits for approval, for when policies allow it. On GitHub, a branch that asks for no review skips Approval, your own pull request waits on someone else's review (GitHub doesn't take the author's), and reviewers are requested on GitHub itself: Keel's people are Azure DevOps', so it offers none there. From the panel you can vote, comment, add reviewers (**Add me** adds you, on your own pull requests too), see policy checks and linked work items, publish drafts, set or cancel auto-complete, and abandon. |
| **New pull request** | From the Pull requests page, or **Create pull request** on a work item. Pick a repo and branches, with recently pushed branches listed first. You see what would merge (commits ahead and behind, files changed) and a warning if a PR for those branches is already open. The repo's PR template fills the description if it has one (`.azuredevops/pull_request_template.md` and the other standard locations). Work items mentioned in the branch name or commits are suggested, and you can add reviewers (required or optional, and yourself with **Add me**), create it as a draft, or set auto-complete. **Suggested reviewers** are the teammates who committed in the same folders in the last 180 days, ranked down by the reviews they already owe, with why ("21 commits in 3 of these folders · last 4d ago · 4 reviews owed"); open pull requests show the same suggestions in their panel. |
| **Commits** | A tab of Pull requests. Commit history on the default branch of every tracked repo, newest first and grouped by day, for the last day to 90 days. Filter by project, repo, author or text, or pick one repo to see any of its branches. Commits link to the work items they mention (`#123`, `AB#123`) and to the pull request a merge commit came from. Click one for its whole message and the files it changed. |
| **Work items** | Open items, with views for sprint, bugs, blocked, untouched for N days, unassigned and mine. You can change state and assignee inline. The detail panel lets you change priority, toggle the blocked tag, comment, and see the hierarchy and linked PRs. Its **Attachments** show pictures as thumbnails and every file as a download. **Add files** attaches more (up to 60 MB each, Azure DevOps' limit): pick them, drop them on the section, or paste a screenshot while the panel is open (it's named `screenshot-<date>-<time>.png`). |
| **Board** | Each team's real Azure DevOps boards (Backlog items, Features, Epics and custom levels such as Reported Issues), with the same columns, WIP limits, split Doing/Done columns and swimlanes. Shows open work plus anything finished recently, not tied to a sprint, with a toggle for the current sprint. Dragging a card sets its board column and the state that column maps to. Boards hidden for a team in Azure DevOps are hidden here too. |
| **Epics** | Navigate epics, then features, then backlog items. Progress bars roll up from stories, PBIs and bugs, along with point totals and open-bug and blocked counts. Search across the whole tree, and click any item to open it. |
| **Pipelines** | Running pipelines first, then the rest grouped by their Azure DevOps folder. Each pipeline is judged on its repo's default branch, and PR validation runs are ignored. **Run at…** in a pipeline's panel starts one run at a set time (up to 30 days ahead), as you, on the branch you pick (its own by default): the pipeline shows **Runs …** until then and is listed in a **Scheduled** group under Running or queued (soonest first, each run with who scheduled it and Cancel), and you get a pop-up and a push notification when it starts, or why it couldn't. A run more than an hour late (the server was down) isn't started. For runs that repeat, use a schedule in the pipeline itself. Shows a run strip, pass rate, failure streak, last green run, median duration (with ↑ or ↓ when this week's runs are 20% slower or faster than last week's), and re-run. Queued runs show too. Click a pipeline for its details: a chart of its latest run times, split into waiting for an agent and running, its typical wait for an agent, its latest runs (any branch), and for each run its stages, jobs and steps with durations, the failed steps' errors and last log lines, approvals it waits on, the commits it built and its test results (test results need the Test Management read scope on the token). A running run updates itself. |
| **Flaky tests** (Pipelines tab) | Tests that fail now and then on a pipeline's own branch and pass again without a fix: re-run on the same commit and passed, or failed at least twice with passes in between. Tests that have failed every run since they first did count as broken, not flaky. Ranked by how often they flip, with how often they failed, the error and the run where they last failed. Each pipeline's panel lists its own. Only failed runs' test results are read (the last 150, each once), and they need the Test Management (Read) scope on the token. |
| **Releases** (Pipelines tab) | Classic release pipelines, grouped by folder. Each stage shows its latest deployment (release, status, when, who) and anything deploying now. You can create a release from the latest artifacts, or deploy and redeploy any recent release to any stage. Stage approvals and gates still apply. |
| **Approvals** | Pending classic release approvals and YAML environment checks, in one list at the top of Pipelines and in your Inbox. Approve or reject with an optional comment. Buttons only appear where Azure DevOps says you may decide. Declining isn't a failure: Azure DevOps marks a YAML run whose approval was declined as failed, and a classic stage as rejected, but Keel shows them as **declined** and leaves them out of pipeline health, pass rate and failure streaks, failure alerts, deploys and the DORA measures. A YAML run counts as declined when it wasn't approved, at an environment's approval check or a **Manual validation** task (rejected, or timed out), and nothing else in it failed: the job and stage a rejected validation fails don't count. Keel reads the newest failed runs' timelines to tell. |
| **Production** | Your production apps next to the deploys that change them. Monitors that need you come first (down, then degraded, then deploying), the rest in their order from Settings. **Compact** shows one row per monitor (state, response, 24h uptime, failure rate, a 24h response-time line and the last deploy) so many fit on one screen, and clicking a row opens its full card; **Detailed** shows every card. The choice follows your account. Each monitor checks a URL every minute (up or down, response time, uptime) and can read Application Insights every 5 minutes (failure rate, p95, exceptions, top failing operations). Failures are server errors (5xx); 404s, mostly bots and old links asking for pages that don't exist, are counted apart (with the most requested missing pages) and never make a monitor degraded, though a jump in them after a deploy is noted on its card. Link a monitor to the release stage or pipeline that deploys it: deploys appear on its charts, and Keel flags it when failures rise after one ("failures up from 0.4% to 6.4% since Release-65"). Outages and regressions go to the Inbox and notifications. While a deploy into the monitored environment is running, and for 10 minutes after it finishes (the app restarting), failed checks are expected: the monitor shows **Deploying** or **Just deployed** and nothing alerts. For a YAML pipeline, "running" means a stage of the run is deploying, timed from when that stage began (so a long wait for a Manual validation or approval before it doesn't count against it); a run that's waiting for someone isn't deploying, so an outage then alerts as usual. An outage that lasts beyond that alerts as usual, counted from when it began. Platform totals is its second tab. Click a deploy, or **See what changed** on a "failures up since …" warning, to see what it shipped since the previous successful deploy of that environment: the work items, each pull request with its commits, and the commits pushed without one. **File a bug** on an outage, failing requests or a regression opens a new bug filled in with the numbers, the top failing operations, the deploy and (for a regression) what it shipped, tagged `production` and linked to the work items that deploy delivered. |
| **Waiting to ship** (Production tab) | For each production environment, what's merged on its branch but not deployed yet: the commits since the last successful deploy, grouped into pull requests and the work items they mention. The branch is the **Production branch** set on the monitor in Settings → Production monitors when there is one; otherwise, for a pipeline, the branch its automatic runs use, and for a release, the one the deployed build came from (a release or hotfix branch too), else the repo's default; if that branch has since been deleted or renamed, the card says so and compares with the default (and if the default branch is missing too, it says it can't compare and asks you to check the repo's default branch). A change is a merged pull request (however many commits it brought) or a commit pushed without one, and the oldest change's wait is counted from when it was merged (over 7 days shows as a warning). Every production monitor is listed: one not linked to the stage or pipeline that deploys it says so, and monitors deployed by the same stage share one card. When production runs a commit the branch doesn't contain (deployed from another branch, or squash-merged releases), Keel says it can't compare instead of counting the branch's whole history. When it can't tell what production runs, the card says why: no deploy in 90 days, none succeeded, the deploys don't say which commit they shipped, or a pipeline's successful runs were all on another branch. While the next deploy is under way the card says so first: **Deploying now**, or **Waiting for approval** (a release stage's pre-deployment approval or gate, or a pipeline run's approval check), with the release or run and since when. When the newest deploy failed, it says **Last deploy failed** and which deploy production is still on. With auto-deploy on every merge, these are usually the only times anything is waiting. Under it, **Coming next** lists the open pull requests into that branch (closest to merging first: auto-complete set and approved, approved, in review, needing work, drafts), so each card shows the way from pull request to production. Answers "is my fix live?" and "what goes out with the next deploy?". |
| **Team** | One section per team you picked in Settings, in every organization, with each member's in-progress items, sprint points, hours left, open PRs, reviews owed and oldest PR. Someone in two teams is in both sections, with the same numbers: they're the person's totals across everything you track. Counts link to filtered views. Only when no organization has a team picked does Keel take people from who authors PRs and owns work items (bots left out), under "Not in a team". A person is matched across organizations by sign-in name or email, so their GitHub pull requests and reviews count on their rows too (see [GitHub](#github)). **Hide** leaves someone off your Team page and its overload alerts (yours only; Azure DevOps doesn't change), with **Show** to bring them back. **Remove from team** takes them out of that section's team in Azure DevOps itself, which changes its board, sprint capacity and @mentions. They leave the page at once, even while Azure DevOps goes on listing them for a while (if it still does an hour later, they're back: Azure DevOps really has them in the team). It needs the token's Graph (Read & manage) scope and admin rights on the team or project, and isn't available on Azure DevOps Server. |
| **Insights** | Three tabs over the same period. **Delivery to production:** the four DORA measures (deploys per week, lead time from commit to production, failed deploys, time to recover after a failed deploy), each with its DORA performance band, a weekly deploy chart and a row per production environment. Production is what the production monitors are linked to, plus classic release stages named Production, Prod, PRD or Live. Lead time is measured over each environment's 30 most recent deploys. **Code review and merging:** weekly merge throughput, median and 85th-percentile time to merge, open PR age, approvals given (review concentration), merges by author, and per-repo flow. **Work item flow:** for work items of every type (tasks, features and epics included), or one type picked from the list, cycle time from Activated Date to finished (median and 85th percentile, by type and as a distribution), items finished per week, and aging work in progress: each item in progress by how long since it started, against those percentiles, with the ones taking longer than usual listed. **Sprint scope** (backlog items and bugs, not tasks) shows each team's running sprint: what it held at the end of its first day, what was added or taken out since (from the work items' history, WIQL `ASOF`), what came over unfinished from the previous sprint, and done against time gone. |
| **Release notes** (Pull requests tab) | Merged PRs in a date range (every organization), plus the work items they delivered, as Markdown grouped into features, fixes, and PRs by repo, to copy or download. For one deploy, **Copy release notes** on its panel gives exactly what it shipped. |

**Search (Ctrl+K, or ⌘K on a Mac)** opens a search box from anywhere: pages and their tabs, open pull requests, open work items, pipelines and repositories (each repo opens its commit history), plus New work item, New pull request and Refresh. Type a number (`#4107` or `4107`) to open any work item, closed ones too, or `!815` for a pull request. With nothing typed it shows what you opened recently (kept in this browser).

Thresholds, the blocked tag, auto-complete defaults and the refresh interval are set in **Settings**. Click a section's title to fold it away; folded sections stay folded in this browser, and a link to one (from Waiting to ship, say) opens it. Settings are saved to `data/settings.json`.

## In the terminal

`npm run cli` opens Keel in the terminal (or run `npm link` once, then `keel` from any folder). It works like Tiller and Trawl: titled panels, a prompt with slash commands, and Pinch the crab keeping an eye on things. `npm run cli:demo` (`keel --demo`) opens the demo organization, no credentials needed.

It works in one of two ways: through your team's Keel, signed in with your Keel account, or straight with Azure DevOps, reading the same `.env` and data folder as the web app in local mode, so tracked projects, snoozes and settings are shared.

**Your team's Keel.** `keel login` signs in with your account on your team's Keel (keel.example.com, or `keel login <address>` for another), the way `gh auth login` does: it shows a code and opens `<address>/terminal` in your browser (a page of its own, like the sign-in screen, without the menu), where you sign in if you aren't already, type the code and choose **Allow**, after seeing which computer asked. The code has to be typed, not passed in the link, so nobody can send you a link that signs their terminal in as you, and it lasts 10 minutes. The terminal then gets its own token, saved in its `.env` (`KEEL_SERVER` and `KEEL_TOKEN`), and works through that Keel as you: your role, your Azure DevOps connection, your tracked projects and settings, with the server's live updates (the same event stream the browser listens to). It never sees your Azure DevOps token. **Settings → Your account → Terminals signed in** on the web lists each terminal with when it was last used, and signs any of them out. A terminal is also signed out after 90 days unused, when you change or reset your password, or when an Admin disables your account; the next start then asks you to sign in again. `keel logout` (or `/logout` inside) signs out and goes back to working straight with Azure DevOps. The first start asks which of the two you want.

**Straight with Azure DevOps.** With `AZDO_PAT` in `.env`, it uses that token. Without one, it uses your Azure CLI sign-in (`az login`), so no token is stored anywhere; your account needs access to the organization. `AZDO_AUTH=az` in `.env` does the same for the web server in local mode. GitHub owners added in Settings use `GITHUB_TOKEN`, or else your GitHub CLI sign-in (`gh auth login`); **o** opens their pull requests and runs on GitHub.
**Without a checkout.** Download the executable for your platform from [Releases](https://github.com/FranciscoNunes-dxspark/keel/releases): `keel-windows-x64.exe`, `keel-linux-x64` / `-arm64`, `keel-macos-arm64` / `-x64`. It's a single file with nothing else to install. Rename it to `keel` (`keel.exe`) and put it in a folder on your PATH. `SHA256SUMS.txt` lists each file's checksum. It keeps its `.env` and data folder in `.keel` in your home folder (`~/.keel/.env`, `~/.keel/data`), not beside the web app's; `keel --help` shows the path. The first time, it asks what to connect to: your team's Keel (its address, keel.example.com if you leave it empty, then the browser sign-in above), Azure DevOps directly (an organization, where a name like `contoso` is enough, and how to sign in: your Azure CLI sign-in, `az login`, with nothing stored, or a personal access token, typed unseen and saved in that `.env`), or the demo. A checkout without `AZDO_ORG_URL` or `KEEL_SERVER` in its `.env` asks the same. The builds aren't code-signed, so Windows SmartScreen may ask before the first run ("More info" → "Run anyway"), and on macOS you may need `xattr -d com.apple.quarantine keel-macos-arm64` once.

**Updates.** The downloaded executable keeps itself up to date, as Tiller does. Once a day at most, after it opens, it asks GitHub for the latest release; if that's newer than yours, it downloads it in the background and puts it in place of the executable you ran, and the new version starts the next time you open Keel. The activity lines and the welcome box say how far it got.

- It asks GitHub's public API first, then through [gh](https://cli.github.com) with your existing sign-in (needed while the repository is private), and downloads the same way.
- The download must match the checksum published with the release (`SHA256SUMS.txt`), or nothing is replaced.
- On Windows a running program can't be overwritten, only renamed, so the old executable is moved aside (`keel.exe.old.<time>`) and deleted on a later start.
- If Keel can't write to the folder it's in (installed under Program Files, say), or anything else goes wrong, nothing changes: it says a new version is out, and why it couldn't install it, with the download link.
- Offline or without gh, it says nothing and tries again next time. Running from a checkout skips all of this; `git pull` updates that. `keel --version` says which version you have.
- The last answer is kept in the data folder (`update-check.json`). `KEEL_AUTO_UPDATE=0` in `.env` only tells you about new versions; `KEEL_CHECK_UPDATES=0` doesn't check at all.
- v0.1.0 doesn't update itself yet: download a later version once, and from then on it does.

**Releases.** `npm run build:cli` makes the executable for this machine in `release/` (`npm run build:cli -- --all` for every platform), with [Bun](https://bun.sh)'s `--compile`, fetched by npx. They're released automatically: a push to main that changes `cli/`, `server/`, `bin/` or the packages runs the Release workflow (`.github/workflows/release-cli.yml`), which runs the tests, builds every platform and publishes a GitHub Release with the files, creating the tag. The version is the latest release with the patch number raised (v0.1.0 → v0.1.1), or `package.json`'s when that's higher, which is how to move to a new minor or major version. Nothing is committed back. "Run workflow" on the Actions tab releases by hand.

| Tab | For |
|---|---|
| **Inbox** | The same list as the web app's Inbox, most urgent first. **↵** opens a pull request or pipeline in its own tab, and anything else in the browser. **s** snoozes for a day (`/snooze 2d`, `/snooze 1w`; `/unsnooze` brings them all back). On a deployment waiting on you, **a** approves it and **x** rejects it (both ask first). |
| **Pull requests** | Active pull requests in your tracked repos: waiting on your review, then yours, then everyone else's (**f** or `/show` narrows it). **a** approves, **A** approves with suggestions, **w** waits for the author, **x** rejects (asks first), **0** clears your vote. **c** completes it with the merge options from Settings (asks first, and says so when it isn't approved yet). **m** turns auto-complete on or off. **↵** shows it in full: description, policies, reviewers, work items, files and recent comments. **p** publishes a draft. The pane shows its steps (✓ Publish → ● Approval → ○ Complete) with what the current one waits on, and its hint leads with that step's key. `/comment <text>` comments. `/pr 817` jumps to one. |
| **Pipelines** | Failing pipelines first, then unstable, healthy and idle, with the selected one's latest runs. **n** runs it on its own branch (`/run <branch>` for another), **c** cancels the run that's queued or running (asks first). **l** shows the run (the one running, else the latest) in full: its stages and jobs as a tree, the steps of any job that failed with their errors and the last 40 lines of their log, the test counts, any approval it waits on, and the commits it built. `/logs <number>` shows an older run. The viewer wraps long lines, so a log line or an error is never cut off. |
| **Work items** | Open work items in your tracked projects, with the web app's views: all open, current sprint, bugs, blocked, no update in N days, unassigned and yours (**f** goes round them, `/show <view>` picks one). In progress first, then resolved, then new, by priority. **s** moves one to another state of its type (picked from a list, or `/state <name>`), **i** takes it, `/assign <person>` (`me`, `nobody`) and `/unassign` change who has it, **b** tags it blocked or takes the tag off, `/priority 1`–`4` sets its priority, and `/comment <text>` comments. **↵** shows it in full: description, acceptance criteria, parent and children, pull requests, attachments and comments. `/new <type> <title>` creates one in the selected work item's project, for its first team, in the current sprint or the backlog (it asks which). `/wi 4107` jumps to one, and **↵** on a work item in the Inbox opens it here. |
| **Production** | The production monitors of the web app's Production page, those that need you first (down, degraded, deploying, just deployed), each with its response time, 24h uptime and failure rate. Beside it: its issues (the same as on the web, such as "failures up since Release-65"), its latest deploys, and **Waiting to ship**: whether a deploy is under way or waiting for approval, how many changes are merged on its branch and not deployed yet (and how long the oldest has waited), and the open pull requests coming next. **↵** shows all of it, with every waiting pull request, commit and work item, what fails most and the missing pages asked for. **o** opens the site. **↵** on a production item in the Inbox comes here. Without a Keel server, the terminal app runs the monitors' checks itself while it's open (one process at a time does, as the web server's copies share them). Monitors are added and linked in the web app. |
| **Releases** | The classic release pipelines of the web app's Releases tab: those deploying or waiting for an approval first, then failing ones, each with its stages in a row (✓ ✗ ● by their latest deployment). Beside it: each stage's latest deployment (which release, how it went, when, and who or "automatically"), what's deploying there now, the approval it waits on with its instructions, and the recent releases stage by stage. **n** creates a release from the latest artifacts (asks first; `/release <description>`). **d** deploys or redeploys a recent release to a stage, picked from two lists (`/stage <name>`); approvals and gates on the stage still apply. **a** and **x** approve or reject what a stage waits on (both ask first; `/deploy` and `/stop` with a comment). **↵** shows every stage and release. |
| **Board** | A team's real Azure DevOps board, as the web app's Board page: its columns side by side with their WIP limits (a split column counts only what's still Doing), each card two lines (number and title; who has it, points, tasks done, swimlane, Done, blocked). Open work and anything finished in the last 14 days, or **f** for the current sprint. **h**/**l** move between columns (more than fit scroll in, with arrows saying how many more) and **j**/**k** between cards. **>** and **<** move a card to the next or previous column that takes it, saving its board column and the state that column maps to for its type, as dragging it on the web does, and the cursor goes with it; **m** picks the column from a list. **space** marks a card Done in a split column, or Doing again. **↵**, **s**, **i**, **b** and the work item commands work as in Work items. **t** picks another team, **v** another of its boards (Stories, Features, Epics, custom levels). A team with no board configured gets a column per state category. |
| **Team** | Who carries what, as the web app's Team page: everyone in your tracked projects' teams (less those hidden on the web), the ones flagged with too much on first (too much in progress, stale pull requests), each with their work in progress, sprint items and points, reviews waiting on them and pull requests. Beside it: their teams, flags and numbers, their open work items, their pull requests, and those waiting on their review. **↵** shows their work items in Work items, **p** their pull requests in Pull requests. |

`/summary` shows this week's summary, the web app's **Weekly summary** as the text its **Copy as text** gives (items finished, pull requests merged by repo, deploys to production per environment, and what's blocked now), ready to paste into an email or chat. `/summary last`, `/summary -3` (up to 26 weeks back) or `/summary 2026-10-06` show earlier weeks.

More of the web app's pages, as reports in the viewer:
- `/insights [days]`: the Insights page and **Delivery to production**. Pull requests merged and abandoned, how long they take from open to merged (half within, 85% within), how long what's open has waited, merges each week, and the same by repo, author and reviewer; then deploys a week, lead time, change failure rate and time to restore with their DORA bands, by environment. 30 days by default, up to 180 (delivery up to 90).
- `/flaky`: the **Flaky tests** tab: tests that fail now and then on a pipeline's own branch and pass again without a fix, failing now first, with how often, the last failure and its error.
- `/closed [days]`: pull requests completed or abandoned in the last 7 days (or any number up to 90), newest first, with who closed them, how long they were open and the reviewers' votes.
- `/commits [repo] [days]`: the **Commits** tab: each tracked repo's default branch, newest first and by day, with the pull request and work items each one mentions. A repo name (or part of one) narrows it; 7 days by default, up to 90.
- `/totals`: **Platform totals**: each ISM site's key figures first, then every area's, with the change since the fetch before.

Everywhere: **o** opens the selection in Azure DevOps, **/** opens the command prompt, `/find` filters the list, **r** asks Azure DevOps again now, and **?** lists every key: the sections down the left, opening on the one for the tab you're in, **j**/**k** to pick another, and **/** to search them all (the slash commands too). While it's open it checks Azure DevOps every "refresh every" seconds from Settings, as the web app does, and says what changed (votes on your pull requests, your runs finishing, new things in the Inbox) in its activity lines. Warnings from Azure DevOps calls are under `/log`.

**Settings.** **,** (or `/settings`) opens them over the current tab, and esc closes them. They're the web app's settings, in the same data folder, so a change shows in both. The sections are down the left, as in the **?** window, and the selected one's settings beside them: **tab** and **shift+tab** (or **h**/**l**, or a click) go to another.
- **Projects:** **space** tracks a project or stops tracking it, and **↵** opens a tracked one's repos, where **space** takes one in or out. Projects tracked when you opened Settings stay at the top while it's open, and `/find` narrows the list.
- **When to flag things:** the web app's thresholds, each one step up or down with **+** and **-**: when a review waiting on you is escalated, when a pull request with no approvals is flagged or called stale, when an in-progress item is stuck, how far back pipeline health looks, and when someone has too much in progress or too many reviews owed. Also the blocked tag (changed on the web) and how often Keel checks for changes.
- **Merging:** the merge type, deleting the source branch, and completing linked work items, used by **c** and auto-complete.
- **Organizations:** **x** removes an added one (asks first). `/addorg <address>` adds another Azure DevOps organization or a GitHub owner (`--github` for a GitHub Enterprise Server); it shows the next time you open Keel. Through your team's Keel, organizations are the server's, for everyone, so only Admins can add or remove them, and each person links their token for a new one on the web.
- **This computer:** the settings file, how you're signed in (through your team's Keel: which account, and where), and the mouse on or off (`KEEL_MOUSE` in that `.env`). In the downloaded executable, **space** on Updates goes round install by itself, only tell, and don't check (`KEEL_AUTO_UPDATE` and `KEEL_CHECK_UPDATES` in that `.env`).

**Mouse.** A click on a tab opens it, on a row picks it, on the prompt or a suggestion types there; a double-click does what ↵ does, and the wheel scrolls the list or the viewer under the pointer (leaving the cursor where it was until a key moves it). Asking for the mouse stops the terminal selecting text by itself, so Keel does it: drag to select what's on screen, and it's copied when you let go (the system clipboard, or through the terminal over SSH); the bottom line says what was copied. Hold Shift while dragging for the terminal's own selection, or turn the mouse off in Settings. On Windows it needs the downloaded app, or Node 22.17 or later from a checkout. Everything still works from the keyboard. It's the same mouse support as Trawl's and Splice's.

Teams and area paths are still picked in the web app.

Not in the terminal yet: epics, new pull requests, release notes and the dashboard (**o** takes you to Azure DevOps, or use the web app). Its text is in English only.

## Production monitoring

Set it up in **Settings → Production monitors**:

- **URL to check:** your app's home page or a health endpoint. It's checked every minute from the Keel server. Only public addresses are allowed. Set `MONITOR_ALLOW_PRIVATE=1` if you really mean to monitor internal endpoints.
- **Application Insights (optional):** in the Azure portal, open the app's Application Insights → **API Access**. Copy the **Application ID**, then **Create API key** with *Read telemetry*. Paste both into Keel, never into chat or tickets. The key is stored encrypted, and Settings shows only that one is saved.
- **Deploys come from:** the classic release stage or the pipeline that deploys this app. This adds deploy markers and regression detection.
- **Project:** who sees the monitor. A monitor linked to what deploys it belongs to that project; otherwise pick one. Only people who track the project see the monitor, its Inbox entries and notifications, its Waiting to ship card, its deploys in Delivery to production and its Platform totals. A monitor with no project shows for everyone, as all monitors did before.
- **Production branch** (optional): the branch production deploys from, when Keel's guess is wrong. Waiting to ship compares with it, and for a pipeline its runs on this branch are the production deploys (for a pipeline that builds Develop for testing and master for production, set master). Until the pipeline has a successful run on it, its deploys stay the runs on the branch its automatic runs use, so a branch it never deploys from doesn't leave it with none. Leave it empty and Keel works it out (see Waiting to ship).

Use **Test** to check a URL and key before saving. Monitors are kept by the Keel server, each shown to the people who track its project, and only Admins can change them. The last 24 hours of checks are kept in the data folder (`monitor-history.json`), so charts are the same for everyone and survive restarts and deploys. When the host runs several copies of Keel, one of them runs the checks; another takes over within 3 minutes if it stops. Azure Monitor alert rules aren't included: reading them needs a Microsoft Entra identity (a service principal) rather than an API key.

### ISM sites: health and platform totals

The ISM product sites (WebShopSite, ShopSites, MarketSite, CartSites) answer the `platform/v1` contract (`docs/monitoring/platform-endpoints.md` in each product repository): `GET /health` and `GET /totals`.

- **Health:** use the site's `/health` address as the URL to check, e.g. `https://shopeusite.azurewebsites.net/health`. Keel reads the envelope: its `down` (database unreachable) counts at once, `degraded` is flagged with the failing check's message, and product, site and version show on the monitor. An answer that isn't the envelope (restarting, an App Service error page) only counts as down after 3 polls in a row, as the contract asks.
- **Platform totals:** add the site's totals key (its `X-Totals-Key`, from `Set-PlatformTotalsKeys.ps1`) to the monitor. It's stored encrypted like the Application Insights key. Keel fetches `/totals` every 1, 6, 12 or 24 hours (24 by default) for the current season or all seasons, one site at a time, with a 5-minute timeout. It never follows redirects with the key. Admins can fetch one site now from its page, or every site they see with **Fetch all** on the Platform totals page: one after another (the ones waiting show as Queued), leaving out any site fetched in the last 10 minutes, since each fetch keeps the club database busy.
- **The Platform totals page** compares sites on key figures or one area at a time, with the change since the previous fetch. Each site's page shows every figure by area, its trend this season and its monthly counts. **Export CSV** downloads every figure of every site, one row per site and figure, with the season total, the change since the previous fetch and the count for each month. The latest figures and up to 300 snapshots per site are kept in the data folder (`monitor-totals.json`). A 404 from `/totals` on a site whose health answers means the key is wrong or missing; the page says so.

## Live updates and notifications

While the console is open (a background tab is fine), the server checks Azure DevOps every 30 seconds. You can set 15–600 seconds in Settings. Pages refresh only when something changed. When nobody has the console open, it stops polling.

You get a notification when:
- a deployment approval or a review request is waiting on you
- someone votes on your pull request, or it completes
- a pipeline run you started finishes
- a pipeline or deployment starts failing
- an item becomes blocked, or a P1 bug has no owner

Notifications show as pop-ups in the console. Desktop notifications are optional: turn them on in **Settings → Notifications**, along with which kinds you want. The browser tab title shows the "act now" count, for example `(3) Keel`.

### Install as an app, with push notifications

Keel can be installed on a phone or computer like an app, with its own icon, opening full screen:
- **Android, Chrome or Edge:** **Install Keel as an app** in **Settings → Notifications**, or "Install app" / "Add to Home screen" in the browser menu.
- **iPhone and iPad (iOS 16.4 or later):** in Safari, tap **Share → Add to Home Screen**, then open Keel from the Home Screen.

Pages fit the screen, so pinch and double-tap zoom are turned off, in the browser and the installed app alike.

**Push notifications** reach that device even when Keel is closed. Turn them on per device with **Turn on push on this device** in **Settings → Notifications**. They cover the same events as the console's notifications, in the kinds you chose there. On iPhone and iPad they only work in the installed app.
- **How often:** the server checks every two minutes, as you, for everyone with a device turned on. Each event is sent once. Tapping a notification opens the page it's about, with the pull request or work item already open.
- **Devices:** each one is listed with a **Remove** button, and **Send a test** checks one is working. A device whose subscription has expired is removed by itself.
- **Requirements:** push needs Keel served over https (or `localhost`).
- **Push services:** Keel sends only to the browsers' push services (Google, Apple, Mozilla and Microsoft), so a device can't make the server call any other address. List any extra push service hosts in `PUSH_ALLOW_HOSTS`.
- **Identifying the server:** messages are encrypted for the one device they're for (RFC 8291). The server identifies itself with a VAPID key pair made on first use. Push services may contact the address in `PUSH_SUBJECT`, which defaults to `PUBLIC_URL`.
- **Offline:** the installed app keeps only Keel itself (the page and its files) for quick and offline starts. It never stores Azure DevOps data.

### Android app

Keel also comes as an Android app (an APK to install directly, or an app bundle for Google Play). It's a [Trusted Web Activity](https://developer.chrome.com/docs/android/trusted-web-activity): Chrome opens the Keel at one address full screen, with Keel's icon, its launcher shortcuts (Inbox, Production, Pull requests) and push notifications shown as the app's. The app holds none of Keel's code, so deploying a new Keel updates it too. It only needs a new build to change the address, name or icon.
- **Download:** the `android-v…` releases on [Releases](https://github.com/FranciscoNunes-dxspark/keel/releases) have `keel-android.apk`, built for `https://keel.example.com`. It needs Android 7.0 or later. Android asks once to allow installing apps from your browser.
- **The server vouches for the app.** Chrome shows its address bar inside the app until the server lists the app's signing certificate at `/.well-known/assetlinks.json`. Set `ANDROID_CERT_SHA256` to its SHA-256 fingerprint, and `ANDROID_PACKAGE` if it isn't `com.example.keel`. Several fingerprints can go in, comma-separated, such as your own key's and Google Play's app signing key (shown in Play Console → App integrity). Without `ANDROID_CERT_SHA256` the address answers 404.
- **Your own build**, for Keel served at another address: make a signing key once with `keytool -genkeypair -v -keystore keel.keystore -alias keel -keyalg RSA -keysize 2048 -validity 10000`, and keep it safe: updates must be signed with the same key. With JDK 17 in `JAVA_HOME` and the Android SDK in `ANDROID_HOME`, run `npm run build:android -- --host keel.example.com --package com.example.keel --keystore keel.keystore`, with the key's passwords in `BUBBLEWRAP_KEYSTORE_PASSWORD` and `BUBBLEWRAP_KEY_PASSWORD`. The host must already be serving Keel, since the icons are downloaded from it. It writes `release/keel-android.apk` and `.aab` and prints the `ANDROID_CERT_SHA256` to set on that server. `--version-code` must go up with every build you upload to Google Play.
- **From GitHub Actions:** "Release the Android app" on the Actions tab builds one for any host and publishes it as a release, from the repository secrets `ANDROID_KEYSTORE_BASE64` (`base64 -w0 keel.keystore`), `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD`.

### Teams and Slack

Admins can have Keel post to team channels in **Settings → Teams and Slack**, whether or not anyone has Keel open:

- **What gets posted:** for each channel, pick from production outages and regressions after a deploy, default-branch pipelines and release stages that start failing, deployment approvals waiting, blocked work items and P1 bugs with no owner, and pull requests with no reviewers or stale for twice the limit. Keel looks every 2 minutes and posts an entry when it appears or becomes urgent, once. A burst of more than 4 at a time goes out as one post.
- **The weekly summary:** last week's summary (the same as the Weekly summary page) on the weekday and hour you choose, in the channel's time zone.
- **Language:** English or Português, per channel.
- **Setting up the webhook:** in Teams, open the channel's **Workflows** and pick "Post to a channel when a webhook request is received", then copy its address. Keel sends an Adaptive Card, which the older Office 365 connectors also take. In Slack, add an **Incoming Webhook** to the channel. **Other (JSON webhook)** sends `{ title, text, content, links }` for anything else, for example Mattermost or Discord. Use **Send a test** to check it.
- **Which projects:** tick the projects a channel is about, so one team's channel gets that team's alerts and weekly summary, whichever Admin set it up. With none ticked, it covers the projects of the Admin who added it, as before. A project that Admin tracks keeps their teams and repos; another gets all its repos and its default team ("<Project> Team"). Changing a channel's projects starts it from a fresh baseline, so it doesn't post everything already open in them.
- **Whose view:** with sign-in, Keel reads Azure DevOps for a channel with the token of the Admin who added it (so they need access to its projects) and respects their snoozes and thresholds. Locally it uses the server's PAT.
- **Storage:** addresses are stored encrypted in the data folder (`channels.json`), only https addresses to public hosts are accepted (as for monitors), and Keel never follows a redirect from one. Set `PUBLIC_URL` (for example `https://keel.example.com`) to have posts link back to Keel. When several copies of Keel run, one of them posts.

## Security

What the app already does:

- Your PAT stays on the server and never reaches the browser. The server binds to `127.0.0.1`, so other machines can't reach it.
- **DNS-rebinding guard:** requests whose `Host` isn't `localhost` or `127.0.0.1` (or `PUBLIC_URL`'s host, or a host you list in `ALLOWED_HOSTS`) are refused, so a malicious website can't point its own domain at your machine and read this API.
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

## Several organizations

Keel can show more than one Azure DevOps organization together, and GitHub owners next to them (see [GitHub](#github)). The one in `AZDO_ORG_URL` is the **primary**; Admins add others in **Settings → Organizations** (stored in the data folder, `orgs.json`).

- **Tokens:** with sign-in, each person links a token per organization in Settings → Organizations (the primary's stays under Your account). Create each token for its own organization: Azure DevOps stops accepting tokens created for "All accessible organizations" on 1 December 2026. Someone without a token for an organization simply doesn't see it. Tokens saved before there were several organizations belong to the primary one; nobody has to link theirs again. Locally, `AZDO_PAT` is used for every organization, so it has to be created for "All accessible organizations", and that stops working on 1 December 2026: to keep several organizations after that, use sign-in (`AUTH_MODE=login`).
- **Everything together:** Inbox, Dashboard, Pull requests, Work items, Board, Epics, Pipelines, Releases, Team and Insights merge every organization. With more than one, project names show their organization ("Org · Project") in filters, the Board picker and the detail panels. Team counts a person once across organizations (matched by email); Insights are computed over all of them.
- **Work item numbers** are only unique within an organization, so Keel keeps the organization with every item (the API takes `?org=` on `/workitems/:id`).
- **Projects** of every organization are picked in Settings → Projects and repositories.
- **If an organization fails** (an expired token, an outage), it's left out and the others still show; the primary failing works as before.
- **Production monitors** stay shared by the server; deploy markers on their charts come from the primary organization's pipelines and releases.

### GitHub

Keel can also follow **GitHub** repositories next to your Azure DevOps projects: their **pull requests** and **GitHub Actions**. Issues and GitHub Projects aren't included. An Admin adds a GitHub owner (an organization or a user) in Settings → Organizations: pick **GitHub** as the kind and give its address, `https://github.com/your-org` (a GitHub Enterprise Server's address works too). The owner shows as one project in Settings → Projects and repositories, with its repositories to pick from. The primary organization is still the Azure DevOps one.

- **Tokens:** locally (and in the terminal app), Keel uses `GITHUB_TOKEN` from `.env`, or else your GitHub CLI sign-in (`gh auth login`), so no token needs storing. With sign-in, each person links their own GitHub token for the owner in Settings → Organizations. It needs the `repo` and `workflow` scopes (classic), or fine-grained Contents, Pull requests, Actions, Checks and Deployments (read and write). Add `read:org` (classic) or the organization's Members (read) to also see teams asked to review; without it Keel leaves them out.
- **Pull requests:** in the Inbox, Pull requests, Dashboard and Insights like any other. Reviews count as votes: an approval is Approved, a change request is Waiting for author, and anyone asked to review who hasn't answered is waiting on. Checks and required reviews show as the PR's checks, blocking when branch protection requires them. While its checks (tests, builds, commit statuses) are still running, a pull request is held: it waits at the merge step ("Checks running" in the list), **Complete…** stays off until they pass (auto-merge can still be turned on, and then merges it once they do), the Inbox doesn't call it approved but not merged, and **c** in the terminal app says to wait. Once they fail, it's held the same way until they're fixed ("Checks failed"). From Keel you can approve or request changes, comment, add reviewers, publish a draft, turn auto-merge on or off, merge (squash, merge commit or rebase, optionally deleting the branch) and close. GitHub has no "approve with suggestions", "reset vote" or semi-linear merge, and Keel can't override branch protection there. On your own pull request there are no review buttons and no **Add me**, since GitHub doesn't let an author review or be asked to review their own.
- **Actions:** each workflow is a pipeline, grouped by repository, with its health, runs, jobs and steps, and the end of a failed step's log. **Run** starts a workflow that has a `workflow_dispatch` trigger. A deployment waiting on an environment's reviewers shows under Approvals and in the Inbox; rejecting it makes the run **declined**, not failed, as in Azure DevOps.
- **People:** a GitHub login is matched to the same person in Azure DevOps by email, so their pull requests and reviews count on their Team page row. Keel uses the person's email in the organization's verified domains when GitHub gives it (the organization needs a verified domain; GitHub may only show it to organization members), and otherwise their public profile email. For someone with neither, their GitHub pull requests don't count on their row.
- **Not from GitHub:** work items, boards, sprints, epics, team pages, classic releases and test results. Those pages simply have nothing from it. With "All repos", Keel only asks about runs in repos pushed to within the build lookback (two weeks by default), so an owner with hundreds of repos stays within GitHub's rate limit; picking repos in Settings asks about exactly those.
- **Search lag:** pull requests come from GitHub's search, which can take a minute to list a brand-new one.

## Hosting it for your team (Hostinger or any server)

With `AUTH_MODE=login`, Keel has its own accounts. Each person signs in with an email and password, then links **their own** Azure DevOps PAT once, so votes, approvals and comments are recorded under their own name. This needs no Microsoft Entra app registration.

### Accounts and roles

| Role | Can do |
|---|---|
| **Admin** | Everything, plus manage users and production monitors |
| **Developer** | Pull requests (create, vote, comment, complete), work items and boards, run pipelines and releases, approve deployments |
| **PM** | Work items and boards, run pipelines and releases, approve deployments. Pull requests are read-only |

Everyone can see everything. Roles only limit what a person can change, and the server enforces them, not just the screens. Azure DevOps permissions still apply on top: a PM can't approve a deployment that Azure DevOps doesn't let them approve.

- **First admin:** on first start the sign-in page asks for a setup code. Set `ADMIN_SETUP_CODE` in `.env`, or use the one the server prints in its log (`pm2 logs keel`). A printed code stays the same across restarts until the first admin exists (it is kept in `setup-code.txt` in the data folder). The first account becomes Admin.
- **Inviting people:** **Users → Invite someone** creates a link for an email address and role. Keel doesn't send email, so copy the link and send it yourself. It works once and expires in 7 days. The person picks their name and password, then links their token.
- **Forgotten passwords:** on **Users**, choose **Reset password** to get a new link. Using it signs that person out everywhere.
- **Managing access:** change a role, disable an account (signs it out at once) or remove it. There's always at least one active Admin.
- **Synced settings:** projects, teams, inbox snoozes, theme, notification choices, the dashboard layout and saved views belong to the account, so they follow you to any device.

### What's stored where

- **Passwords** are hashed with scrypt.
- **Tokens:** each PAT is checked against your organization, then stored encrypted (AES-256-GCM) using `SESSION_SECRET`. It's never sent back to a browser. **Settings → Your account** replaces or disconnects it. If Azure DevOps stops accepting a token (expired or revoked), that person is asked for a new one.
- **Browser:** only a random session cookie (HttpOnly, SameSite=Strict, and Secure/`__Host-` behind HTTPS).
- **Sessions** last `SESSION_DAYS` (7 by default, renewed while you use it, 30 days at most). Changing your password signs out your other devices.
- **Terminals** signed in with `keel login` (`terminals.json`): only a SHA-256 hash of each one's token, with the name it gave (user and computer), the IP it signed in from, and when it was last used. Their tokens reach the API as you, never the account pages (password, Azure DevOps token, users), and end after 90 days unused, on a new password, or when the account is disabled or removed. **Settings → Your account** lists and signs them out.
- **Rate limits:** after 10 failed sign-ins from one IP, or 5 for one email address, sign-in is blocked for 15 minutes.
- **Push notifications:** each device's push address and keys are stored encrypted in `push.json`, with the server's VAPID private key. A device is listed only for the person who turned it on there.

To try accounts and roles before deploying, run on demo data with `AUTH_MODE=login` and `AZDO_MOCK=1`. Demo accounts are kept apart from real ones, and any token-shaped value links to the demo organization.

### What you need on Hostinger

The app is a Node.js server, so it needs a **VPS**, or a plan that can run **Node.js apps**. PHP-only shared hosting can't run it. You also need a domain or subdomain (Keel's is `keel.example.com`) with HTTPS.

### Where Keel keeps its data

Accounts, sessions, settings and monitors are files in a data folder. The server log shows which one (`Data folder: …`) when Keel starts.

- **Hostinger Node.js apps:** every deploy builds into a new `hbuilds/versions/<build>` folder and deletes the old one, so a `data/` folder inside the app would be wiped on each publish. Keel detects this and uses `~/domains/<your-site>/keel-data`, next to `hbuilds`, which deploys don't touch.
- **Anywhere else:** `data/` in the app folder.
- **Your choice:** set `DATA_DIR` to an absolute path.

Also set `SESSION_SECRET` in the host's environment variables. Without it, the encryption key is generated into the data folder, and losing it means everyone links their token again.

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
   PUBLIC_URL=https://keel.example.com
   TRUST_PROXY=1
   HOST=127.0.0.1
   API_PORT=4280
   ```
   `PUBLIC_URL` is the address people open. Keel serves only that host (plus `localhost`), and Teams and Slack posts link to it. If Keel is also reached by another name, such as `www.keel.example.com`, list it in `ALLOWED_HOSTS`.
4. **Keep it running** with pm2, so it restarts on crash and after reboot:
   ```bash
   sudo npm i -g pm2 && pm2 start server/index.js --name keel && pm2 save && pm2 startup
   ```
5. **Put nginx in front.** Live updates need buffering off on `/api/events`:
   ```nginx
   server {
     server_name keel.example.com;
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
   sudo certbot --nginx -d keel.example.com
   ```
6. **Back up and protect the data folder** (`data/`, or `DATA_DIR`). It holds the accounts, everyone's settings and the encrypted tokens. Keep `SESSION_SECRET` safe: without it, stored tokens can't be decrypted and everyone has to link theirs again. Anyone who has both the data folder and the secret can use the stored tokens.
7. **Updating:**
   ```bash
   git pull && npm ci && npm run build && pm2 restart keel
   ```
   Anyone with Keel open (in a browser or the installed app) sees **A new version of Keel is available** within 10 minutes, or as soon as they come back to the tab, and **Update** reloads into it. Each build has its own id (`build.json`), so this works for any way of deploying a new build.

8. **Create your account:** open the site, enter the setup code, then invite your team from **Users**.

Teammates create their own token from the "How to create a token" steps shown after they first sign in. Ask them to use the scopes listed above and a sensible expiry.

## Appearance

**Settings → Appearance** sets the color mode (System, Dark or Light) and an accent color (Green, Blue, Violet, Teal, Magenta, Coral or Sand). The choice is saved in your browser, and with sign-in it also follows your account to other devices.

**Pinch,** the crab in Keel's logo, shows how things are. In the sidebar corner and next to the Dashboard greeting it watches; it looks worried while Azure DevOps answers Keel's live checks with an error, glances about during a refresh, and naps when your Inbox is empty (hover over the logo for what it means). It also glances about while a whole page loads, sits worried by error messages, and appears on the sign-in screen and on a "There's no page here" page for an address Keel doesn't have (which used to open the Dashboard instead). With reduced motion turned on in your system, it keeps still.

**Language:** English or Português (Portugal), in the same place. It follows your account like the theme; the first visit uses the browser's language. Text from Azure DevOps (titles, names, states, board columns) is shown as it is there. Translations live in `client/src/locales/pt/`, keyed by the English text; text the server sends is matched by templates in `server.js` there.

**Remembered choices:** the board's project and team, list filters, tabs and toggles stay as you left them when you move between pages or reload (per browser).

**Saved views:** on Pull requests, Commits and Work items, **Save view** keeps the current filters under a name ("Stale in Commerce"), shown as a chip above the list. Views follow your account like the theme. **Copy link** gives an address that opens the page with those filters, to send to someone.

## How it works

```
client/          React + Vite UI (dark theme, IBM Plex)
server/
  index.js       Express: /api + built UI from dist/
  routes.js      HTTP layer; writes require the x-keel header
  service.js     Scopes everything to tracked projects/repos, caching
  azdo/          REST client (PAT or Azure CLI auth, retries on 429/5xx, paging, concurrency limit) + provider
  github/        A GitHub owner as an organization: REST + GraphQL client (token or gh CLI), provider, mapping
  providers.js   Each organization's provider, by its kind
  mock/          Demo providers with the same interface (Azure DevOps, and a fake GitHub API for github/)
  domain/        Pure logic: PR signals, inbox rules, workload, pipeline health, insights, release notes, commits,
                 delivery (DORA) and the weekly summary
cli/             The terminal app (Ink): the same service as the server, in-process; bin/keel.js starts it
test/            node:test tests for the domain logic and the terminal app
```

- **Process-agnostic.** "Done" is decided by Azure DevOps *state categories*, not state names, so Agile, Scrum, Basic, CMMI and custom processes all work. Work item queries use category groups (`Microsoft.RequirementCategory` and so on), not hard-coded type names.
- **Security.** The PAT lives only on the server. The server binds to `127.0.0.1`, and every write needs a custom header so other websites can't drive the API from your browser. Don't set `HOST=0.0.0.0` unless you're sure about who can reach the port.
- **Load.** Lists are cached for 60 seconds, and each write clears the related cache. The **Refresh** button clears everything. Requests are capped at 6 in flight and back off on throttling.

## Limits

- The changed-files list has no line counts (+/−) because the Azure DevOps REST API doesn't provide them. Images in PR text load only from your own organization. External images show as a placeholder, so no tracking pixels are fetched.

- Group reviewers (for example "[Project]\Team") are shown, but a PR only counts as "waiting on your review" when you are a direct reviewer.
- Work item queries return up to 1,000 open items per project.
- All read views have been checked against a real Azure DevOps Services org. Write actions (vote, comment, reviewers, auto-complete, abandon, work item updates, re-running pipelines) have only been exercised on demo data so far. Error messages from Azure DevOps are passed through to the UI.
- GitHub sources have only been exercised on demo data so far, reads and writes alike. GitHub's error messages are passed through to the UI.
- Azure DevOps reports a team's last iteration as "current" even when it ended long ago or has no dates. The Sprint page shows it with a warning, and the inbox and team pages ignore sprint membership until a dated iteration covers today.
- A work item counts as blocked if it has the blocked tag, a state with the same name (default `Blocked`), or the CMMI Blocked field set.

## Scripts

| Command | |
|---|---|
| `npm run dev` / `npm run dev:mock` | API with auto-restart + Vite dev server on :5173 |
| `npm run build` | Build the UI into `dist/` |
| `npm start` / `npm run start:mock` | Serve the API and built UI on :4280 |
| `npm run cli` / `npm run cli:demo` | Keel in the terminal (needs a real terminal) |
| `npm run build:cli` | The terminal app as a standalone executable in `release/` (`-- --all` for every platform) |
| `npm test` | Domain logic and terminal app tests |
