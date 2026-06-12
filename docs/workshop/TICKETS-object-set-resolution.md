# Workshop — Object Set Resolution Tickets

**Opened:** 2026-06-07
**Reporter:** Workshop OBJECT SET editor investigation (tellus-fe)
**Area:** Workshop object-set variables (Object Table widget) · B05 load proxy · Search Around · indexer

These two tickets capture backend gaps found while making the Workshop
OBJECT SET editor's Filter / Traverse / Combine controls behave as documented.
The **filter** path is fixed on the FE (`tellus-fe`); the **traverse**
(Search Around) and **combine** paths cannot be made correct from the FE alone
— they require the backend work below. Until then the FE fans out one search
per effective type and unions client-side, which is wrong for traversals (see
WS-OST-1) and is additionally masked here by an indexing bug (WS-OST-2).

FE cross-reference (tellus-fe):
- `components/workshop/WidgetObjectTable.tsx` — preview; client-side multi-type fan-out.
- `lib/workshopWidgets.ts` — `effectiveObjectTypes()`, `loadObjectSetsForVariable()`.
- `lib/workshopApi.ts` — `loadObjectSet()` → `POST /workshop/api/v1/object-sets/_load`.

---

## WS-OST-1 — Object-set `_load` does not resolve traversals or combined sets (Search Around not composed)

- **Severity:** P1 (correctness — a configured Search Around returns the wrong objects).
- **Status:** OPEN.

### What's wrong
The Workshop object-set load service resolves a **single** object type +
filters only. It has no notion of:
- **traversals** (Search Around steps: `{ linkTypeApiName, targetObjectType }`), or
- **combined sets** (union with another object-set variable).

`src/services/workshop/objectSetService.ts` accepts `{ objectTypeApiName,
filters, schema, pageSize, … }` and compiles filters via B07
(`compileFilters` / `filterCompiler.ts`), then loads that one type. There is no
`traversals` / `combinedSetIds` input and no link-edge resolution.

Because `_load` can't resolve a Search Around, the FE works around it by
calling `effectiveObjectTypes()` to flatten the definition to a type list and
issuing **one independent search per type**, unioning client-side
(`loadObjectSetsForVariable` / `WidgetObjectTable`). That is **semantically
incorrect** for a traversal: a Search Around `OlivierOrderJune --juneLinkedOrder--> OlivierOrder`
must return *the `OlivierOrder` objects linked to the current (filtered) set of
`OlivierOrderJune` objects*, not the entire `OlivierOrder` type.

### Why this is fixable server-side cheaply
The Search Around primitive **already exists** and is exercised elsewhere:
- `POST /api/v1/objects/:objectType/searchAround` — `src/routes/objects.ts:419`
- `POST /api/v1/objects/:objectType/:primaryKey/searchAround/:linkApiName` — `src/routes/objects.ts:465`
- `searchAround(...)` in `src/services/linkResolverService.ts`, backed by
  `src/services/searchAround/*` (`linkMaterializedView`, `cdcLag`, `cdcLinkProducer`).

The gap is purely that object-set **resolution** doesn't compose it.

### Evidence (live, 2026-06-07)
Module `ri.workshop.main.module.ea2cf76d-f41f-4407-9b6b-0f898b1bc278`, object
set: start `OlivierOrderJune`, filter `status = closed`, traverse
`juneLinkedOrder → OlivierOrder`, combine `Object table 1 Object set`.

```
# starting type, filtered — correct and now reflected in the FE:
POST /api/v1/objects/OlivierOrderJune/search {"where":{"type":"eq","field":"status","value":"closed"}}
  → totalCount 392   (of 746)

# traverse target, fetched independently by the FE (WRONG — whole type, not the linked subset):
POST /api/v1/objects/OlivierOrder/search {}            → totalCount 0   (see WS-OST-2)
```

The FE currently treats the traverse as "add every `OlivierOrder` object",
which is not a Search Around.

### Proposed fix
Extend object-set resolution to accept and resolve the full definition:
1. Add `traversals: [{ linkTypeApiName, targetObjectType }]` and
   `combinedSetIds: string[]` (or inline combined definitions) to the
   `_load` request schema (`objectSetService.ts` + `routes/workshopModules.ts`).
2. Resolve in order: load starting type (filtered, as today) → for each
   traversal, feed the current primary-key set into the existing
   `linkResolverService.searchAround(linkType, direction, { fromPks, … })` to
   get the linked target objects → union combined sets by id.
3. Return the resolved page(s) with a per-object `__objectType` discriminator
   so multi-type results render without client-side fan-out.
4. Keep B07 filter compilation for the starting type; traversed/combined types
   carry their own (optional) filters later.

### Acceptance criteria
- `_load` accepts a definition with `traversals` + `combinedSetIds` and returns
  the **link-resolved** objects (the target objects linked to the filtered
  starting set), not the entire target type.
- A traversal from a 392-object filtered set returns only the `OlivierOrder`
  objects linked to those 392 (cardinality ≤ the link fan-out), proven by a
  test that seeds links and asserts the resolved set.
- The FE can drop the client-side per-type fan-out and consume one resolved set.

### Affected surfaces
`src/services/workshop/objectSetService.ts`, `src/routes/workshopModules.ts`,
`src/services/linkResolverService.ts`, `src/services/searchAround/*`,
`src/services/workshop/filterCompiler.ts`. FE follow-up in tellus-fe
`WidgetObjectTable.tsx` / `loadObjectSetsForVariable`.

---

## WS-OST-2 — `OlivierOrder` reports `objectsIndexed: 746` but search returns 0

- **Severity:** P2 (data/indexing inconsistency; blocks observing WS-OST-1 traversal and any widget on `OlivierOrder`).
- **Status:** OPEN.

### What's wrong
The object type `OlivierOrder` (ontology `default`) reports a healthy funnel
state but is not searchable — the per-type OpenSearch index returns zero hits.

### Evidence (live, 2026-06-07)
```
GET  /api/v1/ontology/default/objectTypes/OlivierOrder
  → indexingState.status = "indexed", indexingState.objectsIndexed = 746

POST /api/v1/objects/OlivierOrder/search {"$pageSize":3}
  → { totalCount: 0, data: [] }
```
Funnel/denormalized state says 746 indexed; the live OpenSearch query
(`track_total_hits: true`) sees 0. Contrast `OlivierOrderJune`, which is
consistent (746 indexed / 746 searchable).

### Root-cause hypotheses (to confirm)
- **Index name / alias drift** after `src/migrations/038_opensearch_index_rename.ts`:
  `getIndexName(objectTypeApiName)` (`src/indexer.ts:260`) may resolve
  `OlivierOrder` to an index that was renamed/never populated, while
  `funnel_state.objects_indexed` retained the pre-rename count.
- **Stale funnel projection**: `objectsIndexed` is a denormalized snapshot
  (`src/metrics/funnelProjection.ts`); a failed/half-completed index run could
  leave the snapshot at 746 while the index is empty.
- **Backing datasource registered but never funneled** for `OlivierOrder`
  (the link `juneLinkedOrder → OlivierOrder` exists; the target objects may
  never have been ingested).

### Proposed fix
1. Reconcile the snapshot with the live index: a check that
   `objects_indexed` matches `track_total_hits` per type (alert when they
   diverge), so this can't silently pass as "indexed".
2. Determine whether `OlivierOrder` needs a (re)index run or whether its index
   name/alias is wrong post-migration-038; repair accordingly.
3. Add a reconciliation/repair path (reindex or funnel re-run) and a test
   asserting `search totalCount == objectsIndexed` for a freshly indexed type.

### Acceptance criteria
- `POST /api/v1/objects/OlivierOrder/search` returns its indexed rows
  (`totalCount > 0`, matching the funnel count), OR the funnel state is
  corrected to reflect reality (not a phantom 746).
- A regression test asserts indexed-count == searchable-count for a seeded type.

### Affected surfaces
`src/indexer.ts`, `src/metrics/funnelProjection.ts`,
`src/migrations/038_opensearch_index_rename.ts`, OpenSearch index/alias config.
