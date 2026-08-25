# Absorbed-Event Visibility Semantics — Position Paper (OSv2 serving edge)

Status: DECIDED (canary rollout run). Scope: the `LINK_INDEX_ACK_REQUIRED`
statusUrl contract and the (future) drift reconciler. This is a DESIGN
position — it changes no code; it unblocks the reconciler workstream.

## 1. The two predicates and which surface uses which

The serving table is `ReplacingMergeTree(event_version)` keyed by
`(tenant_id, ontology_id, branch_id, source_pk, target_pk)`. Visibility for
the statusUrl has been "this exact `event_id` is readable" — meaning a later
write to the same edge that absorbs the older row (a *legitimate* merge
collapse) reads as `PENDING` even though the edge's final state has been
reached and exceeded. That conflates *the event's effect is queryable* with
*this exact row is present*; they are not the same thing.

- **Exact-row** — `countIf(event_id = X) > 0`. Simple, sound, the
  deadline-bounded barrier's natural measure; wrong as the *definition* of
  "the audit effect is queryable" once merges happen.
- **Absorbed-by-successor** — `countIf(event_id = X) > 0` OR a row for the
  same `(scope, source_pk, target_pk)` exists with `event_version > X.version`
  such that its final-state arm subsumes `X`'s intent. Absorption by a
  successor is *inclusion*, not loss: the successor's state dominates the
  edge, and `X`'s mutation contributed to that fold.

| Surface | Predicate | Why |
|---|---|---|
| statusUrl `indexVisibility` | **exact-row, sticky-monotonic** | Pollable, client-facing, simple and one bounded CH probe per scope. Sticky verdict (migration 159) pins a real VISIBLE forever; absorb-by-successor is more work and a new vocabulary welded irreversibly into the 202 contract. |
| Write-barrier `confirmEdgeIndexVisibility` | **exact-row** | The barrier runs *before* the successor can be written — there is no successor to be absorbed-by yet. |
| Sticky verdict (migration 159) | **exact-row → permanent** | Presence of the row = "some exact-row proof once confirmed this." A merge collapse afterward cannot revoke it. |
| Future drift reconciler | **absorbed-by-successor** | Its whole job: classify drifted outbox events as benign-absorbed vs. genuinely-lost (§3). |

## 2. What the probe needs to evaluate absorbed-by-successor

The status probe's existing join already carries the edge identity — no
new table, no schema change:

```sql
SELECT le.event_id, le.link_type_api_name, le.ontology_id, le.branch_id,
       le.source_primary_key, le.target_primary_key, le.operation,
       o.tenant_id, o.outbox_seq
  FROM link_edit le
  JOIN link_cdc_outbox o ON o.event_id = le.event_id::uuid
 WHERE le.execution_id = $1 AND o.dead_lettered_at IS NULL
```

Plus, per (scope, link_type), one aggregate against the same serving table:

```sql
SELECT source_pk, target_pk, max(event_version) AS max_version
  FROM <link table> WHERE <scope filter>
```

The classifier compares the event's *confirmed* version (the barrier already
records it as `confirmed_event_version` in `link_edge_watermarks`, migration
157) against the per-edge `max_version`. What is NOT in `link_cdc_outbox` and
must be re-read at classification time is the event's *own* version (the MV
assigns `event_version` at insert, e.g. `now64(3)`); `link_edge_watermarks`
is the durable source for "the version the barrier once confirmed," so the
classifer keys off it, not off the volatile serving row.

## 3. How the reconciler classifies gate 8's 36 drifted events

Given a drifted outbox event (published, not dead-lettered,
`count(event_id) = 0` in the serving table):

1. **absorbed-benign** — a successor row exists for the same
   `(scope, source_pk, target_pk)` with `event_version > the event's
   original confirmed version`, and the fold of all operations ≤ that
   successor's version reproduces the current argMax-latest arm. Examples: an
   ADD absorbed by a later ADD to the same edge; an ADD absorbed by a later
   REMOVE of that edge (the event's "add" effect is now cancelled by a
   NEWER intent, which is exactly the requested end-state). Action: **mark
   reconciled, no re-ingest.**
2. **genuinely-lost** — no successor for the edge exists, OR the current
   state does NOT subsume the event's intent (an ADD whose edge is now absent
   with no later REMOVE on that edge). Action: **republish / re-ingest with a
   fresh `event_version`.**

Gate 8's 36/40 were almost all category 1 (the synthetic `OPTIMIZE FINAL`
forced every older event_id to collapse). The detector today reports them as
"missing event_id," which is what makes the raw drift report read like a
data-loss incident — and is exactly why the position paper exists. The §3
classifier is what converts "36 drifted" into "36 benign-absorbed +
0 genuinely-lost" (or whatever the real split is in steady-state traffic).

## 4. Should statusUrl return VISIBLE for an absorbed event IN THIS RUN?

**No — exact-row stays; absorbed-successor is reconciler-MVP scope.**

- Adding absorbed-successor to the probe doubles cold-poll latency for a
  marginal semantic win (extra per-edge max_version reads + a final-state
  comparison) and cannot be reported in the flat `VISIBLE | PENDING`
  vocabulary the 202 client depends on. That pair stays.
- The wart is bounded. Permanent-PENDING for an *absorbed* event requires
  three things at once: the exact row died between the barrier's pass and the
  first poll, no sticky row already exists (i.e. no prior VISIBLE poll AND
  no in-band 200 confirmation — meaning the original apply was itself a 202),
  AND no successor is ever visible to its idempotent client retry. At canary
  write rates (~10/min re-writes to hot edges) that subset is sub-1%; the
  soak measured it (the forced-`OPTIMIZE FINAL` cases against the live
  backlog produced absorbed-but-still-PENDING counts in single digits per
  thousand). The idempotent client retry — whose resolved state is the
  *final-state edge read*, not the audit verdict — covers the residual.
- What is NOT acceptable is *monotonicity loss* (VISIBLE → PENDING
  regression). The sticky verdict — and now the write-barrier sticky — kill
  that. Absorbed-successor as a *statusUrl* verdict waits for the reconciler;
  until then an absorbed 202 stays honest-PENDING, not silently-VISIBLE.

**Deliverable of this paper:** the reconciler implements the §3 classifier
against the §2 SQL (no schema change); the statusUrl contract does not
change. A future pass MAY introduce a third verdict (e.g. `INHERITED`) when
the classifier is reliable enough to fold it back into the poll —
deliberately deferred now because coupling the 202 poll to merge semantics
clients should not need to know.

— Final-run author, canary rollout for `LINK_INDEX_ACK_REQUIRED`.
