# Migration Plan: "One Enterprise, One Ontology"

**Status:** Proposal / for review
**Author:** Engineering (investigation report)
**Scope:** `tellus` (backend) + `tellus-fe` (frontend)
**Date:** 2026-06-09

> **Goal.** Collapse the engine from a *multi-ontology* platform to the classic
> Palantir Foundry model: **one enterprise → exactly one ontology**, bootstrapped
> at install time, never created/deleted at runtime, implicit on every request.

This document is an investigation + plan **only**. No code has been changed.

---

## 0. TL;DR for the reviewer

The system today is *physically* multi-ontology (every ontology-scoped table
carries an `ontology_id UUID` FK and the HTTP API threads `:ontologyId` through
~250 endpoints), but *operationally* it already behaves like a single-ontology
system in disguise — there are ad-hoc "default ontology" resolvers scattered in
three places that **disagree with each other**. The cleanest path is to make the
single-ontology assumption *first-class and consistent* rather than to rip out
the `ontology_id` columns.

The four big realities that shape the plan:

1. **Two registries exist; only one is live.** Legacy `ontology` (UUID) is the
   real one (20+ live query sites). The Foundry-style `ontologies` (text `rid`)
   table is **dormant** — seeded with a single `ri.ontology.main.ontology.default`
   row and **read by zero services/routes/controllers**. (verified: grep for
   `FROM/INTO/UPDATE/JOIN ontologies` in `src/services|routes|controllers` → 0 hits.)
2. **The "default ontology" is resolved inconsistently** in at least two places
   that return *different* ontologies (see §2.3). This is a latent correctness
   bug today and the single biggest reason to do this work.
3. **Data is fragmented across 3 real ontologies** that must be consolidated, and
   there is already at least one `api_name` collision that will violate the unique
   constraint on naive merge (`OlivierOrderJune` exists in 2 ontologies).
4. **The DB is the easy part.** Keeping the `ontology_id` columns (pointed at one
   canonical UUID) is far cheaper and safer than dropping them, and leaves the
   door open to re-expand later. The expensive, risky work is the **data
   consolidation** and the **API contract change**.

Recommended strategy: **Singleton, not amputation.** Introduce one canonical
ontology UUID resolved through a *single* choke point, consolidate data into it,
freeze the lifecycle endpoints, and make `:ontologyId` optional/implicit in the
API. Defer physically dropping `ontology_id` columns to a much later, optional
cleanup.

---

## 1. Current-state architecture

### 1.1 Two parallel ontology registries

| Registry | Table | Key | Status | Live query sites |
|---|---|---|---|---|
| **Legacy** | `ontology` | `ontology_id UUID` | **Authoritative** | 20+ (`FROM ontology …`) |
| **Foundry/B8** | `ontologies` | `rid TEXT` / `api_name` | **Dormant** | 0 |

The legacy table is what every route, service, seed, and the live DB data use.
The `ontologies` table (and its `object_types`, `link_types`, `interfaces`,
`shared_property_types` children) was introduced by `src/foundryMigrate.ts`
(B8.01–B8.06, ~lines 1432–1607) as a forward-looking RID-addressed model but was
never wired into the request path. It holds exactly one row (`default`).

> **Decision point #1:** which registry is the target? The Foundry purist answer
> is the RID model (`ontologies`), because "One Enterprise, One Ontology" in
> Foundry *is* a single RID. But migrating live data + 250 endpoints onto a
> dormant schema is a large project. Recommendation: **keep the legacy `ontology`
> table as the runtime store**, collapse it to one row, and treat the RID
> (`ri.ontology.main.ontology.<uuid>`) purely as the *external address* of that
> one row (the codebase already does this translation — see §2.2). The dormant
> `ontologies` table should be **dropped** to remove the confusing second source
> of truth.

### 1.2 What is ontology-scoped (the blast radius)

Tables with a direct `ontology_id UUID` FK → `ontology(ontology_id)`
(`ON DELETE CASCADE`):

`object_type`, `link_type`, `action_type`, `interface`, `ontology_branch`,
`object_type_group`, `ontology_function`, `saved_exploration`, `export_job`,
`ontology_edit`, `link_edit`.

Branch-scoped (carry `ontology_id` **and** `branch_id`):
`ontology_edit`, `link_edit`, `object_instances` (PK = `(ontology_id, branch_id,
object_type_api_name, primary_key)`), `ontology_proposal` (via `branch_id`).

Carry `ontology_id` with **no FK** (data-key only — silent corruption risk on a
naive merge): `object_instances`, `funnel_run`, `funnel_signal`,
`funnel_changelog_watermark`, `funnel_b9_state` (`ontology_rid`).

Key migrations: base schema `src/migrate.ts`; `039_ontology_id_not_null.sql`
(synthetic anchor `ffffffff-…`, NOT NULL backfill); `040_branch_id_on_edits.sql`
(per-ontology `main` branch, deterministic UUIDv5); `041_object_instances_branch_pk.sql`
(branch in the instance PK).

### 1.3 The live data (today)

7 rows in legacy `ontology`; 3 carry real content:

| Ontology | UUID | Object types | Link types | Action types |
|---|---|---|---|---|
| **Synthetic Main (backfill anchor)** | `ffffffff-…ffff` | 14 | 9 | 0 |
| **RRA Tax Ontology** | `49aaa226-…` | 6 | 0 | 6 |
| **Customer Demo** | `3edc794a-…` | 4 | 3 | 0 |
| Flight Ops Demo | `a1b2c3d4-…` | 0 | 0 | 0 |
| AuthCheck | `c371273d-…` | 0 | 0 | 0 |
| E2E Updated 1776943473 | `bae096ea-…` | 0 | 0 | 0 |
| E2E Updated 1776944104 | `e272554d-…` | 0 | 0 | 0 |

Note the **backfill anchor holds the most object types (14)** — pre-039 NULL rows
landed there. So "pick the real ontology and delete the rest" is *not* trivially
"keep RRA": real content is spread across three rows.

---

## 2. Where ontology identity enters the system (the choke points)

### 2.1 HTTP layer — `:ontologyId` path parameter

~250 endpoints are mounted under `/api/v1/ontology/:ontologyId/…`
(`src/routes/*.ts` — objectTypes, properties, links, actionTypes, branches,
groups, functions, interfaces, explorations, datasource, indexing, exports,
governance, migrations, comparisons, geo, summary). Every one reads `ontologyId`
from the path (sub-routers use `mergeParams: true`).

**Lifecycle endpoints** (these must be frozen — `src/routes/ontology.ts`):
- `POST /api/v1/ontology` (create, L41–64)
- `POST /api/v1/ontology/import` (L102–123)
- `GET /api/v1/ontology` (list, L70–96)
- `GET /api/v1/ontology/:ontologyId` (L175–199)
- `PUT /api/v1/ontology/:ontologyId` (L205–247)
- `DELETE /api/v1/ontology/:ontologyId` (L253–277)
- `GET /api/v1/ontology/:ontologyId/export` (L129–169)

### 2.2 RID ↔ UUID translation

`src/services/workshop/postgresOssAdapter.ts:~193` `ontologyUuid()` strips
`ri.ontology.main.ontology.{uuid}` → bare UUID and passes bare UUIDs through. This
is the existing seam that lets the legacy UUID table masquerade as a Foundry RID.

### 2.3 ⚠️ The "default ontology" resolvers — INCONSISTENT (latent bug)

There are (at least) **two** different "give me the default ontology" code paths
that resolve to **different ontologies**:

| Resolver | File | Logic | Resolves to (today) |
|---|---|---|---|
| `getDefaultOntologyId()` | `src/actions/actionValidator.ts:72` | `display_name='RRA Tax Ontology'` → most object_types → newest | **RRA Tax** |
| `resolveOntologyAlias("default"\|"main"\|"primary")` | `src/middleware/resolveOntologyAlias.ts` | `ORDER BY created_at ASC LIMIT 1` | **Synthetic anchor** `ffffffff-…` |

`getDefaultOntologyId()` is used by `src/routes/actions.ts` (L232/265/324) and
`src/routes/bulkActions.ts` (L53). `resolveOntologyAlias` backs the FE's
`GET /v1/ontology/default` call. **These disagree** — an action validated against
RRA can be read back through an object-set resolved to the synthetic anchor. This
inconsistency is itself a strong argument for the consolidation, and **the new
single choke point must replace both.**

Other identity sites: `cbacPolicyLoader.ts:37` cache key
`action_type::${ontologyId ?? "__global__"}::${apiName}`; OSS adapter queries
`postgresOssAdapter.ts:326/360/396` (`WHERE ontology_id = $1`); functions runtime
`ontologyRuntime.ts:72` `loadOntologySnapshot({ontologyId})`.

### 2.4 Seeds (create ontologies at startup)

- `src/seeds/fullSeed.ts` → "Rwanda Revenue Authority" / RRA Tax (8 object types).
- `src/seeds/customerSeed.ts` → "Customer Demo" (4 object types, 500 rows).
- `src/foundryMigrate.ts` → seeds the dormant `ontologies.default` RID row.

### 2.5 Frontend (`tellus-fe`)

- `hooks/useOntology.ts` — `useActiveOntology()` (L89–101) calls
  `GET /v1/ontology/default`; `useOntologies()` (L103–109) lists all. Query caches
  are keyed on `ontologyId`.
- `app/workshop/[rid]/page.tsx:114` hardcodes
  `DEFAULT_ONTOLOGY_RID = "ri.ontology.main.ontology.00000000-0000-0000-0000-000000000001"`
  as a fallback — **note this UUID does not match any real ontology in the DB**;
  it only works because writes pin a real `ontologyRid` and this is a last-resort
  default. Flag for cleanup.
- `app/workshop/new/page.tsx:118` auto-picks `ontologies[0]` and builds the RID.
- `app/ontology-manager/(manager)/configuration/page.tsx` + `OntologySidebar.tsx`
  render an "Active ontology" / "All ontologies" list (display-only; no switcher).

There is **no real ontology-switcher UI** — the FE already assumes one active
ontology. This makes the FE side relatively cheap.

---

## 3. Target model ("One Enterprise, One Ontology")

1. Exactly one ontology row exists, created by bootstrap/migration, with a
   **stable, well-known identity** (a fixed UUID + fixed RID
   `ri.ontology.main.ontology.<that-uuid>`).
2. There is **no runtime create/delete/list** of ontologies. The lifecycle
   endpoints are removed or return `410 Gone` / `405`.
3. Ontology identity is **implicit** on every request. `:ontologyId` is either
   dropped from routes or accepted-and-ignored for backward compatibility (always
   resolved to the singleton).
4. A **single** server-side accessor (`getOntologyId()` / `ONTOLOGY_RID`) is the
   *only* place that knows the canonical id. `getDefaultOntologyId()` and
   `resolveOntologyAlias` both delegate to it (or are deleted).
5. Branching (`ontology_branch`, proposals, edits) is preserved — branches are a
   property *within* the one ontology, exactly like Foundry.

---

## 4. The plan (phased, ship-incrementally)

The phases are ordered so each is independently shippable and reversible. Phases
1–3 are pure code/contract; Phase 4 is the irreversible data step; Phases 5–6 are
cleanup.

### Phase 0 — Decide the canonical ontology + consolidation policy *(design, blocking)*

Open decisions Codex/owner must settle before any code:

- **0a. Which UUID is canonical?** Options: (i) mint a brand-new fixed UUID and
  migrate everything onto it; (ii) promote an existing one (RRA Tax). Recommend a
  **new, well-known constant UUID** (e.g. all-1s or a documented GUID) so the
  identity is environment-independent and not tied to seed order.
- **0b. Merge vs. keep-one-drop-rest.** Real content lives in 3 ontologies
  (anchor=14 OT, RRA=6, Customer Demo=4). Decide whether prod keeps only one
  (delete the others' content) or merges all into the canonical one. For a real
  enterprise the answer is usually "one curated ontology"; the demo/test
  ontologies (Flight Ops, AuthCheck, two E2E) should be deleted outright.
- **0c. Collision handling.** Merging requires resolving `api_name` collisions —
  there is already at least one (`OlivierOrderJune` in 2 ontologies; unique
  constraint is `UNIQUE (ontology_id, api_name)`). Policy needed: rename, or
  pick-a-winner.

### Phase 1 — One canonical accessor (no behavior change yet)

- Add `src/services/ontology/canonicalOntology.ts` exporting:
  - `ONTOLOGY_UUID` (the constant from 0a), `ONTOLOGY_RID`, and
    `async getOntologyId()` (returns the constant; falls back to a single DB
    lookup only during the transition).
- Re-point **both** `getDefaultOntologyId()` (`actionValidator.ts:72`) and
  `resolveDefault()` (`resolveOntologyAlias.ts`) to delegate to this accessor.
  **This alone fixes the §2.3 inconsistency** and is shippable on its own.
- No schema change. Low risk, high value.

### Phase 2 — Freeze the lifecycle (`src/routes/ontology.ts`)

- `POST /ontology`, `POST /ontology/import`, `PUT /ontology/:id`,
  `DELETE /ontology/:id` → return `405/410` (feature-flagged so tests can flip).
- Keep `GET /ontology` and `GET /ontology/:id` but have them always return the
  single ontology (list = one-element array) for FE compatibility.
- `ontologyService.create()` becomes an internal bootstrap-only function (guarded
  so it is callable by migration/seed, not by the route).

### Phase 3 — Make `:ontologyId` implicit in the API

Two sub-options (pick one in design):
- **3a (compatible):** Keep the `:ontologyId` path segment but make
  `resolveOntologyAlias` mounted **globally** on the ontology router so *any*
  value (UUID, `default`, `main`, or garbage) collapses to the singleton. Lowest
  client churn; FE unchanged.
- **3b (clean):** Introduce `/api/v2/ontology/…` (no id segment) that internally
  injects the canonical id; deprecate v1. More work, cleaner contract.

Recommend **3a now, 3b later**. 3a is a few lines at the router mount and makes
the whole platform single-ontology from the client's perspective without
touching 250 handlers.

### Phase 4 — Data consolidation migration *(irreversible — gated, backed up)*

A new migration (e.g. `0XX_consolidate_single_ontology`) that, in one
transaction, per the Phase-0 policy:

1. Ensure the canonical `ontology` row (and its `main` branch via the existing
   `ensureMainBranchId` invariant from `ontologyService.create`).
2. For **merge** policy: `UPDATE` `ontology_id` → canonical on every scoped table
   (`object_type`, `link_type`, `action_type`, `interface`, `object_type_group`,
   `ontology_function`, `saved_exploration`, `export_job`, `ontology_edit`,
   `link_edit`, `ontology_branch`) **and** the no-FK tables (`object_instances`,
   `funnel_run`, `funnel_signal`, `funnel_changelog_watermark`,
   `funnel_b9_state.ontology_rid`). Resolve `api_name` collisions first (0c).
   ⚠️ `object_instances` and the edit tables have `branch_id` in their PK and
   per-ontology `main` branches — branches must be re-pointed/merged too, not just
   `ontology_id`.
3. For **keep-one** policy: `DELETE FROM ontology WHERE ontology_id <> canonical`
   (cascades wipe the others' content) after exporting anything worth keeping.
4. Delete the dormant `ontologies`/`object_types`/… B8 tables (or leave them; they
   are inert). Recommend dropping to kill the second source of truth.
5. Add a DB guard enforcing the singleton, e.g. a unique partial index / trigger
   that prevents `INSERT` of a second `ontology` row (belt-and-suspenders behind
   the Phase-2 route freeze).

**This phase needs a full DB backup and a tested rollback** (it cascades).

### Phase 5 — Frontend (`tellus-fe`)

- `useOntologies()` → remove or hard-return the single ontology; drop the "All
  ontologies" list in `configuration/page.tsx` and the selector affordance in
  `OntologySidebar.tsx`.
- `app/workshop/new/page.tsx` → stop deriving the RID from `ontologies[0]`; use a
  single imported `ONTOLOGY_RID` constant.
- `app/workshop/[rid]/page.tsx:114` → replace the bogus `…00000001` fallback with
  the real canonical RID.
- `ontologyId` may stay in query-cache keys harmlessly, or be simplified.
- `useActiveOntology()` can keep calling `GET /v1/ontology/default` (now always
  the singleton) — minimal churn.

### Phase 6 — Optional hard cleanup (later, low priority)

Only if the team wants the schema to *look* single-ontology: drop `ontology_id`
from scoped tables (collapse PKs/uniques), delete `resolveOntologyAlias`,
`getDefaultOntologyId`, the lifecycle routes, and the `ontologies` B8 tables.
**Recommendation: do NOT do this initially.** Keeping the columns is cheap,
de-risks the rollout, and preserves the ability to re-introduce multi-ontology.

---

## 5. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| `api_name` collisions on merge (`object_type_ontology_id_api_name_key`; already 1 real collision) | High | Resolve in Phase 0c before the merge `UPDATE`; migration aborts on residual dup. |
| No-FK tables (`object_instances`, funnel_*) silently keep stale `ontology_id` | High | Explicitly included in Phase-4 `UPDATE`; add post-migration assertion `COUNT(DISTINCT ontology_id)=1`. |
| Branch PK entanglement (`object_instances`, edits carry `branch_id`; each ontology had its own `main`) | High | Re-point/merge branches, not just `ontology_id`; verify against `040`/`041` invariants. |
| Cascade delete wipes wanted data (keep-one policy) | High | Full backup + export step before `DELETE`; run in transaction; rehearse on a clone. |
| The two divergent resolvers ship inconsistently | Med | Fix both in Phase 1 *first* (it's the cheapest, highest-value change). |
| Dormant `ontologies` table mistaken for live | Med | Drop it in Phase 4; document that legacy `ontology` is authoritative. |
| Hidden clients relying on real `:ontologyId` UUIDs | Med | Phase 3a accepts any value and collapses it — backward compatible. |
| `DEFAULT_ONTOLOGY_RID` FE fallback points at a non-existent UUID | Low | Fixed in Phase 5. |

---

## 6. Effort estimate (rough, senior eng)

| Phase | Effort | Risk |
|---|---|---|
| 1 — canonical accessor + fix resolvers | ~0.5 day | Low |
| 2 — freeze lifecycle | ~0.5 day | Low |
| 3a — global alias collapse | ~0.5 day | Low |
| 4 — data consolidation migration + tests | **2–4 days** | **High** |
| 5 — frontend | ~1 day | Low |
| 6 — optional hard cleanup | 3–5 days | Med (defer) |

**Critical path = Phase 4.** Everything else is small. Phases 1–3 can ship this
week and already deliver correct single-ontology *behavior*; Phase 4 makes the
*data* single; Phase 6 is optional cosmetics.

---

## 7. Open questions for Codex / owner

1. **Canonical identity (0a):** new fixed UUID, or promote RRA Tax's existing UUID?
2. **Consolidation policy (0b):** merge all content into one, or keep one and drop
   the rest? (Affects whether Phase 4 is `UPDATE`-heavy or `DELETE`-heavy.)
3. **Target registry:** confirm we keep legacy `ontology` (UUID) as runtime store
   and drop the dormant Foundry `ontologies` (RID) table — or invest in migrating
   onto the RID model properly?
4. **API contract:** Phase 3a (keep `:ontologyId`, collapse it) now, with 3b
   (clean v2 routes) later — agreed?
5. **Schema cleanup:** keep `ontology_id` columns (recommended) vs. physically
   drop them (Phase 6)?
6. **Branching:** confirm we preserve in-ontology branches (`ontology_branch`,
   proposals) — i.e. "one ontology, many branches", matching Foundry.

---

## Appendix A — Key file references

| Concern | File:line |
|---|---|
| Create/list/update/delete/import/export ontology | `src/routes/ontology.ts` (41, 70, 102, 129, 175, 205, 253) |
| Default resolver #1 (RRA-preferring) | `src/actions/actionValidator.ts:72` |
| Default resolver #2 (oldest-row) | `src/middleware/resolveOntologyAlias.ts` |
| Create service + main-branch invariant | `src/services/ontologyService.ts:44` |
| RID↔UUID translation | `src/services/workshop/postgresOssAdapter.ts:~193` |
| CBAC cache key includes ontologyId | `src/services/security/cbacPolicyLoader.ts:37,65` |
| Functions runtime snapshot | `src/services/functions/ontologyRuntime.ts:72` |
| Cache invalidation bus | `src/services/ontology/cache-invalidation.ts` |
| Backfill anchor / NOT NULL | `src/migrations/039_ontology_id_not_null.sql` |
| Per-ontology main branch | `src/migrations/040_branch_id_on_edits.sql` |
| Instance PK + branch | `src/migrations/041_object_instances_branch_pk.sql` |
| Dormant Foundry registry (B8) | `src/foundryMigrate.ts:1432–1607` |
| Seeds | `src/seeds/fullSeed.ts`, `src/seeds/customerSeed.ts` |
| FE ontology hooks | `tellus-fe/hooks/useOntology.ts:89,103` |
| FE bogus default RID | `tellus-fe/app/workshop/[rid]/page.tsx:114` |
| FE auto-pick first ontology | `tellus-fe/app/workshop/new/page.tsx:118` |

## Appendix B — Verification evidence (run 2026-06-09)

- Dormant registry: `grep -rE "(FROM|INTO|UPDATE|JOIN)\s+ontologies\b"
  src/services src/routes src/controllers` → **0 hits**; `ontologies` table holds
  1 row (`ri.ontology.main.ontology.default`).
- Resolver divergence: `getDefaultOntologyId` SQL orders by
  `display_name='RRA Tax Ontology'` first; `resolveOntologyAlias` orders by
  `created_at ASC` (→ synthetic anchor). Different rows.
- Collision: `SELECT api_name, count(DISTINCT ontology_id) FROM object_type
  GROUP BY api_name HAVING count(DISTINCT ontology_id) > 1` →
  `OlivierOrderJune | 2`.
- Unique constraint: `object_type_ontology_id_api_name_key UNIQUE (ontology_id, api_name)`.
