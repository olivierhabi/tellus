# OSS v2 release-candidate verification

Verified on 2026-07-28 from detached clean checkout
`/Users/olivierhabimana/Desktop/projects/tellus-oss-v2-rc`.

## Verdict

`NOT READY`

The previously reported 95/100 result is not supported by independent
production-readiness evidence. The release candidate scores **75/100** under
the unchanged scorecard.

## Release identity

- Starting commit: `67fdd9a3c1c2620576732e0b49ee994d66edb5e9`
- Release commit: `cdda17100f484a6690a241d316ce4f6b64d04efc`
- Source branch: `fixing-code-repository`
- Release diff: 58 files, 14,091 insertions, 79 deletions
- Clean verification used pnpm `10.28.2` because the repository does not pin a
  package-manager version. `corepack pnpm install --frozen-lockfile` with pnpm
  11.13.1 failed due to a lockfile configuration mismatch.

## Contract sources

Accessed 2026-07-28:

- [ObjectSet load](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/load-object-set/)
- [ObjectSet aggregate](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/aggregate-object-set/)
- [Temporary ObjectSets](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/create-temporary-object-set/)
- [Apply action](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/actions/apply-action/)
- [Paging](https://www.palantir.com/docs/foundry/api/v2/general/overview/paging/)
- [Errors](https://www.palantir.com/docs/foundry/api/v2/general/overview/errors/)
- SDK contract: `@osdk/foundry.ontologies@2.70.0`

The drift gate verified 15 ObjectSet node types, 28 search discriminators, 12
body fields, 6 query fields, 2 action modes, 3 returned-edit shapes, and a
batch maximum of 20.

## Clean-checkout gates

| Gate | Result | Evidence |
|---|---|---|
| Frozen install with pnpm 10.28.2 | PASS | `static/environment.txt` and install transcript in operator log |
| Strict TypeScript | PASS | `static/typecheck.txt` |
| Production build | PASS | `static/build.txt` |
| Lint | PASS with 342 existing warnings, 0 errors | `static/lint.txt` |
| Contract drift | PASS | `static/contract.txt` |
| Focused OSS/OSDK tests | PASS, 123/123 | `static/oss-unit.txt` |
| Full unit suite | BASELINE FAILURES ONLY: 3202 pass, 3 fail, 6 skipped | `regression/full-unit-rc.txt` |
| Fresh clean migrations | PASS | `migrations/clean-*.txt` |
| Migration idempotency | PASS | `migrations/clean-idempotency.txt` |
| Rollback of 141/140/138 | PASS | `migrations/rollback*.txt` |
| Populated upgrade and RID backfill | PASS, 10,000/10,000 unique RIDs | `migrations/populated-upgrade-*.txt` |
| Two API processes | PARTIAL: `/health` 200; `/ready` requires authentication | `runtime/multinode-health.txt` |
| Generated package install/build/pack | PASS | `osdk/generated-*.txt` |
| Separate strict consumer install/build | PASS | `osdk/consumer-*.txt` |
| Generated client execution against clean server | NOT VERIFIED | No isolated clean identity-provider acceptance harness |
| 100,000-group aggregation | FAIL | `aggregation-100k/report.json` |
| One-hour subscription soak | NOT RUN / REQUIRED GATE FAIL | No qualifying multi-worker soak harness |
| 15-minute, 60-minute, and peak load | NOT RUN / REQUIRED GATE FAIL | No qualifying clean authenticated mixed-workload harness |
| Full adversarial security integration | PARTIAL | Focused unit coverage passed; required cross-tenant/replay cases were not proven live |

## 100,000-group result

The authoritative fixture contains 100,001 source rows, 100,000 distinct
non-null values, and one null group. The release-candidate request uses an
OpenSearch `terms` aggregation with `size: 10000`.

- Returned groups: 10,000
- Excluded groups/items: 90,001
- `ALLOW_APPROXIMATE`: `APPROXIMATE`
- `REQUIRE_ACCURATE`: typed `AggregationAccuracyNotSupported`
- Tellus composite pagination: absent
- OpenSearch composite control: 102 pages, 100,001 groups, zero duplicates,
  zero missing
- 20-sample latency: p50 204.42 ms, p95 888.16 ms, p99 1,355.50 ms

This directly fails a mandatory release criterion.

## Repository-wide failures

Each failure was rerun at both the starting and release commits with the same
pnpm 10.28.2 frozen install.

1. `tests/funnel/unit/funnel-unit.test.ts`: DuckDB native module unavailable
   because pnpm's build-script policy skipped the native build. Reproduces at
   both commits; no relevant funnel files changed.
2. `fetch-abortsignal-invariant-unit.test.ts`: four unbounded fetch sites in
   `src/services/aiEngine/client.ts`. Reproduces at both commits; that file was
   not changed.
3. `code-repository/errors-unit.test.ts`: expected 36 error names, observed
   39. Reproduces at both commits; relevant code-repository files were not
   changed.

The funnel error is therefore explained and baseline-reproduced, but the
repository suite is not fully green.

## Score

| Area | Score |
|---|---:|
| Public contract fidelity | 18/20 |
| ObjectSet algebra and filters | 15/15 |
| Loading, selection, paging, snapshot, aggregation | 11/15 |
| Transaction and scenario semantics | 7/10 |
| Enterprise security and property loading | 10/15 |
| OMS, links, interfaces, and actions | 8/10 |
| OSDK external-client compatibility | 3/5 |
| Durable realtime subscriptions | 2/5 |
| Production reliability and recovery | 1/5 |
| **Total** | **75/100** |

## Conformance classification

- ObjectSet schema/compiler/filter contract: `PASS`
- Focused paging/snapshot/token unit behavior: `PASS`
- Fresh and populated migrations: `PASS`
- OSDK package independence and strict compilation: `PASS`
- OSDK clean live execution: `PARTIAL`
- 100,000-group exact/composite behavior: `FAIL`
- Transaction/scenario clean live isolation: `PARTIAL`
- Enterprise property-security clean live matrix: `PARTIAL`
- Durable subscription implementation: `PARTIAL`
- One-hour subscription soak: `FAIL`
- Extended mixed-workload performance: `FAIL`
- Multi-node health: `PARTIAL`
- Full adversarial security integration: `PARTIAL`
- Proprietary Foundry implementation equivalence: `NOT PUBLICLY VERIFIABLE`

## Rollback

1. Stop new v2 traffic and subscription creation; drain action and event
   workers.
2. Back up PostgreSQL, Redis durable state, and OpenSearch indices.
3. Deploy the prior application commit/image
   `67fdd9a3c1c2620576732e0b49ee994d66edb5e9`.
4. If schema rollback is required, apply down migrations in order:
   `141_oss_v2_enterprise_contexts.down.sql`,
   `140_object_rid_lookup.down.sql`, then `138_object_rids.down.sql`.
5. Rebuild the previous OpenSearch mapping/index and verify v1 reads/actions
   before reopening traffic.

The down migrations remove context, subscription, event, audit, embedding, RID
lookup, and object-RID data. They are destructive and require a verified
backup.

## Deployment and monitoring

Do not deploy this candidate to production. A subsequent staging candidate
should use at least two API nodes, dedicated restart-safe subscription workers,
PostgreSQL HA, Redis HA, a three-node OpenSearch cluster, and isolated
identity/worker dependencies. Monitor API and dependency readiness, OpenSearch
rejections/heap, PostgreSQL connections and replication lag, Redis memory,
event backlog, subscription replay lag, unauthorized-event count, snapshot
age/count, indexing freshness, embedding failures, and action/outbox depth.
