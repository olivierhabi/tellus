# Rollback Register

Per Appendix I.2. Each change has: rollback mechanism, feature flag (if any), last rehearsal date. Rehearsals due every 90 days.

| Change | Rollback | Feature flag | Last rehearsed |
|---|---|---|---|
| F-P3-12 link_edit.branch_id | migration 040 down | (none) | not yet |
| F-P3-13 branch read filter | code feature flag `BRANCH_FILTER_ENFORCED` | yes | not yet |
| F-P3-14 merge rewrite | idempotent replay + prior image redeploy | `BRANCH_MERGE_V2` | not yet |
| F-P5-03 OS index rename | alias retained; old index read-only | `OS_PER_TENANT_INDEX` | not yet |
| F-P4-23/24/25 secrets | Vault rotation; code rollback trivial | (none) | not yet |
| F-P4-12 Redis rate limiter | backend flag `RATE_LIMIT_BACKEND=memory` | yes | tested unit-level |
| F-P3-11 audit hash chain | `ENFORCE_AUDIT_HASH_CHAIN=0` + migration 036 down | yes | not yet |
| Fastify per-route port | Ingress weight split | yes | not yet |

**Rehearsal procedure:** staging failover drill; rollback executed; services remain green; timings within RTO.
