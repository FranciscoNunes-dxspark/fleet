# Chart

<img src="assets/logo.svg" alt="Plot, the Chart puffin" width="96" align="right">

Infrastructure as code, in the terminal. Chart asks Terraform (or OpenTofu) for a plan, or Azure for a Bicep or ARM what-if, and lists what would change: what is destroyed or replaced first, in red, with why, then each resource attribute by attribute, sensitive values never shown. It shows what changed outside Terraform since the last apply (drift), what the state holds, and writes the plan as Markdown for a pull request. `chart check` does the same in a pipeline and fails it when a plan destroys something.

It covers what Terraform Cloud's or Spacelift's plan view, env0 or a drift detector are bought for, for a team that runs Terraform or Bicep itself. It runs `terraform`, `tofu` and `az` through their command lines, signed in and set up as they are; **it plans, and applies only what you have seen**: `/apply` takes nothing but a plan Chart saved itself (or the what-if on screen), shows what it does with the destroys first, and goes ahead once you type the name of the environment or workspace it goes to.

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
| `/plan [folder]` | `terraform plan -input=false -lock=false -out=<a file of its own>`, then `terraform show -json` of it. The file is kept, in a folder only you can read, for `/apply`, and removed when a newer plan replaces it, when it is applied, or when Chart closes. The folder is the first one with `.tf` files unless named |
| `/drift [folder]` | The same with `-refresh-only`: only what changed outside Terraform |
| `/state [folder]` | `terraform show -json`: every resource in the state |
| `/init [folder]` | `terraform init -input=false`, which a folder needs before its first plan (Chart says so when a plan fails for want of it) |
| `/whatif [file] --rg <group>` or `--location <region>` `[--params <file>]` | `az deployment group what-if` (or `sub what-if`) `--no-pretty-print`. The file is the first `.bicep` found unless named, and a `.bicepparam` or `.parameters.json` beside it is used; alone, `/whatif` runs the last one again. When the template has parameters with no default and no value in a parameters file, Chart asks for each one (masked when the name looks like a secret), once, and runs it again; the values go to Azure through a temporary file that is removed afterwards, and are never saved |
| `/deploy [file] --rg <group>` or `--location <region>` `[--params <file>]` | `az deployment group create` (or `sub create`) of a Bicep or ARM file, with the same arguments as `/whatif` (and the last ones again). It always runs the what-if first (its changes stay on screen), then shows what it will do (the destroys first) and asks you to type where it goes, as `/apply` does; only the deployment's output names are shown, never their values |
| `/open [file]` | A saved plan or state (`terraform show -json plan.tfplan > plan.json`) or what-if result |

### Applying, deliberately

`/apply` applies the plan on screen, and only one Chart made, with these guardrails:

- **Only a plan Chart saved.** For Terraform, the plan file `/plan` kept (`terraform apply -input=false <that file>`): never a fresh plan, never one opened with `/open`, never the same file twice. What is applied is exactly what you looked at; if the state changed since (someone else applied), Terraform refuses the stale plan and Chart says so: `/plan` again. For a what-if, `az deployment group create` (or `sub create`) of the same file, scope and parameters.
- **What it does, first.** Before anything runs, the plan is shown grouped by what it loses: destroyed, then replaced, changed, created, each with why and what it costs a month.
- **A name typed, not a key pressed.** You type the environment's name (`/env`), or with none the Terraform workspace (`terraform workspace show`, `default` most of the time) or the deployment's resource group; anything else, or `esc`, applies nothing.
- **Production asks again.** In an environment marked `"prod": true`, one more question after the name, No first.
- **The plan's own environment.** A plan made in `dev` isn't applied after `/env prod`: plan again.

The output comes into the activity lines (and the Log) as it is written, the last line beside the spinner; `esc` stops it (Terraform finishes what it is in the middle of). The family's activity log says what was applied and where (the folder, environment and workspace, and the summary), never a value.

`/tool tofu` runs OpenTofu instead (`/tool terraform` back). `-lock=false` keeps a plan from holding the state's lock while you look. Everything put into a command line (a path, a resource group, a region) is checked first: no quotes, no `$`, nothing but what paths and names have.

When Chart opens, it only looks at the folder: a plan can take a while and signs in to your cloud, so it runs when you ask. `ctrl+r` runs the last plan, what-if or file again.

## Views

`1` Changes · `2` Drift · `3` State · `4` Log (what Chart has run). `tab` goes round.

### Changes

What the plan does, worst first: `-` destroy and `±` replace in red (with why: an argument that forces replacement changed, no longer in the configuration, tainted…), `~` update yellow, `+` create green; how many attributes change; `app` on an App Service app. What doesn't change is hidden (`a` shows it). The header sums it up (`-1 ±1 ~2 +2`) with how many drifted.

| Key | |
|---|---|
| `↵` or `l` | What changes in it and what that costs a month (below), attribute by attribute: `~ sku_name: "B1" → "P1v3"`, `# forces replacement` on what does, `(known after apply)`, `(sensitive)` for what Terraform marks sensitive (its value is never shown or kept), `# no effect` for a what-if's noise; its id, and where it is declared |
| `a` | Show the resources that don't change too, or hide them |
| `t` | Copy where it is declared (`resource "type" "name"` in the `.tf` files) for Splice, whose blame says who wrote it |
| `s` | Copy an App Service app (`azurerm_linux_web_app`, `Microsoft.Web/sites`…) for Locker, which shows its settings |
| `y` | Copy its address |

### What it costs

Once a plan or what-if is on screen, Chart prices what it creates, replaces, destroys or resizes from the [Azure Retail Prices API](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices) (pay-as-you-go prices, no key, 730 hours a month), beside the list: each change's column says what it adds a month (`+$234/month`, a destroyed one negative `-$15/month`), the panel's title the total (`cost +$219/month`), `↵` what the price is of (`P1v3 × 2 (Linux), westeurope`), and `/report` and `chart check` say both. An update that leaves what sets the price alone costs nothing more and says nothing.

| Resource | Priced by |
|---|---|
| App Service plans (`azurerm_service_plan`, `azurerm_app_service_plan`, `Microsoft.Web/serverfarms`) | the sku (`B1`, `S1`, `P1v3`…) × workers, Linux or Windows; `Y1` is usage-priced, `F1` free |
| Virtual machines (`azurerm_linux_virtual_machine`, `azurerm_windows_virtual_machine`, `azurerm_virtual_machine`, scale sets, `Microsoft.Compute/virtualMachines`) | the size (`Standard_D2s_v3`) × instances, Linux or Windows; never a spot price |
| AKS (`azurerm_kubernetes_cluster`'s default pool, `azurerm_kubernetes_cluster_node_pool`, `Microsoft.ContainerService/managedClusters`) | `vm_size` × `node_count` (`min_count` when it autoscales): the nodes, not the cluster's tier |
| Azure SQL databases (`azurerm_mssql_database`, `Microsoft.Sql/servers/databases`) | `sku_name`: DTU (`Basic`, `S0`…, `P1`…) or vCore (`GP_Gen5_2`, `BC_Gen5_4`, `HS_Gen5_2`); compute only. Serverless is usage-priced |
| PostgreSQL and MySQL flexible servers | `sku_name` (`GP_Standard_D2s_v3`, `B_Standard_B1ms`); compute only, storage is by the GB |
| Redis (`azurerm_redis_cache`, `Microsoft.Cache/Redis`) | sku, family and capacity (`Standard C1`), × shards for Premium |
| Storage accounts, Application Insights, Log Analytics workspaces, key vaults | usage-priced: by the GB and the operation, so no figure |
| Web and function apps, slots | nothing of their own: their App Service plan is priced |
| Everything else | no price: Chart never guesses one |

The region is the resource's `location`; without one (an Azure SQL database), its parent's (its server) or its resource group's when the plan has them, else no price. When the price list has no item for a sku, or several different ones, that resource has no price either. `/currency EUR` shows prices in another currency (`currency` in the settings, USD by default); prices are asked once a session; `"costs": false` in the settings never asks.

### Drift

What changed outside Terraform since the last apply: the plan's own refresh (`resource_drift`), or `/drift`'s. The same keys as Changes. A what-if can't tell drift from change: everything it would modify is in Changes.

### State

Every resource Terraform keeps track of, the root module's first, then each module's under its name. `↵` shows its values (sensitive ones masked), `t` where it is declared, `y` its address.

## Slash commands

`/plan`, `/drift`, `/state`, `/init`, `/whatif`, `/apply`, `/deploy`, `/open`, `/show <address>`, `/report` (the plan as Markdown: what is destroyed called out, a row per change, each change's attributes in a folded `diff` block, the drift; `alt+y` copies it), `/tool [terraform|tofu]`, `/currency [code]`, `/env [name]`, `/move <folder>`, `/take`, `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

## Environments

A project's `.fleet/project.json` (in the folder or one above it, up to its git checkout's root) names its environments once for every app of the fleet; `/env` says which one is chosen, `/env prod` switches every app to it (and the family's activity log says so). Its `chart` section says what an environment means to Chart:

```json
{
  "default": "dev",
  "environments": {
    "dev":  { "chart": { "workspace": "dev", "varFile": "env/dev.tfvars", "resourceGroup": "shop-dev", "parametersFile": "bicep/main.dev.bicepparam" } },
    "prod": { "prod": true, "chart": { "workspace": "prod", "varFile": "env/prod.tfvars", "resourceGroup": "shop-prod" } }
  }
}
```

| Field | What it does |
|---|---|
| `workspace` | The Terraform workspace plans, the state and applies run in (as `TF_WORKSPACE`, so the folder's own selected workspace is left as it is) |
| `varFile` | `-var-file=` for plans, relative to the Terraform folder |
| `resourceGroup` | Where `/whatif` and `/deploy` go when no `--rg` or `--location` is typed (ahead of the last one used) |
| `parametersFile` | The what-if's parameters file when none is typed |

The header names the environment (red for production), and a `"prod": true` one draws every frame red and asks once more before anything is applied or deployed. A plan keeps the environment it was made for. While Fleet records a runbook, each slash command Chart runs (and each `/take`) goes in it; a `!` line never does.

## In a pipeline

```
chart check [folder|plan.json] [--fail-on destroy|replace|change|drift|none] [--tofu] [--markdown|--json] [--currency EUR] [--no-costs]
```

A folder is planned now (`--fail-on drift` plans with `-refresh-only`); a file is read. It prints the summary, each change (and what forces each replacement, and what it costs a month), the drift and the monthly total, then exits `1` when the plan does what `--fail-on` names (`destroy` by default: a delete or a replacement; `change`: anything at all), `0` otherwise, and `2` when it couldn't run. `--markdown` prints the report for a pull request's comment; `--json` the summary, changes, drift, outputs and `cost`. Prices that can't be had never fail a check (`--no-costs` doesn't ask).

```yaml
# after terraform init, with the pipeline's credentials
- run: ./chart check infra --fail-on destroy --markdown > plan.md
```

## The family

A plan and a drift found go to the family's activity log, so `/timeline` in the others shows when the infrastructure was about to change; Plot's mood (worried while a plan destroys something or something drifted) goes to the others' mascots. `t` hands Splice a `file` context (the line a resource is declared on, for its blame); `s` hands Locker a `site` context (an App Service app or slot). Chart takes no sibling's context yet. The `familyMoods` setting turns the moods and the activity log off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.chart/config.json` (`CHART_HOME` moves it): `theme`, `accent`, `mouse`, `terraform` (`terraform` or `tofu`), `currency` (USD unless set), `costs` (`false` never asks for prices), `whatIf` (the last what-if's file, group or location and parameters), `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `chart-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Applying a plan opened from a file, or a refresh-only one (on purpose: Chart applies only what it planned and showed; `terraform apply` is there for the rest); Pulumi and CloudFormation; telling drift apart in a what-if; a graph of what depends on what.
