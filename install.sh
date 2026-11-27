#!/bin/sh
# Installs the `turnout` command (macOS, Linux). Two ways:
#   One line, nothing else needed (downloads the tagged release into ~/.local/share/turnout):
#     curl -fsSL https://raw.githubusercontent.com/tharunkumardeveloper/turnout/main/install.sh | sh
#   From a checkout:
#     sh install.sh
# Either way: a link at ~/.local/bin/turnout. Undo: turnout uninstall.
set -eu
RELEASE=v1.0.11 # the tagged release a one-line install downloads
REPO=tharunkumardeveloper/turnout
dest="${TURNOUT_BIN_DIR:-$HOME/.local/bin}"
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then G=$(printf '\033[32m'); B=$(printf '\033[1m'); Y=$(printf '\033[33m'); Z=$(printf '\033[0m'); else G=; B=; Y=; Z=; fi

# From a checkout: use it. Piped (curl | sh): $0 is the shell, not this file, so download the release.
here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/bin/turnout" ] && [ -f "$here/install.sh" ]; then
  root=$here
else
  base="${TURNOUT_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/turnout}"
  root="$base/$RELEASE"
  if [ ! -f "$root/bin/turnout" ]; then
    echo "Downloading Turnout $RELEASE from github.com/$REPO ..."
    # The release's own archive (GitHub counts its downloads), else the tag's source archive: the same files.
    asset="https://github.com/$REPO/releases/download/$RELEASE/turnout-$RELEASE.tar.gz"
    source="https://github.com/$REPO/archive/refs/tags/$RELEASE.tar.gz"
    mkdir -p "$base"
    tmp=$(mktemp -d)
    fetch() {
      if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$tmp/t.tar.gz"
      elif command -v wget >/dev/null 2>&1; then wget -qO "$tmp/t.tar.gz" "$1"
      else echo "Turnout: curl or wget is needed to download it." >&2; exit 1; fi
    }
    if [ -n "${TURNOUT_DOWNLOAD_URL:-}" ]; then fetch "$TURNOUT_DOWNLOAD_URL" # override: tests, mirrors
    else fetch "$asset" 2>/dev/null || fetch "$source"; fi
    tar -xzf "$tmp/t.tar.gz" -C "$tmp"
    rm -rf "$root"
    mv "$tmp"/turnout-*/ "$root"
    rm -rf "$tmp"
  fi
fi

mkdir -p "$dest"
chmod +x "$root/bin/turnout"
ln -sf "$root/bin/turnout" "$dest/turnout"

echo ""
echo "${G}${B}Turnout is installed${Z} ($root)."
echo "You need Docker running (Docker Desktop on macOS), with about 4 GB of memory for it."
echo ""
case ":$PATH:" in
  *":$dest:"*)
    echo "${B}Start it now:${Z}"
    echo "  turnout demo                                    the demo shop and the guided demo"
    echo "  turnout compare localhost:3001 localhost:3002   two versions of your own site"
    ;;
  *)
    echo "${B}Start it now, in this terminal:${Z}"
    echo "  $dest/turnout demo"
    echo "${Y}To type just ${B}turnout${Z}${Y}:${Z} add $dest to your PATH, in ~/.profile (or ~/.zshrc), then open a new terminal:"
    echo "  export PATH=\"$dest:\$PATH\""
    ;;
esac
echo "Every command: turnout help.  Remove it all: turnout uninstall."
