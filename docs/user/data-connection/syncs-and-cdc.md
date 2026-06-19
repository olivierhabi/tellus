# Syncs and CDC

A **sync** materialises external data into a Tellus dataset. Two modes:

* **Snapshot** — full re-read at the configured schedule, using Iceberg's
  `replacePartitions` so readers always see a consistent snapshot.
* **Append** — incremental, watermark-driven. Each run reads rows where the
  watermark column is strictly greater than the last committed value.

A **CDC stream** continuously consumes a PostgreSQL logical replication slot
and writes a canonical changelog to a Kafka topic, plus an Iceberg changelog
table consumable by Funnel.

## Wizards

* `/data-connection/sources/:rid/syncs/new` — snapshot/append (F5).
* `/data-connection/sources/:rid/cdc/new` — CDC, gated by replication-slot
  pre-flight (F6).
* `/data-connection/sources/:rid/syncs/:syncRid` — run history + live build
  via SSE + error triage (F7).

## CDC pre-flight

Before letting an operator create a stream, Tellus checks:

1. `wal_level = logical`
2. `max_replication_slots` has at least one free slot
3. The publication exists (or will be created with `pg_create_subscription`).

If any check fails, the wizard surfaces the reasons and refuses submit.

## Throughput SLOs

* Snapshot: 1 M rows in <90 s (B5 load test).
* CDC: 3 000 events in <5 s (B7 load test).
* Funnel indexing: 1 B objects, 16 shards (B9 load test).

Numbers are recorded under `tasks/postgres-connection/B{5,7,9}/PERF.md`.
