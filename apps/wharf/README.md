# Wharf

<img src="assets/logo.svg" alt="Bark, the Wharf seal" width="96" align="right">

Containers and pods in the terminal. Wharf shows what Docker is running (a compose project's containers together under its name), their CPU and memory, live logs, and lets you start, stop, restart and remove them from the keyboard. A Pods tab does the same for a Kubernetes cluster.

It talks to Docker and `kubectl` through their command lines, so whatever they are set to (a docker context, `DOCKER_HOST`, kubectl's current context) is what Wharf shows. Quitting leaves everything as it was.

```
wharf            # the containers on this machine
wharf --demo     # a made-up Docker, to look around: nothing is touched
wharf security   # how the containers run, judged, for a pipeline (see Security)
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command (`!docker compose ps`).

Wharf is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/wharf`), or download the executable from the releases.

## Views

`1` Containers · `2` Images · `3` Pods · `4` Log (what Wharf has run). `tab` goes round.

### Containers

Every container, a compose project's under its name, the standalone ones last, the running ones first. For the running ones: CPU and memory (when the terminal is wide enough). Green is running, yellow starting, paused or restarting, red unhealthy or exited with an error, grey stopped. A `!` after a name is the security check's (see Security): red for something critical or high, yellow for medium; the panel's corner counts the containers at risk.

| Key | |
|---|---|
| `↵` or `l` | Its log, following it |
| `e` | A shell inside it (see Shells) |
| `s` | Stop it, or start it |
| `r` | Restart it |
| `x` | Remove it (asks first; a running one is stopped) |
| `i` | Everything `docker inspect` says |
| `o` | Open its first published port in the browser |
| `p` | Pause it, or let it run again |
| `a` | Only the running ones, or all of them |
| `v` | Hand Bilge its image to scan for known vulnerabilities (see The family) |
| `alt+s` | How it runs, judged for security (see Security) |
| `y` | Copy its id |

### The log

`↵` opens a container's log over the view, coloured (errors red, warnings yellow) with Docker's timestamp cut to the time. It follows the end until you scroll up; `f` follows again.

| Key | |
|---|---|
| `j` `k` `space` `g` `alt+g` | Scroll |
| `/` or `ctrl+f` | Search: matches light up as you type, `↵` stops typing, `n` `N` go from match to match (from the newest), `esc` clears it |
| `f` | Follow, or stay where you are |
| `e` | Only the lines that read as trouble |
| `y` `alt+y` | Copy what is on screen, or all of it |
| `esc` | Close |

### Images

| Key | |
|---|---|
| `x` | Remove it (asks first; one a container uses asks again to force it) |
| `p` | Remove the images nothing uses |
| `v` | Hand it to Bilge to scan for known vulnerabilities |
| `y` | Copy its id |

### Pods

The cluster `kubectl` is set to, a namespace's pods together under its name, the ones that are not well first. Read only while the tab is on screen, so Wharf works without `kubectl`. CPU and memory show when the cluster has a metrics server. Green is running and ready, yellow starting, terminating or not all containers ready, red crash-looping, failing to pull or killed, grey completed.

| Key | |
|---|---|
| `↵` or `l` | Its log (every container of it), following it, with the same search |
| `c` | One container's log (it asks which, when the pod has several) |
| `e` | A shell inside it (it asks which container, when the pod has several; see Shells) |
| `x` | Delete it (asks first); its controller starts another |
| `r` | Restart the deployment it belongs to, pod by pod (asks first) |
| `w` | Follow its deployment's rollout (see Rollouts) |
| `i` | `kubectl describe`, events included |
| `y` | Copy its name |

`/namespace <name>` lists one namespace (`all` lists every one; it is remembered), `/context <name>` switches the cluster (asks first: it changes `kubectl` itself, in every terminal), `/describe` and `/delete-pod` take a pod.

### Rollouts

`w` on a pod, or `/rollout <deployment>` (a name, `namespace/name`, or one of its pods), follows a deployment's rollout over the view, reading it again every 2 seconds: how many of the desired replicas are updated, ready and available, the old ones still running, the new ReplicaSet's pods, and their problems as they happen (a crash loop, an image that can't be pulled, a failed readiness or liveness probe, from the pods and their warning events). It ends done, or says so when it has stalled (past the deployment's `progressDeadlineSeconds`) or is failing (a new pod waits on something it won't get over by itself); either way the activity lines keep what it ended with.

| Key | |
|---|---|
| `u` | Undo it: `kubectl rollout undo`, back to the previous revision (asks first), and follow that |
| `l` | The log of the newest pod with a problem, else of the first new pod |
| `esc` | Close |

`/rollout restart <pod>` restarts a pod's deployment (as `r`), `/rollout undo <deployment>` undoes one (asks first).

### Shells

`e` on a running container or pod opens a shell inside it: bash where the image has it, else sh
(`docker exec -it <id> sh -c 'command -v bash >/dev/null && exec bash || exec sh'`, or `kubectl exec
-it -n <namespace> <pod> -c <container> -- …`). Wharf steps aside and gives the shell the terminal;
`exit` (or `ctrl+d`) brings you back.

Inside Fleet there is no terminal to hand over, so the shell runs without one (`-i` only) in a pane:
its output scrolls above, and a line typed below is sent with `↵`. There's no prompt, no colours and
nothing full-screen (vim, top, less), and programs see no terminal. `↑` `↓` go through the lines sent,
`pgup` `pgdn` scroll, `ctrl+c` clears the line, on an empty one sends ^C (which most programs ignore
without a terminal) and, pressed again within 2 seconds, stops the shell; `esc` or `ctrl+d` closes it.
Once the shell has ended, `↵` starts another. `/shell <container|pod> [container]` does the same from
the prompt. `--demo` has a pretend shell.

### Security

How containers run, judged for what would let one hurt its host or leak: read from one `docker inspect` of every container (Podman's inspect works the same), or from a compose file's services before they run. What an image holds, its packages and its Dockerfile, is Bilge's (`v`); this is how it is run.

| Severity | Found |
|---|---|
| critical | Privileged (`--privileged`, `privileged: true`); the Docker, Podman or containerd socket mounted (worse read-write) |
| high | `SYS_ADMIN`, `NET_ADMIN`, `ALL` (and `SYS_PTRACE`, `SYS_MODULE`, `DAC_READ_SEARCH`) added; seccomp or AppArmor unconfined; the host's pid, network or ipc; the host's own folders (`/`, `/etc`, `/root`, `/var/run`, `/proc`, `/sys` …) mounted writable; a database, cache, queue or admin port (3306, 5432, 6379, 27017, 9200, 2375, 15672 …) published on every interface |
| medium | Runs as root (no user, `0` or `root`; in a compose file only an explicit `user: root`, as without one it's the image's); a variable named like a secret (`*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*KEY*`) with a value written out, not `${…}` |
| low | A writable root filesystem; no memory or process limit; other ports on every interface; an image on `latest` or without a tag, or not pinned to a digest |

`/security` checks every container and lists the findings over the view, worst first; `/security <container>` (or `alt+s` on one) checks one, `/security <project>` the compose files its labels name, `/security <path>` any compose file (a path from where Wharf runs, its findings with their lines). A secret is never shown whole: its value is cut to its first characters.

| Key | |
|---|---|
| `↵` or `l` | The finding: what was seen, why it matters and the fix, which names the `docker run` flag and the compose key |
| `y` | Copy it |
| `r` | Check again |
| `esc` | Close (in a finding, back to the list) |

The list's markers come from the same check, run quietly whenever the containers are others than last time.

Without the screen, for a pipeline:

```
wharf security [--compose file]... [--fail-on critical|high|medium|low|none] [--json]
```

checks every container, or with `--compose` (`-f`, as often as needed) the compose files named and nothing else (Docker isn't asked). It prints the findings and their fixes, and exits 1 when one is as bad as `--fail-on` (high by default), 0 when none is, 2 when it couldn't run. `--json` prints the fleet's shape (`app`, `check`, `target`, `at`, `counts`, `findings`, each with `rule`, `severity`, `title`, `where`, `line`, `why`, `fix`), without the excerpts. `"securityIgnore"` in the settings leaves out a rule (`"root"`) or a rule on one thing (`"public-port:mailpit"`), here and in the app.

## Slash commands

`/start`, `/stop`, `/restart`, `/kill` take a container, a compose project's name, or `all`; stopping, killing or restarting several asks first. `/up` and `/down` run `docker compose up -d` or `down` for a project, where its files are (`/down` asks first; volumes are kept). `/exec <container> <command>` runs one command inside a running container with no terminal, so nothing interactive. `/shell <name> [container]` opens a shell in a running container or pod (see Shells). `/pause` and `/unpause` take a container. `/rm` removes (asks). `/logs`, `/inspect`, `/open` take a container. `/scan <container|image>` hands Bilge an image (as `v`). `/security [container|project|compose file]` checks how containers run (see Security). `/pull <image>`, `/rmi <image>` (asks), `/prune [containers|images]` (asks). `/run <command>` is `!`. `/last` shows the last command's whole output. `/refresh` reads Docker again now (it does every few seconds). `/env [name]` says or switches the project's environment (see Environments). `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

A name can be a prefix when it's unambiguous, an id, or `project/service`.

## Environments

A project can name its environments (dev, staging, prod) once for every app of the family, in `.fleet/project.json` at its root (or a folder above where Wharf runs, inside the checkout), a section per app for each; nothing secret goes in it. Wharf reads its own section of the one chosen:

```json
"prod": { "prod": true, "wharf": { "context": "aks-prod", "namespace": "shop" } }
```

`context` sends every `kubectl` Wharf runs there with `--context` (kubectl's own current context, which every terminal shares, is left alone, and `/context` says so rather than switching), and `namespace` is what the Pods view lists. `/env` says which environment the project is on, `/env <name>` switches every app to another, and a switch made elsewhere is followed here within a second. The top line shows its name; a production one (`"prod": true`) draws the frames red, and stopping, killing, restarting, removing, taking down, pruning, deleting a pod, restarting a deployment and undoing a rollout all ask first.

While Fleet records a runbook, each slash command Wharf's prompt runs (and each `/take`) is kept for it; a `!` shell command never is.

## The family

Wharf is one of the family's apps that hand each other what is under their cursor, as lines to paste into the other's prompt (never a secret).

- `t` in a log copies its newest line that reads as trouble for Sonar, Hail or Bosun (`/take` there finds it in their logs and requests). In Fleet, the other app opens with it in its prompt.
- `v` on a container or an image (or `/scan <name>`) copies its image (`repo:tag`, or the id of an untagged one) as a line for Bilge, which scans it for known vulnerabilities. In Fleet, Bilge opens with it.
- `/take <line>` takes a log line a sibling copied: it is looked for in the last 1000 lines of every running container (and the pods the Pods tab has read), and the first log that has it opens with the line searched.
- What Wharf changes (a start, a stop, a removal, a compose up or down, a pod deleted) goes in the family's activity log, so `/timeline` in the others shows it. Bark writes its mood for the others to remark on, and remarks on theirs; `"familyMoods": false` turns both off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, copied when you let go (`ctrl+c` copies it again and never quits); `ctrl+v` pastes. `/mouse off` leaves the mouse to the terminal.

## Settings

Kept in `~/.wharf/config.json` (`WHARF_HOME` moves it): `theme` (`dark`, `light`, `auto`), `kubeNamespace`, `accent` (`#rrggbb`), `familyMoods`, `mouse`, `checkForUpdates`, `autoUpdate`, `history`, `securityIgnore` (rules, or `rule:where`, the security check leaves out). `/settings` shows them.

## Updates

Once a day the downloaded executable looks for a newer `wharf-v…` release and installs it in the background; `/update` asks now. Inside Fleet, Fleet updates as a whole.

## Not yet

Acting on a pod's containers separately beyond its log and a shell (a pod is deleted and restarted as a whole). A shell inside Fleet with a real terminal: Fleet runs each app over pipes, so the shell gets lines, not keys.
