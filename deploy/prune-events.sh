#!/bin/sh
# Server-mode housekeeping for the always-on demo (compose.server.yml, service event-pruner). Runs in a postgres image.
#
# Flagsmith never deletes SDK events (its docs: manage retention yourself), and the autopilot sends simulated visitors
# forever, so experimentation_sdkexperimentationevent grows without end (530,572 rows, 228 MB after 10 h on a 2-vCPU VM).
#
# Rules, so it can never touch data a decision still needs:
#   - only while the autopilot runs (TURNOUT_AUTOPILOT=on): with it off, Turnout is in normal use and nothing is deleted;
#   - an event is deleted only if it is older than RETENTION_HOURS AND older than the start of every experiment that is
#     not finished-and-snapshotted: running, paused or created experiments, and completed ones with no decision snapshot
#     in .turnout/snapshots (Turnout writes experiment-<id>-<time>.json before every Ship or Revert). Flagsmith counts an
#     experiment's events from its start, so events before that floor can't change any protected experiment's results.
#   - DRY_RUN=1 counts instead of deleting.
set -eu
HOURS="${RETENTION_HOURS:-6}"
SNAPSHOTS="${SNAPSHOT_DIR:-/snapshots}"
PSQL="psql -h ${PGHOST:-postgres} -U postgres -d flagsmith -v ON_ERROR_STOP=1 -At"
log() { echo "$(date -u +%FT%TZ) $*"; }

case "$HOURS" in *[!0-9]*|"") log "RETENTION_HOURS must be a whole number"; exit 1;; esac
if [ "${AUTOPILOT:-}" != on ] || [ "$HOURS" = 0 ]; then
  log "event pruning off (only for the autopilot demo: TURNOUT_AUTOPILOT=on and TURNOUT_EVENT_RETENTION_HOURS > 0)"
  exec sleep infinity
fi

prune_once() {
  # Experiments whose events must stay: not completed, or completed without a snapshot.
  protected=""
  for row in $($PSQL -c "select id || ':' || status from experimentation_experiment where deleted_at is null"); do
    id="${row%%:*}"; status="${row#*:}"
    if [ "$status" != completed ] || ! ls "$SNAPSHOTS"/experiment-"$id"-*.json >/dev/null 2>&1; then
      protected="$protected${protected:+,}$id"
    fi
  done
  floor="now() - interval '$HOURS hours'"
  if [ -n "$protected" ]; then
    floor="least($floor, (select min(coalesce(started_at, created_at)) from experimentation_experiment where id in ($protected)))"
  fi
  where="\"timestamp\" < $floor"
  if [ "${DRY_RUN:-}" = 1 ]; then
    log "dry run: $($PSQL -c "select count(*) from experimentation_sdkexperimentationevent where $where") events would be deleted (protected experiments: ${protected:-none})"
  else
    log "$($PSQL -c "delete from experimentation_sdkexperimentationevent where $where") events (older than $HOURS h and before every unfinished or unsnapshotted experiment; protected: ${protected:-none})"
  fi
}

while :; do
  prune_once || log "prune failed; trying again next hour"
  [ "${ONCE:-}" = 1 ] && exit 0
  sleep 3600
done
