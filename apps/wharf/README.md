# Wharf

<img src="assets/logo.svg" alt="Bark, the Wharf seal" width="96" align="right">

Containers and pods in the terminal. Wharf shows what Docker is running (a compose project's containers together under its name), their CPU and memory, live logs, and lets you start, stop, restart and remove them from the keyboard. A Pods tab does the same for a Kubernetes cluster.

It talks to Docker and `kubectl` through their command lines, so whatever they are set to (a docker context, `DOCKER_HOST`, kubectl's current context) is what Wharf shows. Quitting leaves everything as it was.

```
wharf            # the containers on this machine
wharf --demo     # a made-up Docker, to look around: nothing is touched
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command (`!docker compose ps`).

Wharf is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/wharf`), or download the executable from the releases.

## Views

`1` Containers · `2` Images · `3` Pods · `4` Log (what Wharf has run). `tab` goes round.

### Containers

Every container, a compose project's under its name, the standalone ones last, the running ones first. For the running ones: CPU and memory (when the terminal is wide enough). Green is running, yellow starting, paused or restarting, red unhealthy or exited with an error, grey stopped.

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
| `i` | `kubectl describe`, events included |
| `y` | Copy its name |

`/namespace <name>` lists one namespace (`all` lists every one; it is remembered), `/context <name>` switches the cluster (asks first: it changes `kubectl` itself, in every terminal), `/rollout`, `/describe` and `/delete-pod` take a pod.

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

## Slash commands

`/start`, `/stop`, `/restart`, `/kill` take a container, a compose project's name, or `all`; stopping, killing or restarting several asks first. `/up` and `/down` run `docker compose up -d` or `down` for a project, where its files are (`/down` asks first; volumes are kept). `/exec <container> <command>` runs one command inside a running container with no terminal, so nothing interactive. `/shell <name> [container]` opens a shell in a running container or pod (see Shells). `/pause` and `/unpause` take a container. `/rm` removes (asks). `/logs`, `/inspect`, `/open` take a container. `/pull <image>`, `/rmi <image>` (asks), `/prune [containers|images]` (asks). `/run <command>` is `!`. `/last` shows the last command's whole output. `/refresh` reads Docker again now (it does every few seconds). `/settings`, `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit`.

A name can be a prefix when it's unambiguous, an id, or `project/service`.

## The family

Wharf is one of the family's apps that hand each other what is under their cursor, as lines to paste into the other's prompt (never a secret).

- `t` in a log copies its newest line that reads as trouble for Sonar, Hail or Bosun (`/take` there finds it in their logs and requests). In Fleet, the other app opens with it in its prompt.
- `/take <line>` takes a log line a sibling copied: it is looked for in the last 1000 lines of every running container (and the pods the Pods tab has read), and the first log that has it opens with the line searched.
- What Wharf changes (a start, a stop, a removal, a compose up or down, a pod deleted) goes in the family's activity log, so `/timeline` in the others shows it. Bark writes its mood for the others to remark on, and remarks on theirs; `"familyMoods": false` turns both off.

## Mouse

Click a tab, a row or the prompt; double-click does `↵`; the wheel scrolls. Drag to select text, copied when you let go (`ctrl+c` copies it again and never quits); `ctrl+v` pastes. `/mouse off` leaves the mouse to the terminal.

## Settings

Kept in `~/.wharf/config.json` (`WHARF_HOME` moves it): `theme` (`dark`, `light`, `auto`), `kubeNamespace`, `accent` (`#rrggbb`), `familyMoods`, `mouse`, `checkForUpdates`, `autoUpdate`, `history`. `/settings` shows them.

## Updates

Once a day the downloaded executable looks for a newer `wharf-v…` release and installs it in the background; `/update` asks now. Inside Fleet, Fleet updates as a whole.

## Not yet

Acting on a pod's containers separately beyond its log and a shell (a pod is deleted and restarted as a whole). A shell inside Fleet with a real terminal: Fleet runs each app over pipes, so the shell gets lines, not keys.
