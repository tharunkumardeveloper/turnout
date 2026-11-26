#!/bin/sh
# ===========================================================================================================
#  Turnover setup (macOS and Linux): checks everything the demo needs and offers to install what's missing.
#
#    sh setup.sh            check, and ask before installing anything
#    sh setup.sh --check    check only: install nothing, change nothing (exit code 1 if something is missing)
#    sh setup.sh --yes      check, and install what's missing without asking
#
#  Needed to run the demo:        Docker (Docker Desktop on macOS, Docker Engine on Linux), Docker Compose 2.20+,
#                                 about 8 GB of RAM for Docker, free ports 8000, 8080, 8090 and 8091.
#  Needed only for development:   Node.js 24+ and npm (tests and typecheck), Git.
#
#  macOS installs with Homebrew. On Linux it prints the exact command (apt, dnf or Docker's official script) and,
#  unless --check, asks before running anything with sudo (--yes runs it).
# ===========================================================================================================
cd "$(dirname "$0")" || exit 1

MODE=ask
case "${1:-}" in
  --check|-c|/check) MODE=check ;;
  --yes|-y|/yes) MODE=yes ;;
  -h|--help|/?) echo "Usage: sh setup.sh [--check | --yes]"
                echo "  --check  check only, install nothing"
                echo "  --yes    install missing tools without asking (Homebrew on macOS; sudo commands on Linux)"
                exit 0 ;;
  "") ;;
  *) echo "Unknown option \"$1\". Usage: sh setup.sh [--check | --yes]"; exit 1 ;;
esac

MISSING=0
WARNINGS=0
INSTALLED_SOMETHING=
OS=$(uname -s)

ok()   { echo "   [ OK ] $1"; }
warn() { echo "   [WARN] $1"; WARNINGS=$((WARNINGS + 1)); }
miss() { echo "   [MISS] $1"; MISSING=$((MISSING + 1)); }
note() { echo "          $1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ask "<question>": yes in --yes mode, no in --check mode, otherwise asks (default no).
ask() {
  [ "$MODE" = yes ] && return 0
  [ "$MODE" = check ] && return 1
  printf '          %s [y/N] ' "$1"
  read -r answer || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# The Linux package manager, for the commands we print.
PKG=
if [ "$OS" = Linux ]; then
  if have apt-get; then PKG=apt; elif have dnf; then PKG=dnf; elif have yum; then PKG=yum; fi
fi

# offer "<name>" "<brew args>" "<linux command>": install with Homebrew on macOS; on Linux print the command and
# run it only if the user agrees (it uses sudo).
offer() {
  [ "$MODE" = check ] && return 0
  if [ "$OS" = Darwin ]; then
    if ! have brew; then
      note "Homebrew isn't installed: install $1 by hand, or install Homebrew first:"
      note '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
      return 0
    fi
    if ask "Install $1 now with Homebrew (brew install $2)?"; then
      echo "          Installing $1 ..."
      # shellcheck disable=SC2086
      if brew install $2; then INSTALLED_SOMETHING=1; echo "          Installed $1."; else note "brew couldn't install $1: install it by hand."; fi
    fi
  else
    if [ -z "$3" ]; then
      note "Install $1 with your distribution's package manager."
      return 0
    fi
    note "To install $1:  $3"
    if ask "Run that now (it uses sudo)?"; then
      if sh -c "$3"; then INSTALLED_SOMETHING=1; echo "          Installed $1."; else note "That didn't work: install $1 by hand."; fi
    fi
  fi
}

echo
echo " Turnover setup"
echo " ================"
echo " Folder: $(pwd)"
[ "$MODE" = check ] && echo " Mode: check only, nothing will be installed or changed"
echo

# ---- Docker CLI ------------------------------------------------------------------------------------------
echo "[1/8] Docker"
case "$PKG" in
  apt|dnf|yum) DOCKER_LINUX='curl -fsSL https://get.docker.com | sudo sh && sudo systemctl enable --now docker' ;;
  *) DOCKER_LINUX='' ;;
esac
if ! have docker; then
  if [ "$OS" = Darwin ]; then miss "Docker Desktop is not installed"; else miss "Docker is not installed"; fi
  offer "Docker Desktop" "--cask docker-desktop" "$DOCKER_LINUX"
fi
if have docker; then ok "$(docker --version 2>/dev/null)"; DOCKER_OK=1; else DOCKER_OK=; fi

# ---- Docker engine running -------------------------------------------------------------------------------
echo "[2/8] Docker engine"
ENGINE_OK=
if [ -z "$DOCKER_OK" ]; then
  miss "skipped: Docker is not installed"
elif docker info >/dev/null 2>&1; then
  ok "Docker engine is running"; ENGINE_OK=1
elif docker info 2>&1 | grep -qi "permission denied"; then
  miss "Docker is running, but this user may not use it"
  note "Fix: sudo usermod -aG docker \"\$USER\"   then log out and back in"
elif [ "$MODE" = check ]; then
  miss "Docker is installed but not running"
elif [ "$OS" = Darwin ]; then
  echo "          Starting Docker Desktop (this can take a minute)..."
  open -a Docker >/dev/null 2>&1 || true
  i=0
  while [ $i -lt 60 ]; do
    if docker info >/dev/null 2>&1; then ENGINE_OK=1; break; fi
    sleep 3; i=$((i + 1))
  done
  if [ -n "$ENGINE_OK" ]; then ok "Docker engine is running"
  else miss "Docker Desktop didn't start within 3 minutes: open it and accept any prompts, then run sh setup.sh again"; fi
else
  note "To start it:  sudo systemctl start docker"
  if ask "Run that now (it uses sudo)?" && sudo systemctl start docker && docker info >/dev/null 2>&1; then
    ok "Docker engine is running"; ENGINE_OK=1
  else
    miss "Docker engine is not running: sudo systemctl start docker"
  fi
fi

# ---- Docker Compose 2.20+ (compose.yaml uses "include") --------------------------------------------------
echo "[3/8] Docker Compose"
if [ -z "$DOCKER_OK" ]; then
  miss "skipped: Docker is not installed"
else
  CV=$(docker compose version --short 2>/dev/null | sed 's/^v//')
  if [ -z "$CV" ]; then
    miss "docker compose is not available"
    case "$PKG" in
      apt) note "Fix: sudo apt-get install -y docker-compose-plugin" ;;
      dnf|yum) note "Fix: sudo $PKG install -y docker-compose-plugin" ;;
      *) note "Fix: update Docker Desktop" ;;
    esac
  else
    CMAJ=$(echo "$CV" | cut -d. -f1); CMIN=$(echo "$CV" | cut -d. -f2)
    if [ "${CMAJ:-0}" -gt 2 ] 2>/dev/null || { [ "${CMAJ:-0}" -eq 2 ] && [ "${CMIN:-0}" -ge 20 ]; } 2>/dev/null; then
      ok "Docker Compose $CV"
    else
      miss "Docker Compose $CV is too old: 2.20 or newer is needed. Update Docker (Desktop, or the docker-compose-plugin package)."
    fi
  fi
fi

# ---- Memory ----------------------------------------------------------------------------------------------
echo "[4/8] Memory"
# What Docker's containers can use (on macOS, Docker Desktop's VM); else the machine's memory.
BYTES=
WHAT="of RAM"
if [ -n "$ENGINE_OK" ]; then BYTES=$(docker info --format '{{.MemTotal}}' 2>/dev/null); WHAT="of memory for Docker"; fi
if [ -z "$BYTES" ] || [ "$BYTES" = 0 ]; then
  WHAT="of RAM"
  if [ "$OS" = Darwin ]; then BYTES=$(sysctl -n hw.memsize 2>/dev/null)
  elif [ -r /proc/meminfo ]; then BYTES=$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo); fi
fi
if [ -z "$BYTES" ]; then
  warn "could not read the amount of memory"
else
  GB=$(awk -v b="$BYTES" 'BEGIN { printf "%d", b / 1073741824 + 0.5 }')
  # Docker Desktop reports a little under its setting (8 GB shows as about 7.7), hence 7.
  if [ "$GB" -lt 7 ]; then
    warn "$GB GB $WHAT: Flagsmith, Postgres and the demo want about 8 GB. It may be slow."
    [ "$OS" = Darwin ] && note "Docker Desktop: Settings > Resources > Memory"
  else
    ok "$GB GB $WHAT"
  fi
fi

# ---- Ports -----------------------------------------------------------------------------------------------
echo "[5/8] Ports 8000 (Flagsmith), 8080 (shop), 8090 and 8091 (console)"
DOCKER_PORTS=
[ -n "$ENGINE_OK" ] && DOCKER_PORTS=$(docker ps --format '{{.Ports}}' 2>/dev/null)
for p in 8000 8080 8090 8091; do
  if echo "$DOCKER_PORTS" | grep -q ":$p->"; then
    ok "port $p is used by Docker (Turnover may already be running)"
    continue
  fi
  # Another user's process (root's, say) is invisible to lsof and ss without sudo; a connect test still sees it.
  # Only a "(LISTEN)" row with a numeric PID counts: BusyBox's lsof (Alpine) ignores the options and lists every
  # open file.
  USER_OF=
  if have lsof; then
    USER_OF=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk '/\(LISTEN\)/ && $2 ~ /^[0-9]+$/ { print $1 " (PID " $2 ")"; exit }')
  fi
  if [ -z "$USER_OF" ] && have ss; then
    USER_OF=$(ss -ltnpH "sport = :$p" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)",pid=\([0-9]*\).*/\1 (PID \2)/p' | head -n 1)
  fi
  if [ -z "$USER_OF" ] && have nc && nc -z 127.0.0.1 "$p" >/dev/null 2>&1; then USER_OF="another program"; fi
  if [ -z "$USER_OF" ]; then
    ok "port $p is free"
  elif echo "$USER_OF" | grep -qiE "docker|com\.docke|vpnkit|rootlessk"; then
    ok "port $p is used by Docker (Turnover may already be running)"
  else
    warn "port $p is used by $USER_OF: stop it, or the demo can't start"
  fi
done

# ---- Configuration ---------------------------------------------------------------------------------------
echo "[6/8] Configuration"
if [ -d .env ]; then
  miss ".env is a folder (Docker creates one when the file is missing). Delete it (rm -r .env) and run sh setup.sh again."
elif [ -f .env ]; then
  ok ".env exists"
elif [ "$MODE" = check ]; then
  warn ".env is missing; turnover.sh creates it from .env.example"
else
  cp .env.example .env && ok "created .env from .env.example"
fi
[ -f turnover.config.yml ] || miss "turnover.config.yml is missing: is this the Turnover folder?"
[ -f compose.yaml ] || miss "compose.yaml is missing: is this the Turnover folder?"
# On Linux the console and the CLI run as TURNOVER_UID:TURNOVER_GID (default 1000:1000, the image's node user)
# so they can write .turnover/ and .env. turnover.sh sets them to this user; .env covers plain `docker compose`.
if [ "$OS" = Linux ]; then
  MY_IDS="$(id -u):$(id -g)"
  if [ -d .turnover ] && [ ! -w .turnover ]; then
    miss ".turnover/ isn't writable by this user. Fix: sudo chown -R $MY_IDS .turnover"
  fi
  if [ "$MY_IDS" = 1000:1000 ]; then
    ok "containers that write here run as $MY_IDS (this user)"
  elif [ -f .env ] && grep -q "^TURNOVER_UID=$(id -u)\$" .env && grep -q "^TURNOVER_GID=$(id -g)\$" .env; then
    ok "containers that write here run as $MY_IDS (TURNOVER_UID/GID in .env)"
  elif [ "$MODE" = check ] || [ ! -f .env ] || [ ! -w .env ]; then
    ok "turnover.sh runs the containers that write here as $MY_IDS"
    note "For plain docker compose, add TURNOVER_UID=$(id -u) and TURNOVER_GID=$(id -g) to .env (sh setup.sh does it)."
  else
    [ -n "$(tail -c 1 .env)" ] && echo >> .env # end the last line before appending
    for kv in "TURNOVER_UID=$(id -u)" "TURNOVER_GID=$(id -g)"; do
      k=${kv%%=*}
      if grep -q "^$k=" .env; then sed -i "s/^$k=.*/$kv/" .env; else printf '%s\n' "$kv" >> .env; fi
    done
    ok "wrote TURNOVER_UID=$(id -u) and TURNOVER_GID=$(id -g) to .env: containers that write here run as this user"
  fi
fi

# ---- Node.js 24+ and npm (development only) --------------------------------------------------------------
echo "[7/8] Node.js 24+ and npm (only for running tests; the demo runs in Docker)"
case "$PKG" in
  apt) NODE_LINUX='curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs' ;;
  dnf|yum) NODE_LINUX="curl -fsSL https://rpm.nodesource.com/setup_24.x | sudo bash - && sudo $PKG install -y nodejs" ;;
  *) NODE_LINUX='' ;;
esac
if ! have node; then
  warn "Node.js is not installed (only needed for development)"
  offer "Node.js" "node" "$NODE_LINUX"
fi
if have node; then
  NODE_VERSION=$(node -v 2>/dev/null)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)
  if [ "${NODE_MAJOR:-0}" -ge 24 ] 2>/dev/null; then
    ok "Node.js $NODE_VERSION"
    if [ -d node_modules ]; then
      ok "npm packages installed"
    elif [ "$MODE" = check ]; then
      warn "npm packages not installed: run  npm ci"
    elif ! have npm; then
      warn "npm is not installed: it comes with Node.js; reinstall Node.js"
    else
      echo "          Installing npm packages (npm ci)..."
      if npm ci --no-audit --no-fund >/dev/null 2>&1; then ok "npm packages installed"; else warn "npm ci failed: run it by hand to see why"; fi
    fi
  else
    warn "Node.js $NODE_VERSION is too old for development: 24 or newer runs the TypeScript directly"
    offer "Node.js 24+" "node" "$NODE_LINUX"
  fi
fi

# ---- Git (development only) ------------------------------------------------------------------------------
echo "[8/8] Git (only for development)"
case "$PKG" in
  apt) GIT_LINUX='sudo apt-get update && sudo apt-get install -y git' ;;
  dnf|yum) GIT_LINUX="sudo $PKG install -y git" ;;
  *) GIT_LINUX='' ;;
esac
if have git && git --version >/dev/null 2>&1; then
  ok "$(git --version)"
else
  warn "Git is not installed (only needed to clone or commit)"
  offer "Git" "git" "$GIT_LINUX"
fi

# ---- Summary ---------------------------------------------------------------------------------------------
echo
echo " ------------------------------------------------------------"
if [ "$MISSING" -gt 0 ]; then
  echo " $MISSING problem(s) to fix before the demo can run, $WARNINGS warning(s)."
  [ -n "$INSTALLED_SOMETHING" ] && echo " Something was just installed: open a NEW terminal and run sh setup.sh again."
  echo " ------------------------------------------------------------"
  exit 1
fi
echo " Ready. $WARNINGS warning(s)."
[ -n "$INSTALLED_SOMETHING" ] && echo " Something was just installed: if a command isn't found, open a NEW terminal."
echo " Next: sh turnover.sh   (starts Flagsmith, sets it up and opens judge mode)"
echo " ------------------------------------------------------------"
exit 0
