# Workshop k6 SLO Load Tests

Per spec §B01..§B10, every endpoint has a per-task SLO target. The brief's Definition of Done requires `P50/P95/P99` recorded and pasted into `progress/T-XX.md` per endpoint.

## Prerequisites

```bash
brew install k6                # or: docker run -i grafana/k6 ...
export WORKSHOP_BASE_URL=http://localhost:4000  # or wherever your stack runs
export WORKSHOP_JWT=<a-valid-multipass-token>
export WORKSHOP_FOLDER_RID=<a-test-folder-rid>
export WORKSHOP_ONTOLOGY_RID=<a-test-ontology-rid>
```

## Running

Each script is self-contained:

```bash
k6 run tests/load/B01-module-crud.js
k6 run tests/load/B02-validate.js
k6 run tests/load/B03-resolve.js
k6 run tests/load/B05-object-set-load.js
k6 run tests/load/B08-aggregate.js
k6 run tests/load/B10-apply.js
```

Each prints a per-endpoint `P50/P95/P99` table at the end and exits non-zero if any P95 misses the spec target. Plumb the JSON output (`--out json=results.json`) into your dashboard of choice for tracking.

## SLO targets (from spec §B01..§B10)

| Endpoint | Target P95 |
|---|---|
| B01 GET /modules/{rid} | 180ms |
| B01 PUT /modules/{rid} | 250ms |
| B02 POST /modules/_validate | 80ms |
| B03 GET /resolve/latest | 80ms |
| B03 GET /resolve/dev | 80ms |
| B05 POST /object-sets/_load | 800ms (pageSize ≤ 1000) |
| B06 GET /object-types[/{id}] cache hit | 60ms |
| B06 GET /object-types[/{id}] cache miss | 400ms |
| B07 (filter compile) | 20ms (CPU-bound) |
| B08 POST /object-sets/_aggregate | 1s (PREFER_SPEED, ≤1000 buckets) |
| B10 POST /actions/_validate | 250ms |
| B10 POST /actions/_apply | 900ms |

## Status

These scripts are scaffolds. They run k6 against the stated endpoints with synthetic payloads matching the spec's accepted shapes. They are **not** a complete substitute for a sustained production-traffic shape — for that you need k6's `scenarios:` with weighted ramps, which is a follow-on.
