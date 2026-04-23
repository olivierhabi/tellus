# Restore Drill Protocol

Monthly on staging. One system per drill, randomly selected.

## Pre-drill

1. Announce 48h in advance; coordinate with on-call.
2. Verify staging cluster is healthy.
3. Verify most recent backup exists.

## Drill

1. Record start time.
2. Select system via `scripts/restore-drill.sh select-random`.
3. Delete the data store entirely.
4. Execute restore per system-specific procedure.
5. Verify data integrity via checksum on a known subset.
6. Measure elapsed time vs. RTO target.

## Post-drill

1. Log outcome in `ops/restore-drill-log.csv` (system, date, RTO target, actual, pass/fail, notes).
2. If failure, file P0 incident and fix before next drill.
3. Last 6 drill logs retained externally (S3 Object Lock bucket).

## Automation

`ops/cronjobs/restore-drill.yaml` — K8s CronJob template that invokes `scripts/restore-drill.sh` with a weekly cadence on staging.
