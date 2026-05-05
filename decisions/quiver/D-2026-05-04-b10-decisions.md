# Decisions — B10 Publishing (Dashboards / Visual Functions / Templates)

Date: 2026-05-04 (continued through 2026-05-05)

## D-63 — Compass-write is the source of truth; rows tombstoned on failure

**Ambiguity:** spec calls for Compass to register the published artefact, but
silent on what happens if Compass write fails *after* the local
`quiver_published_*` row is inserted.

**Options considered:**
- (a) Two-phase commit across Postgres + Compass.
- (b) Compass-first; Postgres row only on success.
- (c) Postgres-first with `compass_status` column; tombstone on failure;
  user retries with a new `Idempotency-Key`.

**Choice:** (c). Decision-Protocol defaults: production safety
(fail-loudly), more auditable (preserves the failed attempt), more
restrictive (tombstoned row blocks reuse). Two-phase commit across an
external service (Compass) is brittle and not in our toolbox.

**Implication:** idempotency replay of the original key returns the
*failed* envelope (per G-04 byte-identical replay). User must mint a
fresh key on retry once Compass is healthy.

**Touches:** B10 C-01, B10 C-02, B10 C-09.

## D-64 — Visual Functions are immutable per `(rid, version)`; consumers pin

**Ambiguity:** "consumed by another analysis" — is the consumer reading
the *latest* version or a pinned version?

**Choice:** consumers pin via `bindInput.visualFunctionVersion`. New
publishes allocate `version + 1`; old versions remain readable forever.
Decision-Protocol default: more restrictive + more auditable.
Mirrors `B4` named-version semantics.

**Touches:** B10 C-03, B10 C-04, B10 C-05.

## D-65 — Templates are content-addressable

**Ambiguity:** spec says "reusable template" but silent on naming /
deduplication.

**Choice:** template `rid` derived from SHA-256(canonicalised sub-DAG).
Two publishes of the same sub-DAG return the same RID; no duplicate
storage. Decision-Protocol default: more deterministic.

**Touches:** B10 C-06, B10 C-07.

## D-66 — Embed registration idempotent on `(dashboard_rid, surface, parent_rid)`

**Ambiguity:** what happens if the same embed is registered twice
(e.g. browser double-submit)?

**Choice:** unique index on `(dashboard_rid, surface, parent_rid)`;
duplicate insert returns `409 Tellus:Quiver:IdempotencyKeyReplay` per
G-04. No new error code. Embed parameters bound to the dashboard at
embed time and stored on the embed row, not the parent.

**Touches:** B10 C-08.

## D-67 — Idempotency-Key required on every publish path

Per G-04 universal default — but flagged here because publishing has
the highest cost-of-failure (visible to non-Quiver users).

**Touches:** every B10 mutating endpoint.
