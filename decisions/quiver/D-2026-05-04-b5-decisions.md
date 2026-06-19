# D-2026-05-04 — B5 Decisions

## D-25 — Inline-only cache; large results rejected
- Ambiguity: spec mentions a 64 KB inline path and a Blobster blob path.
- Options:
  (a) Implement both paths now (Blobster = S3 in this stack; new GC sweep).
  (b) Inline-only; reject > 64 KB at write-time.
- Chosen: (b). Decision-Protocol default — "more restrictive". Blob path follows once the cache surface ships behind the phase-2 flag.
- Evidence that would change it: real workload reveals > 1 % of card results exceed 64 KB.
- Touches: B5 C-04 (inline-vs-blob storage decision).

## D-26 — OTel trace event for compute deferred
- Ambiguity: B5 C-15 calls for sampled OTel trace events per compute call.
- Decision: defer until the OTel rollout phase wires the ingestion path. Until then, the per-cardType / per-backend / per-cache Prometheus surface (B5 C-13) carries the observability load.
- Evidence that would change it: OTel collector reaches the cluster.
- Touches: B5 C-15.

## D-27 — `INLINE` is a valid backend label
- Ambiguity: G-09 forbids high-cardinality backend labels; some card types are pure CPU and have no remote backend.
- Decision: introduce `INLINE` as a fixed seventh value. Total bounded set: `OSS | MMDP | POLARS | CODEX | FUNCTIONS | AIP_LOGIC | INLINE`.
- Evidence that would change it: a future card type that requires a new bounded backend identity.
- Touches: G-09, B5 C-13.

## D-28 — Stub backends ship with B5; B6/B7/B8/B9 swap them in-place
- Ambiguity: B5 lands before its real backends. Without backends, B5 cannot be tested end-to-end.
- Decision: every cardType gets a deterministic-echo stub backend in `stubBackends.ts`. The stub's `resultType` matches the registry's declared output so cache-key derivation and DAG planning are exercised against a realistic surface.
- Evidence that would change it: a real backend ships and replaces the stub via `BackendRouter.register()`. The `stubBackends.ts` symbol is then unimported in production, leaving only test usage.
- Touches: B5 C-03.

## D-29 — `dispatch` raced against `withDeadline`
- Ambiguity: spec says DEADLINE_EXCEEDED at the boundary, not at completion. A backend that ignores `remainingMs` would still satisfy the spec literally but violate it operationally.
- Decision: every dispatch is wrapped in `withDeadline(deadline, fn)`, which races the backend promise against a `setTimeout` rejection on the remaining budget. This guarantees the boundary semantics regardless of backend behavior.
- Evidence that would change it: a backend that *requires* observing slow completion for correctness (none in v1).
- Touches: B5 C-09, G-06.
