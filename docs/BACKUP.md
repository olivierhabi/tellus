# Backup

| System | Cadence | Retention | Encryption |
|---|---|---|---|
| PG | Continuous WAL + daily snapshot | 35 days daily, 7 years WAL for audit | AES-256 at rest + in transit |
| OpenSearch | Daily snapshot to S3 | 30 days | S3 SSE-KMS |
| ClickHouse | Daily snapshot | 30 days | S3 SSE-KMS |
| Iceberg on MinIO | Object versioning enabled | Indefinite for audit, 7 yrs minimum | SSE-S3 |
| Redis | Best-effort RDB + AOF | 24 hours | — (cache only; rebuilt) |
| Kafka | Topic replication factor 3 | Topic-specific (audit=7yr, CDC=14d) | TLS in transit |
| Keycloak | DB = PG; covered by PG backup | Same | Same |

## Legal retention

Rwandan Law 058/2021 requires 7 years minimum on audit/personal data processing logs. The audit chain + object versioning on Iceberg together cover this.

## Encryption keys

See `docs/KEY_ROTATION.md`. Quarterly rotation. Keys held in KMS; rotation is zero-downtime (multi-version key rings).
