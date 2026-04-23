# F-P3-14 — Three-Way Merge Algorithm Rewrite — Design Document

Status: **DESIGN — awaiting human reviewer with VCS-internals experience.**
This document is the input to that review, per F-P3-14 packet §1 and original-audit Appendix A.1. No code in this packet. Implementation follows review.

---

## §1 — Current State

The 8 defects named against `src/services/branchMergeService.ts` in the original audit §2.1 are labelled BM-1…BM-8. Each is catalogued below with its current line number, reproduction state, and user-visible symptom. Line numbers refer to the in-tree file at the time of writing (577 LOC).

**BM-1 — Base value never populated on `MergeConflict`.**
`detectConflicts` at `src/services/branchMergeService.ts:276-319` constructs each conflict with `baseValue: undefined` and a comment (`:311-315`) that says the value "will be filled in by the caller which has access to the PG client" via a planned `populateBaseValues()` helper. That helper does not exist. `mergeThreeWay` at `:339-498` never reads the base value at the fork point, so every resolution decision is effectively a two-way diff (parent vs branch) with no information about the common ancestor. Symptom: convergent-modification-from-same-base cases cannot be distinguished from actual conflicts; the user is prompted to resolve a non-conflict, and the chosen side may silently overwrite the other's identical work.

**BM-2 — Fork-point predicate still compares UUIDs lexicographically.**
Both `getBranchEdits` (`:106-144`) and `getParentEditsSinceFork` (`:146-229`) filter with `edit_id > $forkPointEditId` even though the ORDER BY clause was migrated to `ORDER BY commit_seq ASC`. UUID lexicographic comparison is unrelated to insertion order — UUIDv4 is random; UUIDv7 is only partly monotonic under clock skew. Migration 042 added the monotonic `commit_seq BIGSERIAL` column and the `fork_point_commit_seq` column on `ontology_branch`, but the query predicate was not switched. Symptom: edits with lexicographically-smaller UUIDs created *after* the fork point are silently excluded from the merge input; edits with lexicographically-larger UUIDs created *before* the fork point are silently included. The merge runs on an arbitrary subset of the real history.

**BM-3 — Canonical JSON equality (previously LANDED).**
`detectConflicts:285-300` calls `canonicalJson` from `src/services/audit/canonicalJson.ts` (F-P3-11 closure shared surface) before comparing `parent.value` vs `branch.value`. Key-reorder false-positives and type-coercion false-negatives are closed. `safeCanonical` at `:20-34` returns `null` on canonicalisation failure, which preserves the conservative outcome (treat as conflict) rather than silently converging. No reproduction. Retain as-is.

**BM-4 — Key-collision-safe change map (previously LANDED).**
`buildPropertyChangeMap:245-266` uses a `Map<string, {value, operation}>` keyed by `"objectType::primaryKey::propertyName"` with a dedicated `::__DELETE__` sentinel for deletions. The prior object-literal map lost entries when a property name collided with `Object.prototype` keys (e.g. `toString`, `constructor`). No reproduction. Retain as-is.

**BM-5 — Silent-swallow of concurrent merges removed (previously LANDED).**
`mergeThreeWay:349-358` takes `pg_advisory_xact_lock(hashtext('tellus.merge.<branchId>'))` before reading the branch row. A second concurrent merge blocks at the lock rather than racing and either producing duplicate edits or silently losing one side's replay. No reproduction. Retain, with a known question about lock key scope (see §6 Q3).

**BM-6 — Deterministic replay via `merge_op_id` (previously LANDED).**
`deriveMergeOpId` at `:43-56` is a pure function of `(sourceBranchId, targetBranchId, forkPointCommitSeq)` under the prefix `tellus.merge.v1`. Each replayed edit's `execution_id` is `${mergeOpId.slice(0,16)}-${index}` (`:439-448`). A retried merge of the same source→target at the same fork point produces byte-identical `execution_id`s at each offset, which a unique-index on `execution_id` catches as a no-op. No reproduction. Retain, with a question about whether content hash should participate (§6 Q4).

**BM-7 — Merging principal recorded, not 'system' (previously LANDED).**
`mergeThreeWay` now takes an optional `mergedBy` parameter (`:343`) and binds it to `executed_by` on every replayed edit (`:462-467`). The default `'system'` remains for backward compatibility during the migration window. No reproduction in the code itself; see §6 Q5 on whether the route layer correctly propagates the authenticated subject.

**BM-8 — `commit_seq`-based ordering (previously LANDED).**
Every query `ORDER BY commit_seq ASC`. This is the ordering half of what migration 042 enables; the predicate half is BM-2 above. Ordering correct, predicate wrong — so the algorithm reads the right rows in the right order, but the row set itself is still wrong. Retain ordering, fix BM-2 predicate.

**Summary:** BM-1 and BM-2 reproduce (the two "3-way-ness" bugs). BM-3..BM-8 landed and are retained. Rewrite scope is BM-1 + BM-2 plus the structural refactor those changes imply.

---

## §2 — Contract

### What the patent and Palantir Foundry's public documentation establish

**US10585862B2 col. 9 lines 15-58 — UNVERIFIED ASSUMPTION.**
The patent text could not be accessed directly from this environment; the citation is carried forward from the original audit's §2.1. The audit's paraphrase (which this design treats as the authoritative source until the reviewer confirms the patent text) is that the patent describes a three-way merge in which each conflicting entity carries the **base value** at the nearest common ancestor, the **source value** on the branch being merged in, and the **target value** on the branch being merged into. A conflict exists when `source ≠ target` AND at least one of (`source ≠ base`, `target ≠ base`) is true. Convergent modification (source == target, both different from base) is not a conflict.

**UNVERIFIED ASSUMPTION — see §6 Q1.** If the reviewer can supply the patent text, the §3 algorithm must be checked against the actual col. 9 lines 15-58 contract; paraphrased assumptions are marked below.

**Palantir Foundry publicly documented behavior.**
Foundry's Ontology branching documentation (public-facing; cited in the original audit without direct URL) states that branch merges preserve **Markings** through merge (the union of source and target Markings applies to the merged entity). It also states that merges emit an **audit event** per changed entity, and that **idempotent replay** is supported under a client-supplied key. These three items are treated as binding public-documentation-level requirements.

**Tellus-specific additional requirements.**

1. **Markings preservation — union semantics by default.**
   Per F-P3-11 / F-P3-18 (CBAC policy engine), a user visible to target must remain visible after merge; narrowing a Marking set during merge is a privilege-escalation vector. Default: union. Non-default behaviors require an explicit, audited policy decision at the route layer.

2. **Audit emission must be `durable-before-ack`.**
   Per F-P3-11, the audit write must commit and hash-chain before the merge returns success. A merge that commits PG state but fails to append the audit entry must return 503 (durable-audit failure) and rely on the F-P3-11 verifier job to detect the gap. **This requirement is not negotiable** — it's the whole point of F-P3-11.

3. **Branch isolation must hold throughout replay.**
   Per F-P3-12 and F-P3-13, every `link_edit` INSERT produced by the merge carries `branch_id = <target>`, and every OpenSearch write stamps `__branch: <targetBranchId>`. F-P3-13-FOLLOWUP-1 closes the read side. The merge must not open a cross-branch side channel.

4. **Idempotency key shape matches the existing F-P3-11 / F-P4-09 pattern.**
   Route-level `Idempotency-Key` header is honored if present; the data-level `merge_op_id` (BM-6) is the second line of defense.

---

## §3 — Algorithm

Pseudocode, not TypeScript. Levels of abstraction follow the Git "three-way merge with base" literature, adapted for Tellus's PG+OpenSearch dual-store.

```
function mergeThreeWay(ontologyId, sourceBranchId, targetBranchId, resolutions?, mergedBy, idempotencyKey?):

  ; === 1. Fork-point identification ===
  open PG transaction T1 with isolation = REPEATABLE READ

  acquire advisory lock on hashtext("tellus.merge.v2." || targetBranchId)
    ; scope: target. A source→target merge blocks any other *→target merge.
    ; rationale: conflicts are always resolved against the target history;
    ; two concurrent merges into the same target produce divergent replays.

  SELECT ... FROM ontology_branch WHERE branch_id = sourceBranchId FOR UPDATE
  fork_seq := row.fork_point_commit_seq
    ; NOT NULL on post-042 branches; on legacy-null branches, translate
    ; from fork_point_edit_id → commit_seq via an explicit JOIN and
    ; if that translation is still NULL after the JOIN, reject the merge
    ; with an error code (do not treat NULL as "since forever").

  ; === 2. Collect edit sets ===
  source_edits := SELECT ... FROM ontology_edit
                  WHERE branch_id = sourceBranchId AND commit_seq > fork_seq
                  ORDER BY commit_seq ASC

  target_edits := SELECT ... FROM ontology_edit
                  WHERE ontology_id_fk = ontologyId
                    AND branch_id IS NOT DISTINCT FROM targetBranchIdOrNullForMain
                    AND commit_seq > fork_seq
                  ORDER BY commit_seq ASC

  ; These are the two predicates that BM-2 gets wrong today.
  ; The column semantics were established by migration 042.

  ; === 3. Build per-property change maps ===
  source_map := buildPropertyChangeMap(source_edits)  ; unchanged from BM-4
  target_map := buildPropertyChangeMap(target_edits)  ; unchanged from BM-4

  ; === 4. Fetch base values for every key present in BOTH maps ===
  collision_keys := intersect(keys(source_map), keys(target_map))
  base_values := populateBaseValues(ontologyId, collision_keys, fork_seq)
    ; Details in §3.base-value-read below.

  ; === 5. Conflict detection using (base, source, target) triples ===
  conflicts := []
  convergent := []
  for each key in collision_keys:
    base_v   := base_values[key]
    source_v := source_map[key].value
    target_v := target_map[key].value

    ; canonicalJson equality (BM-3, retained)
    if canon(source_v) == canon(target_v):
      convergent.append(key, source_v)
      continue   ; not a conflict — both sides converged

    ; classic three-way:
    ;   source differs from base, target doesn't → source wins automatically
    ;   target differs from base, source doesn't → target wins automatically
    ;   both differ from base and from each other → conflict
    if canon(source_v) != canon(base_v) and canon(target_v) == canon(base_v):
      convergent.append(key, source_v)  ; source wins (fast-forward)
      continue
    if canon(target_v) != canon(base_v) and canon(source_v) == canon(base_v):
      convergent.append(key, target_v)  ; target wins (no-op replay)
      continue
    ; both differ from base and from each other
    conflicts.append({ key, base: base_v, source: source_v, target: target_v })

  ; === 6. Resolve or abort ===
  if conflicts is nonempty and no resolution covers every conflict:
    rollback T1
    return { success: false, conflicts }

  ; === 7. Replay ===
  merge_op_id := deriveMergeOpId(sourceBranchId, targetBranchId, fork_seq)
    ; Pure function. BM-6 retained.

  ; Idempotency short-circuit: if an edit with execution_id = merge_op_id-0
  ; already exists on target, the merge has been replayed before.
  existing := SELECT 1 FROM ontology_edit
              WHERE execution_id = merge_op_id || "-0"
              AND branch_id IS NOT DISTINCT FROM targetBranchIdOrNullForMain
  if existing: rollback T1; return success with mergedEditCount=0, idempotent=true

  resolved_values := { key: chosen_value for each (key, chosen_value) in resolutions + convergent }

  for each source_edit in source_edits in commit_seq order:
    ; Apply resolved_values for any key that was a conflict or convergent.
    ; Skip properties where resolution chose "target" (= no-op replay).
    effective := apply_resolutions(source_edit, resolved_values, resolutions)
    if effective is empty and not a delete:
      continue

    INSERT INTO ontology_edit (
      ontology_id_fk, branch_id, object_type_api_name, primary_key,
      operation, property_values, link_edits, action_type_api_name,
      execution_id, action_parameters, executed_by, edit_strategy
    ) VALUES (
      ontologyId, targetBranchIdOrNullForMain, edit.objectType, edit.primaryKey,
      edit.operation, effective, [], 'branch_merge',
      merge_op_id || '-' || i, {}, mergedBy ?? 'system', 'branch_merge'
    )
    mergedCount++

  ; === 8. Mirror to OpenSearch ===
  for each (objectType, primaryKey) touched by the replay:
    write document with __branch = targetBranchIdOrNullForMain
    ; F-P3-13 invariant: every doc stamps __branch; per F-P3-12 the
    ; associated link_edits already carry branch_id on insert.

  ; === 9. Audit emission (F-P3-11 durable-before-ack) ===
  append_audit_entries(merge_op_id, mergedCount, conflicts_resolved, mergedBy)
  if audit_write failed: raise AuditDurabilityError → HTTP 503

  ; === 10. Branch bookkeeping ===
  UPDATE ontology_branch SET status='MERGED', merged_at=now() WHERE branch_id=sourceBranchId
  UPDATE ontology_proposal SET status='MERGED', merged_at=now()
    WHERE branch_id=sourceBranchId AND status='APPROVED'

  commit T1
  return { success: true, mergedEditCount, conflicts: [], merge_op_id }
```

### §3.base-value-read — how `populateBaseValues` works

For each `key = objectType::primaryKey::propertyName` in the collision set, walk backwards through PG history to find the **last non-null value at or before `fork_seq`**, scoped to the source branch's ancestry chain:

```
SELECT DISTINCT ON (object_type_api_name, primary_key, property_key)
       object_type_api_name, primary_key, property_key, property_value
  FROM (
    SELECT object_type_api_name, primary_key, commit_seq,
           (jsonb_each(property_values)).key   AS property_key,
           (jsonb_each(property_values)).value AS property_value
      FROM ontology_edit
     WHERE ontology_id_fk = $1
       AND commit_seq <= $2   -- fork_seq
       AND (branch_id = $3 OR branch_id IS NULL)   -- target or main
  ) expanded
 WHERE (object_type_api_name, primary_key, property_key) IN (<collision tuple list>)
 ORDER BY object_type_api_name, primary_key, property_key, commit_seq DESC
```

This is the shape, not the exact query — the `IN (<tuple list>)` needs materialisation via `unnest` or a temp table when the collision set is large. The reviewer should verify the index strategy (`idx_ontology_edit_commit_seq` exists; a covering `(ontology_id_fk, commit_seq)` composite may be needed).

**Edge case:** a property that never existed at `fork_seq` and was added on both branches to different values — base is `undefined`, both sides "added-new". Per §4 this is a conflict (the added-on-both case); the algorithm emits a conflict with `baseValue: undefined` that is explicitly marked `baseAbsent: true` so the UI / caller can distinguish.

### §3.conflict-equality

The equality function is `canonicalJson` from `src/services/audit/canonicalJson.ts`, already in use for BM-3. Contract:

- JSON key order: irrelevant (canonicalJson sorts keys).
- Numeric types: `1 ≠ "1"` (types are preserved in canonical form).
- Nested objects: deep-equal after canonicalisation.
- Arrays: **ordered equality** — `[1,2] ≠ [2,1]`. UNVERIFIED ASSUMPTION; see §6 Q6 — Foundry may treat some array-valued properties as sets, in which case the equality function needs a property-schema hint.
- `null` vs missing: `{x: null}` is not equal to `{}`; canonicalJson emits `"x":null` in the first and omits it in the second.

### §3.concurrency — advisory lock scope

Key: `hashtext("tellus.merge.v2." || targetBranchId)`.
Scope: transaction (released on COMMIT or ROLLBACK).
Semantics: a second `*→targetBranchId` merge waits at the lock. On wake it re-reads the target; if the wanted source's `execution_id = merge_op_id-0` already exists, it no-ops (idempotent replay). If not, it proceeds with fresh source state (the intervening merge may have changed what conflicts).

The `v2` suffix is new — it distinguishes the rewritten algorithm's lock from the BM-5 legacy `tellus.merge.<branchId>` lock so that during a grace period both run without blocking each other. §6 Q3 asks the reviewer whether the migration should enforce an atomic lock-key cutover instead.

### §3.audit — payload shape

Per-replayed-edit audit entry:
```
{
  event_type: "branch_merge.edit_replayed",
  merge_op_id,
  source_branch_id, target_branch_id, fork_point_commit_seq,
  object_type, primary_key,
  operation,                        ; create | update | delete
  resolved_keys: [key1, key2, …],   ; the conflict keys this edit touched
  resolution_choices: { key1: "source", key2: "target", … },
  merged_by,
  edit_execution_id                  ; = merge_op_id-<i>
}
```
Appended via the F-P3-11 hash-chain durable-before-ack path. The merge call returns success only after every audit entry's `hash_chain_row_id` is committed.

### §3.failure-modes

1. **PG commit succeeds, OpenSearch write fails.**
   Reconciliation responsibility: the F-P3-15 indexing-pipeline worker replays `ontology_edit` rows with `indexed_at IS NULL`. The merge returns success after PG commit; it does not wait for OpenSearch. `tellus_merge_opensearch_lag_seconds` gauge (new) surfaces the lag. UNVERIFIED ASSUMPTION that F-P3-15 consumer handles the `branch_merge` action_type — the reviewer should confirm.

2. **PG commit succeeds, audit write fails.**
   The merge returns 503 (`AuditDurabilityError`, F-P3-11 shape). The PG edits are committed — which is the right outcome because the F-P3-11 verifier will detect the missing audit entries and alert. No rollback of edits (that would violate `durable-before-ack`'s forward-progress guarantee).

3. **Conflict detected, caller did not supply resolution.**
   Transaction rolls back, HTTP 409 with the `conflicts[]` array in the body. No partial replay.

4. **Race — two concurrent source→target merges.**
   First acquires the lock; second blocks; on wake second observes the replayed edits via `execution_id = merge_op_id-0` and no-ops. Returns `{ success: true, mergedEditCount: 0, idempotent: true }`.

5. **Race — source→target and different-source→target.**
   Second waits; on wake its fork_seq is unchanged (fork points are immutable), but its source_edits are unchanged too. Second runs normally. The second merge may discover new conflicts against the target history (which now includes the first merge's replays). That is correct three-way behavior.

6. **Retry with same `merge_op_id` after partial commit.**
   The `execution_id = merge_op_id-0` exists → idempotent no-op.

---

## §4 — Edge Cases the Algorithm Must Handle

Each line: scenario → behavior → source (patent / Foundry docs / Tellus-specific / UNVERIFIED).

1. **Property added on source only, not present on target, not present at base.**
   Not a conflict. Source wins (fast-forward). *Patent (paraphrased); UNVERIFIED.*
2. **Property added on target only, not present on source, not present at base.**
   Not a conflict. Target retained. *Patent (paraphrased); UNVERIFIED.*
3. **Property modified on both to same value.**
   Convergent. Replay `source_v`. *BM-3 closure; landed.*
4. **Property modified on both to different values, both differ from base.**
   Conflict. Caller must supply resolution. *Patent (paraphrased); UNVERIFIED.*
5. **Property deleted on source, modified on target.**
   Conflict. Caller resolves. *Patent col. 9 (per audit's paraphrase); the "deletion-reinsert" class; UNVERIFIED.*
6. **Property deleted on target, modified on source.**
   Conflict. Caller resolves. *Symmetric; UNVERIFIED.*
7. **Property deleted on both.**
   Convergent. Replay delete once. *Trivial; no source.*
8. **Object deleted on source, target has a link pointing to it.**
   Consistent with F-P3-12's cascade cleanup: the delete replays, and the dangling link is handled by the existing `linkViolationEnforcer` cascade on the next link-edit pass. The merge itself does not cascade. *Tellus-specific; F-P3-12 §(h) cross-branch cleanup exemption.*
9. **Link added on source, target of link deleted on target branch.**
   Replay creates an orphaned link. The F-P3-05 CASCADE behavior (currently OPEN) or the F-P3-06 reverse-link RYW lag path handles it. §6 Q7 asks the reviewer whether the merge should reject preemptively. *UNVERIFIED — depends on F-P3-05 outcome.*
10. **Concurrent `source1→main` and `source2→main`.**
    Serialised by advisory lock. Second may find new conflicts against first's replays. *Standard VCS; §3.concurrency.*
11. **Retried merge with same `merge_op_id`.**
    Idempotent no-op via existing-execution-id check. *BM-6 closure + §3.10.*
12. **Criss-cross merge topology: A forked from main, B forked from A, `A→main` and `B→main` run concurrently.**
    Each merge's advisory lock is keyed on `main`. They serialise. Second merge's `fork_seq` points at B's original fork (from A), but A's edits have now been merged into main — so B's source_edits still show B's own history and target_edits show main-including-A. The algorithm works if `populateBaseValues` correctly walks the ancestry chain via `branch_id = target OR branch_id IS NULL` (the scope used in §3.base-value-read). §6 Q8 asks the reviewer to confirm the ancestry walk is correct for chains longer than 2. *UNVERIFIED — classical VCS edge case, needs reviewer.*
13. **Markings diverged between source and target for the same object.**
    Default: union (Foundry docs; Tellus-specific §2.1). Caller may pass `markingPolicy: "intersection" | "sourceWins" | "targetWins"` — audited as a policy decision. Implementation note: markings live on `object_instances.marking_ids` (F-P3-18 CBAC surface) and are not in `property_values`; the merge must JOIN them separately. §6 Q9. *Foundry docs for default; CBAC-bound; UNVERIFIED in detail.*
14. **Property modified on source to `null`, unchanged on target.**
    Not a conflict. Source wins. `null` is a legitimate value, not absence. *Tellus-specific — canonicalJson preserves `null`.*
15. **Property that never existed at base, added on both branches to different values.**
    Conflict. Emit with `baseAbsent: true` flag so UI distinguishes. §3.base-value-read edge case.

---

## §5 — Test Plan

Each line is a test case, not test code. Co-authored in a follow-up packet.

**Algorithm (pure, unit):**
1. Base value present, source and target converge → no conflict, replay once.
2. Base value present, source changes, target unchanged → auto fast-forward.
3. Base value present, target changes, source unchanged → auto no-op replay.
4. Base value present, both change to different values → conflict.
5. Base absent (added on both), same value → convergent.
6. Base absent (added on both), different values → conflict with `baseAbsent: true`.
7. Source deletes property, target modifies → conflict with delete sentinel.
8. Target deletes property, source modifies → symmetric conflict.
9. Both delete the same property → convergent delete.
10. Array value reorder → conflict (ordered semantics). §6 Q6 confirms.
11. Key reorder only → not a conflict (canonicalJson, BM-3).
12. `null` vs missing key → conflict (canonicalJson, BM-3).
13. `1` vs `"1"` → conflict (typed canonicalJson, BM-3).

**Defect regression (one per BM-*):**
14. BM-1 — conflict carries `baseValue` not `undefined`. Negative-test: temporarily revert `populateBaseValues` to a no-op and assert cases 2 and 3 become false-conflicts.
15. BM-2 — fork-point predicate uses `commit_seq > $forkSeq`. Negative-test: temporarily revert to `edit_id > $forkEditId` and assert a UUID-lexicographic ordering violation surfaces (insert an edit with a lexicographically-smaller UUID after the fork point and observe it silently excluded).
16. BM-3 — canonicalJson equality. Negative-test: swap to JSON.stringify and assert the key-reorder case (test 11) becomes a false-positive conflict.
17. BM-4 — map keyed by string literal. Negative-test: swap Map for plain `{}` and assert property name `toString` collides.
18. BM-5 — advisory lock. Negative-test: spawn 2 concurrent merges, remove the `pg_advisory_xact_lock`, assert duplicate `execution_id` insertion rejects with unique-constraint violation (which exposes the race).
19. BM-6 — `merge_op_id` stable. Negative-test: change the hash input to include `Date.now()`, assert replay creates duplicate edits.
20. BM-7 — `mergedBy` recorded. Negative-test: pass `mergedBy="alice"`, assert `executed_by="alice"` on every replayed edit.
21. BM-8 — order by `commit_seq`. Negative-test: `ORDER BY created_at` and assert non-determinism under a time-tie fixture.

**Concurrency (integration):**
22. Spawn N parallel `source_i → target` merges, each with a different source. Assert the target's `ontology_edit` rows after the Nth merge form a prefix-consistent history; no duplicate `execution_id`s.
23. Same source retried 100 times → final state matches single-replay state byte-for-byte.
24. Criss-cross: A forks main, B forks A, `A→main` and `B→main` concurrently. Assert final main == main+A's edits+B's edits (modulo declared conflicts and resolutions).

**Determinism (integration):**
25. Run the same `source→target` merge 100 times from isolated snapshots. Assert identical output (diff byte-for-byte the final `ontology_edit` rows produced).

**Audit (F-P3-11 integration):**
26. Merge emits one `branch_merge.edit_replayed` per replayed edit; hash chain extends; verifier accepts.
27. Simulated audit write failure → merge returns 503, PG edits committed (forward-progress guarantee), verifier flags the gap.

**Branch isolation (F-P3-12 / F-P3-13 integration):**
28. Every replayed edit's `branch_id` equals `targetBranchIdOrNullForMain`; never the source's.
29. Every OpenSearch mirror write stamps `__branch` equal to target.

---

## §6 — Open Questions for the Human Reviewer

1. **Q1 — Patent text access.**
   The algorithm in §3 is derived from the original audit's paraphrase of US10585862B2 col. 9 lines 15-58. The patent text itself was not accessible from this environment. Can the reviewer either (a) supply the column text so the design is verified against it, or (b) confirm that the audit's paraphrase is sufficient for implementation? If (a), the §4 edge cases 1, 2, 4, 5, 6 lose their UNVERIFIED tag; if (b), the tag remains and any later patent-derived challenge is absorbed by re-reading the column at that time.

2. **Q2 — Fast-forward vs. always-conflict on "target changed from base, source didn't".**
   §3 auto-retains target without prompting when only target changed from base. The patent text may require explicit acknowledgement of this class (some VCS systems do — Git's `--ff-only` flag exists for exactly this reason). Should Tellus always auto-resolve these, or should there be a caller-supplied policy flag `onOneSidedTargetChange: "auto" | "prompt"`?

3. **Q3 — Advisory lock key scope and the `v1` → `v2` cutover.**
   Currently BM-5 uses `tellus.merge.<branchId>`. §3.concurrency proposes `tellus.merge.v2.<branchId>` to allow mixed-version coexistence during rollout. The reviewer must decide: does the cutover happen atomically (deploy drains old merges, then switches) or gracefully (both locks coexist)? Graceful coexistence has a subtle bug: an old-lock merge and a new-lock merge can proceed concurrently against the same target. Is the bug acceptable during the drain window, or is atomic cutover required?

4. **Q4 — `merge_op_id` hash inputs.**
   Currently: `(sourceBranchId, targetBranchId, fork_point_commit_seq)`. Does the hash also need to include a content hash of the resolved values, so that a retry with a *different resolution* produces a different `merge_op_id` and is not mistakenly deduped? Current proposal says no — retries with different resolutions are a new merge call from the caller's perspective and should land with a different idempotency-key header. The reviewer may disagree.

5. **Q5 — Authenticated subject → `mergedBy` propagation.**
   Which layer is responsible for passing `mergedBy` from the JWT / session to `mergeThreeWay`? The route handler already has `req.security.subjectId` per F-P3-18 CBAC plumbing. Is the correct thing to (a) extract in the route and pass as a parameter, or (b) read from AsyncLocalStorage inside the service? (a) is more explicit; (b) survives the service being called from non-HTTP entrypoints (workers, CLI, Temporal activities).

6. **Q6 — Array equality semantics.**
   §3.conflict-equality treats arrays as ordered. For some Tellus property types (Markings list, tags) the array is set-valued — order is insignificant. Should the merge consult the property schema (OT-level `property.schema.arrayAs: "ordered" | "set"`) or always use ordered equality and let the UI's resolver surface a "these look equivalent" hint?

7. **Q7 — Link to deleted target (edge case 9).**
   Should the merge reject preemptively when it detects a replayed link whose target was deleted on the target branch, or should it let F-P3-05 cascade handle it on the next link-edit pass? The former is stricter; the latter is faster. Both are defensible. Tellus's eventual-consistency posture leans toward the latter, but the reviewer's VCS experience may land elsewhere.

8. **Q8 — Criss-cross merge correctness (edge case 12).**
   §3.base-value-read walks `branch_id = target OR branch_id IS NULL`. For a B-forked-from-A-forked-from-main topology, when `A→main` completes, main's history now contains A's edits. When `B→main` runs, its base walk must include main's history up to `fork_seq_B` (which is A's `commit_seq` at the time B was forked). The query predicate `commit_seq <= fork_seq_B` inside branch_id filter should work, but only if A's replayed edits on main have `commit_seq` values greater than `fork_seq_B` (i.e., they were inserted after B's fork). Is this guaranteed by the BIGSERIAL semantics? Reviewer please confirm.

9. **Q9 — Markings merge semantics.**
   Default union is stated as Foundry-documented. Are there Tellus use cases where intersection is correct (e.g., declassification workflow)? If so, should the default be "explicit-policy-required" rather than "union-by-default"?

10. **Q10 — Audit emission on conflict-abort.**
    A merge that aborts due to unresolved conflicts currently emits no audit entry. Should there be a `branch_merge.conflict_detected` audit record? Pros: investigators can see who tried to merge what and why it didn't go through. Cons: high-volume on noisy branches, audit cost.

11. **Q11 — What happens to the source branch's `status` when the merge is idempotently-replayed (no-op)?**
    The first merge sets source `status = MERGED`. A second idempotent retry observes the same `execution_id`, no-ops, returns success. Should it still re-touch `merged_at`? Currently no (the UPDATE is skipped in the no-op path), but a reviewer may argue for updating `merged_at` to reflect the latest observed merge time.

12. **Q12 — `fork_point_commit_seq IS NULL` handling.**
    Legacy branches created before migration 042 may have NULL `fork_point_commit_seq`. §3 proposes rejecting the merge with a specific error code rather than treating NULL as "since beginning of time." Is this acceptable, or does the design need a bulk-backfill operational step (and at what risk — bad backfills produce silent-wrong-merge-inputs)?

---

## §7 — Implementation Plan

Ordered by risk × dependency. No timelines. Review produces the go/no-go on each.

1. **Migration 042** — already committed and backfilled (this tree). `fork_point_commit_seq` is populated on all existing branches; `commit_seq` is NOT NULL on `ontology_edit`. Verify before starting §2.

2. **Pure algorithm scaffolding.** Extract `detectConflicts`, `populateBaseValues`, `canonicalJson` comparisons into side-effect-free functions that take (source_edits, target_edits, base_values) and return `{ conflicts, convergent }`. All test cases 1-13 and 14-21 exercise these pure functions without PG. Unit-test first, 100 % branch coverage target before proceeding.

3. **PG integration — predicate fix (BM-2) and base-value read (BM-1).** Swap the two query predicates from `edit_id > $forkPointEditId` to `commit_seq > $fork_seq`. Add `populateBaseValues` with the SQL from §3.base-value-read. This phase must be mergeable and tested against a Docker-backed PG before proceeding.

4. **Advisory-lock v2 cutover.** Switch to `tellus.merge.v2.<branchId>`. Per Q3, decide with reviewer on atomic vs graceful. Implement the decided path.

5. **Replay loop.** Wire `resolutions`, `convergent`, and `merge_op_id-<i>` execution-id generation. The existing BM-6 / BM-7 plumbing stays; BM-1 / BM-2 feed the inputs.

6. **OpenSearch mirror write.** Per §3 step 8. Reuses the F-P3-13 `__branch`-stamped write path — the merge writes look identical to any other branch-scoped write from the index's perspective.

7. **Audit integration.** Per §3 step 9 and F-P3-11 hash-chain. Fails-the-merge-to-503 on audit durability failure.

8. **Concurrency + idempotency tests.** Cases 22-29 require Docker-backed integration harness.

9. **Deprecation of old `mergeThreeWay`.** Once the new path has passed canary at N% traffic for M merges (reviewer decides N, M), remove the old BM-5 `v1` advisory lock; remove the `fork_point_edit_id` column (migration 044 will be the schema cutover).

**Dependencies:**
- Phase 2 depends on nothing beyond migration 042.
- Phase 3 depends on Phase 2.
- Phase 4 depends on Q3's answer.
- Phase 5 depends on Phases 2-4.
- Phases 6-7 depend on Phase 5.
- Phase 8 depends on Phases 2-7.
- Phase 9 depends on Phase 8 canary data.

---

*End of design document. This document's scope is reconnaissance; implementation begins in a separate packet after human review.*
