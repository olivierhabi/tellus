#!/usr/bin/env bash
#
# verify-auth-all.sh
# ------------------
# Umbrella script that runs every Tellus auth verify-* in order, short-
# circuiting on the first failure. Used by CI and as the quick-feedback
# loop when iterating on ontology/tellus-auth.md Phase 1.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "=== bootstrap-keycloak ==="
bash "$HERE/bootstrap-keycloak.sh"
echo
echo "=== verify-auth-realm (Task 1) ==="
bash "$HERE/verify-auth-realm.sh"
echo
echo "=== verify-saml-cert-expiry (Task 2) ==="
bash "$HERE/verify-saml-cert-expiry.sh"
echo
echo "=== verify-auth-oauth (Task 4) ==="
bash "$HERE/verify-auth-oauth.sh"
echo
echo "=== verify-auth-mfa (Task 5) ==="
bash "$HERE/verify-auth-mfa.sh"
echo
echo "=== verify-auth-jwt (Task 3) — REQUIRES tellus server running ==="
bash "$HERE/verify-auth-jwt.sh"
echo
echo "=== verify-auth-pat (Task 9) — REQUIRES tellus server running ==="
bash "$HERE/verify-auth-pat.sh"
echo
printf '\033[0;32m✓\033[0m all Phase 1 auth checks passed\n'
