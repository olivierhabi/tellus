# Tellus SLOs

Authoritative SLO contract for Tellus. Confirmed via override prompt Q3.

| Metric | Target | Window | Burn-rate alert |
|---|---|---|---|
| Reads throughput | 200 req/s | 1 minute | — |
| Actions throughput | 50 req/s | 1 minute | — |
| Read p99 latency | < 250 ms | 5 minutes | yes |
| Action p99 latency | < 800 ms | 5 minutes | yes |
| Availability | 99.9% | 30 days | 2%/1h, 5%/6h, 10%/24h |

Measured from `tellus_http_request_duration_seconds` histograms (Block G) per route class.

Burn-rate alert rules: `ops/prometheus/alerts/slo-burn-rate.yml`.
Dashboards: `ops/grafana/slo-dashboard.json`.
