#!/bin/sh
# Server-mode housekeeping for the always-on demo (compose.server.yml, service flagsmith-housekeeping), run in
# Flagsmith's own image so it uses Flagsmith's own code (deploy/housekeeping.py: its models' delete()).
# Only while the autopilot runs: with it off, Turnout is in normal use and nothing is removed. Every 10 minutes it
# keeps the 10 most recent experiments per flag and removes older ones that are completed and have a Turnout decision
# snapshot, with their rollout segments. Measured: 140 experiments made the environment document 141 segments, built
# in 3-40 s on a 2-vCPU VM and fetched by each proxy every 5 s.
set -eu
log() { echo "$(date -u +%FT%TZ) $*"; }
if [ "${AUTOPILOT:-}" != on ]; then log "housekeeping off (only for the autopilot demo: TURNOUT_AUTOPILOT=on)"; exec sleep infinity; fi
cd /app
while :; do
  ids=$(ls /snapshots 2>/dev/null | sed -n 's/^experiment-\([0-9]*\)-.*/\1/p' | sort -un | tr '\n' ',')
  log "$(SNAPSHOTTED="$ids" python manage.py shell < /housekeeping.py 2>&1 | tail -1)"
  [ "${ONCE:-}" = 1 ] && exit 0
  sleep "${EVERY_SECONDS:-600}"
done
