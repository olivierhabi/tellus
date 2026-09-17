#!/usr/bin/env bash
# ============================================================================
# scripts/lib/test-auth-token.sh — harness-token resolver for the test-*
# bypasses (SOURCED, never executed directly).
#
# The X-Tellus-Test-Principal bypass is TOKEN-GATED (see
# isTestAuthTokenBound in src/utils/testAuthGate.ts): the server only binds
# the header identity when the request also carries X-Tellus-Test-Auth-Token
# matching the server process's CODE_REPOS_TEST_AUTH_TOKEN. An untokened
# header is rejected 401 — so scripts must send the token.
#
# Resolution precedence: the environment first, then the repo-root .env
# (gitignored). Fail-closed: aborts the calling script when the token
# cannot be resolved, rather than sending an untokened header that the
# server will 401 anyway (with a far less legible error).
#
# Usage (right after the script resolves its ROOT, BEFORE it defines the
# AUTH array so array expansion below sees the value):
#
#   # shellcheck disable=SC1091
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/test-auth-token.sh"
# ============================================================================

if [ -z "${CODE_REPOS_TEST_AUTH_TOKEN:-}" ]; then
  # Resolve the repo root from THIS file's location (scripts/lib), not from
  # the caller's cwd — scripts run from different directories.
  # shellcheck disable=SC2155,SC2034
  export CODE_REPOS_TEST_AUTH_TOKEN="$(
    _token_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    _token_repo_root="$(cd "$_token_lib_dir/../.." && pwd)"
    grep -m1 '^CODE_REPOS_TEST_AUTH_TOKEN=' "$_token_repo_root/.env" 2>/dev/null | cut -d= -f2- || true
  )"
fi
: "${CODE_REPOS_TEST_AUTH_TOKEN:?CODE_REPOS_TEST_AUTH_TOKEN must be set (env or repo-root .env) — the test-principal bypass is token-gated}"
