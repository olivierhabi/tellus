# ADR — Quiver B5 (Compute Coordinator: Planner, BackendRouter, Cache, Deadlines)

Status: ACCEPTED 2026-05-04
Author: Quiver Drive (Iteration 6)
Phase: 2 (Compute Core)

## Context

B5 stands up the per-card compute coordinator: the surface that translates
"compute card $X with these parameter overrides on this branch" into a
backend dispatch (OSS, MMDP, Codex, Functions, AIP_LOGIC, INLINE), with a
result cache, per-backend circuit breaker, and end-to-end deadline
propagation. The downstream backends (B6 OSS, B7 Polars/MMDP, B8 Codex,
B9 AIP) plug into this surface as `CardBackend` implementations registered
on a `BackendRouter`.

## Decisions

### D-25 — RESULT_TOO_LARGE_FOR_INLINE rejected at write-time (no S3 in v1)

The spec describes a 64 KB inline path and a blob path (Blobster).
Implementing the blob path requires Blobster (S3 in this stack) plus a
new GC sweep. v1 ships only the inline path; payloads larger than 64 KB
fail closed with `RESULT_TOO_LARGE_FOR_INLINE`. Decision Protocol default:
"more restrictive". The blob path is a follow-up item once the cache
surface ships behind the phase-2 flag.

### D-26 — OTel trace event for compute deferred

B5 C-15 calls for a sampled OTel trace event per compute call. The
existing tellus stack does not yet have OTel ingestion wired; once the
OTel rollout phase ships the event surface, the trace event lands as a
small follow-up. Until then, the latency / error / cache / inflight
Prometheus surface (B5 C-13) is the canonical observability path.

### D-27 — `INLINE` is a real backend label

Several card types are pure CPU computations (parameter cards, formulae,
visualization-only cards). The bounded-cardinality rule (G-09) requires
backend labels to come from a fixed set; `INLINE` is added so these card
types can dispatch to a no-op backend without inflating the backend
label space. Confirmed: 7 fixed values total — `OSS`, `MMDP`, `POLARS`,
`CODEX`, `FUNCTIONS`, `AIP_LOGIC`, `INLINE`.

### D-28 — Stub backends ship with B5; B6/B7/B8/B9 swap them in-place

B5 lands before its real backends (B6/B7/B8/B9). To keep B5 testable
end-to-end *now*, every cardType has a `stubBackends.ts` deterministic
echo backend. Stubs are shape-correct (their `resultType` matches the
registry's declared output) so cache-key derivation and DAG planning are
exercised against a realistic surface. The stubs are unregistered when
B6/B7/B8/B9 replace them in their respective iterations.

### D-29 — `dispatch` raced against `withDeadline`

The spec's invariant — DEADLINE_EXCEEDED returned at the boundary, not
at completion — is enforced by wrapping `router.dispatch` in
`withDeadline(deadline, fn)`, which races the backend promise against a
`setTimeout` rejection on the remaining budget. Without this, a backend
that ignores its `remainingMs` field would still satisfy the spec
literally but violate it operationally.

## Cache key (B5 C-04, C-05)

```
configHash = SHA256(canonicalJson(card.config) +
                    canonicalJson(parameterOverrides ∩ parameterDependencies))
cacheKey   = SHA256(cardId || configHash || sortedUpstreamHashes ||
                    branch || ontologyVersionForBranch)
```

`sortedUpstreamHashes` is sorted lexicographically *before* the
concatenation, so the key is stable under input reordering. Verified by
a property test (1000 random shuffles produce identical cache keys).

## Cache behavior matrix (B5 C-06)

| Mode         | Reads cache | Writes cache |
|--------------|------------|-------------|
| READ_WRITE   | ✓          | ✓           |
| READ_ONLY    | ✓          | —           |
| BYPASS       | —          | —           |
| REFRESH      | —          | ✓           |

## Circuit breaker (B5 C-14)

50-call sliding window per `backendName`; trips at ≥ 50 % failure rate
(min 10 calls); 30 s cooldown; first half-open success closes; first
half-open failure reopens with cooldown reset. `CircuitOpenError` does
not count against the breaker (it never reached the backend).

## Test surface

- **Unit:** cache-key property (1000 shuffles), config-hash deps,
  planner topo + cycle, deadline race, circuit-breaker state machine.
- **Integration:** 200 + cache-hit, BYPASS / REFRESH, ontology bump
  invalidation, per-branch cache isolation, NoBackendForCardType,
  AnalysisNotFound, DEADLINE_EXCEEDED at boundary, cache TTL refresh.
- **Chaos:** 100-concurrent deadline storm; backend-unavailable circuit
  trip.

`bash scripts/quiver-verify.sh` exits 0 with these tests; cache-coverage
gate green; B5 removed from PENDING_PREFIXES.

## Deferred (filed in this ADR + coverage exclusion list)

- B5 C-11 (idempotency on POST /compute/cards) — D-25; cache-keying
  already gives idempotent reads for cached results; idempotent writes
  arrive once we wire a real LLM-bearing path in B9.
- B5 C-12 (load-test SLO) — D-17; load tests run at phase boundary.
- B5 C-15 (OTel trace event) — D-26; deferred to OTel rollout.
