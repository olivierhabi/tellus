# Tellus Branching — Design Contract

**Status:** Authoritative contract for Block E (branching correctness
closure — F-P3-12, F-P3-13, F-P3-14).

**Regulatory anchor:** Every branch operation produces an audit row via
the hash chain defined in `docs/AUDIT_CONTRACT.md`. Merges in particular
record the merging principal and the full conflict-resolution record.

**Patent reference:** Palantir US10585862B2 columns 9-11 (three-way
merge with fork-point base value, per-property conflict detection,
idempotent replay). This document translates that contract into the
Tellus schema and call graph.

---

## 1. Schema primitives

| Column                              | Added by migration | Purpose |
|------------------------------------|--------------------|---------|
| `ontology_edit.branch_id`          | 035                | Tag every edit with the branch it belongs to |
| `ontology_edit.commit_seq`         | 042                | Monotonic per-edit ordering for fork-point selection |
| `link_edit.branch_id`              | 040                | Tag every link edit with its branch |
| `object_instances.branch_id`       | 041                | Row-level branch isolation on the indexed mirror |
| `ontology_branch.fork_point_commit_seq` | 042           | Points at the commit_seq of the parent branch's latest edit at the moment this branch was forked |
| `audit_hash_head`                  | 036                | Tamper-evident audit for merge replay |

The PKs after migration 041:

```
ontology_edit:  (edit_id)                              — unchanged
ontology_edit uniqueness: (commit_seq)                 — new in 042
link_edit:      (link_edit_id)                         — unchanged
object_instances: (ontology_id, branch_id, object_type_api_name, primary_key)
```

---

## 2. Isolation contract

**Rule 2.1.** A writer on branch B inserts edits with `branch_id = B`.
Readers filtering `branch_id = B` see exactly those writes.

**Rule 2.2.** A reader on branch B sees `B`'s edits PLUS every edit on
`B`'s parent branch up to and including `B.fork_point_commit_seq`.
Edits on the parent AFTER the fork point are NOT visible on B.

**Rule 2.3.** Reads on branch A never observe uncommitted writes from
branch B — the PG transaction model handles this because every write is
inside a single `BEGIN ... COMMIT` and READ COMMITTED isolation
guarantees no dirty reads. Cross-branch visibility is gated by
`branch_id`; cross-transaction visibility is gated by `COMMIT`.

**Rule 2.4.** Search (OpenSearch) enforces isolation at index-naming
time. The index is `ontology-${ontologyId}-${branchId}-${objectType}`.
Queries SHOULD target a single index; queries that span branches must be
explicitly multi-index and MUST include the branch segment in the
`_tenant` filter.

## 3. Merge — three-way, idempotent

Merge of `source` into `target`:

```
  fork_seq = source.fork_point_commit_seq
  source_edits = { ontology_edit WHERE branch_id = source AND commit_seq > fork_seq }
  target_edits = { ontology_edit WHERE branch_id = target AND commit_seq > fork_seq }

  for each (object_type, primary_key, property) touched by either side:
    base_val   = property value at commit_seq = fork_seq
    source_val = latest source_edits.property_values[property]
    target_val = latest target_edits.property_values[property]

    if source_val == target_val:                resolve(either)
    elif source_val == base_val:                resolve(target_val)   # source unchanged
    elif target_val == base_val:                resolve(source_val)   # target unchanged
    else:                                       conflict(source_val, target_val)

  resolved edits replayed into target as new edits, one commit per edit,
  with executed_by = merging principal and execution_id derived from a
  deterministic merge_op_id = SHA256(source || target || fork_seq)
  so retries are idempotent at the commit layer.
```

**Equality for conflict detection** is deep structural equality over the
property_values JSONB, computed through `canonicalJson` from the audit
chain so key-reorder and whitespace differences are NOT conflicts but
numeric-type mismatches (`1` vs `"1"`) ARE conflicts.

**Concurrent merges on the same target** serialize on a PG advisory
lock keyed by `hashtext(target_branch_id)`:

```sql
SELECT pg_advisory_xact_lock(hashtext('tellus.merge.' || :target_branch_id));
```

The second concurrent merger blocks on the lock; once the first
completes, the second observes the updated target and either no-ops
(same merge already applied — idempotent) or proceeds with the new
source state.

**Idempotency**: `Idempotency-Key` HTTP header on `POST
/branches/:id/merge` is honored. A repeated merge with the same key
returns the original response without re-running the algorithm.
`merge_op_id` is deterministic so replays also no-op at the data layer.

## 4. Read-your-writes

After `POST /branches/:id/edits` returns 200, a subsequent `GET
/branches/:id/objects/...` on the same branch MUST see the write. This
is guaranteed because:

1. The write goes into `ontology_edit` AND `object_instances` in one PG
   transaction.
2. The read reads `object_instances` filtered by `branch_id`.
3. Both rows commit atomically.

OpenSearch read-your-writes on the same branch depends on indexing
latency. The SLO is `p95 < 250 ms` from commit to index — see
`docs/SLO.md`.

## 5. Migration runbook

Migrations 040-042 touch core write-path schemas. The deploy sequence:

1. **Alert window.** Announce maintenance 72 hours in advance.
2. **Feature flag.** Set `BLOCK_WRITES=1` in env and restart Tellus.
   Global middleware returns 503 on every mutate route for the duration.
3. **Run migrations.** `pnpm migrate` runs 040, 041, 042 in order.
   Migration 041 takes an `ACCESS EXCLUSIVE` lock on `object_instances`
   and can block for minutes on large tables.
4. **Deploy new application.** The new code assumes `branch_id` is
   present and writes it on every edit.
5. **Unflag.** Clear `BLOCK_WRITES`. Writes resume.

**Zero-downtime alternative** (not implemented in this session): create a
shadow `object_instances_v2` table with the new PK, dual-write for a
burn-in period, atomic alias swap. Documented here for future
implementation; tracked as E-ZDT in `accepted-risks.md`.

## 6. Rollback

`down.sql` files for 040, 041, 042 exist and are tested against a
staging restore. The rollback path:

1. Set `BLOCK_WRITES=1`.
2. Deploy previous application version (no branch_id assumptions).
3. Run `.down.sql` in reverse migration order (042, 041, 040).
4. Unflag.

Synthetic `main` branches and backfill rows are RETAINED on rollback
— removing them could orphan foreign keys. A separate cleanup migration
purges them once all references are gone.

---

*End of BRANCHING.md.*
