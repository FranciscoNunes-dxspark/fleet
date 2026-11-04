# Lookout

<img src="assets/logo.svg" alt="Peep, the Lookout meerkat" width="96" align="right">

What a browser, a mobile emulator or your own server sends and receives, in the terminal. Lookout is a local HTTP and HTTPS proxy: point a client at it and every request and response shows up as it happens, with its headers, its body (JSON and CSV as a tree or a table) and its timings. Its point is the hand-off: any request it saw becomes a request in a `.http` file, opened in [Hail](../hail) with one key (`h`), so a bug seen in the browser is reproducible straight away.

Captured traffic holds tokens and cookies, and Lookout treats it so. `Authorization`, `Cookie`, `Set-Cookie`, API keys and anything that looks like a secret (a JWT, a GitHub token, an AWS key, a password field) are hidden on screen until you ask (`s`), become variables (`{{token}}`, `{{cookie}}`) in the `.http` files it writes, and are masked in a HAR export unless you say otherwise. Nothing captured goes to the family's moods or activity log: that says only "captured 40 requests to api.example.com". It listens on `127.0.0.1` alone, and the key of its certificate authority never leaves your profile.

```
lookout                         # listen on 127.0.0.1:8888; .http files and HAR exports go in this folder
lookout ../shop --port 9000     # another folder, another port
lookout --demo                  # a made-up session, to look around: nothing listens, nothing is written
lookout security --json         # what the last session's traffic says, for Fleet's security overview
lookout security capture.har    # the same for a HAR file (a browser's DevTools export)
lookout ca                      # make the certificate authority and say how to trust it here
lookout env                     # the proxy settings, for a shell, Bosun, a browser or an emulator
```

Press `?` inside for every key and command, `/` for the commands, `!` to run a shell command in the folder.

Lookout is one of the fleet's apps: it needs Node 22 or newer from a checkout (`npm install` at the repository root, then `npm start -w apps/lookout`), or download the executable from the releases.

## Sending traffic through it

Lookout listens on `127.0.0.1:8888` when it opens (`"autoStart": false` in the settings leaves that to `/start`; `/port` and `--port` choose another). It never listens beyond this machine. The Setup view (`4`) has every line below, ready to copy:

| Client | |
|---|---|
| A process (a `.env`, a shell) | `HTTPS_PROXY=http://127.0.0.1:8888` and `HTTP_PROXY=…` (`y` in Setup copies the first). .NET's HttpClient, Python's requests, curl and Go read them; Node 24 and later do with `NODE_USE_ENV_PROXY=1`, an older Node needs a proxy agent in the code |
| What Bosun runs | `"env"` in `bosun.json` for the process or a profile: `HTTP_PROXY`, `HTTPS_PROXY`, `NODE_USE_ENV_PROXY`, and `NODE_EXTRA_CA_CERTS` while HTTPS is intercepted (`b` in Setup copies it) |
| Chrome, Edge | `--proxy-server="http://127.0.0.1:8888" --proxy-bypass-list="<-loopback>"` (the last part sends `localhost` through too) |
| Firefox | Settings, Network Settings, Manual proxy: `127.0.0.1` port `8888`, also for HTTPS |
| Android emulator | `emulator -avd <name> -http-proxy http://127.0.0.1:8888`, or its proxy setting (inside it, this machine is `10.0.2.2`) |

## HTTPS

Out of the box HTTPS passes through as a tunnel: Lookout records the host it went to, how much went each way and for how long, and nothing inside. Plain HTTP is recorded whole.

`/intercept on` (or `i` in Setup) reads HTTPS too. The first time, it asks, then makes a certificate authority of Lookout's own: an ECDSA P-256 key and a certificate, `Lookout local CA`, in `~/.lookout` (`ca.crt`, and `ca-key.pem` readable by you alone: 0600, in a 0700 folder, off Windows). From then on Lookout answers each client with a certificate for the host it asked for, signed by that authority (made the first time a host is seen and kept for the run), and forwards the request to the real server over its own TLS, checking that server's certificate as any client would. A client sees HTTPS only once it trusts the authority: the Setup view says how, for this system first (`certutil -user -addstore Root` on Windows, `security add-trusted-cert` on macOS, `update-ca-certificates` or `update-ca-trust` on Linux), then Firefox's own store, `NODE_EXTRA_CA_CERTS` for Node, curl's `--cacert`, Python's `REQUESTS_CA_BUNDLE` and the Android emulator. `lookout ca` prints the same. `http://lookout/ca.crt` through the proxy hands out the certificate (never the key).

Lookout speaks HTTP/1.1 to the client: it offers nothing else in ALPN, so a browser falls back to HTTP/1.1. A client that wants HTTP/2 alone, or that turns the certificate down (it doesn't trust the authority yet, or it pins the certificates it accepts, as banking apps, some SDKs and the browsers' own services do), shows as a red **refused** row saying why. `p` on it passes that host through untouched from then on: its traffic still flows, as a tunnel. The pass-through list is a setting (`/pass`, `/unpass`; `*.example.com` covers a domain).

The certificates are made with no dependency: Node has key generation and signing (`crypto.generateKeyPairSync`, `crypto.sign`) but no certificate builder, so Lookout writes X.509 v3 itself (`src/asn1.js`, `src/certs.js`): the authority with basicConstraints `CA:true` and keyCertSign, each host's with subjectAltName (a DNS name or an IP address), serverAuth, and the authority's key id.

## Views

`1` Requests · `2` Hosts · `3` Security · `4` Setup · `5` Log. `tab` goes round; `space` pauses recording anywhere (traffic still passes).

### Requests

Everything that passed through, oldest first, as it comes: on the last row, the cursor follows new ones. Each row has the time, the method, the status (2xx green, 3xx blue, 4xx yellow, 5xx and errors red; `tunnel`, `refused`), how it came (`http`, `tls` for HTTPS read through interception, `tun` for a tunnel, `✗` refused, `har` imported), the host, the path (secrets in the query masked), the size and how long it took.

| Key | |
|---|---|
| `↵` or `l` | The request and its response: headers, bodies (JSON laid out, gzip and brotli undone), timings (connect, waiting, receiving) |
| `h` | Write it to `lookout.http` in the folder with credentials as variables, and open it in Hail (below) |
| `t` | Copy it for Hail's `/take` (a `request` context, credentials as variables too) |
| `f` | Filter: `host:api.example.com` (that host and those under it), `status:404`, `status:4xx`, `status:error`, `status:refused`, `method:post`, and words found in the URL, headers or bodies. What's hidden isn't searchable |
| `p` | Pass its host through untouched from now on, asked first (again takes it off the list) |
| `y` | Copy its URL (secrets in it masked) |
| `e` | Export what is shown as a HAR file (`/export`) |
| `c` | Forget everything captured (asked first) |

At most 5000 exchanges are kept (the oldest go first), and of each body the first megabyte (`/maxbody`); the whole body always reaches the client.

### The detail

| Key | |
|---|---|
| `s` | Show or hide the credentials. They are hidden again whenever the detail opens |
| `d` / `r` | The response's or the request's body in the data viewer: a tree or a table (JSON, JSON lines, CSV), with a path query |
| `h` `t` `p` | As in Requests |
| `/` `n` `N` | Search |
| `y` `Y` | Copy what's on screen, or all of it (as shown: hidden stays hidden) |

### Hosts

Every host seen, busiest first: requests, errors, and how its traffic went (plain http, read, tunnelled, refused, passed through). `↵` shows its requests, `p` passes it through or intercepts it again, `y` copies its name.

### Security

What the captured traffic says about the apps that sent it, worst first, each once per place with how often it was seen; the same as `lookout security`. `↵` explains one, `y` copies where.

| Rule | | Severity |
|---|---|---|
| `token-over-http` | An `Authorization`, API key or token header sent over plain HTTP | high (medium to `localhost`) |
| `cookie-over-http` | Cookies sent over plain HTTP | high for a session's, else medium |
| `secret-in-body-over-http` | A password or token field, or a value that looks like a key, in a body over plain HTTP | high |
| `credentials-in-query` | A token, key, password or signature in a URL's query (logs, history and `Referer` keep it) | high over HTTP, medium over HTTPS |
| `cookie-not-secure` | A cookie set without `Secure` (not for `localhost`) | medium for a session's, else low |
| `cookie-not-httponly` | A session cookie set without `HttpOnly` | low |

A finding says where (the scheme, host and path, never the query) and which header, cookie or field, never its value.

### Setup

What to set so traffic goes through Lookout, and with interception on, how to trust its authority on each system. `y` copies the `HTTPS_PROXY` line, `b` Bosun's `"env"`, `c` the certificate's path, `i` turns interception on or off.

### Log

What Lookout has done, newest at the bottom; `↵` shows all of an entry.

## To Hail

`h` (or `/hail [file.http]`) writes the request under the cursor to `lookout.http` in the folder Lookout is in (`"httpFile"` in the settings for another), as Hail reads it:

```http
### POST /v1/orders
# from Lookout at 2026-11-03T09:30:01Z, where it answered 201
# fill in {{token}}, {{cookie}} (Hail's environment, http-client.private.env.json): Lookout never writes a credential down
# @name post-orders
POST https://api.shop.test/v1/orders
Content-Type: application/json
Authorization: Bearer {{token}}
Cookie: {{cookie}}

{
  "items": [{ "id": 1, "qty": 2 }]
}
```

`Authorization` keeps its scheme (`Bearer {{token}}`); a cookie header is `{{cookie}}`; another credential header is named after itself (`X-Api-Key` is `{{apiKey}}`); a secret in the query, a secret field of a JSON or form body and any value codescan's rules take for a key become a variable of their name. Connection headers (`Host`, `Content-Length`, `Accept-Encoding`…) are left to Hail. Each request gets a `@name` of its own. Then Lookout copies `/open <file>` for Hail (inside Fleet, Fleet switches to Hail and runs it), where the request is ready to send again once the variables have values.

`t` copies the same request as a `request` context instead (`/take` in Hail adds it to the open file, or replays it elsewhere and compares).

Lookout itself takes no context from its siblings: `/take` says whose one is.

## HAR

`/export [file.har]` writes the requests shown (the filter's) as HAR 1.2, `lookout-<time>.har` in the folder unless named. Credentials are masked in it: HAR files end up in tickets and chats. `/export <file> secrets` writes them as they were, after asking. `/import <file.har>` adds a HAR file's requests to the list: a browser's DevTools export, or Lookout's own.

## Without the screen

| Command | |
|---|---|
| `lookout security [capture.har]` | What the traffic says: of the HAR file given, else of the last session (the app keeps only that session's findings, in `~/.lookout/findings.json`, never the traffic). Exits 1 when a finding is as bad as `--fail-on` (high by default; `none` never fails), 2 when it couldn't run |
| `--json` | The family's security JSON (the kit's `findings.js`), which `fleet security` adds up |
| `--sarif [file]` | SARIF for GitHub's or Azure DevOps' code scanning |
| `lookout ca [--pem]` | Make the certificate authority when there is none, print its path, fingerprint and how to trust it; `--pem` prints the certificate |
| `lookout env [--port n]` | The proxy settings |

## Commands

| Command | |
|---|---|
| `/start [port]` | Listen (a port given is kept) |
| `/stop` | Stop listening; what was captured stays |
| `/pause` | Record or not (`space`) |
| `/intercept [on\|off]` | Read HTTPS, or tunnel it |
| `/ca` | The certificate authority and how to trust it |
| `/pass [host]`, `/unpass <host\|all>` | The pass-through list |
| `/filter [words…]` | What Requests shows |
| `/hail [file.http]` | The request under the cursor to a `.http` file, opened in Hail |
| `/export [file.har] [secrets]`, `/import <file.har>` | HAR |
| `/clear` | Forget what was captured |
| `/security` | The Security view |
| `/port [n]`, `/maxbody [MB]` | The port, and how much of each body is kept |
| `/move [folder]` | Where `.http` files and HAR exports go |
| `/env [name]` | The project's environment (`.fleet/project.json`), for every app |
| `/take <family:v1:…>` | Says whose a sibling's context is |
| `/run <command>`, `!` | A shell command in the folder |
| `/last`, `/settings` (`,`), `/theme`, `/accent`, `/mouse`, `/update`, `/help`, `/quit` | As in every app of the fleet |

## Settings

`~/.lookout/config.json` (`LOOKOUT_HOME` moves the whole folder): `port`, `autoStart`, `intercept`, `passThrough`, `maxBodyMb`, `httpFile`, `theme`, `accent`, `mouse`, `checkForUpdates`, `autoUpdate`, `familyMoods`. The certificate authority and the last session's findings live beside it.

## Not yet

Rules that rewrite or delay a response; HTTP/2 to the client; WebSocket frames (an upgrade passes through, recorded as its handshake); an upstream proxy of your own.

## Peep

Lookout's mascot is Peep, a meerkat standing up on its hind legs, keeping watch. It curls up while nothing listens, looks round while requests are in flight, and stares when a client refuses the certificate or the traffic gives something away. `node scripts/logo.js` draws `assets/` from `src/pet.js`.
