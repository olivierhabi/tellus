#!/usr/bin/env bash
# verify-mfa-options-counter.sh
# ---------------------------------------------------------------------------
# Regression test for the passkey-MFA "Start over from the sign-in screen"
# bug. Proves at the service layer that /login/mfa/webauthn-options no longer
# burns an MFA attempt-counter slot (it now uses read-only peekMfaChallenge),
# while /login/mfa (verify) still increments + caps at MFA_MAX_ATTEMPTS.
#
# See scripts/verify-mfa-options-counter.ts for the full root-cause writeup.
#
# Prerequisites: dev Postgres on localhost:5432, database tellus_db (the same
# DB the backend on :3000 uses). No server/Keycloak/WebAuthn ceremony needed.
#
# Usage: ./scripts/verify-mfa-options-counter.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "✗ npx not found on PATH" >&2
  exit 1
fi

# npx tsx exits non-zero if any assertion fails (process.exitCode=1).
npx tsx scripts/verify-mfa-options-counter.ts
