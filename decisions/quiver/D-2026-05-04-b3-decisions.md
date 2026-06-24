# D-entries — Quiver B3 (Operational Transform)

## D-40 — Per-(rid, applied_by, client_op_id) idempotency at the database layer

**Context.** B3 C-18 mandates the same client_op_id replays return the
original ack with no double log row.

**Decision.** UNIQUE INDEX `quiver_instruction_log_dedup` on
`(rid, applied_by, client_op_id)`. The route also early-checks the
log so re-submissions skip the transform pipeline entirely and
return the cached `latestSeq`.

**Why.** Two-tier defense: app-layer skip avoids transformer cost;
DB-layer UNIQUE catches races between replicas. Same pattern as B1's
idempotency record (D-04..D-09 in starting-protocol).

## D-41 — JSON-path LWW covers descendants by ancestor match

**Context.** B3 C-05 says "LWW field-level on identical JSON path."
Spec is silent on what happens when remote replaces `/style` and local
adds `/style/color`.

**Decision.** Ancestor wins. If remote LWW set contains `/style`, any
local op on `/style/...` is dropped (`coveringPath()` walks up).

**Why.** Foundry-faithful: remote already replaced the entire object,
so a sub-path patch from local is operating on stale state. The
alternative — keeping local — would resurrect the old object via the
sub-path patch.

## D-42 — WebSocket gateway deferred to F8

**Context.** B3 C-11/12/13 specify a WS endpoint at
`/quiver/api/v1/analyses/:rid/stream`. The OT engine and event bus
are needed before WS transport; F8 (collab client) is the consuming
deliverable.

**Decision.** Ship B3's collab events on an in-process Node
EventEmitter (`collabBus`). F8 will add the `ws`-package transport
and bridge `bus → ws.send()`. The transport split keeps the OT
engine pure (no socket handling).

**Why.** OT correctness must be testable without sockets. The
event bus is a stable seam; F8 only adds transport.

**Evidence to revisit.** A second consumer of collab events (e.g.,
audit-tap) would justify keeping the bus; if WS is the only consumer
forever, fold the WS layer into otService directly.

## D-43 — Canvases as Record<id, Canvas> inside the OT engine

**Context.** AnalysisDocument wire shape has `canvases: Canvas[]`.
The OT engine needs O(1) lookup by canvas id (most ops target one
canvas).

**Decision.** Convert array → record at the otService entry boundary;
record → array at the row write. The internal `OtDocument` interface
declares both as `Record<string, any>`. Insertion order is preserved
by walking `Object.keys()` (which preserves insertion order in JS).

**Why.** Index locality. The alternative — linear scans on every
`placeCardOnCanvas` etc. — would push transform latency above the
spec's 100 ms p99 budget on analyses with 10+ canvases.

## D-44 — OT_BASE_VERSION_TOO_OLD threshold = 200 ops

**Context.** Spec says "mismatch beyond threshold → 412." No
specific number.

**Decision.** 200 ops. Below = transform; above = client must
re-fetch.

**Why.** 200 is comfortably above any plausible burst from a
short-disconnected client (most disconnects are < 30s, < 50 ops).
Above 200, the cost of transforming dwarfs the cost of a re-fetch
(GET /analyses/:rid is sub-50ms warm per B1 SLO).

**Evidence to revisit.** If 412 OtBaseVersionTooOld rate exceeds 1/s
in production, raise to 500 and re-evaluate.

## D-45 — `OtDocument` is the OT engine's internal type, not exported

**Context.** B3 must work with the wire `AnalysisDocument` shape but
needs a looser internal shape (canvases-as-record per D-43).

**Decision.** Declare `interface OtDocument { cards, canvases,
parameters: Record<string, any> }` in `apply.ts`. otService converts
between row shape ↔ OtDocument at the transaction boundary.

**Why.** Keeps the OT engine type-checked at strict mode without
forcing the wire schema to be loose. The conversion functions live
in one place (`canvasArrayToRecord` / `canvasRecordToArray`) and are
unit-testable.
