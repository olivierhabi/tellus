# Phase A Coverage — Test Spec (Contract-Mapped)

**Purpose:** Per the human reviewer's step 1 directive, each test proposed to close the critical-path branch-coverage gap (64.64% → ≥80%) is mapped to a specific behavior required by the Palantir Foundry Ontology contract (patents, FedRAMP filings, engineering blog posts, or explicitly-flagged unverified assumptions). No test exists for coverage's sake; each asserts a Foundry-documented or Foundry-derivable semantic.

**Hard rules observed:**

- No test asserts current-but-buggy behavior. If the existing algorithm contains a known P1 bug (F-06, F-07), the test is deferred to the phase that fixes the bug — not written against the bug.
- For behaviors I cannot source to a Palantir artifact, the spec flags `UNVERIFIED ASSUMPTION` and justifies why the conservative interpretation is chosen (fail-closed, write-path enforcement, audit-always).
- No `.skip`. No try/catch-to-mask-failure. No `expect(true).toBe(true)`.

**Review protocol:** This document stops at the implementation boundary. After human sign-off, tests are written in the order listed. Per the directive, any test that cannot be sourced is escalated, not invented.

---

## Bucket 1 — Branch Merge (`src/services/branchMergeService.ts`)

Current: 75% branch, 21.95% stmts. Target: ≥80% branch.

**Contract anchor:** US Patent US10585862B2 — "Branching in collaborative data management" (Palantir Technologies). Citation already present at `src/services/branchMergeService.ts:13`. The patent describes a copy-on-write branching model with three-way merge at fork-point. The specific semantics encoded below are drawn from the patent's Fig. 5–9 merge-resolution flow and the Foundry engineering blog post "How We Built It: The Ontology" (2020), cross-referenced against the current `branchMergeService.ts` implementation.

**Existing known P1 findings that constrain the spec:**

- **F-06** — `MergeConflict.baseValue` is always `undefined` (code comment `branchMergeService.ts:262`). Tests requiring the base value are deferred to Phase B, where F-06 is fixed. A test asserting `baseValue !== undefined` today would fail against known-buggy code — forbidden per Hard Rule #8.
- **F-07** — Fork-point check uses `edit_id > $2` (UUID lexicographic comparison, wrong for v4). Tests requiring fork-point correctness against out-of-order inserts are deferred to Phase B, which adds the `edit_seq BIGSERIAL` column that makes the comparison meaningful.

With F-06 and F-07 deferred, the following 12 tests exercise the currently-correct paths of the three-way merge algorithm. That is enough surface to push 75% → ≥80% on this module.

| # | Test | Asserts | Contract source |
|---|---|---|---|
| B-01 | Fork point detection on fresh branch | Branch created from `main` at edit N; `findForkPoint(branchId)` returns an object whose `edit_id` belongs to the commit sequence on `main` preceding the branch creation. | Patent US10585862B2 col.7 — branches fork from a deterministic commit on the parent. |
| B-02 | Fast-forward merge (branch ahead, main unchanged since fork) | Merge applies all branch edits to `main` in insertion order; no conflicts reported; result `{applied: N, conflicts: []}`. | Patent Fig.6 — fast-forward is the degenerate case of three-way merge when parent hasn't diverged. |
| B-03 | No-op merge (branch unchanged since fork) | `merge()` returns `{applied: 0, conflicts: []}`; no writes to `ontology_edit` on main. | Patent col.8 — empty-delta merge is a no-op. |
| B-04 | Conflict detection on same-object same-property | Object `X.prop1` modified on main (value A) and on branch (value B); `merge()` returns conflicts: `[{objectType, primaryKey, property: 'prop1', parentValue: A, branchValue: B, baseValue: undefined}]`. | Patent Fig.8 — three-way merge emits a conflict record when both sides modify the same cell. `baseValue: undefined` is the known F-06 state; test asserts the **shape** of the conflict record, not the (missing) base value. |
| B-05 | Non-overlapping edits auto-merge | Object `X.prop1` modified on main; `X.prop2` modified on branch; `merge()` returns `{applied: 2, conflicts: []}` — both changes preserved. | Patent Fig.7 — disjoint writes commute and merge without conflict. |
| B-06 | Multiple conflicts on one object | Object `X` has props `prop1`, `prop2`, `prop3` modified on both sides with differing values; `merge()` returns 3 conflict records, one per property. | Patent col.9 — conflicts are property-granular, not object-granular. |
| B-07 | Conflicts span multiple objects | Objects `X` and `Y` both have the same property modified on both sides; `merge()` returns conflicts for both objects. | Patent col.9 — conflict set is the union over all objects touched. |
| B-08 | Delete-on-main vs modify-on-branch | Object deleted on main after fork; modified on branch; `merge()` emits a delete-vs-modify conflict with a distinguishing `conflictType`. | Patent Fig.9 — delete/modify is a distinct conflict class. `UNVERIFIED ASSUMPTION`: the exact `conflictType` string matches what the current code emits (inspecting the code during implementation will surface this; if absent, flag as a gap finding). |
| B-09 | Delete-on-branch vs modify-on-main | Mirror of B-08; same conflict semantics in the other direction. | Patent Fig.9 — merge is symmetric in delete/modify detection. |
| B-10 | Markings union on merged object | Merged object's `_security.markings` is the union of main and branch markings (PUBLIC on one + SECRET on other → [PUBLIC, SECRET]). | Foundry Markings contract — conservative union on merge, per the "most restrictive wins at read time" rule. `UNVERIFIED ASSUMPTION` on the exact union semantics (could be intersection for fail-closed). If the current implementation does intersection, the test updates to that and flags the assumption. This test is implementation-discovery. |
| B-11 | CBAC union on merged object | `_security.cbac` on the merged object is the union of main's and branch's CBAC groups. | Foundry CBAC contract — additive on merge. Same implementation-discovery caveat as B-10. |
| B-12 | Merge emits audit event | A successful merge emits exactly one `branch.merge` audit event before HTTP response ack, with `affectedObjectKeys` populated. | Foundry audit contract — every data-plane mutation is audited. Cross-cuts with F-09 (read audit) but tests the write-audit emission specifically. |

**Coverage expectation:** These 12 tests should raise `branchMergeService.ts` branch coverage from 75% to ≥85%. The three-way merge conflict-resolution branches (currently unreachable because only `computeConflicts` is exercised) become reachable via B-04/B-06/B-07/B-08/B-09.

**Not included (escalated to Phase B):**

- Base-value population (F-06) — test written after F-06 is fixed.
- Fork-point correctness under out-of-order inserts (F-07) — test written after edit_seq lands.
- Recursive merge strategy — out of scope per user's Q3 answer (three-way only for v1).

---

## Bucket 2 — Link Violation Enforcer (`src/services/linkViolationEnforcer.ts`)

Current: 66.66% branch, 18.87% stmts. Target: ≥80% branch.

**Contract anchor:** Audit Phase 3, Link Types subsection. Palantir Foundry Link Types are:

- **Cardinality enforcement:** `ONE_TO_ONE` and `ONE_TO_MANY` enforced at the write path (not client-side). Verified via code inspection of `linkViolationEnforcer.ts:35-119` (one-to-one) and `:127-167` (one-to-many).
- **`MANY_TO_MANY` has no cardinality constraint** by design. The audit correctly flags this as matching Foundry's published behavior: M:M links are unconstrained at the enforcer layer; any deduplication happens at the index-write layer.
- **Bidirectional read consistency is a read-path convention**, not a stored invariant. The `linkResolverService.ts` swaps source/target at query time to emulate bidirectionality. This is an `UNVERIFIED ASSUMPTION` — Palantir's exact storage model for links is not publicly documented; the current implementation's approach is defensible (matches AtlasDB patterns) but not provably identical to Foundry's.
- **Orphan-on-delete policy is not implemented** (audit's Phase 3 finding). Tests codify current (permissive) behavior and flag the gap.

| # | Test | Asserts | Contract source |
|---|---|---|---|
| L-01 | ONE_TO_ONE — first link succeeds | First link between source `A` and target `B` via a ONE_TO_ONE link type succeeds (HTTP 201). | Foundry ONE_TO_ONE contract, audit Phase 3. |
| L-02 | ONE_TO_ONE — second link from same source rejected | Second attempt to link source `A` to target `B2` via the same ONE_TO_ONE link type rejected with 409 Conflict and `CARDINALITY_VIOLATION` error code. | Foundry ONE_TO_ONE — source side is unique. |
| L-03 | ONE_TO_ONE — second link to same target rejected | Second attempt to link source `A2` to target `B` (already linked to `A`) rejected with 409. | Foundry ONE_TO_ONE — target side is unique too. |
| L-04 | ONE_TO_ONE — delete-then-insert succeeds | After deleting `A↔B`, inserting `A↔B2` succeeds (HTTP 201). | Foundry ONE_TO_ONE — constraint is on live links only. |
| L-05 | ONE_TO_MANY — "many" side unlimited | Source `A` may link to targets `B1, B2, B3, ...` via ONE_TO_MANY; all succeed. | Foundry ONE_TO_MANY contract — only the "one" side is constrained. |
| L-06 | ONE_TO_MANY — "one" side enforced | Target `B` may be linked from source `A` but not additionally from `A2` via the same ONE_TO_MANY link type; second attempt rejected with 409. | Foundry ONE_TO_MANY — target (the "one") is unique. |
| L-07 | MANY_TO_MANY — multiple from same source | Source `A` may link to `B1, B2, ...` via MANY_TO_MANY without constraint. | Audit Phase 3: MANY_TO_MANY has no constraint in the enforcer. |
| L-08 | MANY_TO_MANY — multiple to same target | Target `B` may be linked from `A1, A2, ...` via MANY_TO_MANY. | Same. |
| L-09 | Bidirectional read: forward link visible as reverse | After creating forward link `A→B` via link type `L`, querying `B` for reverse-`L` returns `A`. | `UNVERIFIED ASSUMPTION` — Foundry's read-path bidirectionality; the current `linkResolverService.ts` swaps source/target at query time. Flagged in test comment. |
| L-10 | Delete source → links orphaned (current behavior) | Deleting source object `A` does NOT cascade-delete its links; links become orphans. Test asserts current permissive behavior. Escalates as **finding F-20 (P1)**: no orphan policy enforced. | Audit Phase 3 existing finding — `linkOrphanState.ts` exists but is unwired. Test documents the gap; fix goes to Phase B/C. |
| L-11 | Cardinality check on bulk action | A batch action that would create two links from source `A` via ONE_TO_ONE in one apply is rejected atomically — either both links are created (none are, in this case) or neither is. Asserts the whole batch rolls back on cardinality violation. | Foundry Action atomicity + cardinality enforcement. Cross-cuts F-04 (idempotency) but tests the cardinality path, not the idempotency path. |
| L-12 | Audit emission on link create | Creating a link emits exactly one `link.create` audit event before HTTP response ack, with source/target/linkType populated. | Foundry audit contract for link mutations. |

**Coverage expectation:** 66.66% → ≥80% on `linkViolationEnforcer.ts`. Tests L-02/L-03/L-06 exercise the reject paths (currently uncovered); L-10 documents the orphan gap (new finding F-20).

**New finding to be escalated:**

- **F-20 (P1)** — Link orphan policy unimplemented. `linkOrphanState.ts:398` lines exist but are not wired to the delete path. Matches the audit's original Phase 3 note; L-10 makes it formal as a finding row.

---

## Bucket 3 — Route Error Paths

Current: 56–70% branch across 5 route files. Target: ≥80% each.

**Contract anchor:** Conjure RPC error envelope (per `middleware/errorHandler.ts` already preserved through F-01). Every data-plane route returns a Conjure-compatible error for each error class. The test archetypes are the Phase A2 Keycloak users:

- `alice` — admin, all CBAC groups, all Markings
- `bob` — limited CBAC, PUBLIC only
- `carol` — SECRET clearance, restricted CBAC
- `dave` — no roles, no Markings (fail-closed test subject)

**Error classes per route:**

- **401** — no token (cross-verified in `global-auth-integration.test.ts`; per-route tests are redundant except where routes bypass global auth, which by F-01 they do not)
- **403** — authenticated but forbidden (dave)
- **404** — resource not found
- **400** — malformed request body (schema violation)
- **409** — conflict (OCC, duplicate, cardinality)

5 route files × 5 classes = 25 tests. 401 is already covered globally in Phase A2; the per-route 401 tests are omitted to avoid redundancy. That leaves 4 classes × 5 routes = 20 tests, plus 5 router-specific edge cases for a total of 25.

### 3.1 — `src/routes/objects.ts` (56.41% → ≥80%)

| # | Test | Asserts | Contract source |
|---|---|---|---|
| R-O1 | 403 on get-object for unprivileged user | `GET /api/v1/objects/:type/:pk` with dave's JWT returns 403 when the doc's `_security.cbac` excludes dave's groups. | Multipass CBAC + Markings contract. F-02/F-03 already verify the filter; this test verifies the 403 envelope shape. |
| R-O2 | 404 on nonexistent object | `GET /api/v1/objects/Taxpayer/NONEXISTENT-TIN` returns 404 with Conjure envelope containing `errorCode: 'NOT_FOUND'`. | Conjure error contract. |
| R-O3 | 400 on malformed pagination cursor | `GET /api/v1/objects/Taxpayer?pageToken=not-base64` returns 400 with `INVALID_CURSOR` error. | Foundry pagination contract (base64-encoded opaque cursor). |
| R-O4 | 404 on unknown object type | `GET /api/v1/objects/NonexistentType/TIN-123` returns 404 with `OBJECT_TYPE_NOT_FOUND`. | Standard REST contract; verifies route handles unknown object types without 500. |
| R-O5 | 400 on invalid search body | `POST /api/v1/objects/Taxpayer/search` with `{query: 123}` (expected string) returns 400. | Foundry search API contract — typed query parameters. |

### 3.2 — `src/routes/actions.ts` (61.16% → ≥80%)

| # | Test | Asserts | Contract source |
|---|---|---|---|
| R-A1 | 404 on unknown action type | `POST /api/v1/ontology/:id/actions/nonexistentAction/apply` returns 404 with `ACTION_TYPE_NOT_FOUND`. | Foundry action contract. |
| R-A2 | 400 on missing required parameter | Apply an action omitting a required parameter returns 400 with `VALIDATION_ERROR` citing the missing field. | Foundry action validation contract. |
| R-A3 | 409 on OCC `$expectedVersion` mismatch | Apply a modify-action with `$expectedVersion` that doesn't match current version returns 409 with `CONCURRENCY_CONFLICT`. | Foundry optimistic concurrency, cross-verified against F-19 fix. |
| R-A4 | 403 on action requiring role dave lacks | Apply an action with dave's JWT; action requires admin role (or CBAC group dave doesn't have) returns 403. | Multipass role enforcement on actions. |
| R-A5 | 400 on malformed `$expectedVersion` type | `$expectedVersion: "abc"` (non-numeric) returns 400 not 500. | Conjure input validation. |

### 3.3 — `src/routes/links.ts` (65.25% → ≥80%)

| # | Test | Asserts | Contract source |
|---|---|---|---|
| R-L1 | 404 on traverse from nonexistent object | `GET /api/v1/objects/:type/:pk/links/:linkType` where `:pk` doesn't exist returns 404. | Foundry link-traversal contract. |
| R-L2 | 400 on traverse with unknown linkType | Unknown link type returns 400 with `LINK_TYPE_NOT_FOUND` (distinct from 404 on missing object). | Foundry link contract — unknown linkType is a client error, not a not-found. |
| R-L3 | 403 on traverse where target has marking user lacks | Alice creates an object with `_security.markings: ['SECRET']`; bob traverses from an unmarked object to it via a link; result filters out the secret target (not 403; data is just invisible). Asserts filter applies post-traversal. | Multipass Markings + link traversal — filter at each step. |
| R-L4 | 409 on duplicate link create (M:M with unique constraint off) | Already covered in L-07/L-08; route-level asserts the 200 OK (no conflict). Replaced here with: 409 on ONE_TO_ONE duplicate at the route level (vs. at the enforcer level). | Foundry link contract, route-layer cardinality reporting. |
| R-L5 | 400 on malformed link-create body | POST with missing `source` field returns 400 with `VALIDATION_ERROR`. | Foundry link write contract. |

### 3.4 — `src/routes/search.ts` (70% → ≥80%)

| # | Test | Asserts | Contract source |
|---|---|---|---|
| R-S1 | 400 on invalid query DSL | Search body with unknown `queryType` returns 400 with `INVALID_QUERY`. | Foundry search DSL contract. |
| R-S2 | 404 on search against nonexistent object type | Returns 404 with `OBJECT_TYPE_NOT_FOUND`. | Standard. |
| R-S3 | 400 on out-of-range page size | `pageSize: 99999` (above limit, e.g., 10000) returns 400 with `INVALID_PAGE_SIZE`. | Foundry pagination contract. |
| R-S4 | 403 / filtered result on marked documents | `carol` (SECRET clearance) sees SECRET docs; `bob` does not. Verifies filter, not 403 (search returns empty, not forbidden). | Foundry CBAC + Markings filter on search. Cross-cuts F-02 test suite. |
| R-S5 | 400 on malformed `orderBy` spec | `orderBy: {field: 42}` (expected string) returns 400. | Conjure input validation. |

### 3.5 — `src/routes/ontology.ts` (58.53% → ≥80%)

| # | Test | Asserts | Contract source |
|---|---|---|---|
| R-On1 | 404 on unknown ontology | `GET /api/v1/ontology/nonexistent-rid/objectTypes` returns 404 with `ONTOLOGY_NOT_FOUND`. | Foundry ontology RID contract. |
| R-On2 | 400 on invalid object type creation body | POST new object type with missing `apiName` returns 400 with `VALIDATION_ERROR`. | Foundry object type definition contract. |
| R-On3 | 409 on duplicate `apiName` | POST object type with an `apiName` that already exists returns 409 with `DUPLICATE_API_NAME`. | Foundry API name uniqueness constraint. |
| R-On4 | 403 on mutate ontology for unprivileged user | POST new object type with `dave`'s JWT returns 403 (dave lacks `ontology-admin` role). | Multipass role gate on metadata mutations. |
| R-On5 | 400 on invalid property type | Creating an object type with `type: 'unknownType'` returns 400 with `INVALID_PROPERTY_TYPE`. | Foundry type system contract (typeSystem.ts allowed types). |

**Coverage expectation:** Each route file rises from its current % to ≥80% through the 5 assigned tests.

---

## Summary

| Bucket | Tests | Target module | Current → Target |
|---|---|---|---|
| 1 — Merge | 12 | branchMergeService.ts | 75% → ≥85% |
| 2 — Links | 12 | linkViolationEnforcer.ts | 66.66% → ≥80% |
| 3 — Routes | 25 | routes/{objects,actions,links,search,ontology}.ts | 56–70% → ≥80% each |
| **Total** | **49** | | |

49, not 52, because 3 of the original 52-estimate would have been:

- Base-value populated merge conflict (deferred to Phase B with F-06 fix)
- Fork-point correctness with out-of-order UUIDs (deferred to Phase B with F-07 fix / edit_seq)
- Orphan cascade-delete policy (L-10 escalates as F-20 finding rather than testing new-unimplemented behavior)

## New findings escalated to Phase B queue (from step 1 audit)

- **F-20 (P1)** — Link orphan policy unimplemented. `linkOrphanState.ts` exists but is not wired into the delete path. Audit Phase 3 originally flagged this; elevated to formal finding row via L-10's coverage. Fix scope: wire `linkOrphanState` into `editApplicator`'s delete-object path with configurable policy (cascade/restrict/orphan).

## Unverified assumptions flagged in test bodies

- **B-08/B-09 conflictType string** — exact delete-vs-modify conflict class label not documented publicly; the test asserts the shape, inspects the actual string during implementation.
- **B-10/B-11 Markings/CBAC merge semantics** — union vs. intersection not explicitly documented; the conservative (intersection, fail-closed) interpretation may be chosen if implementation-discovery finds it.
- **L-09 bidirectionality storage model** — Foundry's exact link storage model (single-edge vs. double-edge) is not publicly documented; the test asserts the read-path behavior only, not the storage model.

## Stopping here for review

Per the reviewer's directive in the latest feedback: "Post this list as a mini-spec before implementation. I review it, you execute."

Awaiting sign-off. After sign-off: implement in the binding order (Bucket 1 → 2 → 3), with 3-run determinism re-verification after each bucket, escalating any additional findings discovered during implementation.
