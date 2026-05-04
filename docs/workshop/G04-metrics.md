# G-04 — Workshop Prometheus Metrics Endpoint

**Endpoint**: `GET /workshop/api/v1/metrics`
**Auth**: bypassed by `globalAuth` for the metrics surface (see existing `/api/metrics` precedent in `src/middleware/globalAuth.ts:136`).
**Content-Type**: `text/plain; version=0.0.4; charset=utf-8` (set from `prom-client`'s `register.contentType`).
**Source**: `src/routes/workshopModules.ts:847-883`.

## What this endpoint exposes

Every Workshop metric registered against the `prom-client` default registry by `src/services/workshop/metrics.ts`. Per spec §0.4: histograms end in `_seconds`, counters end in `_total`, gauges have no suffix, all labels are low-cardinality (no per-RID labels — exemplars instead).

| Family | Metric names | Owner task |
|---|---|---|
| Module CRUD | `tellus_workshop_module_load_seconds`, `_save_seconds`, `_create_seconds`, `_delete_seconds`, `_list_seconds`, `_etag_mismatch_total`, `_size_bytes` | B01 |
| Validator | `tellus_workshop_validate_seconds`, `tellus_workshop_validate_total` | B02 |
| Versioning + Resolve | `tellus_workshop_publish_seconds`, `tellus_workshop_resolve_seconds`, `_resolve_cache_hit_total`, `_resolve_total` | B03 |
| Object set load | `tellus_workshop_object_set_load_seconds`, `_load_total` | B05 |
| OMS facade | `tellus_workshop_oms_lookup_seconds`, `_oms_cache_hit_total` (label: `kind`, `result`) | B06 |
| Filter compiler | `tellus_workshop_filter_compile_seconds` | B07 |
| Aggregation | `tellus_workshop_aggregate_seconds`, `_aggregate_total`, `_aggregate_groupby_kind_total` (labels: `kind`, `property_type`) | B08 |
| Action types | `tellus_workshop_action_type_create_seconds`, `_create_total` | B09 |
| Apply | `tellus_workshop_apply_seconds`, `_apply_total`, `_apply_stale_object_total` (labels: `phase`, `result`) | B10 |

## Alerts

| Alert | Trigger | Severity | Page who? |
|---|---|---|---|
| `WorkshopMetricsScrapeFailing` | The `up{job="workshop-metrics"}` Prometheus scrape returns 0 for ≥5min | P2 | On-call SRE |
| `WorkshopMetricsCardinalityExploded` | The Prometheus tsdb head series count for `tellus_workshop_*` grows >5x baseline in 1h | P2 | Workshop service owner |

The first alert is a generic scrape-down alert against this endpoint. The second guards against accidentally introducing per-RID labels (forbidden by §0.4) — if a future change starts emitting `tellus_workshop_*{rid="ri.workshop..."}`, cardinality blows up.

## Diagnose

1. **Endpoint returns 503**: prom-client failed to import. Check the deploy: `npm ls prom-client` should show the version pinned in `package.json`.
2. **Endpoint returns 200 but body is empty / missing families**: the corresponding service module hasn't been hit yet, so its metric hasn't observed anything. Generate a request against the relevant route and re-scrape.
3. **Metric values look stuck**: prom-client's default registry collects in-memory; on a process restart, all counters reset. Check the deployment age — counters of "0" right after a rollout are normal.
4. **A new metric isn't showing up**: the metric is created on import via `makeHist`/`makeCounter` in `src/services/workshop/metrics.ts`. If the creating module is tree-shaken out, the registry won't know about it. Add an `import "../services/workshop/metrics"` near the top of `src/server.ts` if needed (already done implicitly via the route imports).

## Remediate

1. **Endpoint down (503)**: `npm install prom-client@<pinned>` and redeploy.
2. **Cardinality explosion**: revert the offending commit. Cardinality is a contract — `git log -p src/services/workshop/metrics.ts` to find the breach.
3. **Scrape failure but endpoint healthy**: check the Prometheus scrape config — the path is `/workshop/api/v1/metrics`, not `/metrics` or `/api/metrics`.

## Test coverage

- **Integration**: `tests/integration/workshop/G04-metrics-endpoint-integration.test.ts` — asserts 200 + `text/plain` + exposition format markers + per-family metric presence after observation.
- **Unit**: `tests/unit/workshop/metrics-emission-unit.test.ts` — asserts that calling the wrapped service functions actually increments the right metric (catches the "metric defined but never emitted" regression).

## Related

- `src/routes/workshopModules.ts:847-883` — endpoint implementation.
- `src/services/workshop/metrics.ts` — metric definitions.
- Each B-task runbook (`docs/workshop/B01.md` .. `B10.md`) — per-task metric → SLO mapping.
