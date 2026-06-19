# Decisions — T-03 (B4)

## D-20 — TTL via expires_at column + sweeper function
**Date**: 2026-05-04
**Ambiguity**: Spec specifies `default_time_to_live = 86400` (Cassandra
syntax). Postgres has no native row TTL.

**Options**:
1. `pg_cron` extension — schedule a row-purge.
2. Triggers on insert/select to lazy-delete expired rows.
3. `expires_at` column + `quiver_purge_expired_working_states()` function
   invoked by an external cron / health-check.

**Chosen**: 3. Zero new dependencies; the sweeper is already part of the
deployment surface (cluster cron); the `expires_at` column is queryable
for SLO debugging. The function returns a row count for metric emission.

**Evidence that would change it**: noisy load on the working-state table
creating long-running purge transactions (would push toward `pg_cron` for
chunked purges).

**Contracts affected**: B4 C-10.

---

## D-21 — Revert allocates a new version row
**Date**: 2026-05-04
**Ambiguity**: Spec says revert "loads version blob; writes new analysis
row + new instruction-log entry of type `revert`." Two readings:
(a) write a new instruction-log row (B3 territory), or (b) allocate a
new immutable version snapshot.

**Options**:
1. Truncate later versions (matches some Git-style undo UX).
2. Append a new version row that references the reverted snapshot
   (parent_version = reverted version).

**Chosen**: 2. Auditable & reversible (a revert can itself be reverted).
Matches the spec's "immutable snapshot" language.

**Contracts affected**: B4 C-03.

---

## D-22 — State-ID retry limit is 5
**Date**: 2026-05-04
**Ambiguity**: Spec is silent on retry semantics for PK collisions on
`quiver_working_state`.

**Options**:
1. Infinite retry — masks a deeper entropy problem.
2. Bounded retry; surface failure as 400 with reason.
3. Bounded retry; surface failure as 500 (entropy issue).

**Chosen**: 2 with limit 5. At 64-bit entropy a collision in 5 attempts
is ~2⁻³²·⁵, effectively impossible. Surfacing 400 lets the client retry
with a fresh request.

**Contracts affected**: B4 C-07.
