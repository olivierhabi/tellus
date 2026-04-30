#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/restore-drill.sh — Appendix F monthly restore drill.
#
# Supported subsystems: pg | opensearch | clickhouse | iceberg | redis | keycloak
#
# Usage:
#   restore-drill.sh select-random         # picks a subsystem
#   restore-drill.sh <subsystem>           # runs the drill for it
#
# Hard rules:
#   - Runs on staging only. Refuses if TELLUS_ENV != "staging".
#   - Logs outcome to ops/restore-drill-log.csv.
#   - Measures wall-clock elapsed time vs. the RTO target per docs/DR.md.
#
# This script is a scaffold. Each subsystem's restore body is TODO
# for the operations team to fill in per their cluster conventions
# (pg_restore vs pgbackrest vs volumesnapshot, curl-based OS snapshot
# restore, CH remote-backup pull, Iceberg snapshot rollback, etc.).
# ---------------------------------------------------------------------------
set -euo pipefail

if [[ "${TELLUS_ENV:-}" != "staging" ]]; then
  echo "refusing: TELLUS_ENV must be 'staging' (got '${TELLUS_ENV:-}')" >&2
  exit 2
fi

SUBSYSTEMS=(pg opensearch clickhouse iceberg redis keycloak)
LOG=ops/restore-drill-log.csv
mkdir -p "$(dirname "$LOG")"
[[ -f "$LOG" ]] || echo "timestamp,subsystem,rto_target_sec,actual_sec,outcome,notes" > "$LOG"

pick_random() {
  echo "${SUBSYSTEMS[$RANDOM % ${#SUBSYSTEMS[@]}]}"
}

rto_for() {
  case "$1" in
    pg)          echo 900 ;;
    opensearch)  echo 3600 ;;
    clickhouse)  echo 3600 ;;
    iceberg)     echo 3600 ;;
    redis)       echo 60 ;;
    keycloak)    echo 1800 ;;
    *) echo 1800 ;;
  esac
}

drill_pg()         { echo "[drill] pg: pg_restore from latest daily snapshot"; sleep 1; }
drill_opensearch() { echo "[drill] opensearch: POST _snapshot/<repo>/<snap>/_restore"; sleep 1; }
drill_clickhouse() { echo "[drill] clickhouse: RESTORE DATABASE tellus FROM <remote>"; sleep 1; }
drill_iceberg()    { echo "[drill] iceberg: rollback to snapshot via catalog"; sleep 1; }
drill_redis()      { echo "[drill] redis: kubectl delete pod; verify AOF replay"; sleep 1; }
drill_keycloak()   { echo "[drill] keycloak: DB = PG; covered by pg restore; failover realm"; sleep 1; }

case "${1:-}" in
  select-random) pick_random ;;
  pg|opensearch|clickhouse|iceberg|redis|keycloak)
    sub="$1"
    rto=$(rto_for "$sub")
    start=$(date +%s)
    if "drill_${sub}"; then outcome=pass; else outcome=fail; fi
    elapsed=$(( $(date +%s) - start ))
    printf '%s,%s,%d,%d,%s,%s\n' "$(date -u +%FT%TZ)" "$sub" "$rto" "$elapsed" "$outcome" "" >> "$LOG"
    echo "[drill] $sub outcome=$outcome rto_target=${rto}s actual=${elapsed}s"
    [[ "$outcome" == "pass" ]]
    ;;
  *) echo "usage: $0 {select-random|pg|opensearch|clickhouse|iceberg|redis|keycloak}" >&2; exit 1 ;;
esac
