# Delivered: "One Enterprise, One Ontology"

**Status:** Implemented + verified. For Codex review.
**Scope:** `tellus` (backend) + `tellus-fe` (frontend)
**Canonical identity:** UUID `00000000-0000-0000-0000-000000000001`, RID
`ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001`, name
"Enterprise Ontology".

---

## What changed (and why)

The engine was *physically* multi-ontology but had **three divergent "default
ontology" resolvers that disagreed** (a latent correctness bug). This change
makes the single-ontology model first-class, consistent, and enforced at the DB.

### Backend

| Area | File | Change |
|---|---|---|
| **Single source of truth** | `src/services/ontology/canonicalOntology.ts` *(new)* | Canonical UUID/RID constants + `getOntologyId()` (resolved-once, with a pre-migration fallback) + `coerceToCanonicalOntologyId()` + `ensureEnterpriseOntology()`. |
| **Resolver #1** | `src/actions/actionValidator.ts` | `getDefaultOntologyId()` now delegates to `getOntologyId()` (was: prefer "RRA Tax Ontology" → most object types). |
| **Resolver #2** | `src/middleware/resolveOntologyAlias.ts` | `default/main/primary` resolve via `getOntologyId()` (was: `ORDER BY created_at ASC` → a *different* ontology). |
| **Resolver #3 + edge collapse** | `src/server.ts` | The inline alias middleware now collapses **any** `:ontologyId` (UUID, alias, or anything) to canonical — except the `import` sub-route. |
| **Frozen lifecycle** | `src/routes/ontology.ts` | `POST /ontology`, `POST /ontology/import`, `DELETE /ontology/:id` → `409 ONTOLOGY_SINGLETON`. List/get/update/export stay live. |
| **Error code** | `src/utils/responseFormatter.ts` | Added `ONTOLOGY_SINGLETON: 409`. |
| **Data consolidation + DB guard** | `src/migrations/100_single_enterprise_ontology.sql` *(new)* | Folds every ontology-scoped row + per-ontology `main` branch into the canonical ontology; deterministic object_type api_name collision rename (keep most-instances, rename losers to `<name>__<id8>`); asserts invariants; creates `uq_ontology_singleton` unique-on-`(true)` index capping the table at one row. |
| **Seeds** | `src/seeds/seedOntology.ts` *(new)*, `src/seed.ts`, `src/seeds/fullSeed.ts`, `src/seeds/customerSeed.ts` | Populate THE enterprise ontology (reset its content) instead of creating a new ontology row — so re-seeding doesn't hit the guard. |

### Frontend

| Area | File | Change |
|---|---|---|
| **Shared constant** | `tellus-fe/lib/ontologyConstants.ts` *(new)* | Mirrors the backend canonical UUID/RID. |
| **Workshop editor** | `tellus-fe/app/workshop/[rid]/page.tsx` | Bogus fallback RID → the real `ENTERPRISE_ONTOLOGY_RID`. |
| **New module** | `tellus-fe/app/workshop/new/page.tsx` | Uses the constant RID directly instead of deriving from `ontologies[0]`; readiness guard keyed on "ontology exists". |
| **Config page** | `tellus-fe/app/ontology-manager/(manager)/configuration/page.tsx` | Dropped the "All ontologies" list; shows only the single "Enterprise ontology". |
| **Sidebar** | `tellus-fe/app/ontology-manager/(manager)/_components/OntologySidebar.tsx` | Removed the ontology-switcher affordance (carets/clickable) → static label. |
| **Hook removed** | `tellus-fe/hooks/useOntology.ts` | Deleted `useOntologies()` (no multi-ontology list); `useActiveOntology()` remains. |

---

## Verification

All scripts under `scripts/single-ontology/` (run `bash scripts/single-ontology/run-all.sh`):

| Script | Proves | Result |
|---|---|---|
| `verify-invariants.sh [db]` | Singleton invariants on a live DB (one ontology, no off-canon rows in 15 tables, guard rejects a 2nd insert, api_name uniqueness). | **22/22 pass** on `tellus_db` |
| `test-on-clone.sh` | Migration replays on a pg_dump clone; **idempotent**; **no data loss**. | **23/23 pass**, 9043 instances preserved |
| `test-merge-fixture.sh` | Injects a 2nd ontology + a colliding `Taxpayer` type + instances, runs the migration end-to-end: fold + collision-rename + branch-fold + zero loss. | **9/9 pass** |
| `smoke-api.sh` | Authenticated API behavior (one-ontology list, alias/any-id collapse, frozen 409s). | Ready; skips without a token |
| `apply-to-db.sh [db]` | Backup + apply + ledger + verify, for not-yet-consolidated environments. | — |

**Live production state (already migrated via the migrate runner):** 7 ontologies
→ **1** ("Enterprise Ontology"). 24 object types, 12 link types, **9043 instances
— zero loss**. The one real collision (`OlivierOrderJune`, in 2 ontologies) was
resolved by keeping the 746-instance copy and renaming the 20-instance copy to
`OlivierOrderJune__46a8bb56` (both preserved).

**Type safety:** `tsc --noEmit` — 0 errors (backend). FE changed files clean
(34 pre-existing errors elsewhere, none mine).
**Unit suite:** `npm run test:unit` — **2030 pass**. (2 file failures are
`MissingEnvError: PGPASSWORD`, an env-config issue, not these changes.)

---

## Phase status vs. the migration plan

Phases **1–4** (canonical accessor, freeze lifecycle, edge collapse, data
consolidation + DB guard) and **Phase 5** (frontend cleanup — all items)
are **done and verified**. Phase 6 (physically dropping `ontology_id` columns)
is intentionally deferred per the plan. Deviations: `PUT /ontology/:id`
(metadata rename) is left live by design; the dormant Foundry `ontologies` RID
table is left inert (not dropped).

## Production hardening (done after first review)

- **Batched consolidation** — `src/migrations/099_consolidate_procedure.sql` installs
  `consolidate_single_ontology(p_batch_size)`. `0` = inline (migration path);
  `>0` re-points the large tables (`object_instances`, edits, `funnel_*`) in
  chunks with `COMMIT` per chunk → short locks, scales to millions of rows.
- **Gated migration** — `100_single_enterprise_ontology.sql` is now a gate: it
  auto-consolidates inline only when rows-pending ≤ `tellus.consolidation_inline_threshold`
  (default 200k); above that it **raises** and refuses the unattended single-tx merge.
- **Backup-enforced runner** — `scripts/single-ontology/consolidate.sh` pg_dumps
  first (aborts if the dump is empty/small), runs the batched `CALL`, records the
  ledger, and verifies. Verified by `scripts/single-ontology/test-batched.sh`
  (gate raises; 5k-row batched merge preserves all rows).
- **Workflow termination on delete** — `objectTypeService.remove()` now terminates
  the durable `ObjectTypeFunnelWorkflow-<api>` (worker.ts `terminateTemporalWorkflow`)
  and drops the OpenSearch index, best-effort. Root-cause fix for the zombie-workflow
  errors (no more deleted-type sync failures).
- **Dangling-datasource cleanup** — `datasetService.deleteDataset()` now clears any
  `backing_datasource` referencing the deleted dataset (dedicated columns or the
  `file_path` `#foundry-dataset:<id>#` embed). Root-cause fix for the preview 404.

## Known follow-ups (flagged, not done — would balloon scope)

1. **Integration/e2e suites** that create throwaway ontologies as setup
   (`tests/monday`, `tests/integration/test0*`, `tests/tuesday`, `tests/sunday`
   e2e `suite.sh`, etc., asserting `POST /ontology → 201`) now need to target the
   canonical ontology instead of creating one. These require a full running
   stack + auth and are a separate, mechanical pass.
2. **Dormant Foundry `ontologies` (RID) registry** (`src/foundryMigrate.ts`) is
   intentionally untouched — zero live readers, owned by a later migrator. Could
   be dropped later to remove the second (inert) source of truth.
3. **`ontology_id` columns retained** (pointed at the one canonical id) rather
   than physically dropped — cheaper, reversible, and leaves the door open. A
   later cleanup migration could collapse PKs if desired.
