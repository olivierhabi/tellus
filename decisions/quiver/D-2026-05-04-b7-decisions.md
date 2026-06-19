# Quiver B7 — Decisions

| ID | Ambiguity | Decision | Rationale | Contracts touched |
|---|---|---|---|---|
| D-50 | Polars sidecar (`tellus-quiver-mat-runner`) on UDS / Arrow Flight is out of scope for this iteration. | Substitute `InProcessMatAdapter` (deterministic JS evaluator) behind the same `MatPort` interface; production swaps in the real sidecar without changing call sites. | The contract layer is the test target; production transport is a swap. Mirrors B6's `InProcessOssAdapter` (D-30). | B7 C-12 (deferred) |
| D-51 | `MatLimitExceededError` (50_000-row limit, B7 C-08) currently surfaces as 500 from the executor — the route layer doesn't yet map it to 400 `Tellus:Quiver:TransformTableRowLimit`. | Accept the 500 envelope for now; B10 (publishing path) wires the richer mapping when the dashboards layer needs the cleaner UX. The error name is preserved on `MatLimitExceededError.errorName` so the mapping is one line. | Avoids invasive surgery to the executor's generic error path; the test case for B7 C-08 asserts the error envelope is well-formed. | B7 C-08 (partial) |
| D-52 | Spec says results > 1 MiB go to Blobster; in this slice we have no Blobster integration. | Encode an `arrowBytes`-based `kind: "blob"` payload with a synthetic `ri.tellus.main.blob.<cardId>-<ts>` URI when the inline threshold is exceeded; production's Blobster adapter swaps in via the same call shape. | The boundary check is the testable invariant; the actual upload is an adapter detail. | B7 C-07 |
| D-53 | Spec defines per-card-type result types (TRANSFORM_TABLE, etc.) but the registry's declared output for several mat cards (e.g. EXPRESSION) is `ANY`. | `resultTypeFor()` keeps `EXPRESSION` as `ANY` to honour the registry; the others bind to their natural type so the executor can index by result-type. | The registry is the source of truth; mat-side specialisation only when the registry was non-committal. | B7 C-04 |

## Cross-references
- D-30 (B6 InProcessOss) — sister precedent for in-process port adapters.
- D-17 — load-test SLO measurement deferred to phase boundary.
- D-25 (B5 inline cache) — sets the inline-vs-blob policy.
