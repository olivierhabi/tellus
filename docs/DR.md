# Disaster Recovery

## RTO / RPO per subsystem

| System | RTO | RPO | Failover |
|---|---|---|---|
| PG primary | 15 min | 0 s (sync repl) | monthly drill |
| PG read replica | restart | — | — |
| OpenSearch | 60 min | 5 min (snapshot) | weekly drill |
| ClickHouse | 60 min | 5 min | monthly drill |
| Iceberg / MinIO | 60 min | 0 (versioning) | monthly object-lock verify |
| Redis | 30 s | any (rebuilt from PG) | weekly pod-kill drill |
| Kafka | 15 min | 0 (RF=3) | monthly broker-loss drill |
| Keycloak | 30 min | 0 (PG-backed) | monthly failover drill |

## Backup cadence

See `docs/BACKUP.md`.

## Restore drill protocol

See `docs/RESTORE_DRILL.md`. Monthly on staging. Drill failure = P0 regression.

## Regional failover

Documented once multi-region is in scope. Single-region today per Block D K8s topology.
