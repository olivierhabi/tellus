# Quiver B8 — Decisions

## D-54 — In-process Codex port substitutes for native client until phase-4 end

**Ambiguity:** Spec calls for "Codex" as the time-series backend. Codex is an
existing Tellus service, but its Conjure-typed client lives in the platform
SDK, not in this monorepo's source tree.

**Options:**
1. Inline Conjure codegen + spin up Codex testcontainer.
2. Define a `CodexPort` interface and ship `InProcessCodex` for v1; swap in
   the native client at phase-4 end.

**Chosen:** Option 2.

**Rationale:** Decision-Protocol default — consistency with existing Tellus
conventions (B6 used `OssPort`/`InProcessOss`; B7 used `MatPort`/`InProcessMat`).
Same swap-at-port pattern keeps the executor + backend test surface stable.

**Reversal evidence:** First Codex production deploy will require the native
client; this ADR is reversed when the SDK lands in the workspace.

## D-55 — Default bucket op is `avg`

**Ambiguity:** Spec lists 6 ops (avg/min/max/sum/last/first) but does not name
a default.

**Chosen:** `avg`. Most operationally faithful for line charts; spec example
("rolling aggregate") implies averaging semantics.

**Reversal evidence:** UX research showing `last` is preferred by analysts for
sensor-style data.

## D-56 — LTTB-style defensive downsample triggers above 1000 buckets

**Ambiguity:** Spec says "> 1000 → defensive downsample" but does not specify
algorithm.

**Chosen:** LTTB-inspired (Largest-Triangle-Three-Buckets) with deterministic
ties. Preserves visual shape; widely used in time-series rendering.

**Reversal evidence:** A simpler stride sample suffices and visual fidelity
testing shows no perceptible difference.
