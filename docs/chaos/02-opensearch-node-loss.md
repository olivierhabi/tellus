# Chaos Runbook: 02-opensearch-node-loss

See `ops/chaos/02-opensearch-node-loss.yaml` for the manifest.

## Scenario

See Appendix E of `tasks/Prodution-rediness.md` for scenario description.

## Expected behaviour

See the matrix in Appendix E.

## Abort criteria

- Any Sev-1 during the window.
- User-visible 5xx rate > 1%.
- Data-integrity check fails.

## Measurement

- MTTD (via Prometheus alert firing time).
- MTTR (until synthetic probe returns to green).
- Blast radius (count of failing endpoints).

## Remediation of findings

File P0/P1 per Appendix E.2. Fix before next scheduled drill.
