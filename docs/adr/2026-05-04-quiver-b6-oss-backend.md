# ADR — Quiver B6: OSS Object-Set Backend

- **Status:** Accepted
- **Date:** 2026-05-04
- **Phase:** 2 (Compute Core)
- **Task:** T-07 (B6)
- **Upstream deps:** T-01 (B1), T-02 (B2), T-06 (B5)

## Context

B5 (T-06) shipped the compute coordinator with stub backends for every card
type so the dispatch path could be exercised end-to-end. B6 replaces the
stubs for the six OSS-bound card types with a real backend that talks to
Object Set Service (OSS): `OBJECT_SET`, `FILTER_OBJECT_SET`, `SEARCH_AROUND`,
`AGGREGATION`, `PROPERTY_VALUE_SELECT`, `ACTION_BUTTON`.

The existing Tellus monorepo does not yet provide a Conjure-generated OSS
client. Per **D-30** (this ADR), B6 lands as the contract surface plus an
in-repo `InProcessOssAdapter` that supplies deterministic in-memory behavior.
Production swaps in a real Conjure client via `setOssPortForTests()` (or the
equivalent production wiring in `compute/context.ts`) once the Conjure
client is available — no further changes to backend or coordinator logic.

## Decision

**B6 ships behind `TELLUS_QUIVER_PHASE >= 2` (same gate as B5).** The
implementation is an OssPort-driven backend with the following structure:

```
src/services/quiver/compute/oss/
  ossPort.ts        — interface contract; error classes
  inProcessOss.ts   — deterministic in-memory adapter (D-30)
  ossBackend.ts     — CardBackend implementation (one per OSS-bound type)
  instrumentedOss.ts — Proxy wrapper recording prom-client metrics
```

Routing wiring lives in `compute/context.ts`: the OSS-bound card types are
filtered out of the stub-backend list and replaced with `OssBackend` instances
that share a single instrumented `OssPort`.

### Decisions

- **D-30 InProcessOssAdapter** — `OssPort` is the contract; production
  Conjure-generated client is deferred until that codegen lands. The
  in-repo adapter ships with options for deterministic test injection
  (`forcedCardinality`, `forcedStorageGeneration`, `permittedActions`,
  `throwError`). Decision-Protocol default: most-restrictive interface
  surface so swap-in is mechanical.

- **D-31 OSS limits enforced in BOTH layers** — limit checks happen in the
  port adapter (so a real OSS that raises an HTTP 400 surfaces as a typed
  Error) AND in `OssBackend` (so the in-process path can simulate the
  same surfaces). Decision-Protocol default: more-restrictive validation
  in two layers.

- **D-32 Aggregation default mode `PREFER_SPEED`** — per spec contract
  B6 C-06 verbatim. `PREFER_ACCURACY` is opt-in via
  `card.config.aggregation.mode`. Test asserts both branches.

- **D-33 ACTION_BUTTON: canApplyAction BEFORE applyAction** — the gate
  is checked synchronously before any state-mutating call. Denial throws
  `ActionApplyForbiddenError` with the user subject in the parameters so
  the audit trail captures the user the request authenticated as, not
  the action's caller subject.

- **D-34 userSubject plumbed via BackendExecuteInput** — added an
  optional `userSubject` field to `BackendExecuteInput`/
  `ComputeCardRequest` so the route can pass the authed JWT subject to
  the OSS adapter. Tests use the `parameterOverrides.__user__` fallback
  when running OssBackend in isolation. Decision-Protocol default: more
  auditable (uses authed subject, never user-supplied).

- **D-35 PROPERTY_VALUE_SELECT capped at 100 distinct values** — hard
  cap independent of `topN`. PII-leak guardrail is consistent with the
  spec's "no excessive sampling that could leak PII".

- **D-36 SEARCH_AROUND depth tracked structurally** — depth is computed
  from the chained `definition` (kind === "searchAround" links recursed
  through `src`), not as a separate counter. Limits enforced
  pre-dispatch.

## Consequences

- B5 end-to-end with realistic OSS behavior is now testable; downstream
  tasks (B7, B8, B9, F3..F10) are unblocked.
- Production cutover is a single `setOssPortForTests()` swap when the
  Conjure-generated client lands.
- `InProcessOssAdapter` is **test-only** — production must override.

## Verification

- 16 unit tests (`tests/quiver/unit/b6-oss-backend-unit.test.ts`) cover
  every contract C-01..C-09 in pure-logic mode.
- 10 integration tests (`tests/quiver/integration/b6-oss-route-integration.test.ts`)
  drive the full route → executor → OssBackend → port path.
- Coverage gate green; B6 removed from `PENDING_PREFIXES`.
- `bash scripts/quiver-verify.sh` exit 0 — 32 files / 251 tests passing.
