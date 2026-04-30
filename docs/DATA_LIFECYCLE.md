# Data Lifecycle

## Retention

| Category | Retention | Archive tier |
|---|---|---|
| Audit rows (hash-chained) | 7 years | Iceberg on cold S3 after 12 months |
| Object instances | Indefinite (business data) | Iceberg snapshots retained |
| Link edits | Indefinite | — |
| CBAC decision log | 2 years | Cold S3 |
| Read-audit rows | 2 years (volume management) | Cold S3 |
| Kafka CDC topics | 14 days (messaging) | Topic retention config |
| Logs | 30 days hot, 365 days archive | S3 |

## Right to be forgotten

Per Law 058/2021, tax records are legally retained for 7 years and RTBF does NOT override that. For non-audit personal data:

1. Create RTBF ticket linking the subject's identifier.
2. Pseudonymize PII columns on `object_instances` where not required for legal retention.
3. Log the RTBF action in audit chain (itself permanent).

## Legal hold

Per-object legal-hold toggle is a business operation not implemented in code today. Placeholder: `object_instances.legal_hold BOOLEAN DEFAULT FALSE` via future migration. Under legal hold, any DELETE attempt throws `LEGAL_HOLD_ACTIVE`.

## Archival

Monthly job promotes audit rows older than 12 months to Iceberg cold tier. Deleted only after legal retention expires.
