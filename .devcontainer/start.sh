#!/bin/sh
# Codespaces: the same steps as "sh switchyard.sh start", plus the settings a forwarded *.app.github.dev address needs.
# Runs on every start of the codespace (postStartCommand). Outside Codespaces it changes nothing in .env.
cd "$(dirname "$0")/.." || exit 1

[ -f .env ] || cp .env.example .env
mkdir -p .switchyard

# Set KEY=VALUE in .env (replace the line, or append it).
set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

if [ -n "$CODESPACE_NAME" ] && [ -n "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN" ]; then
  base="$CODESPACE_NAME-%s.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
  judge_host=$(printf "$base" 8090)
  shop_host=$(printf "$base" 8080)
  flagsmith_host=$(printf "$base" 8000)
  # The console answers a non-loopback Host only with the judge cookie (src/console/server.ts); listing the
  # forwarded hostnames lets the browser reach it there. The ports stay published on 127.0.0.1 in the codespace,
  # which is where Codespaces forwards from, so SWITCHYARD_PUBLISH_HOST is left alone.
  set_env SWITCHYARD_CONSOLE_HOSTS "$judge_host,$shop_host"
  set_env SWITCHYARD_PUBLIC_SHOP_URL "https://$shop_host"
  set_env FLAGSMITH_DASHBOARD_URL "https://$flagsmith_host"
fi

export SWITCHYARD_UID="$(id -u)" SWITCHYARD_GID="$(id -g)"

docker compose up -d --wait flagsmith || { echo "Flagsmith didn't become healthy: docker compose logs flagsmith"; exit 1; }
# init is safe to re-run; it creates SWITCHYARD_JUDGE_TOKEN the first time.
docker compose run --rm --build cli init || { echo "init failed: see the message above."; exit 1; }
docker compose up -d --build --wait || { echo "Something didn't start: docker compose ps; docker compose logs"; exit 1; }
docker compose run --rm cli doctor || true

if [ -n "$judge_host" ]; then
  token=$(sed -n 's/^SWITCHYARD_JUDGE_TOKEN=//p' .env | head -n 1)
  echo
  echo "Judge mode: https://$judge_host/judge?key=$token"
  echo "  (open this link once in your browser; the key is traded for a cookie and dropped from the address bar)"
fi
