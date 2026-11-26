#!/bin/sh
# Puts the `turnout` command on your PATH (macOS, Linux): a link in ~/.local/bin to bin/turnout in this checkout.
# Run it from the checkout: sh install.sh. Undo: rm ~/.local/bin/turnout
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dest="${TURNOUT_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$dest"
chmod +x "$here/bin/turnout"
ln -sf "$here/bin/turnout" "$dest/turnout"
echo "Installed: $dest/turnout -> $here/bin/turnout"
case ":$PATH:" in
  *":$dest:"*) echo "Try it: cd your-project && turnout compare localhost:3001 localhost:3002" ;;
  *)
    echo "$dest isn't on your PATH yet. Add this line to ~/.profile (or ~/.zshrc), then open a new terminal:"
    echo "  export PATH=\"$dest:\$PATH\""
    ;;
esac
command -v docker >/dev/null 2>&1 || echo "Docker isn't installed yet: https://docs.docker.com/get-docker/ (Turnout runs in it)."
