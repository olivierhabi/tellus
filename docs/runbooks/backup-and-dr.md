# Backup & Disaster Recovery Runbook

**Scope:** single-tenant Tellus deployment (one PostgreSQL database per customer).
**Status:** baseline procedure introduced to close audit finding D-03 ("no backup/restore process in-repo"). Operators MUST adapt the RPO/RTO targets and the PITR section to the actual managed-Postgres provider in use.

---

## 1. What must be backed up

| Asset | Mechanism | Owner |
|---|---|---|
| **Primary PostgreSQL** (`PGDATABASE`) — all ontology, dataset, auth, connectivity, quiver state | Logical dump (`scripts/backup-db.sh`) **plus** provider PITR/WAL archiving | Platform |
| **Credential vault material** — the KEK (`TELLUS_LOCAL_KEK_B64`) or the external KMS key | Secrets manager / KMS backup (NOT in the DB dump) | Security |
| **Object store** (S3/MinIO uploaded datasets) | Bucket versioning + lifecycle / cross-region replication | Platform |
| **OpenSearch indices** | Rebuildable from Postgres via reindex; snapshot optional | Platform |

> The Postgres dump does **not** contain the vault KEK. A restore without the matching KEK leaves connectivity credentials undecryptable. Back up and restore the KEK/KMS key alongside the database, and keep them in separate trust domains.

---

## 2. Targets (set per customer SLA)

| Metric | Baseline target | How it is met |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 min | Provider WAL archiving / PITR. Logical dumps alone give RPO = dump interval. |
| **RTO** (max downtime) | ≤ 1 h | Restore latest base + replay WAL, or `pg_restore` the latest dump. |
| **Backup frequency** | Hourly logical dump + continuous WAL | `backup-db.sh` on a cron/k8s CronJob + provider PITR |
| **Retention** | 14 days local, 35 days in object store | `BACKUP_RETENTION_DAYS` + bucket lifecycle |
| **Restore drill** | Quarterly | §5 |

---

## 3. Taking a backup

```bash
PGHOST=… PGPORT=5432 PGDATABASE=tellus_db PGUSER=… PGPASSWORD=… \
  BACKUP_S3_URI=s3://acme-tellus-backups/db \
  scripts/backup-db.sh
```

The script writes a compressed `pg_dump --format=custom` archive, **verifies it parses** (`pg_restore --list`), optionally uploads to object storage, and prunes local archives past the retention window. Schedule it as a Kubernetes `CronJob` (hourly) with the DB creds injected from the secrets manager — never baked into the image.

A logical dump is portable and supports selective restore, but its RPO is only as good as its interval. **For a tight RPO you must also enable continuous archiving (PITR)** on the managed Postgres (RDS automated backups / Cloud SQL PITR / pgBackRest / wal-g). This runbook assumes both layers exist.

---

## 4. Restoring

### 4a. Full logical restore into a fresh database

```bash
createdb -h "$PGHOST" -U "$PGADMIN" tellus_db_restore
pg_restore \
  --host="$PGHOST" --username="$PGADMIN" \
  --dbname=tellus_db_restore \
  --no-owner --role="$PGUSER" \
  --jobs=4 \
  tellus_tellus_db_20260601T120000Z.dump
```

Then: (1) restore/point the app at the KEK/KMS key that matches this dump, (2) run `pnpm run migrate` to confirm the schema is at head (the migration gate also asserts this on boot), (3) reindex OpenSearch, (4) cut traffic over.

### 4b. Point-in-time recovery (tightest RPO)

Use the provider's PITR to roll a base backup forward to a target timestamp (just before the incident). Logical dumps are the fallback when PITR is unavailable or the target predates WAL retention.

---

## 5. Quarterly restore drill (the part most teams skip)

A backup that has never been restored is a hypothesis, not a backup.

1. Provision a throwaway DB.
2. Run §4a against the **latest** archive from object storage (not a local copy).
3. Boot the app against the restored DB with a test KEK; confirm the migration/schema-contract gate passes and `/health/ready` is green.
4. Spot-check: list ontologies, decrypt one connectivity credential (validates KEK pairing), run one quiver analysis read.
5. Record the measured RTO and any deviation. File a ticket for any step that required manual fixup.

---

## 6. Reverse-migration policy

Roughly half the migrations under `src/migrations/` ship without a `.down.sql` / `down()` counterpart, so a forward migration that must be rolled back may not be reversible by the migration tool. Policy going forward:

- **Every new migration MUST ship a paired down migration** (or an explicit, reviewed `-- IRREVERSIBLE: <reason>` marker for genuinely one-way data changes, e.g. a destructive backfill).
- A migration with no down and no IRREVERSIBLE marker should fail review.
- For irreversible migrations, the rollback plan IS this runbook: restore from the last backup taken **before** the migration ran. Therefore: **always take an on-demand backup (`scripts/backup-db.sh`) immediately before applying a migration in production.**

---

## 7. Related security posture (for the enterprise reviewer)

- **CSRF (audit D-12):** Tellus does not use a CSRF token. State-changing requests are protected by (a) the `TELLUS_TOKEN` session cookie being `SameSite=Strict` in production and (b) CORS being fail-closed in production (no origin reflected unless explicitly allow-listed via `CORS_ORIGINS`). Do not introduce any `SameSite=None`/`Lax` cookie path for an authenticated session without adding a CSRF token first.
- **Secrets at rest:** the KEK and DB/superadmin credentials must be injected at runtime from a secrets manager/KMS, never persisted to a `.env` on a production host (audit F-03). The vault already refuses the local in-process KEK adapter in production unless explicitly opted in.
