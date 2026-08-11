# D-2026-04-30-009 — Temporal worker host deferred to Phase B operational rollout

## Ambiguity

T-05 specifies a "Temporal-driven export pipeline." The spec is silent on
whether the worker **host** (the Temporal task queue, activity runtime,
heartbeat policy) ships in this engineering pass or in a follow-up
operational deploy. A literal reading would require a running Temporal
cluster and a registered worker process — neither of which are
agent-deployable artefacts.

## Options considered

1. **Stub the activity body, register a fake worker** — would deceive the
   operator that exports work end-to-end when they don't.
2. **Implement a Postgres-only "claim-loop" worker in-process** — works
   without Temporal but contradicts the spec's choice of orchestrator
   (loses retry policy, durable execution, signals/queries surface).
3. **Implement the activity body as a pure function with injectable side
   effects, defer the worker host to the operational rollout.** The
   activity runs end-to-end against an injected `streamObjectSet` /
   `uploadObject` / `getPresignedDownloadUrl` in tests; the production
   path wires it to Temporal + S3 + Quickwit at deploy time.

## Decision — option 3.

The engineering surface is the activity contract: idempotency,
snapshot-driven security, row-cap enforcement, status transitions,
metrics. That is fully tested. The host (Temporal task queue config,
worker registration, retry policy) is one runbook step + one CI workflow
file once Temporal is provisioned. Spec §T-05 5B.3 enumerates the values
that the host must use (`EXPORT_WORKFLOW_TIMEOUT_MS`,
`EXPORT_WORKFLOW_RETRIES`, exponential 1s→4s→16s) — those constants are
already defined in `src/services/exports/exportConstants.ts:50-71`.

## Rationale

- Production safety: an in-process claim loop running on every API replica
  would multiply the export load on Postgres and OpenSearch by the replica
  count. Deferring keeps the activity contract honest.
- Auditability: the snapshot columns (`security_context_snapshot`,
  `branch_id_snapshot`) are populated **at job-creation time** by the
  route, so the worker has everything it needs whenever the operator
  starts it. Audit chain is complete before the worker exists.
- Reversibility: migration 046 is additive only with a tested down path
  (`046_export_job_security_snapshot.down.sql`), so the schema can be
  rolled back if the Temporal rollout slips.

## What would change this decision

A spec amendment requiring the worker to ship in the same release as the
route. In that case we would still implement the activity body the same
way; the addition would be a `src/workers/temporalExportWorker.ts` entry
point that calls `executeExportActivity()` and a `k8s/temporal-worker.yaml`
deployment.

## Operational gate (recorded for FINAL_REPORT)

| Gate | Owner | Evidence required |
| --- | --- | --- |
| G-T05-1: Temporal task queue `tellus-export` provisioned | Platform SRE | `temporal --address ... task-queue describe tellus-export` returns ≥1 worker |
| G-T05-2: S3 bucket `tellus-exports` created with 7-day lifecycle | Storage SRE | `aws s3api get-bucket-lifecycle-configuration` shows the rule |
| G-T05-3: presigned URL signing key rotated and stored in Vault | Security | Vault entry `secret/tellus/export-signer` populated |
| G-T05-4: 24h soak with synthetic 1M-row export at p95 < 5min | Backend on-call | Grafana panel `tellus_export_duration_seconds{quantile="0.95"} < 300` over 24h window |

The engineering deliverable is complete. The four gates are operator
work, tracked here so they cannot be overlooked at release.
