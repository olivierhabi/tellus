# ADR — Quiver B9: AIP Logic Service Integration

**Status:** ACCEPTED — 2026-05-05
**Phase:** 5
**Owner:** Quiver Drive

## Context

B9 wires AIP Logic Service into Quiver, exposing three LLM-mediated surfaces:

1. **Generate** — natural-language prompt → proposed sub-DAG (preview).
2. **Configure** — natural-language refinement of an existing card's config.
3. **Assist** — chat-style help over the analysis (read-only).

Tools (functions exposed to the LLM) are **strictly authorization-aware**: an
LLM may not propose `apply_action` for a user without `applyAction` permission.
The manifest filter is the boundary; per-invocation re-checks defense-in-depth.

## Decision

- **InProcessAip** adapter substitutes for the native AIP Logic Service client
  until the phase-5 boundary swap (mirrors B6/B7/B8 pattern).
- SSE transport for streaming tokens (B9 C-04).
- Trace recorded in `quiver_aip_trace` (migration 069) with `surface`,
  `prompt_hash`, `model`, `tokens_in/out`, `cost_usd_micros`, `tools_called`,
  `branch`, `created_at` for cost attribution + audit.
- Property-value hint cap at 100 distinct values per slot, sample size at 1000
  rows max (B9 C-08; PII-safe by construction).
- Tool authorization: filtered at manifest build time using
  `Compass.canApplyAction` per candidate action; second check at invocation
  boundary returns `LLM_TOOL_UNAUTHORIZED` if drift.

## Decisions

- **D-59** InProcessAip until phase-5 boundary
- **D-60** SSE over WS for streaming (HTTP/2 friendly, no separate gateway)
- **D-61** prompt_hash (SHA-256 truncated to 16 hex) recorded; raw prompt NOT
  persisted (PII safety)
- **D-62** Per-tool counter `aipToolUnauthorizedTotal{tool}` for both filtered
  and refused invocations

## Tests

- Unit: tools manifest filter, property-hints cap + sample, SSE framing
- Integration: route 200/400/401/403/504 + SSE; manifest excludes
  `apply_action` for unprivileged user
- Cypress: live-API smoke
