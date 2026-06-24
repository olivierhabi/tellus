# ADR — Quiver F7: Time-Series Plot Renderer (FE-only)

**Status:** Accepted — 2026-05-04
**Phase:** 4 (closes Phase 4 FE surface)
**Scope:** FE-only per D-23.

## Context

F7 is the time-series viewport that consumes B8's bucketed payloads.
All BE surface (`POST /compute/cards` for ts cards, `GET /compute/timeseries/:token`)
is already shipped under T-14 (B8). F7 contracts F7 C-01..C-09 are
client-side rendering and interaction concerns.

## FE deliverable mapping (parallel in `tellus-fe/`)

| Contract | File | Note |
|---|---|---|
| F7 C-01 | `frontend/timeseries/Canvas.tsx` | OffscreenCanvas branch; main-thread fallback. |
| F7 C-02 | `frontend/timeseries/lttb.ts` | Mirrors `src/services/quiver/compute/ts/bucketing.ts` LTTB so client can downsample if upstream returns > 1000. |
| F7 C-03 | `frontend/timeseries/Axes.tsx` | Auto-detect shared y when `unit` field matches. |
| F7 C-04 | `frontend/timeseries/Scrubber.tsx` | Drag/wheel/double-click/arrow handlers. |
| F7 C-05 | `frontend/timeseries/state/xAxisGroupSlice.ts` | Redux slice keyed by `xAxisGroupId`. |
| F7 C-06 | `frontend/timeseries/Tooltip.tsx` | Settings panel: range/min/max/avg toggle. |
| F7 C-07 | `frontend/timeseries/ColdSkeleton.tsx` | Polls `GET /compute/timeseries/:token` every 1 s until 200; on 410 surfaces "session expired, refresh chart". |
| F7 C-08 | `frontend/timeseries/streaming.ts` | Per-axis SSE/WS toggle; keeps other axes' caches warm. |
| F7 C-09 | `frontend/timeseries/perf.bench.ts` | 60 fps × 12 axes × 1000 buckets gating CI. |

## Decisions

- **D-57** — Client-side LTTB matches the server's algorithm byte-for-byte (deterministic ties) so hover values agree. Reversal evidence: visual-fidelity testing shows perceptible drift.
- **D-58** — Tooltip default = `range` per UX precedent in Workshop charts. Reversal evidence: analyst feedback.

## Verification

- F7 C-01..C-08 covered by ADR fallback (D-24).
- F7 C-09 (SLO) deferred to GATE-02 phase boundary (D-17).
