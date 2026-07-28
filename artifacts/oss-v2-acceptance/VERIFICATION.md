# OSS v2 staging-candidate verification

Verification date: 2026-07-28  
Starting release implementation: `cdda17100f484a6690a241d316ce4f6b64d04efc`  
Implementation candidate: `d733e99678c84c130fffde2513ebdf95470e51f0`  
Branch: `oss-v2-staging-candidate`  
Clean checkout: `/Users/olivierhabimana/Desktop/projects/tellus-oss-v2-clean-2b17fca`

## Verdict

`NOT READY`

Evidence-backed compatibility score: **81/100**.

The candidate materially improves exact aggregation and live generated-client
compatibility, but the required reindex acceptance, one-hour subscription soak,
15-minute/60-minute load profiles, and complete live adversarial matrix did not
pass. The score therefore remains below 95.

## Implementation scope

The implementation commit contains 18 files, 1,753 insertions, and 70
deletions relative to `cdda171`. It adds exact composite aggregation paging and
merge logic, signed durable subscription cursors, fail-closed object-type and
ontology checks, overlay identity normalization, deterministic package-manager
metadata, and the three safe repository-wide baseline fixes.

Generated SDK output, consumer projects, package-manager stores, `node_modules`,
PID files, tokens, and credentials are excluded from the implementation commit.

## Runtime gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Clean lockfile install with Corepack/pnpm 10.28.2 | PASS | `install/clean-install.txt` |
| Clean migrations, including idempotent second run | PASS | `infrastructure/clean-migrations.txt` |
| Strict TypeScript and production build | PASS | `tests/static-final.txt` |
| Lint | PASS with 342 warnings, zero errors | `tests/static-final.txt` |
| SDK 2.70 contract drift check | PASS | `tests/static-final.txt` |
| Full repository unit suite | PASS: 249 files, 3,219 passed, 3 skipped | `tests/full-repository-unit-final.txt` |
| 100,001-group exact aggregation | PASS: no missing/duplicate/mismatched groups | `aggregation/100001-groups-fresh-stack.txt` |
| OpenSearch interruption/restart | PASS: typed retryable 503, then exact recovery | `aggregation/opensearch-interruption.txt` |
| Packed isolated OSDK live execution | PASS for the APIs recorded in the transcript | `osdk/execution-transcript.txt` |
| Live subscription acknowledgment/update/resume/replay | PASS (functional acceptance only) | `osdk/execution-transcript.txt` |
| Forged page/query/branch/cursor attempts | PASS for the recorded cases | `security/adversarial-live.txt` |
| Full reindex transition/rollback/recovery | FAIL | `reindex/reindex-acceptance.txt` |
| One-hour, 100-subscription soak | FAIL: not run | No qualifying evidence |
| 15-minute and 60-minute mixed load | FAIL: not run | No qualifying evidence |
| One-minute two-node diagnostic | FAIL: 99.813% errors at concurrency 20 | `performance/mixed-load-smoke-result.json` |
| Complete live adversarial matrix | PARTIAL | `security/adversarial-live.txt` |

## Exact aggregation

The real PostgreSQL/OpenSearch fixture contained 100,001 source rows, 100,000
distinct non-null groups, and one null group. PostgreSQL was the authority.

Result:

- expected groups: 100,001
- actual groups: 100,001
- missing groups: 0
- duplicate groups: 0
- metric mismatches: 0
- additional metric mismatches: 0
- composite pages: 612
- OpenSearch requests: 613
- retried pages: 1
- runtime: 24,837 ms
- page latency p50/p95/p99: 168.91/543.06/889.50 ms
- process RSS: 194,887,680 bytes

When OpenSearch was stopped during the same exact workload, the request
returned `AggregationBackendUnavailable` with HTTP 503, `retryable=true`, and
five attempts. Following restart, the request again returned 100,001 groups
with `ACCURATE`.

## Generated client

The SDK was generated from the isolated database, installed using only its
declared dependencies, strictly compiled, packed, installed into a separate
consumer, and executed against the two isolated API nodes.

The passing transcript covers authentication, object loads, signed paging,
cross-node snapshot paging, filtering, 100,001-group exact aggregation,
temporary/referenced sets, interfaces, transaction reads, scenario reads,
combined scenario/transaction composition, validation-only actions, action
execution, batch actions, actual edits, typed error decoding, subscription
creation, update delivery, disconnect, resume, and replay.

Forward/reverse live links, cursor-expiry refresh, and authorization revocation
were not completed by this consumer and are not counted as passing.

## Production-readiness failures

1. The full reindex acceptance was blocked at the authorization boundary with
   a correct typed 403. No alias transition, rollback, interrupted reindex, or
   reads/writes-during-reindex evidence was produced.
2. The mandatory one-hour subscription soak with 100 subscriptions, two
   tenants, dependency interruptions, slow consumers, and authorization
   changes was not run.
3. The mandatory 15-minute steady-state and 60-minute soak profiles were not
   run. No Tellus SLO was established before the diagnostic, so it cannot be
   treated as an SLO test.
4. The one-minute diagnostic saturated the request path: 218,421 requests,
   3,640.35 requests/s attempted, 99.813% errors. The harness did not retain
   status distribution, so the cause cannot be conclusively classified.
5. The complete cross-tenant/property-security/media/reverse-link/inference
   adversarial matrix was not run on real infrastructure.
6. Object storage still lacks a demonstrated tenant stamp in the indexed
   fixture. Ontology isolation is fail-closed, but tenant isolation is not
   independently established for object documents.

## Score

| Area | Score |
| --- | ---: |
| Public contract fidelity | 18/20 |
| ObjectSet algebra and filters | 15/15 |
| Loading, selection, paging, snapshot, aggregation | 15/15 |
| Transaction and scenario semantics | 9/10 |
| Enterprise security and property loading | 8/15 |
| OMS, links, interfaces, and actions | 8/10 |
| OSDK external-client compatibility | 4/5 |
| Durable realtime subscriptions | 3/5 |
| Production reliability and recovery | 1/5 |
| **Total** | **81/100** |

## Rollback

The implementation commit is additive at runtime and contains no new schema
migration. Roll back application nodes to
`cdda17100f484a6690a241d316ce4f6b64d04efc`, keep migrations 138-141 applied,
and restart workers before API nodes. Do not delete RID, read-context,
subscription, or event tables. Existing signed subscription cursors may be
rejected after rollback; clients must perform a full resynchronization.
