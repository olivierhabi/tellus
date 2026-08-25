// ---------------------------------------------------------------------------
// Edge-version contract (OSv2 serving-index parity, Stage 7).
//
// THE CONTRACT
// ============
// Every edge event carries ONE authoritative, globally unique, monotonically
// increasing scalar version: `edge_revision`, allocated by the SINGLE
// PostgreSQL BIGSERIAL behind `link_cdc_outbox.outbox_seq` (migration 157),
// allocated inside the same transaction as the domain write.
//
//   CH projection: event_version = edge_revision (outbox_seq)
//   identity:    (tenant_id, ontology_id, branch_id, link_type, source_pk, target_pk)
//
// WHY A SINGLE SCALAR IS ENFORCEABLE (the complete ordering domain):
//   * live CDC      — allocated in the Action transaction (outbox staging);
//   * retries       — same row stays pending; re-promotion uses the SAME row
//                     and the SAME allocated version (outbox is idempotent);
//   * duplicates    — identical replay of an identical (identity, version,
//                     payload): ClickHouse keeps one copy after merge; the
//                     pre-merge argMax is computed between byte-identical
//                     candidates ⇒ deterministic;
//   * out-of-order  — queries read argMax per identity: insertion order is
//                     irrelevant; no wall-clock inputs anywhere;
//   * recreation    — recreation after REMOVE/RETRACT is a NEW event with a
//                     NEWER allocated version, so it wins;
//   * equal-version — CANNOT EXIST BY CONSTRUCTION: the allocating sequence
//                     has a UNIQUE index and a single owner; the only rows
//                     that could share one are byte-identical replays;
//   * clock skew    — the sequence has no clock input; fabricated
//                     event_ts_micros values never affect ordering;
//   * snapshot replay — replaying a stored payload reuses its ORIGINAL
//                     outbox_seq, which is older than every newer live event;
//   * current-truth backfill — stages NEW outbox events atomically with the
//                     snapshot read (see stageBackfillEdges): by construction
//                     the backfilled value IS the latest truth and may win;
//                     backfill of a HISTORICAL snapshot without re-reading
//                     current state is a replay (rule above) and must carry
//                     its original versions.
//   * DB restoration — PostgreSQL DROP TABLE without the sequence could
//                     reset allocation; ensureOutboxSequenceForward() guards
//                     the boot path (setval ≥ max+1).
//   * multi-writer / multi-region — RESERVED layout `(epoch << 42) | seq`
//                     opens the same slot scheme for a per-region epoch; no
//                     implementation yet (single-writer today).
//
// PostgreSQL serializer note: sequence ALLOCATION order can diverge from
// transaction COMMIT order across two overlapping transactions (alloc A<B,
// commit B<A). This does NOT violate the invariants above because the
// invariants are stated causally per stream (alloc order), which is the
// same stream order the single-threaded drain loop publishes in
// (ORDER BY outbox_seq). It is documented as an accepted anomaly about
// inter-transaction causality, bounded by the connection window; it never
// affects replay, backfill, recreation or replay-vs-live invariants.
// ---------------------------------------------------------------------------

/** Compute the serving scalar version for an edge event.
 *  Throws if the event has no defensible identity-order. */
export function edgeEventVersion(input: {
  outbox_seq?: number | null;
  event_ts_micros?: number | null;
}): number {
  const seq = input.outbox_seq ?? 0;
  if (seq > 0) return seq;
  // Legacy (pre-outbox) payload fallback — kept ONLY so a replay of an old
  // snapshot is still replayable. New writers MUST allocate outbox_seq.
  if (input.event_ts_micros && input.event_ts_micros > 0) {
    return input.event_ts_micros;
  }
  throw new Error(
    "edgeEventVersion: missing ordering identity — allocate outbox_seq or replay with the original event_ts_micros",
  );
}

/**
 * Boot-time guard against a table-preserved/sequence-lost DB restore:
 * raises the backing sequence at least above MAX(outbox_seq)+1 so a "new"
 * allocation can never collide with a preserved row and so equal-version
 * rows remain physically impossible. Written as a single statement so the
 * caller runs it through any pg query function.
 */
export const GUARD_OUTBOX_SEQUENCE_SQL = `
SELECT setval(
  pg_get_serial_sequence('link_cdc_outbox', 'outbox_seq'),
  GREATEST(
    s.last_value,
    (SELECT COALESCE(max(o.outbox_seq), 0) + 1 FROM link_cdc_outbox o)
  ),
  true
) AS raised_seq
FROM pg_sequences s
WHERE s.schemaname = current_schema()
  AND s.sequencename = 'link_cdc_outbox_outbox_seq_seq'`;

/**

/**
 * The serving-layer tenant handshake. The write side normalizes "no
 * tenant" to ""; the read side resolves "no tenant" to "default" via
 * resolveRequestTenant(). If these never meet, a scope filter asks for
 * "default" while the rows are stamped "" — the isolation fold makes
 * them INVISIBLE to cross-scope readers. Collapse both surfaces.
 */
export function canonicalTenant(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s === "" ? "default" : s;
}
