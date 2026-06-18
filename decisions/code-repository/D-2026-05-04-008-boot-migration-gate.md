# D-2026-05-04-008 — Boot-time migration gate

## Status

Accepted — 2026-05-04.

## Context

On 2026-05-04 a `POST /api/v1/code-repositories` request returned
`500 Stemma:IdempotencyStoreUnavailable` with the underlying message
`relation "code_repos_idempotency" does not exist`. Investigation
showed:

* The table is owned by migration `051_code_repos_audit.sql:223-244`.
* The live `tellus_db.public` schema had `code_repos_audit_events`,
  `code_repos_audit_hash_head`, `code_repository`,
  `code_repository_branch_cache`, and `code_repository_saga_ledger`,
  but **not** `code_repos_idempotency`.
* The `schema_migrations_applied` ledger had no rows for `050`,
  `051`, or `053`, even though five of the six tables those
  migrations create were present.
* `src/server.ts` did not call the migration runner at boot. The
  contract was "operator runs `npm run migrate` before deploys".
* `scripts/code-repos-e2e.sh:90-100` applied 050–057 directly via
  `psql` for the e2e harness, swallowing per-file failures with
  `"already applied? continuing"` — exactly the path that produces
  partial schemas.

The runtime had no way to detect this drift; it surfaced only when
the create-repo saga's idempotency middleware tried to write to a
table that did not exist, returning `500` to a real user.

The same shape of bug already happened twice in this codebase:
mount-time auth scoping (D-2026-05-04-007) and now schema drift.
The pattern is identical — defaults that silently degrade rather
than fail loud.

## Problem framing

A 20-year-Palantir reviewer would file three observations:

1. **Apollo deploys assume schema parity at boot.** A K8s rollout
   that brings a service up against a stale schema is a deploy
   bug; the runtime must detect it and fail the rollout, not
   serve traffic in a degraded state.
2. **`scripts/code-repos-e2e.sh`'s swallowed-failure loop** is
   parallel to the production codepath. It exists for ergonomics
   but has produced partial states that production code never
   sees in CI.
3. **Dev ergonomics** still matter: `tsx src/server.ts` reload
   should not require remembering a separate `npm run migrate`
   step.

## Decision

Add a **boot-time migration gate** in
`src/db/migrationGate.ts`, called from `src/server.ts` after the
`pool.query("SELECT NOW()")` health probe and before any service
that writes to Postgres registers traffic. Three modes, selected
by `TELLUS_MIGRATION_GATE`:

| Mode | Behavior on drift | Default for | Use case |
| --- | --- | --- | --- |
| `strict` | Throw `MigrationDriftError`, log structured event, `process.exit(1)` | `NODE_ENV=production` | Apollo / K8s rollouts, prod-shaped CI |
| `auto` | Apply pending migrations in lexical order, each in its own transaction, then start | All other `NODE_ENV` | `tsx src/server.ts` dev reloads |
| `off` | Log a `migration_gate.disabled` warning and start | Never (opt-in only) | Manual recovery (operator running migrations through a different channel) |

Default selection is the same shape as the existing `autoCreate`
toggle at `src/server.ts:1105`: production is locked-down, dev is
ergonomic. Explicit `TELLUS_MIGRATION_GATE` always wins; an
invalid value throws (no silent downgrade).

Eligibility filter (`minMigrationNumber`, default 33) matches the
existing CLI runner `src/migrate.ts:1962` so the gate and the CLI
agree on which migrations they own. Files numbered ≤ 032 are
handled inline in `src/migrate.ts` via the bootstrap path and are
not gated here.

## Rationale (Decision Protocol order)

1. **Correctness.** Drift is detected before any write that would
   silently 500. The gate runs before `app.listen()`, so K8s
   readiness probes report the deploy as failed and the rollout
   stops at the first bad pod. No degraded traffic.
2. **Failure mode is loud and structured.** `MigrationDriftError`
   carries `pending: string[]`; the error logger emits a JSON
   line with `type: "migration_gate.drift"` and the full pending
   list — operator can grep for it and act.
3. **Production safety preserved.** Production never auto-applies
   schema changes. Operators run `npm run migrate` as a discrete
   deploy step (the same contract Apollo manifest deploys assume)
   and the gate enforces parity at the next pod restart. This
   matches the deploy posture of every Palantir service that
   touches Cassandra/Postgres.
4. **Dev ergonomics.** `auto` mode behaves like the long-standing
   `tsx src/server.ts` workflow most contributors expect — boot
   the file you saved, no extra step.
5. **Recovery escape hatch.** `off` lets an operator side-step
   the gate during incident response (e.g., applying a
   half-formed migration by hand without the runtime fighting
   them). It is logged at `warn`, never the default.

## Alternatives considered

### A. Always auto-apply on every boot, no `strict` mode

Rejected. Production should fail rollouts on drift, not silently
absorb schema changes mid-deploy — a migration that runs at boot
of pod #1 but silently fails at pod #2 is a fleet-wide split
brain. Deploy windows exist; the gate respects them.

### B. Detect drift but log-only (no exit)

Rejected. This is the existing `console.warn(...)` posture for
OpenSearch / MinIO at `src/server.ts:837-855`. It works for
those because they're degradation-tolerant (best-effort caches);
schema is not — a missing table is a 500, not a degradation.

### C. Run the gate inside K8s as an init-container

Reasonable for a real Apollo deployment and consistent with the
v2 spec's `product.yml` direction. Not in scope today: the
service does not yet ship as a separate migrator pod, and we
need the gate to fire in `tsx src/server.ts` dev mode anyway.
The init-container pattern is forward-compatible — once it
exists, set `TELLUS_MIGRATION_GATE=strict` in the runtime pod
and have the init-container apply.

### D. Reuse `src/migrate.ts` directly from the server

Rejected. `src/migrate.ts` is a CLI: it terminates the process
on success, calls `pool.end()`, and is wired to its own
top-level `migrate()` invocation. Importing it for runtime use
would entangle CLI semantics with the live Pool.
`src/db/migrationGate.ts` is a dependency-free library; the CLI
remains the single-purpose tool it is today. They share the
filter rule (≥ 033, forward `.sql`) by convention; if that rule
ever changes, both sites update.

## Consequences

* **Production** deploys fail-fast on schema drift. Operators
  must run `npm run migrate` as an explicit step (in CI, in a
  K8s init-container, or via Apollo manifest hook).
* **Development** boots auto-apply pending migrations. A
  contributor pulling main and running `tsx src/server.ts`
  watches the gate apply 052/054-061 and starts a clean
  service.
* **Tests** are unaffected — integration tests already create
  per-suite schemas and apply migrations explicitly via
  `ctx.applyMigration(...)`. The gate is wired in the live
  `start()` path only.
* **Operator UX** — invalid `TELLUS_MIGRATION_GATE` value
  throws at boot rather than silently downgrading. A typo like
  `TELLUS_MIGRATION_GATE=loose` is now a deploy failure, not a
  silent off-mode.

## Pinned tests

`tests/unit/code-repos/code-repository/migration-gate-unit.test.ts`
covers all 23 branches:

* `diffPending` set-difference + ordering invariants.
* `pickDefaultMode` returns `strict` ⇔ production.
* `resolveMode` priority: option > env > default; rejects
  invalid env.
* `listForwardMigrations` filters `.down.sql`, `.ts`, non-numeric
  files, and below `minN`; tolerates missing dir.
* `enforceMigrationGate` per-mode behavior: off skips ledger
  query entirely; strict-clean returns; strict-drift throws;
  auto applies in lexical order; auto-failure aborts later
  migrations.
* `MigrationDriftError.name`, `pending`, message contains the
  remediation hint (`npm run migrate`).

## Contract IDs depending on this decision

* G-C-21 (idempotency replay storage) — gate prevents the table
  from being missing at runtime.
* G-C-50..54 (audit hash chain durability) — same: the audit
  tables ship with 051; gate ensures they exist before any
  mutation tries to write a row.
* B2-C-01..09 (Code Repository CRUD) — every B2 mutation depends
  on the saga ledger, idempotency, and audit tables; the gate is
  the structural guarantee that all three exist on a live pod.

## What evidence would supersede this decision

* A successful migration of the deploy contract to a separate
  init-container or a managed schema-orchestration service
  (Liquibase / Flyway server-mode / Apollo migration hook). At
  that point the gate could be defaulted to `off` in production,
  with the init-container holding the contract instead.
* Adoption of online-schema-change tooling (gh-ost / pgroll)
  that decouples DDL from boot. The gate would then verify
  *application-compatible-schema*, not absolute parity, and the
  contract would shift accordingly.

## Follow-up work (not in this decision)

* `scripts/code-repos-e2e.sh` should run via the migrate runner
  rather than per-file `psql` with swallowed failures (tracked
  as a separate PR).
* `src/migrations/` migration files should be standardized to
  `CREATE TABLE IF NOT EXISTS` (today's mix is what permitted
  the partial 051 apply that produced the original incident).
  Tracked as a separate PR.
* CI gate: regression test that asserts `npm run migrate` on a
  brand-new database produces zero pending migrations on next
  boot. Tracked.

## Operator runbook

A pod fails to start with:

```json
{"type":"migration_gate.drift","pending":["052_b10_stemma_events.sql","054_b6_jemma.sql","..."],"message":"Migration gate (strict): 9 pending forward migration(s): 052_b10_stemma_events.sql, ... Run `npm run migrate` before starting the server, or set TELLUS_MIGRATION_GATE=auto to apply at boot."}
```

Response (in order):

1. Confirm the listed migrations are intended for this release
   (compare against the release manifest).
2. From a privileged runner, against the same DSN the pod uses:
   `npm run migrate`. Verify exit 0 and `Applied <n>` lines for
   each pending file.
3. Re-roll the pod. The gate now reports
   `migration_gate.ok` with `pendingBefore: 0`.
4. If migrations themselves fail, capture the per-file
   transaction error from the runner output, roll back via the
   matching `*.down.sql` files, and triage.
