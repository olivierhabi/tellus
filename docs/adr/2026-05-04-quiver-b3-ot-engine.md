# ADR — Quiver B3: Operational Transform Engine

- **Status:** Accepted
- **Date:** 2026-05-04
- **Phase:** 3 (Collab)
- **Task:** T-10 (B3)
- **Upstream deps:** T-01 (B1), T-02 (B2)

## Context

Phase 3 introduces real-time collaboration. The OT engine is the
single mutating entry point that converts client-submitted instructions
into a serialized, replayable history while preserving the convergence
invariant required by the spec (§B3 C-04, C-16).

Phase 1 stored analyses as immutable documents updated via PATCH +
If-Match. Phase 3 supersedes that for in-document edits: every card
mutation, canvas placement, parameter update, etc. now flows through
`POST /quiver/api/v1/analyses/:rid/instructions` and is rebased
server-side against the per-analysis instruction log.

## Decision

**B3 ships behind `TELLUS_QUIVER_PHASE >= 3`.** The implementation is:

```
src/services/quiver/ot/
  instructions.ts   13-variant Instruction discriminated union (zod)
  apply.ts          pure applyInstruction(doc, instr, tombstones)
  transform.ts      transformLocalAgainstRemote(local, remote)
  replay.ts         replay(seed, instructions[]) → canonical doc
  eventBus.ts       in-process collab event bus (Node EventEmitter)
  otService.ts      submitInstructions / readLogSlice (DB + transform)
src/routes/quiver/instructions.ts
                    POST/GET /analyses/:rid/instructions

src/migrations/067_b3_quiver_instruction_log.{sql,down.sql}
                    quiver_instruction_log (rid, seq) PK +
                    UNIQUE (rid, applied_by, client_op_id) for dedup
```

### Conflict resolution rules (per spec §B3 C-05..C-08)

| Rule | Implementation |
|---|---|
| `updateCardConfig` LWW | per-JSON-path; ancestor paths cover descendants (D-41) |
| `bindInput` different slot → merge; same slot → LWW | `lwwBindInputs` per-card |
| `deleteCard` tombstones; future ops drop | `tombstoneCards` set; reused IDs forbidden |
| `placeCardOnCanvas` collision → ±32 px offset | `occupiedPositions` per canvas |
| `addCard`/`addCanvas` duplicate ID → drop | `addedCards`/`addedCanvases` set |

### Threshold for OT_BASE_VERSION_TOO_OLD

**200 ops** (D-44). Below this, the server transforms the client's
batch against the server tail. Above, the server returns 412
`Tellus:Quiver:OtBaseVersionTooOld` and the client must full re-fetch
+ rebase per the F2 protocol.

### Idempotency

Per-`(rid, applied_by, client_op_id)`. UNIQUE index on
`quiver_instruction_log` enforces at the database layer; the route
also early-checks the existing log so re-submissions return the
original `latestSeq` without re-walking the transform pipeline (D-40).

### Audit (B3 C-19)

`emitQuiverAudit({action: "QUIVER_OT_INSTRUCTION_APPLIED"})` is fired
for every accepted instruction (one per row). The action is already
in the `QuiverAuditAction` enum from Phase 1.

### Metrics (B3 C-20)

`tellus_quiver_ot_submit_seconds{result}`,
`..._transform_seconds`, `..._instruction_apply_seconds{type}`,
`..._conflicts_total{resolution}`, `..._duplicate_op_id_total`,
`..._collab_active_sessions{analysisRid}` (cardinality-bounded per
G-09; drop label if > 1000), `..._ws_disconnects_total{reason}`,
`..._instruction_log_seq_lag` gauge.

### Deferred to F8

WebSocket gateway (`/quiver/api/v1/analyses/:rid/stream`),
presence broadcast, cursor positions, and WS auth/close codes
(B3 C-11/12/13) are deferred per **D-42**. The in-process `eventBus`
is the substrate; F8 will add the `ws` transport. The OT engine
already emits `appliedInstruction` and `serverRebase` events on the
bus, so wiring the WS layer is a transport-only concern.

The convergence property test (B3 C-16) lands at unit-test scale
(seeded simulation; 100 rounds × 30 ops/client). The spec calls for
1M-iteration property testing under fast-check; that scaling is
covered by the SLO load gate at the phase boundary (D-17).

## Consequences

- Frontend OT client (F2 spec) targets the same `Instruction` JSON
  shape; the wire contract is shared between client and server.
- Phase 1 PATCH endpoints remain valid for metadata-only updates
  (displayName, description). Card/canvas/parameter mutations now
  prefer the OT path; calling PATCH with a stale `cards` field is
  not blocked but is documented as deprecated for in-card data.
- Replay (B3 C-10) is exercised at unit test scale and at the GET
  endpoint level. End-to-end byte-identical replay against a long
  history is part of the GATE-01 cross-cutting test.

## References

- Spec §B3 (operational transform engine, instruction variants,
  conflict resolution, replay, presence, metrics)
- Decisions: D-40..D-44 in
  `decisions/quiver/D-2026-05-04-b3-decisions.md`
- Runbook: `runbooks/tellus-quiver/b3.md`
- Progress: `tasks/quiver/progress/T-10-B3.md`
