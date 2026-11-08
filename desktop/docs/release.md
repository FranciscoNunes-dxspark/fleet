# Signing and updates: what to provide

The Desktop workflow (`.github/workflows/desktop.yml`) builds the installers on Linux, Windows and macOS on every change to `desktop/`. Signing, notarisation and the updater are all wired in, and each switches on by itself once its secrets exist (repository Settings › Secrets and variables › Actions). Until then the build is unsigned and has no updater, and nothing fails for want of them. `scripts/ci-config.mjs` decides, and the build's log says what it had: "This build has the updater, Windows signing, …".

## Windows: code signing

Without a signature, SmartScreen warns "Windows protected your PC" before the installer runs.

| Secret | What |
|---|---|
| `WINDOWS_CERTIFICATE` | The code-signing certificate as a `.pfx`, base64-encoded (`base64 -w0 cert.pfx`). |
| `WINDOWS_CERTIFICATE_PASSWORD` | Its password. |

Get one from a certificate authority (DigiCert, Sectigo, SSL.com …). An EV certificate is trusted by SmartScreen at once; an OV certificate builds its reputation over the first downloads. Most EV certificates now live on a hardware token or in a cloud HSM and can't be exported as a `.pfx`. For those, Azure Trusted Signing (about $10 a month) is the simplest route from CI. It replaces the import step with its own `signCommand`, a small change to the workflow. The timestamp server is DigiCert's unless `WINDOWS_TIMESTAMP_URL` is set.

## macOS: signing and notarisation

Without them, Gatekeeper refuses to open the app unless it's right-clicked and opened.

| Secret | What |
|---|---|
| `APPLE_CERTIFICATE` | A "Developer ID Application" certificate exported from Keychain as a `.p12`, base64-encoded. |
| `APPLE_CERTIFICATE_PASSWORD` | The `.p12`'s password. |
| `APPLE_SIGNING_IDENTITY` | Its name, e.g. `Developer ID Application: dxspark (TEAMID)`. |
| `APPLE_ID` | The Apple ID that notarises. |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com). |
| `APPLE_TEAM_ID` | The team's ID. |

All of these need the Apple Developer Program ($99 a year).

## Updates

The window looks for a newer version 10 seconds after it opens, only when the build was given the updater's key and an address. A newer version shows as a toast. A click downloads it, checks its signature against the key built into the window, and installs it. Fleet's own apps come with it, since they're bundled inside.

| Secret or variable | What |
|---|---|
| `TAURI_UPDATER_PUBKEY` (secret) | The public key, built into every window. |
| `TAURI_SIGNING_PRIVATE_KEY` (secret) | The private key that signs each update. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (secret) | Its password, if it has one. |
| `FLEET_UPDATE_URL` (variable) | Where the window asks, e.g. `https://updates.example.com/fleet/{{target}}/{{arch}}/{{current_version}}`. |

Make the key pair once, and keep the private key safe:

```bash
npx @tauri-apps/cli@2.12.3 signer generate -w fleet-updater.key
```

**Losing the private key means the installed windows can never be updated again.** They would need reinstalling with a new key.

The address must be reachable without signing in, and this repository is private, so the windows can't read its releases. The usual choices:

- **A public releases repository** (`fleet-releases`), with a `latest.json` the workflow publishes beside the installers. This costs nothing, but makes the installers public.
- **An object store** (S3, R2, Azure Blob) with `latest.json`. Public read for that bucket only.
- **A small update server** that answers for each target and version, and can check a licence first. It fits the licence plan below.

`latest.json` is Tauri's format: the version, notes, and for each platform the installer's URL and its `.sig` (which the build now makes, beside each installer, once the private key is set). Publishing it from the workflow is the last step, once the choice is made.

I've checked this path here: an AppImage built with a throwaway key carried its `.sig`, and it started and looked for updates without trouble.
