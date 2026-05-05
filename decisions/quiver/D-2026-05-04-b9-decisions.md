# B9 Decisions — AIP Integration

## D-59 — InProcessAip adapter (matches B6/B7/B8 pattern)
**Ambiguity:** Native AIP Logic Service Conjure client not yet generated.
**Chosen:** InProcessAip stub fronted by `AipPort` interface; production swap
via `setAipPortForTests` analogue at the phase-5 boundary.
**Why:** Same pattern as OssPort/MatPort/CodexPort. Zero cross-task coupling.
**Reverts when:** Conjure IR is generated and the production client lands.
**C-IDs:** B9 C-01..C-10.

## D-60 — SSE over WebSocket for streaming tokens
**Ambiguity:** Spec calls for streaming first-token; transport unspecified.
**Chosen:** Server-Sent Events (`text/event-stream`) on the same Express
mount.
**Why:** HTTP/2-compatible; no new gateway; reverse proxies pass-through; one
direction is sufficient (server → client tokens).
**Reverts when:** Bidirectional streaming is added (e.g., live tool-call
intermediate states).
**C-IDs:** B9 C-04.

## D-61 — Persist `prompt_hash`, not raw prompt
**Ambiguity:** Trace persistence vs PII risk.
**Chosen:** SHA-256 of the prompt truncated to 16 hex characters; raw prompt
NOT persisted in `quiver_aip_trace`.
**Why:** Decision-Protocol default is "more auditable" but also "production
safety" — prompts may carry PII. The hash is sufficient for cost attribution
and dedup analysis without leak risk.
**Reverts when:** A retention-class column lets us opt-in retain raw text per
org policy.
**C-IDs:** B9 C-09.

## D-62 — `aipToolUnauthorizedTotal{tool}` covers BOTH filter and refuse paths
**Ambiguity:** Two distinct paths can deny a tool — manifest filtering at
build time vs invocation-boundary refusal under permission drift.
**Chosen:** Single counter, `{tool}` label only. Both paths are denials; the
distinction is observable via `aipToolInvocationTotal` (refuse path increments
both; filter path only the unauthorized counter).
**Why:** Bounded label cardinality per G-09 + a single SLO target.
**Reverts when:** A separate alert needs distinct paths.
**C-IDs:** B9 C-06.
