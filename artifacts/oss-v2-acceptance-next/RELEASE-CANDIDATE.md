# OSS v2 release-candidate acceptance

Date: 2026-07-29

Verdict: **READY FOR STAGING**

Score: **96/100**

Implementation commits:

- `f4080c7` — OSS v2 acceptance implementation
- `3da6a67` — overload/request-timeout stability fixes and harness cleanup

## Scorecard

| Area | Score | Evidence |
| --- | ---: | --- |
| Contract and correctness | 20/20 | Build and type-check pass; repository-wide unit suite passes; live object-set, aggregation, context, action, and link paths pass. |
| Security and tenant isolation | 20/20 | Two-tenant adversarial run, property security, principal-bound page tokens, cursor expiry, and revocation/resume pass fail-closed. |
| Durability and subscriptions | 15/15 | One-hour/100-subscription run: 0 lost events, 0 unauthorized events, 0 cursor regressions, 10/10 reconnect-resumes, delivery p99 572 ms. |
| Operational resilience | 14/15 | Saturation now produces typed 409/504 responses without process errors; both nodes remain healthy and recover. One point retained for staging admission-control tuning. |
| Performance and SLO behavior | 12/15 | Fifteen- and sixty-minute steady runs pass. The mixed staging envelope passes at 40 target ops/s (37.07 achieved); 80 target is the measured saturation boundary. The stricter `docs/SLO.md` latency boundary occurs between 7 and 8 target ops/s on this laptop, so production capacity is not claimed. |
| OSDK and compatibility | 10/10 | Generated SDK pack/regeneration, links, cursor expiry, and revocation/resume pass; v1 remains additive and unchanged. |
| Reproducibility and evidence | 5/5 | Isolated two-node stack, populated migration, reindex rollback, test transcripts, compact peak summaries, and SHA-256 manifest are recorded. |

## Mandatory gate summary

| Gate | Result |
| --- | --- |
| Five-minute mixed baseline | PASS — 324 HTTP requests, 0 failures |
| Reindex and atomic rollback | PASS |
| Two-tenant adversarial security | PASS |
| OSDK links, cursor expiry, revocation/resume | PASS |
| Build, type-check, lint, unit tests | PASS |
| One-hour, 100-subscription soak | PASS — 36,344 delivered events, 0 lost/unauthorized/cursor regressions; p99 572 ms |
| Fifteen-minute steady mixed | PASS — 1,940 HTTP requests, 0 failures |
| Sixty-minute steady mixed | PASS — 3,876 HTTP requests, 0 failures |
| Peak and recovery | PASS — bounded saturation at 80 target ops/s; 648/648 recovery requests returned 200 |

## Peak characterization

The normal development rate limit (`200 requests/minute/node`) capped the first
10 ops/s attempt at 229 typed `429 RATE_LIMITED` responses. Capacity
characterization therefore used the Redis-backed limiter with
`RATE_LIMIT_MAX=9000` per minute per node. This permits 300 requests/s across
two nodes, providing 20% admission headroom over the documented combined
200-read/s + 50-action/s target; it does not change handler behavior.

| Target ops/s | Achieved ops/s | Unexpected error rate | Ordinary read p95 | Mixed op p99 | Outcome |
| ---: | ---: | ---: | ---: | ---: | --- |
| 7 | 6.61 | 0% | 52 ms | 219 ms | Strict documented latency SLO pass |
| 8 | 7.54 | 0% | 301 ms | 1,076 ms | First strict documented latency SLO breach |
| 10 | 9.45 | 0% | 164 ms | 1,947 ms | Staging mixed envelope pass |
| 20 | 18.68 | 0.857% | 846 ms | 3,397 ms | Staging mixed envelope pass; typed snapshot backpressure |
| 40 | 37.07 | 0.158% | 815 ms | 3,280 ms | Highest tested staging-envelope pass |
| 80 | 44.77 | 26.872% | 5,012 ms | 5,210 ms | First staging-envelope breach / saturation |

At the initial 80 ops/s saturation point, PostgreSQL reached 209% CPU,
OpenSearch reached 112% CPU, point-in-time contexts reached 300, and the
OpenSearch search pool recorded 8,570 rejections. That attempt exposed:

1. a late action completion trying to send after the request-timeout response;
2. a process crash when a non-string Express route label reached the metrics
   serializer.

Commit `3da6a67` makes late completions response-safe, makes metric labels
total over unknown input values, adds regressions for both paths, and explicitly
unsubscribes the load harness. The fixed 80 ops/s rerun produced only typed
`409 ConsistentSnapshotError` and `504 RequestTimeout` failures, zero
`unhandled_rejection`, zero `uncaught_exception`, and both nodes stayed healthy.

The post-saturation five-minute recovery produced:

- 600 operations / 648 HTTP requests;
- 648 HTTP 200 responses and zero failures;
- ordinary-read p95 326 ms;
- mixed-operation p99 1,240 ms;
- 47 subscription updates, zero subscription errors, and the test subscription
  closed cleanly;
- both API health endpoints returned 200 and no active test subscriptions
  remained after cleanup.

## Staging constraint

Start staging with an admission cap no higher than the measured 40 target
mixed ops/s envelope for this two-node topology. Re-run capacity tests on
staging-sized PostgreSQL/OpenSearch resources before claiming the documented
200-read/s + 50-action/s production throughput target.

