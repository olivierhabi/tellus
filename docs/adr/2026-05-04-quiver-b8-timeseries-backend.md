# ADR — Quiver B8: Time-Series Backend (Codex)

**Status:** Accepted — 2026-05-04
**Phase:** 4 (Time-series & Materialization)
**Upstream deps:** B5 (Compute Coordinator).

## Context

Five Quiver card types target time-series semantics: `TIME_SERIES_PLOT`,
`TIME_SERIES_CHART`, `ROLLING_AGGREGATE`, `EVENT_SET`, and
`TIME_SERIES_FORMULA`. They share a single backend that talks to Codex
through the Conjure-typed `CodexPort` interface.

The spec mandates:

- **Per-axis hydration** (B8 C-03). A `TIME_SERIES_CHART` with N axes
  must trigger N independent jobs. Invalidating axis 1 must leave
  axis 2's cache untouched.
- **Display-time bucketing** (B8 C-02) capped at 1000 buckets per
  series with selectable op (avg/min/max/sum/last/first); an LTTB-style
  defensive downsample when the upstream returns more.
- **Cold hydration** (B8 C-05). First call returns 202 with
  `hydrationToken`; client polls
  `GET /quiver/api/v1/compute/timeseries/{token}`; resolves by SLO
  timeout. 60 s token TTL → 410 once expired (B8 C-09).
- **Branch forwarding** on every Codex call (B8 C-06).
- **Bounded-cardinality metrics** for hydration latency, bucket counts,
  event-detection latency, hydration-timeouts (B8 C-08).

## Decision

### Module layout

```
src/services/quiver/compute/ts/
  codexPort.ts           // CodexPort interface + types
  bucketing.ts           // toBuckets() + ops + LTTB defensive downsample
  inProcessCodex.ts      // in-memory Codex (test harness + dev)
  tsBackend.ts           // ComputeBackend impl for the 5 card types
  instrumentedCodex.ts   // metric wrapper around CodexPort
```

`compute/context.ts` registers `tsBackend` against the 5 card types
behind `setCodexPortForTests` + `buildBackendsWithRealAdapters`. The
production path swaps the in-process port for a Conjure-typed Codex
client without changing the backend or executor.

### Per-axis hydration (B8 C-03)

`TIME_SERIES_CHART` config carries `axes[]` with each axis declaring
its own `seriesRef`, `bucketOp`, and dependency upstream. The backend
issues N parallel `Promise.all(...)` to `CodexPort.hydrateRange` and
caches each axis under its own cache key (cache-key derivation from
B5: `cardId || configHash || sortedUpstreamHashes || branch || ontologyVersion`,
extended with the axis index). Axis-1 invalidation rewrites only that
row.

### Cold hydration (B8 C-05/C-09)

`hydrateRange` may return `{ status: "pending", token, etaMs }`. The
backend forwards 202 + `hydrationToken` upstream and stores
`{ token, expiresAt: now + 60_000, ctx }` in process. The companion
route `GET /compute/timeseries/:token`:

- token unknown / expired → 410 `Tellus:Quiver:HydrationTokenExpired`;
- token still pending → 202 with refreshed eta;
- token resolved → 200 with the buckets payload.

### Bucketing (B8 C-02)

`toBuckets(points, range, count, op)` is pure. `op ∈
{avg,min,max,sum,last,first}`. When upstream returns more than 1000
points the backend defensively downsamples to ≤ 1000 (LTTB-style,
deterministic). Unit tests assert byte-equal output for fixed seeds.

### Metrics

- `tellus_quiver_ts_hydration_seconds{state}` — `state ∈ {warm,cold}`.
- `tellus_quiver_ts_buckets_returned` — histogram of buckets per axis.
- `tellus_quiver_ts_event_detection_seconds` — histogram.
- `tellus_quiver_ts_hydration_timeouts_total` — counter (no labels).

All four are bounded-label per G-09.

## Consequences

- The 5 ts cards share a single execution path; future ts card types
  drop into `tsBackend` without further plumbing.
- Per-axis hydration is observable end-to-end via cache-key inspection.
- Cold hydration is a first-class state, not a workaround; the route
  returns 202 with token rather than forcing the client to retry.

## Deferred

- **B8 C-07** — endpoint p95/p99 load measurement deferred to GATE-02
  (per D-17, load runs at phase boundary, not per-task).
- Native Codex Conjure client wiring deferred until phase-4-end; the
  in-process port is sufficient until Codex compose service ships.
