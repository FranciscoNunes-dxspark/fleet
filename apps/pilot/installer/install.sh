#!/bin/sh
# Installs Pilot on macOS or Linux: the newest release for this machine, checked against the
# release's SHA256SUMS.txt, into ~/.local/bin (PILOT_INSTALL_DIR to choose another folder). The
# repository is private, so it downloads through gh signed in (gh auth login), or with a token in
# GITHUB_TOKEN (or GH_TOKEN) that can read it. Run it again to update, or use `pilot update`.
#   sh pilot-install.sh            the newest release
#   sh pilot-install.sh 0.1.2      that version
set -eu

REPO="FranciscoNunes-dxspark/fleet"
DIR="${PILOT_INSTALL_DIR:-$HOME/.local/bin}"
# PILOT_INSTALL_API: another GitHub API (GitHub Enterprise, or a test).
API="${PILOT_INSTALL_API:-https://api.github.com}/repos/$REPO"

say() { printf '%s\n' "$*"; }
fail() { printf 'pilot-install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "this script is for macOS and Linux; on Windows run pilot-windows-x64-setup.exe or pilot-install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no Pilot build for $(uname -m)" ;;
esac
FILE="pilot-$os-$arch"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

# gh when it's signed in, else a token (PILOT_INSTALL_VIA=gh or =token picks one).
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
use_gh=0
if [ "${PILOT_INSTALL_VIA:-}" = gh ] || { [ "${PILOT_INSTALL_VIA:-}" != token ] && command -v gh >/dev/null 2>&1 && gh auth token >/dev/null 2>&1; }; then use_gh=1; fi
if [ "$use_gh" = 0 ] && [ -z "$token" ]; then
  fail "the repository is private: sign in with gh (gh auth login) or set GITHUB_TOKEN to a token that can read $REPO"
fi

# GitHub's REST API, signed in either way.
api() {
  if [ "$use_gh" = 1 ]; then
    gh api "repos/$REPO/${1#"$API/"}"
  else
    curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" "$1"
  fi
}

# The release: the version asked for, else the newest pilot-v… (the API lists newest first).
if [ "${1:-}" != "" ]; then
  tag="pilot-v${1#v}"
else
  tag="$(api "$API/releases?per_page=100" | tr ',{}' '\n\n\n' | sed -n 's/^ *"tag_name": *"\(pilot-v[0-9][0-9.]*\)".*/\1/p' | head -n 1)"
  [ -n "$tag" ] || fail "no Pilot release found in $REPO"
fi
release="$(api "$API/releases/tags/$tag")" || fail "no release $tag"

# Each asset's API URL, then its name: download by the URL whose name matches.
asset_url() {
  printf '%s' "$release" | tr ',{}' '\n\n\n' | awk -v want="$1" '
    /"url": *"https?:\/\/[^"]*\/releases\/assets\/[0-9]+"/ { match($0, /https?:[^"]*/); url = substr($0, RSTART, RLENGTH) }
    /"name": *"/ { match($0, /"name": *"[^"]*"/); n = substr($0, RSTART, RLENGTH); sub(/"name": *"/, "", n); sub(/"$/, "", n); if (n == want && url != "") { print url; exit } }'
}
download() {
  url="$(asset_url "$1")"
  [ -n "$url" ] || fail "$tag has no $1"
  if [ "$use_gh" = 1 ]; then
    gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/${url##*/}" > "$work/$1"
  else
    curl -fsSL -H "Authorization: Bearer $token" -H "Accept: application/octet-stream" -o "$work/$1" "$url"
  fi
}

say "Downloading $FILE from $tag…"
download "$FILE"
download SHA256SUMS.txt

want="$(grep " [ *]$FILE\$" "$work/SHA256SUMS.txt" | cut -d' ' -f1)"
[ -n "$want" ] || fail "SHA256SUMS.txt has no checksum for $FILE"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$work/$FILE" | cut -d' ' -f1)"; else got="$(shasum -a 256 "$work/$FILE" | cut -d' ' -f1)"; fi
[ "$got" = "$want" ] || fail "the download doesn't match its checksum: not installed"

mkdir -p "$DIR"
chmod 755 "$work/$FILE"
# A move, so a Pilot running from there keeps the copy it started from.
mv -f "$work/$FILE" "$DIR/pilot"
# macOS keeps a downloaded program from starting until the quarantine mark is gone.
if [ "$os" = macos ]; then xattr -d com.apple.quarantine "$DIR/pilot" 2>/dev/null || true; fi

say "Installed $("$DIR/pilot" --version 2>/dev/null || echo "${tag#pilot-v}") in $DIR/pilot."
case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    say ""
    say "$DIR isn't on your PATH. Add it (then open a new terminal):"
    case "${SHELL:-}" in
      */zsh) say "  echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.zshrc" ;;
      */fish) say "  fish_add_path $DIR" ;;
      *) say "  echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.bashrc" ;;
    esac
    ;;
esac
say ""
say "Next, in a project's folder:"
say "  pilot app                 Pilot's window: recent projects, Open a folder"
say "  pilot ui                  the UI in your browser"
say "  pilot init --mcp          connect Claude Code (the skill and the MCP server)"
