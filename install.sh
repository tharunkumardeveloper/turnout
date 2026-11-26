#!/bin/sh
# Installs the `turnout` command (macOS, Linux): a link in ~/.local/bin to bin/turnout in this checkout, then shows
# what this machine has and how to use it. Run it from the checkout: sh install.sh. Undo: rm ~/.local/bin/turnout
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest="${TURNOUT_BIN_DIR:-$HOME/.local/bin}"
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then G=$(printf '\033[32m'); B=$(printf '\033[1m'); Y=$(printf '\033[33m'); Z=$(printf '\033[0m'); else G=; B=; Y=; Z=; fi

mkdir -p "$dest"
chmod +x "$here/bin/turnout"
ln -sf "$here/bin/turnout" "$dest/turnout"

# The logo, what's needed, and every command (the same screen as `turnout help`).
sh "$here/bin/turnout" help
echo ""
echo "${G}${B}Installed:${Z} $dest/turnout"
case ":$PATH:" in
  *":$dest:"*) echo "${B}Next:${Z} open your project's folder and run ${B}turnout compare localhost:3001 localhost:3002${Z}, or try ${B}turnout demo${Z}." ;;
  *)
    echo "${Y}One more step:${Z} $dest isn't on your PATH. Add this line to ~/.profile (or ~/.zshrc), then open a new terminal:"
    echo "  export PATH=\"$dest:\$PATH\""
    ;;
esac
