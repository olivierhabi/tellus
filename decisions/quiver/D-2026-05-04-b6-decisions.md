# Quiver B6 Decisions

Decisions taken during T-07 (B6 — OSS Object-Set Backend).

## D-30 — Ship `OssPort` + in-repo `InProcessOssAdapter`; production swaps at boot

**Ambiguity.** The brief specifies a Conjure-generated OSS client, but the
Tellus monorepo has no Conjure code-gen pipeline yet (per **D-07**, contract
shapes are zod + OpenAPI in this stack). Direct HTTP-to-OSS in B6 would
hard-couple the backend to a specific transport.

**Options.**
1. Hand-write an HTTP client in B6 against the OSS REST surface.
2. Define an `OssPort` interface; ship `InProcessOssAdapter` for tests; defer
   production transport.
3. Block on Conjure code-gen pipeline.

**Chosen.** Option 2. The interface is the contract; production swaps in a
real client via `setOssPortForTests()` at boot. Backend logic, limits,
metrics, branch propagation are all transport-independent.

**Why.** Decision-Protocol default: most-restrictive interface surface so
future swap-in is mechanical. Same precedent as B5 stub backends (D-28).

**Reverts when.** Conjure code-gen lands.

**Touches.** B6 C-01..C-13.

---

## D-31 — Limits enforced in BOTH the port and the backend

**Ambiguity.** Should size/depth limits be enforced in `OssPort` (so a real
HTTP client hitting an OSS-side 400 surfaces as a typed Error), or in
`OssBackend` (so the in-process path can simulate the same surface), or both?

**Chosen.** Both. `InProcessOssAdapter` raises `OssLimitExceededError` for
the limits the real OSS would reject; `OssBackend.executeObjectSet` /
`executeFilter` / `executeAggregation` also raise it pre-dispatch when the
declared cardinality exceeds the threshold.

**Why.** Decision-Protocol default: more-restrictive validation in two
layers is more auditable. The real OSS client will surface
`OssLimitExceededError` only when the backend validation didn't already.

**Touches.** B6 C-03, C-04, C-05.

---

## D-32 — Aggregation default mode `PREFER_SPEED`

**Ambiguity.** None — the spec is explicit. Recorded for traceability.

**Chosen.** Default `PREFER_SPEED`; `PREFER_ACCURACY` opt-in via
`card.config.aggregation.mode`. The backend reads
`config.aggregation?.mode === "PREFER_ACCURACY" ? "PREFER_ACCURACY" : "PREFER_SPEED"`.

**Touches.** B6 C-06.

---

## D-33 — `canApplyAction` BEFORE `applyAction` (no inversion)

**Ambiguity.** Could the OSS adapter do the canApplyAction check inside
applyAction (single round-trip)? Saves a network hop.

**Chosen.** Two-call gate: backend calls `canApplyAction` first, denial
raises `ActionApplyForbiddenError` synchronously, only on success does
`applyAction` get called.

**Why.** Decision-Protocol default: more auditable. Fits the spec verbatim
("validates user has applyAction permission via OMS BEFORE delegating").
Even though it costs a hop, the audit log captures the denial cleanly and
the action never enters the partially-applied state.

**Touches.** B6 C-08.

---

## D-34 — `userSubject` plumbed via `BackendExecuteInput.userSubject`

**Ambiguity.** Where does the authed JWT subject enter the backend's call
context? Options: (a) parameterOverrides (user-supplied — spoofable);
(b) request envelope (route-supplied); (c) a thread-local context.

**Chosen.** Option (b). `ComputeCardRequest` and `BackendExecuteInput`
gain an optional `userSubject` field. Route reads from the actor (Multipass
JWT or test header), passes through executor → backend.

**Why.** Decision-Protocol default: more auditable + Foundry-faithful (auth
context flows with the request). Test-only fallback to
`parameterOverrides.__user__` exists for unit tests that drive `OssBackend`
directly without a route.

**Touches.** B6 C-08, G-04.

---

## D-35 — `PROPERTY_VALUE_SELECT` capped at 100 distinct values

**Ambiguity.** The spec mentions "no excessive sampling that could leak
PII" but doesn't pin the cap.

**Chosen.** Hard cap at 100 values, regardless of `topN`. `truncated: true`
flag set when input `topN` exceeds the cap.

**Why.** Decision-Protocol default: most-restrictive. Caps PII exposure for
high-cardinality string columns; users can request top-25 / top-50 freely.

**Touches.** B6 PROPERTY_VALUE_SELECT execution.

---

## D-36 — `SEARCH_AROUND` depth tracked structurally

**Ambiguity.** "Depth in single coordinator request" could mean
single-DAG-walk depth, single-card-traversal depth, or recursive definition
depth.

**Chosen.** Recursive definition depth: walks the chained `definition`
following `kind === "searchAround"` links through `src`. Limits enforced
pre-dispatch (`InProcessOssAdapter.searchAround` throws when
`depthOf(src) + 1 > 3`).

**Why.** Mirrors how OSS itself accounts depth (per definition graph, not
per call). Consistent with the spec's wording "depth > 3 in single
coordinator request".

**Touches.** B6 C-05.
