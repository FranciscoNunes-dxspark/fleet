# Chart

<img src="assets/logo.svg" alt="Plot, the Chart puffin" width="96" align="right">

Infrastructure as code, in the terminal. Chart asks Terraform (or OpenTofu) for a plan, or Azure for a Bicep or ARM what-if, and lists what would change: what is destroyed or replaced first, in red, with why, then each resource attribute by attribute, sensitive values never shown. It shows what changed outside Terraform since the last apply (drift), what the state holds, and writes the plan as Markdown for a pull request. It reads what a plan would deploy for misconfigurations (a storage account with public blobs, SSH open to the internet, a database firewall open to everyone, a password written into the code), so an insecure resource is caught in the pull request. `chart check` does the same in a pipeline and fails it when a plan destroys something; `chart security` fails it when what it deploys is insecure.

It covers what Terraform Cloud's or Spacelift's plan view, env0 or a drift detector are bought for, for a team that runs Terraform or Bicep itself. It runs `terraform`, `tofu` and `az` through their command lines, signed in and set up as they are; **it plans, and applies only what you have seen**: `/apply` takes nothing but a plan Chart saved itself (or the what-if on screen), shows what it does with the destroys first, and goes ahead once you type the name of the environment or workspace it goes to.

```
chart                     # this folder
chart ../infra            # another folder
chart --demo              # a made-up Azure estate, to look around: nothing is run
chart check --fail-on destroy        # in a pipeline: plan, and exit 1 when something is destroyed
chart check plan.json --markdown     # a saved plan, as a pull request's comment
chart security infra --sarif chart.sarif   # misconfigurations in the .tf and .bicep files, for code scanning
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
- **What it does, first.** Before anything runs, the plan is shown grouped by what it loses: destroyed, then replaced, changed, created, each with why, what it costs a month, and what destroying or replacing it affects (Depends, below).
- **A name typed, not a key pressed.** You type the environment's name (`/env`), or with none the Terraform workspace (`terraform workspace show`, `default` most of the time) or the deployment's resource group; anything else, or `esc`, applies nothing.
- **Production asks again.** In an environment marked `"prod": true`, one more question after the name, No first.
- **The plan's own environment.** A plan made in `dev` isn't applied after `/env prod`: plan again.

The output comes into the activity lines (and the Log) as it is written, the last line beside the spinner; `esc` stops it (Terraform finishes what it is in the middle of). The family's activity log says what was applied and where (the folder, environment and workspace, and the summary), never a value.

`/tool tofu` runs OpenTofu instead (`/tool terraform` back). `-lock=false` keeps a plan from holding the state's lock while you look. Everything put into a command line (a path, a resource group, a region) is checked first: no quotes, no `$`, nothing but what paths and names have.

When Chart opens, it only looks at the folder: a plan can take a while and signs in to your cloud, so it runs when you ask. `ctrl+r` runs the last plan, what-if or file again.

## Views

`1` Changes · `2` Drift · `3` State · `4` Log (what Chart has run) · `5` Depends · `6` Security. `tab` goes round.

### Changes

What the plan does, worst first: `-` destroy and `±` replace in red (with why: an argument that forces replacement changed, no longer in the configuration, tainted…), `~` update yellow, `+` create green; how many attributes change; `! high` (in red, or `! med` yellow…) on what it would deploy insecurely, its worst finding and `+n` more (Security, below); `app` on an App Service app. What doesn't change is hidden (`a` shows it). The header sums it up (`-1 ±1 ~2 +2`) with how many drifted.

| Key | |
|---|---|
| `↵` or `l` | What changes in it and what that costs a month (below), attribute by attribute: `~ sku_name: "B1" → "P1v3"`, `# forces replacement` on what does, `(known after apply)`, `(sensitive)` for what Terraform marks sensitive (its value is never shown or kept), `# no effect` for a what-if's noise; its id, and where it is declared |
| `a` | Show the resources that don't change too, or hide them |
| `g` | What depends on what, on this resource (the Depends view, below); `home` goes to the top here |
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

### Depends

What depends on what, as an indented tree: the resources nothing depends on at the top, and under each the ones that depend on it (a resource under several is drawn in full once and marked `(above)` under the others). It comes from the plan's own configuration (the references each resource's arguments make, `depends_on`, and what a module is given); for a plan that came without one, `/graph` asks `terraform graph` and reads its DOT; for a what-if, a child resource sits under its parent (a slot under its app, a database under its server). What is destroyed or replaced is red, with how many depend on it (`replace: affects 1`); what depends on one of those is yellow with which (`← replacing azurerm_linux_web_app.admin`). The same "replacing X affects Y, Z" is in the change's detail (`↵`), and under it in what `/apply` shows before it asks. `g` in Changes opens it on the selected resource; `↵` shows a change, `y` copies its address.

### Security

What the plan on screen would deploy, read for misconfigurations: each resource's planned state after the apply (Terraform's, what it marks sensitive or known only after apply left unread; or the what-if's), then the folder's `.tf`, `.tfvars`, `.bicep` and `.bicepparam` files as they are written, each finding with its file and line. The files are read the first time the view is shown (or with `/security [folder]`); nothing is run for them. Worst first under each heading: the severity, what, which resource or `path:line`, and what was seen (`min_tls_version = "TLS1_0"`).

| Key | |
|---|---|
| `↵` or `l` | What it is, where (and, for the plan's, what the plan does to the resource and where it is declared), what was seen, why it matters and what to set |
| `t` | Copy the line it is on, or where its resource is declared, for Splice |
| `y` | Copy where it is (`path:line`, or the resource's address) |

| Rule | Severity | Terraform | Bicep / ARM |
|---|---|---|---|
| Storage: public blobs, plain HTTP | high | `azurerm_storage_account` `allow_nested_items_to_be_public = true`, `https_traffic_only_enabled = false` | `Microsoft.Storage/storageAccounts` `allowBlobPublicAccess: true`, `supportsHttpsTrafficOnly: false` |
| Storage: TLS older than 1.2; open to every network | medium; low | `min_tls_version`; `public_network_access_enabled` without `network_rules` denying (or an `azurerm_storage_account_network_rules`) | `minimumTlsVersion`; `publicNetworkAccess` without `networkAcls` denying |
| NSG: inbound Allow from `*`, `Internet` or `0.0.0.0/0` to 22, 3389, 1433, 3306, 5432, 6379 or 27017; to every port | high; critical | `azurerm_network_security_rule`, `azurerm_network_security_group`'s `security_rule` | `Microsoft.Network/networkSecurityGroups` `securityRules`, `…/securityRules` |
| App Service and Function apps: plain HTTP; TLS older than 1.2, FTP allowed, remote debugging | high; medium | `azurerm_linux_web_app`, `azurerm_windows_web_app`, the function apps and slots: `https_only`, `site_config` `minimum_tls_version`, `ftps_state = "AllAllowed"`, `remote_debugging_enabled` | `Microsoft.Web/sites` (and slots) `httpsOnly`, `siteConfig` |
| SQL: a firewall rule 0.0.0.0–255.255.255.255; public network access | critical; low | `azurerm_mssql_firewall_rule` (and PostgreSQL's, MySQL's); `azurerm_mssql_server` `public_network_access_enabled` | `Microsoft.Sql/servers/firewallRules`; `publicNetworkAccess` |
| Key Vault: no purge protection; network ACLs default Allow | medium; low | `azurerm_key_vault` | `Microsoft.KeyVault/vaults` |
| Redis: the non-TLS port; TLS older than 1.2 | high; medium | `azurerm_redis_cache` | `Microsoft.Cache/Redis` |
| Container registry: anonymous pull; the admin user | high; medium | `azurerm_container_registry` | `Microsoft.ContainerRegistry/registries` |
| AWS: a public S3 ACL, a public access block with a flag off or none for a bucket, a security group open to SSH or RDP (every port: critical), a public database | high | `aws_s3_bucket(_acl)`, `aws_s3_bucket_public_access_block`, `aws_security_group(_rule)`, `aws_vpc_security_group_ingress_rule`, `aws_db_instance` | |
| AWS: database storage not encrypted | medium | `aws_db_instance`, `aws_rds_cluster` `storage_encrypted = false` | |
| A password written into the code | high | `administrator_login_password = "…"`, a `variable` named like a secret with a default, a `.tfvars` value | a property, or a parameter's default; a `.bicepparam` value |
| A secret parameter without `@secure()` | medium | | `param adminPassword string` |

The kit's secret rules (keys, tokens, connection strings) read the same files. A password found is shown cut to its first characters, never whole. A line saying `chart-ignore` (or `bilge-ignore`), or the line above it, is left alone; so is a file saying `chart-ignore-file` near its top. `securityIgnore` in the settings leaves out a rule (`"app-ftp"`) or one rule on one thing (`"app-ftp:azurerm_linux_web_app.api"`, `"iac-plain-password:env/dev.tfvars"`). `↵` on a change says what was found in it too, and `/report` has a Security section.

## Slash commands

`/plan`, `/drift`, `/state`, `/init`, `/whatif`, `/apply`, `/deploy`, `/open`, `/show <address>`, `/graph [folder]` (what depends on what from `terraform graph`, for a plan that came without its configuration), `/report` (the plan as Markdown: what is destroyed called out, a row per change, each change's attributes in a folded `diff` block, what it would deploy insecurely, the drift; `alt+y` copies it), `/security [folder]` (the folder's source files read for the Security view), `/tool [terraform|tofu]`, `/currency [code]`, `/env [name]`, `/move <folder>`, `/take`, `/run`, `/last`, `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

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

A check also says what the plan would deploy insecurely (`Security: 1 critical · 2 high`, and `security`'s counts in `--json`), without failing for it; that is `chart security`'s:

```
chart security [folder|plan.json|whatif.json] [--plan] [--source folder] [--tofu] [--fail-on critical|high|medium|low|none] [--json] [--sarif [file.sarif]]
```

A folder's `.tf`, `.tfvars`, `.bicep` and `.bicepparam` files are read as they are: nothing is run and no credentials are needed, so it fits a pull request's first step. `--plan` plans the folder too (as `chart check` does) and adds what the plan would deploy; a plan or what-if file (`terraform show -json plan.tfplan > plan.json`, `az deployment group what-if --no-pretty-print -o json > whatif.json`) is read instead, `--source` adding a folder's files. A finding both have is said once, with the file's line. It prints each finding with what to set, and exits `1` when one is as bad as `--fail-on` (`high` by default), `0` otherwise, `2` when it couldn't run. `--json` prints the fleet's security JSON (`app`, `check`, `counts`, `findings`, never what was seen); `--sarif` SARIF 2.1.0 for GitHub's or Azure DevOps' code scanning, to the file named (ending `.sarif`; the findings are printed too) or alone to the output. A plan's finding is about a resource rather than a line, so in SARIF it points at the repository's root with the resource's address in its message.

```yaml
- run: ./chart security infra --sarif chart.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: chart.sarif }
```

## The family

A plan and a drift found go to the family's activity log, so `/timeline` in the others shows when the infrastructure was about to change; Plot's mood (worried while a plan destroys something or something drifted) goes to the others' mascots. `t` hands Splice a `file` context (the line a resource is declared on, for its blame); `s` hands Locker a `site` context (an App Service app or slot). Chart takes no sibling's context yet. The `familyMoods` setting turns the moods and the activity log off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, which is copied when you let go. `/mouse off` leaves the mouse to the terminal.

## Settings

`~/.chart/config.json` (`CHART_HOME` moves it): `theme`, `accent`, `mouse`, `terraform` (`terraform` or `tofu`), `currency` (USD unless set), `costs` (`false` never asks for prices), `securityIgnore` (the security findings left out, above), `whatIf` (the last what-if's file, group or location and parameters), `checkForUpdates`, `autoUpdate`, `familyMoods`. `,` or `/settings` shows them.

## Updates

The downloaded executable looks for a newer `chart-v…` release once a day and installs it in the background (`/update` does it now); inside Fleet, Fleet updates as one.

## Not yet

Applying a plan opened from a file, or a refresh-only one (on purpose: Chart applies only what it planned and showed; `terraform apply` is there for the rest); Pulumi and CloudFormation; telling drift apart in a what-if; what depends on what inside a module a plan only calls, or between what-if resources other than a child under its parent.
