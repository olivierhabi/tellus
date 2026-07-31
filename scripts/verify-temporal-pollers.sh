#!/usr/bin/env bash
# scripts/verify-temporal-pollers.sh — FUNN-ISO-8
#
# Assert that EVERY active poller on a Temporal task queue belongs to an
# approved deployment environment. Worker identities carry the environment
# prefix (`<envId>:<buildId>:<pid>@<host>` — see
# src/config/environmentIdentity.ts), so an unexpected environment, worker
# identity, or build id is immediately visible here.
#
# This does NOT enforce "exactly one poller" — multiple replicas of the
# SAME approved deployment are expected (HA). It rejects FOREIGN
# environments only.
#
# Usage:
#   scripts/verify-temporal-pollers.sh <namespace> <task-queue> <approved-env> [more-approved-envs...]
#
# Exit:
#   0  all active pollers match an approved environment prefix
#   1  foreign/legacy poller identities found (prints offenders)
#   2  temporal unreachable / usage error
set -uo pipefail

NS="${1:-}"
QUEUE="${2:-}"
shift 2 2>/dev/null || true
if [ -z "$NS" ] || [ -z "$QUEUE" ] || [ $# -eq 0 ]; then
  echo "usage: $0 <namespace> <task-queue> <approved-env> [more-approved-envs...]" >&2
  exit 2
fi
APPROVED=("$@")

TNS=$(docker ps --format '{{.Names}}' | grep -E '^tellus-temporal(-1)?$' | head -1 || true)
if [ -z "$TNS" ]; then
  echo "ERROR: temporal container not found" >&2
  exit 2
fi

OUT=$(docker exec "$TNS" temporal task-queue describe --address temporal:7233 \
      --namespace "$NS" --task-queue "$QUEUE" 2>&1) || {
  echo "ERROR: task-queue describe failed for $NS/$QUEUE:" >&2
  echo "$OUT" >&2
  exit 2
}

# Extract poller identity tokens — the 4th field in the poller rows of the
# CLI table output ("UNVERSIONED  <type>  <identity>  <lastAccess> ...").
IDENTITIES=$(printf '%s\n' "$OUT" | awk '/UNVERSIONED/ {print $3}' | grep -E '.+@.+' | sort -u || true)

if [ -z "$IDENTITIES" ]; then
  echo "pollers($NS/$QUEUE): none active (OK — no foreign pollers)"
  exit 0
fi

BAD=()
while IFS= read -r ident; do
  ok=""
  for env_prefix in "${APPROVED[@]}"; do
    case "$ident" in
      "$env_prefix":*) ok=1; break ;;
    esac
  done
  [ -z "$ok" ] && BAD+=("$ident")
done <<< "$IDENTITIES"

count=$(printf '%s\n' "$IDENTITIES" | wc -l | tr -d ' ')
echo "pollers($NS/$QUEUE): $count active identity(ies)"
printf '%s\n' "$IDENTITIES" | sed 's/^/  /'

if [ ${#BAD[@]} -gt 0 ]; then
  echo "FAIL: foreign poller identities on $NS/$QUEUE (approved: ${APPROVED[*]}):" >&2
  printf '  %s\n' "${BAD[@]}" >&2
  echo "temporal_unexpected_poller_total +${#BAD[@]}" >&2
  exit 1
fi
echo "OK: all pollers belong to approved environments (${APPROVED[*]})"
