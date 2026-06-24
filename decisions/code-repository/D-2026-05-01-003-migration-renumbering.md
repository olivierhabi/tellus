# D-2026-05-01-003 — Code Repos migration renumbering (031/032/033 → 050/051/052)

## Status

Accepted. Implemented. Live in repo as of 2026-05-01.

## Context

I authored migrations under filenames `031_stemma_ddl.sql`,
`032_code_repos_audit.sql`, and `033_b10_stemma_events.sql` during
Waves 1–3. After auditing the migrations directory I discovered that
each of those numbers was already taken by an existing pre-Code-Repos
migration that ships with the Tellus baseline:

| Number | My (Code Repos) file | Existing file |
|---|---|---|
| 031 | `031_stemma_ddl.sql` | `031_pipeline_snapshot_invariants.sql` |
| 032 | `032_code_repos_audit.sql` | `032_migration_ledger.sql` |
| 033 | `033_b10_stemma_events.sql` | `033_pipeline_supervised_deploys.sql` |

The integration test harness applies migrations by absolute path inside
isolated per-test schemas, so the collisions did not break the test
lane. They would, however, break the production migration runner the
first time a deploy applied both. The runner orders by numeric prefix,
and two files with the same prefix is undefined behaviour at best and
"the second file silently overwrites the first" at worst.

## Decision

Renumber the three Code Repos migrations to slots above the highest
in-tree non-date-based migration (`046_export_job_security_snapshot.sql`):

- `031_stemma_ddl.{sql,down.sql}` → `050_stemma_ddl.{sql,down.sql}`
- `032_code_repos_audit.{sql,down.sql}` → `051_code_repos_audit.{sql,down.sql}`
- `033_b10_stemma_events.{sql,down.sql}` → `052_b10_stemma_events.{sql,down.sql}`

The test references in `tests/integration/code-repos/**` were updated
in the same change via `sed -i ''`. Inline comments inside the migration
files still mention "031_" / "032_" / "033_" — left alone because they
are documentation and not executed.

## Alternatives considered

1. **Keep the colliding numbers.** Rejected — production migration
   runners (e.g. our wrapper around `node-pg-migrate` plus the in-house
   `032_migration_ledger.sql` schema) order by numeric prefix; two
   files with the same prefix is undefined behaviour. This would have
   caused real harm on first deploy.
2. **Date-based suffix, e.g. `20260501000000_stemma_ddl.ts`.**
   Already a convention for one TypeScript-shaped migration in-tree
   (`20260316000000_create_user_preferences.ts`). Rejected for now
   because every other Code Repos migration is plain SQL and the
   ledger reads numeric-then-name-sort; mixing styles within one
   feature would confuse future readers. Worth revisiting if the
   numeric ledger becomes contested across teams.
3. **Reserve a higher numeric block, e.g. 100..199, for Code Repos.**
   Considered. Rejected because it implies a permanent stake in the
   migration namespace and we are 50 deltas away from collision today.
   The 050/051/052 slots match the natural "next available" cadence
   and allow B2..B10 migrations to extend at 053..061 in DAG order.

## What evidence would change this

- The in-tree migration runner moves to date-based ordering (per #2).
  In that case all Code Repos migrations should be renamed to
  `YYYYMMDDhhmmss_*` to match.
- Another team takes the 050..059 slots before B2..B10 migrations
  land. In that case I'd renumber forward to the next clear block
  rather than re-collide.

## Contracts touched

This decision affects no spec contract IDs directly; the file paths
are an implementation detail. Tests reference paths verbatim so the
rename was a one-shot textual edit.

## Verification

After the rename: `npx vitest run --config vitest.codeRepos.config.ts`
shows the integration suite passing as before (65 → 65), and `ls
src/migrations/ | grep ^05` shows the three renamed pairs sitting
cleanly above the existing 030..046 block.
