# Synthetic Monitoring

External probes (Pingdom / Datadog Synthetics / in-house) run every 60 seconds from outside the K8s cluster.

## Canary endpoints

1. `GET /health` — expect 200.
2. `GET /api/v1/ready` — expect 200 + all dependency statuses OK.
3. `GET /api/v1/ontology/${TEST_ONTOLOGY}/objects/TestType/known-pk` — expect 200 + known payload.
4. `POST /api/v1/ontology/${TEST_ONTOLOGY}/objects/TestType/search` — deterministic query; expect 200 + expected hit count.
5. Low-frequency scratch Action: `POST /api/v1/actionTypes/scratchAction/apply` — expect 200 + audit row created.

## Alert thresholds

- 3 consecutive failures on any probe → page primary.
- p99 of synthetic > SLO + 25% over 15 min → page primary.
- Any probe 5xx → page primary.

## Canary data

Scratch ontology `__canary__` seeded at staging + production. Managed by the SRE team.
