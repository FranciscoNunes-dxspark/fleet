# Chart

<img src="assets/logo.svg" alt="Plot, the Chart puffin" width="96" align="right">

Infrastructure as code, in the terminal. Chart asks Terraform (or OpenTofu) for a plan, or Azure for a Bicep or ARM what-if, and lists what would change: what is destroyed or replaced first, in red, with why, then each resource attribute by attribute, sensitive values never shown. It shows what changed outside Terraform since the last apply (drift), what the state holds, and writes the plan as Markdown for a pull request. `chart check` does the same in a pipeline and fails it when a plan destroys something.

It covers what Terraform Cloud's or Spacelift's plan view, env0 or a drift detector are bought for, for a team that runs Terraform or Bicep itself. It runs `terraform`, `tofu` and `az` through their command lines, signed in and set up as they are; **it only plans: nothing is ever applied.**

```
chart                     # this folder
chart ../infra            # another folder
chart --demo              # a made-up Azure estate, to look around: nothing is run
chart check --fail-on destroy        # in a pipeline: plan, and exit 1 when something is destroyed
chart check plan.json --markdown     # a saved plan, as a pull request's comment
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder (`!terraform validate`).

Chart is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/chart`), or download the executable from the releases.

## Where the plans come from

| Command | What runs |
|---|---|
| `/plan [folder]` | `terraform plan -input=false -lock=false -out=<a temporary file>`, then `terraform show -json` of it (the file is deleted after). The folder is the first one with `.tf` files unless named |
| `/drift [folder]` | The same with `-refresh-only`: only what changed outside Terraform |
| `/state [folder]` | `terraform show -json`: every resource in the state |
| `/init [folder]` | `terraform init -input=false`, which a folder needs before its first plan (Chart says so when a plan fails for want of it) |
| `/whatif [file] --rg <group>` or `--location <region>` `[--params <file>]` | `az deployment group what-if` (or `sub what-if`) `--no-pretty-print`. The file is the first `.bicep` found unless named, and a `.bicepparam` or `.parameters.json` beside it is used; alone, `/whatif` runs the last one again |
| `/open [file]` | A saved plan or state (`terraform show -json plan.tfplan > plan.json`) or what-if result |

`/tool tofu` runs OpenTofu instead (`/tool terraform` back). `-lock=false` keeps a plan from holding the state's lock while you look. Everything put into a command line (a path, a resource group, a region) is checked first: no quotes, no `$`, nothing but what paths and names have.

When Chart opens, it only looks at the folder: a plan can take a while and signs in to your cloud, so it runs when you ask. `ctrl+r` runs the last plan, what-if or file again.

## Views

`1` Changes · `2` Drift · `3` State · `4` Log (what Chart has run). `tab` goes round.

### Changes

What the plan does, worst first: `-` destroy and `±` replace in red (with why: an argument that forces replacement changed, no longer in the configuration, tainted…), `~` update yellow, `+` create green; how many attributes change; `app` on an App Service app. What doesn't change is hidden (`a` shows it). The header sums it up (`-1 ±1 ~2 +2`) with how many drifted.

| Key | |
|---|---|
| `↵` or `l` | What changes in it, attribute by attribute: `~ sku_name: "B1" → "P1v3"`, `# forces replacement` on what does, `(known after apply)`, `(sensitive)` for what Terraform marks sensitive (its value is never shown or kept), `# no effect` for a what-if's noise; its id, and where it is declared |
| `a` | Show the resources that don't change too, or hide them |
| `t` | Copy where it is declared (`resource "type" "name"` in the `.tf` files) for Splice, whose blame says who wrote it |
| `s` | Copy an App Service app (`azurerm_linux_web_app`, `Microsoft.Web/sites`…) for Locker, which shows its settings |
| `y` | Copy its address |

### Drift

What changed outside Terraform since the last apply: the plan's own refresh (`resource_drift`), or `/drift`'s. The same keys as Changes. A what-if can't tell drift from change: everything it would modify is in Changes.

### State

Every resource Terraform keeps track of, the root module's first, then each module's under its name. `↵` shows its values (sensitive ones masked), `t` where it is declared, `y` its address.

## Slash commands

`/plan`, `/drift`, `/state`, `/init`, `/whatif`, `/open`, `/show <address>`, `/report` (the plan as Markdown: what is destroyed called out, a row per change, each change's attributes in a folded `diff` block, the drift; `alt+y` copies it), `/tool [terraform|tofu]`, `/move <folder>`, `/take`, `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

## In a pipeline

```
chart check [folder|plan.json] [--fail-on destroy|replace|change|drift|none] [--tofu] [--markdown|--json]
```

A folder is planned now (`--fail-on drift` plans with `-refresh-only`); a file is read. It prints the summary, each change (and what forces each replacement), and the drift, then exits `1` when the plan does what `--fail-on` names (`destroy` by default: a delete or a replacement; `change`: anything at all), `0` otherwise, and `2` when it couldn't run. `--markdown` prints the report for a pull request's comment; `--json` the summary, changes, drift and outputs.

```yaml
# after terraform init, with the pipeline's credentials
- run: ./chart check infra --fail-on destroy --markdown > plan.md
```

## The family

A plan and a drift found go to the family's activity log, so `/timeline` in the others shows when the infrastructure was about to change; Plot's mood (worried while a plan destroys something or something drifted) goes to the others' mascots. `t` hands Splice a `file` context (the line a resource is declared on, for its blame); `s` hands Locker a `site` context (an App Service app or slot). Chart takes no sibling's context yet. The `familyMoods` setting turns the moods and the activity log off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.chart/config.json` (`CHART_HOME` moves it): `theme`, `accent`, `mouse`, `terraform` (`terraform` or `tofu`), `whatIf` (the last what-if's file, group or location and parameters), `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `chart-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Applying a plan (on purpose, for now); Pulumi and CloudFormation; telling drift apart in a what-if; a graph of what depends on what.
