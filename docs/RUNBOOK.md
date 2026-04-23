# Runbook

One entry per Prometheus alert. Keep updated as alerts change.

## `tellus_audit_chain_breaks_total > 0`

**Severity:** P0 regulatory incident.
**Response:** see `docs/AUDIT_CONTRACT.md §5.1`. Do NOT auto-repair. Preserve PG backup before investigation. Notify DPA within 72h.

## `tellus_audit_chain_verified_at` lags > 26h

**Severity:** P1. The daily verifier has not completed. Check Temporal scheduler; re-run `node -e "import('./dist/jobs/auditVerifier.js').then(m => m.runAuditVerification())"`.

## `tellus_action_audit_rollback_total{reason=hash_chain} > 0`

**Severity:** P1. Every affected Action returns 503. Check `audit_hash_head` singleton present, `ENFORCE_AUDIT_HASH_CHAIN=1`, migration 036 applied, PG pool not saturated.

## `tellus_cbac_deny_total{reason=missing_policy_default_deny}` > 0

**Severity:** P1. A route reached cbacMiddleware but no policy row exists. Check `action_type.allowed_principals` / `required_markings` are seeded.

## `tellus_rate_limit_failed_open_total` > 0

**Severity:** P2. Redis unreachable; rate-limiter failing open. Check Redis health. If sustained, investigate Redis connection config (`REDIS_URL`, `REDIS_CONNECT_TIMEOUT_MS`).

## `tellus_circuit_breaker_state{label=pg} == 2` (open)

**Severity:** P0. PG is unreachable. Dependency outage. Check PG health, PgBouncer sidecar, network policies.

## `tellus_link_violation_blocked_total` rapidly increasing

**Severity:** P2. Callers are hitting ONE_TO_ONE / ONE_TO_MANY constraints. Expected under legitimate workload; investigate if unexpected.

## `tellus_event_loop_lag_ms > 250`

**Severity:** P1. Event-loop is blocked on CPU work. Likely DuckDB / polars inline; Block F worker offload not yet deployed.

## `tellus_http_request_duration_seconds{route=...}` p99 > SLO

**Severity:** P1 (one route) / P0 (aggregate). Triggers SLO burn-rate alerts. See `docs/chaos/` for dependency-failure runbooks.
