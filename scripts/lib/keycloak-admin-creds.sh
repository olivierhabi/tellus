#!/usr/bin/env bash
# ============================================================================
# scripts/lib/keycloak-admin-creds.sh — master-realm admin credentials
# (SOURCED, never executed directly).
#
# Resolution precedence: the environment (KC_ADMIN_USER / KC_ADMIN_PASS)
# first, then the repo-root .env (which holds the rotated
# KEYCLOAK_ADMIN_PASSWORD — the vendor default admin/admin was a full-IdP-
# takeover vector and is forbidden). Fail-closed: aborts the calling script
# when the password cannot be resolved, rather than authenticating against
# the wrong account with a misleading downstream error.
#
# Usage: source this file, then use $KC_ADMIN_USER / $KC_ADMIN_PASS.
# ============================================================================

: "${KC_ADMIN_USER:=admin}"
if [ -z "${KC_ADMIN_PASS:-}" ]; then
  _kc_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _kc_repo_root="$(cd "$_kc_lib_dir/../.." && pwd)"
  KC_ADMIN_PASS="$(grep -m1 '^KEYCLOAK_ADMIN_PASSWORD=' "$_kc_repo_root/.env" 2>/dev/null | cut -d= -f2- || true)"
  unset _kc_lib_dir _kc_repo_root
fi
: "${KC_ADMIN_PASS:?KC_ADMIN_PASS must be set (env or repo-root .env) — the master admin password was rotated off the vendor default 'admin'}"
export KC_ADMIN_USER KC_ADMIN_PASS
