#!/bin/sh
# ===========================================================================================================
#  Switchyard (macOS and Linux): start everything and open judge mode. (Set SWITCHYARD_NO_BROWSER=1 to skip opening
#  the browser.)
#
#    sh switchyard.sh            start Flagsmith, set it up (first run), start Switchyard and the shop, check the
#                                setup, open judge mode
#    sh switchyard.sh demo       the same, then send 1,500 simulated visitors through the proxy
#    sh switchyard.sh status     show what's running, check the setup, and the links
#    sh switchyard.sh stop       stop every container (Flagsmith's data and the keys are kept)
#    sh switchyard.sh reset      wipe Flagsmith's data, the ledger and the keys, then start from scratch
#    sh switchyard.sh reset --yes   the same without asking (for scripts and tests)
#
#  First time on this machine? Run sh setup.sh first: it checks and installs what's needed.
# ===========================================================================================================
cd "$(dirname "$0")" || exit 1
HERE=$(pwd)

ACTION=${1:-start}
OPTION=${2:-}
usage() {
  echo "Usage: sh switchyard.sh [start | demo | status | stop | reset [--yes]]"
  echo "  start   (default) start everything, check the setup and open judge mode"
  echo "  demo    start, then send 1,500 simulated visitors"
  echo "  status  show what's running, check the setup, and the links"
  echo "  stop    stop every container; data and keys are kept"
  echo "  reset   wipe Flagsmith's data, the ledger and the keys, then start fresh (--yes: don't ask)"
}
case "$ACTION" in
  start|demo|status|stop|reset) ;;
  -h|--help|/?) usage; exit 0 ;;
  *) echo "Unknown option \"$ACTION\"."; usage; echo; echo " Not started."; exit 1 ;;
esac
ASSUME_YES=
case "$ACTION:$OPTION" in
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

# On Linux the console and the one-off CLI write .switchyard/ (and the CLI .env) through bind mounts: Compose runs
# them as SWITCHYARD_UID:SWITCHYARD_GID (default 1000, the image's node user), so make that this user.
if [ "$(uname -s)" = Linux ]; then
  SWITCHYARD_UID=${SWITCHYARD_UID:-$(id -u)}
  SWITCHYARD_GID=${SWITCHYARD_GID:-$(id -g)}
  export SWITCHYARD_UID SWITCHYARD_GID
fi
cli() {
  docker compose run --rm "$@"
}

# The hostname for links on this machine: 127.0.0.1 (Compose publishes there; "localhost" can try IPv6 first), or
# localhost when .env's shop URL uses it, so judge mode and its Shop tab share a hostname and the shop keeps its cookies.
HOST=127.0.0.1
pick_host() {
  case "$(sed -n 's/^SWITCHYARD_PUBLIC_SHOP_URL=//p' .env 2>/dev/null | head -n 1)" in
    http://localhost:*|http://localhost/*|http://localhost) HOST=localhost ;;
    *) HOST=127.0.0.1 ;;
  esac
}

ADMIN_EMAIL=
links() {
  ADMIN_EMAIL=$(sed -n 's/^FLAGSMITH_ADMIN_EMAIL=//p' .env 2>/dev/null | head -n 1)
  echo
  echo " ------------------------------------------------------------"
  echo "  Judge mode   http://$HOST:8090/judge   (the whole story, with buttons)"
  echo "  Setup check  http://$HOST:8090/setup   (is everything in place?)"
  echo "  Console      http://$HOST:8090"
  echo "  Shop         http://$HOST:8080          (through Switchyard)"
  echo "  Flagsmith    http://$HOST:8000"
  [ -n "$ADMIN_EMAIL" ] && echo "               login $ADMIN_EMAIL, password in .env (FLAGSMITH_ADMIN_PASSWORD)"
  echo " ------------------------------------------------------------"
  echo "  Stop:   sh switchyard.sh stop        Start over:   sh switchyard.sh reset"
  echo " ------------------------------------------------------------"
  echo
}

# switchyard doctor: expected against actual for Flagsmith, the keys, the flag, metrics, proxy and shops. Non-fatal.
doctor() {
  if ! cli cli doctor; then
    echo " Some checks above are failing (FAIL). The same list, with Expected and Actual: http://$HOST:8090/setup"
  fi
}

open_browser() {
  [ -n "${SWITCHYARD_NO_BROWSER:-}" ] && return 0
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
echo " Switchyard"
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
        echo " Docker Desktop didn't start within 3 minutes. Open it, accept any prompts, then run sh switchyard.sh again."
        failed
      fi
      sleep 3
    done
    echo " Docker is running."
  else
    echo " Docker isn't running. Start it (Linux: sudo systemctl start docker), then run sh switchyard.sh again."
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
    echo " .env is a folder (Docker creates one when the file is missing). Delete it (rm -r .env) and run sh switchyard.sh again."
    failed
  fi
  if [ ! -f .env ]; then
    cp .env.example .env
    echo " Created .env from .env.example"
  fi
  mkdir -p .switchyard # before Docker creates it, owned by root, for the bind mount
  if [ ! -w .switchyard ] || [ ! -w .env ]; then
    echo " .switchyard/ or .env isn't writable by this user, and the console and the CLI run as this user."
    echo " Fix: sudo chown -R \"\$(id -u):\$(id -g)\" .switchyard .env   then run sh switchyard.sh again."
    failed
  fi
  pick_host

  echo
  echo " [1/5] Starting Flagsmith (the first run downloads its images: a few minutes)..."
  if ! docker compose up -d --wait flagsmith; then
    echo " Flagsmith didn't become healthy. Logs:  docker compose logs flagsmith"
    failed
  fi

  echo
  echo " [2/5] Setting up Flagsmith (admin, keys, event store, flag, metrics, first experiment)..."
  echo "       Safe to repeat: on an instance that's already set up, it only checks."
  if ! cli --build cli init; then
    echo " init failed: see the message above."
    echo " If this Flagsmith already has users, put an Organisation API key in .env as SWITCHYARD_ADMIN_KEY."
    failed
  fi

  echo
  echo " [3/5] Starting Switchyard, the console and the three shop releases..."
  if ! docker compose up -d --build --wait; then
    echo " Something didn't start. See:  docker compose ps   and   docker compose logs"
    failed
  fi

  if [ "$ACTION" = demo ]; then
    echo
    echo " [3b] Sending 1,500 simulated visitors through the proxy (labelled simulation)..."
    cli cli demo --visitors 1500
  fi

  echo
  echo " [4/5] Checking that everything is in place (switchyard doctor)..."
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
    docker compose ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
    echo
    # The setup check mounts .env and .switchyard/: without them Docker would create both, .env as a folder.
    if [ -f .env ] && [ -d .switchyard ]; then
      doctor
    else
      echo " Not set up yet: run sh switchyard.sh first (it creates .env and .switchyard/). Setup check skipped."
    fi
    links
    exit 0
    ;;
  stop)
    echo
    echo " Stopping every container. Flagsmith's data, the keys in .env and the ledger are kept."
    docker compose --profile tools down
    echo " Stopped. Run sh switchyard.sh to bring it back."
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
    if ! docker compose --profile tools down -v; then
      echo " Docker could not remove the containers and volumes: nothing deleted (the ledger and snapshots are kept)."
      echo
      echo " Not reset."
      exit 1
    fi
    rm -rf .switchyard
    echo " Wiped. Starting from scratch..."
    start
    ;;
  *) start ;;
esac
