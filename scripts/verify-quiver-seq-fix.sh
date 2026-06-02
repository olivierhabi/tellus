#!/usr/bin/env bash
# scripts/verify-quiver-seq-fix.sh — verify the Quiver OT seq-allocation fix.
#
# Bug: when an analysis row's `current_version` drifts below MAX(seq) in
# quiver_instruction_log, submitting an addCard+placeCardOnCanvas batch
# re-issued an existing seq → PK(rid,seq) 23505 → aborted transaction →
# Tellus:Quiver:Internal (HTTP 500). The user hit this when clicking "Add
# objects" on the demo analysis (whose current_version was 2 vs 23 log rows).
#
# Fix: src/services/quiver/ot/otService.ts allocates new seqs from
# MAX(serverVersion, MAX(seq)), so the batch commits and current_version
# self-heals.
#
# This runs the focused integration regression test, which:
#   - seeds an instruction log to MAX(seq)=3,
#   - corrupts current_version DOWN to 1,
#   - submits addCard(OBJECT_SET,apiName)+placeCardOnCanvas,
#   - asserts HTTP 200 (not 500) and current_version re-syncs to MAX(seq)=5.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
SPEC="tests/quiver/integration/b3-instructions-route-integration.test.ts"
echo "[verify] running OT seq-allocation regression in $SPEC"
npx vitest run "$SPEC" -t "regression: current_version drifted"
echo "[verify] PASS — add-card batch survives current_version/MAX(seq) drift"
