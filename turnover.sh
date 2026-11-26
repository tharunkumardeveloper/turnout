#!/bin/sh
# ===========================================================================================================
#  Turnover (macOS and Linux): start everything and open judge mode. (Set TURNOVER_NO_BROWSER=1 to skip opening
#  the browser.)
#
#    sh turnover.sh            start Flagsmith, set it up (first run), start Turnover and the shop, check the
#                                setup, open judge mode
#    sh turnover.sh demo       the same, then send 1,500 simulated visitors through the proxy
#    sh turnover.sh status     show what's running, check the setup, and the links
#    sh turnover.sh stop       stop every container (Flagsmith's data and the keys are kept)
#    sh turnover.sh reset      wipe Flagsmith's data, the ledger and the keys, then start from scratch
#    sh turnover.sh reset --yes   the same without asking (for scripts and tests)
#    sh turnover.sh server <hostname>   server mode: write TURNOVER_MODE=server and the hostname into .env,
#                                generate Flagsmith's secrets, then start behind Caddy with HTTPS on that hostname.
#                                Every command after that adds -f compose.server.yml (docs/SETUP.md, "Running on a server")
#
#  First time on this machine? Run sh setup.sh first: it checks and installs what's needed.
# ===========================================================================================================
cd "$(dirname "$0")" || exit 1
HERE=$(pwd)

ACTION=${1:-start}
OPTION=${2:-}
usage() {
  echo "Usage: sh turnover.sh [start | demo | status | stop | reset [--yes] | server <hostname>]"
  echo "  start   (default) start everything, check the setup and open judge mode"
  echo "  demo    start, then send 1,500 simulated visitors"
  echo "  status  show what's running, check the setup, and the links"
  echo "  stop    stop every container; data and keys are kept"
  echo "  reset   wipe Flagsmith's data, the ledger and the keys, then start fresh (--yes: don't ask)"
  echo "  server  server mode on <hostname>: HTTPS through Caddy, read-only judge view at https://<hostname>/judge"
}
case "$ACTION" in
  start|demo|status|stop|reset|server) ;;
  -h|--help|/?) usage; exit 0 ;;
  *) echo "Unknown option \"$ACTION\"."; usage; echo; echo " Not started."; exit 1 ;;
esac
ASSUME_YES=
SERVER_HOST=
case "$ACTION:$OPTION" in
  server:-*|server:/*) echo "Unknown option \"$OPTION\" for server: give the hostname, e.g. sh turnover.sh server turnover.example.com"; usage; echo; echo " Not started."; exit 1 ;;
  server:*) SERVER_HOST=$OPTION ;;
  *:) ;;
  reset:--yes|reset:-y|reset:/yes) ASSUME_YES=1 ;;
  *) echo "Unknown option \"$OPTION\" for $ACTION."; usage; echo; echo " Not started."; exit 1 ;;
esac
if [ $# -gt 2 ]; then echo "Too many options."; usage; echo; echo " Not started."; exit 1; fi

failed() {
  echo
  echo " Not started."
  exit 1
}

# On Linux the console and the one-off CLI write .turnover/ (and the CLI .env) through bind mounts: Compose runs
# them as TURNOVER_UID:TURNOVER_GID (default 1000, the image's node user), so make that this user.
if [ "$(uname -s)" = Linux ]; then
  TURNOVER_UID=${TURNOVER_UID:-$(id -u)}
  TURNOVER_GID=${TURNOVER_GID:-$(id -g)}
  export TURNOVER_UID TURNOVER_GID
fi
# ---- Mode: TURNOVER_MODE in .env. local (default) is the stack as it always was; server adds compose.server.yml
# (Caddy, HTTPS, restart policies, random Flagsmith secrets) to every compose command. Same experiment logic either way.
env_get() {
  sed -n "s/^$1=//p" .env 2>/dev/null | head -n 1
}
# Set NAME=VALUE in .env (replacing the line, or adding it). Values are never echoed.
env_set() {
  if grep -q "^$1=" .env 2>/dev/null; then
    tmp=".env.tmp.$$"
    awk -v k="$1" -v v="$2" 'BEGIN { p = k "=" } index($0, p) == 1 { print p v; next } { print }' .env > "$tmp" && cat "$tmp" > .env
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
random_secret() {
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
}
MODE=local
COMPOSE_FILES=
pick_mode() {
  case "$(env_get TURNOVER_MODE)" in
    server) MODE=server; COMPOSE_FILES="-f compose.yaml -f compose.server.yml" ;;
    *) MODE=local; COMPOSE_FILES= ;;
  esac
}
pick_mode
dc() {
  # shellcheck disable=SC2086 # COMPOSE_FILES is a list of flags
  docker compose $COMPOSE_FILES "$@"
}
cli() {
  dc run --rm "$@"
}

# The hostname for links on this machine: 127.0.0.1 (Compose publishes there; "localhost" can try IPv6 first), or
# localhost when .env's shop URL uses it, so judge mode and its Shop tab share a hostname and the shop keeps its cookies.
HOST=127.0.0.1
pick_host() {
  case "$(sed -n 's/^TURNOVER_PUBLIC_SHOP_URL=//p' .env 2>/dev/null | head -n 1)" in
    http://localhost:*|http://localhost/*|http://localhost) HOST=localhost ;;
    *) HOST=127.0.0.1 ;;
  esac
}

ADMIN_EMAIL=
links() {
  ADMIN_EMAIL=$(sed -n 's/^FLAGSMITH_ADMIN_EMAIL=//p' .env 2>/dev/null | head -n 1)
  if [ "$MODE" = server ]; then
    SH=$(env_get TURNOVER_HOSTNAME)
    echo
    echo " ------------------------------------------------------------"
    echo "  Server mode on $SH"
    echo "  Shop         https://$SH/          (through Turnover)"
    echo "  Judge view   https://$SH/judge     (read-only, for anyone)"
    echo "  Console, Flagsmith and the full judge mode stay on this server's 127.0.0.1. From your machine:"
    echo "    ssh -L 8090:127.0.0.1:8090 -L 8000:127.0.0.1:8000 <you>@$SH"
    echo "    then http://127.0.0.1:8090/judge and http://127.0.0.1:8000"
    [ -n "$ADMIN_EMAIL" ] && echo "  Flagsmith login $ADMIN_EMAIL, password in .env (FLAGSMITH_ADMIN_PASSWORD)"
    echo " ------------------------------------------------------------"
    echo "  Stop:   sh turnover.sh stop        Status:   sh turnover.sh status"
    echo " ------------------------------------------------------------"
    echo
    return 0
  fi
  echo
  echo " ------------------------------------------------------------"
  echo "  Judge mode   http://$HOST:8090/judge   (the whole story, with buttons)"
  echo "  Setup check  http://$HOST:8090/setup   (is everything in place?)"
  echo "  Console      http://$HOST:8090"
  echo "  Shop         http://$HOST:8080          (through Turnover)"
  echo "  Flagsmith    http://$HOST:8000"
  [ -n "$ADMIN_EMAIL" ] && echo "               login $ADMIN_EMAIL, password in .env (FLAGSMITH_ADMIN_PASSWORD)"
  echo " ------------------------------------------------------------"
  echo "  Stop:   sh turnover.sh stop        Start over:   sh turnover.sh reset"
  echo " ------------------------------------------------------------"
  echo
}

# turnover doctor: expected against actual for Flagsmith, the keys, the flag, metrics, proxy and shops. Non-fatal.
doctor() {
  if [ "$MODE" = server ]; then
    # Restart policies are Docker's, not visible from inside a container: read them here, hand them to doctor.
    POLICIES=$(dc ps -q | xargs docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}={{.HostConfig.RestartPolicy.Name}}' 2>/dev/null | tr '\n' ',')
    if ! cli -e TURNOVER_RESTART_POLICIES="$POLICIES" cli doctor; then
      echo " Some checks above are failing (FAIL)."
    fi
    return 0
  fi
  if ! cli cli doctor; then
    echo " Some checks above are failing (FAIL). The same list, with Expected and Actual: http://$HOST:8090/setup"
  fi
}

open_browser() {
  [ -n "${TURNOVER_NO_BROWSER:-}" ] && return 0
  [ "$MODE" = server ] && return 0 # a server has no one at its screen
  echo " Opening judge mode in your browser..."
  if [ "$(uname -s)" = Darwin ]; then
    open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  else
    echo " (no xdg-open: open $1 yourself)"
  fi
}

echo
echo " Turnover"
echo " =========="

# ---- Docker must be installed and running -----------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo " Docker isn't installed. Run sh setup.sh first."
  failed
fi
if ! docker info >/dev/null 2>&1; then
  if docker info 2>&1 | grep -qi "permission denied"; then
    echo " This user may not use Docker. Fix: sudo usermod -aG docker \"\$USER\", log out and back in. Or run sh setup.sh."
    failed
  fi
  if [ "$(uname -s)" = Darwin ] && open -a Docker >/dev/null 2>&1; then
    echo " Starting Docker Desktop (this can take a minute)..."
    i=0
    until docker info >/dev/null 2>&1; do
      i=$((i + 1))
      if [ $i -gt 60 ]; then
        echo " Docker Desktop didn't start within 3 minutes. Open it, accept any prompts, then run sh turnover.sh again."
        failed
      fi
      sleep 3
    done
    echo " Docker is running."
  else
    echo " Docker isn't running. Start it (Linux: sudo systemctl start docker), then run sh turnover.sh again."
    failed
  fi
fi

start() {
  # ---- Everything else setup.sh checks (Compose version, files, ports) ------------------------------------
  if ! sh "$HERE/setup.sh" --check >/dev/null 2>&1; then
    echo " Something the demo needs is missing. Run sh setup.sh to see what, and to fix it."
    failed
  fi
  if [ -d .env ]; then
    echo " .env is a folder (Docker creates one when the file is missing). Delete it (rm -r .env) and run sh turnover.sh again."
    failed
  fi
  if [ ! -f .env ]; then
    cp .env.example .env
    echo " Created .env from .env.example"
  fi
  mkdir -p .turnover # before Docker creates it, owned by root, for the bind mount
  if [ ! -w .turnover ] || [ ! -w .env ]; then
    echo " .turnover/ or .env isn't writable by this user, and the console and the CLI run as this user."
    echo " Fix: sudo chown -R \"\$(id -u):\$(id -g)\" .turnover .env   then run sh turnover.sh again."
    failed
  fi
  pick_host
  pick_mode
  if [ "$MODE" = server ]; then
    echo
    echo " Server mode: $(env_get TURNOVER_HOSTNAME) (compose.yaml + compose.server.yml)"
    # Placeholder Flagsmith secrets or tokens: refuse before anything public starts. Names only, never values.
    if ! cli --build --no-deps cli server-check; then
      echo " Fix the settings above in .env (sh turnover.sh server <hostname> writes random Flagsmith secrets)."
      failed
    fi
  fi

  echo
  echo " [1/5] Starting Flagsmith (the first run downloads its images: a few minutes)..."
  if ! dc up -d --wait flagsmith; then
    echo " Flagsmith didn't become healthy. Logs:  docker compose $COMPOSE_FILES logs flagsmith"
    failed
  fi

  echo
  echo " [2/5] Setting up Flagsmith (admin, keys, event store, flag, metrics, first experiment)..."
  echo "       Safe to repeat: on an instance that's already set up, it only checks."
  if ! cli --build cli init; then
    echo " init failed: see the message above."
    echo " If this Flagsmith already has users, put an Organisation API key in .env as TURNOVER_ADMIN_KEY."
    failed
  fi

  if [ "$MODE" = server ] && ! cli --no-deps cli server-check --after-init; then
    echo " init left a token empty or a placeholder: see above. Not starting the public side."
    failed
  fi

  echo
  echo " [3/5] Starting Turnover, the console and the three shop releases..."
  [ "$MODE" = server ] && echo "       and Caddy (HTTPS for $(env_get TURNOVER_HOSTNAME); the first certificate can take a minute)"
  if ! dc up -d --build --wait; then
    echo " Something didn't start. See:  docker compose $COMPOSE_FILES ps   and   docker compose $COMPOSE_FILES logs"
    failed
  fi

  if [ "$ACTION" = demo ]; then
    echo
    echo " [3b] Sending 1,500 simulated visitors through the proxy (labelled simulation)..."
    cli cli demo --visitors 1500
  fi

  echo
  echo " [4/5] Checking that everything is in place (turnover doctor)..."
  doctor

  echo
  echo " [5/5] Ready."
  links
  open_browser "http://$HOST:8090/judge"
  exit 0
}

case "$ACTION" in
  status)
    pick_host
    echo
    dc ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
    echo
    # The setup check mounts .env and .turnover/: without them Docker would create both, .env as a folder.
    if [ -f .env ] && [ -d .turnover ]; then
      doctor
    else
      echo " Not set up yet: run sh turnover.sh first (it creates .env and .turnover/). Setup check skipped."
    fi
    links
    exit 0
    ;;
  stop)
    echo
    echo " Stopping every container. Flagsmith's data, the keys in .env and the ledger are kept."
    dc --profile tools down
    echo " Stopped. Run sh turnover.sh to bring it back."
    exit 0
    ;;
  reset)
    echo
    echo " This wipes Flagsmith's database (flags, experiments, results), the release ledger and the decision snapshots."
    echo " A new admin and new keys are created on the next start. Your .env file stays, and its keys get replaced."
    if [ -n "$ASSUME_YES" ]; then
      echo " --yes: wiping without asking."
    else
      printf ' Wipe everything and start from scratch? [y/N] '
      read -r answer || answer=
      case "$answer" in
        y|Y|yes|YES) ;;
        *) echo " Nothing changed."; exit 0 ;;
      esac
    fi
    if ! dc --profile tools down -v; then
      echo " Docker could not remove the containers and volumes: nothing deleted (the ledger and snapshots are kept)."
      echo
      echo " Not reset."
      exit 1
    fi
    rm -rf .turnover
    echo " Wiped. Starting from scratch..."
    start
    ;;
  server)
    # Server mode: hostname and mode into .env, random Flagsmith secrets where there are none, then the usual start.
    if [ -d .env ]; then echo " .env is a folder. Delete it (rm -r .env) and run again."; failed; fi
    [ -f .env ] || { cp .env.example .env; echo " Created .env from .env.example"; }
    if [ -z "$SERVER_HOST" ]; then
      SERVER_HOST=$(env_get TURNOVER_HOSTNAME)
      [ -n "$SERVER_HOST" ] || { echo " Give the hostname: sh turnover.sh server turnover.example.com"; failed; }
    fi
    env_set TURNOVER_MODE server
    env_set TURNOVER_HOSTNAME "$SERVER_HOST"
    env_set TURNOVER_PUBLISH_HOST 127.0.0.1
    env_set TURNOVER_PUBLIC_SHOP_URL "https://$SERVER_HOST"
    # localhost (a trial, CI) gets Caddy's own CA; a real hostname a public certificate.
    if [ "$SERVER_HOST" = localhost ] && [ -z "$(env_get TURNOVER_CADDY_TLS)" ]; then env_set TURNOVER_CADDY_TLS "tls internal"; fi
    # Only where empty: Postgres keeps the password it was created with, so an existing one is never replaced.
    for name in FLAGSMITH_DJANGO_SECRET_KEY FLAGSMITH_WAREHOUSE_SECRET POSTGRES_PASSWORD; do
      if [ -z "$(env_get "$name")" ]; then env_set "$name" "$(random_secret)"; echo " Wrote a random $name to .env"; fi
    done
    echo " .env: TURNOVER_MODE=server, TURNOVER_HOSTNAME=$SERVER_HOST. From now on every command adds compose.server.yml."
    pick_mode
    start
    ;;
  *) start ;;
esac
