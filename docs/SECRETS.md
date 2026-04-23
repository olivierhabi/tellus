# Tellus Secrets Management

**Status:** Authoritative. Part of Block D closure for F-P4-25 (no vault
integration; rotation impossible without redeploy).

This document defines every secret Tellus consumes, its vault path, its
rotation schedule, and its incident response. If a secret is not listed
here, it does not exist. If a secret exists in the runtime environment
and is not listed here, that is an audit finding.

---

## 1. Summary table

| Env var                       | Vault path                    | Owner    | Rotation | Grace |
|-------------------------------|-------------------------------|----------|----------|-------|
| `PGPASSWORD`                  | `/tellus/prod/pg`             | DBA      | 90d      | 0     |
| `PGUSER`                      | `/tellus/prod/pg`             | DBA      | 90d      | 0     |
| `S3_ACCESS_KEY_ID`            | `/tellus/prod/s3`             | Platform | 90d      | 24h   |
| `S3_SECRET_ACCESS_KEY`        | `/tellus/prod/s3`             | Platform | 90d      | 24h   |
| `S3_ENDPOINT`                 | `/tellus/prod/s3`             | Platform | never    | —     |
| `KEYCLOAK_CLIENT_ID`          | `/tellus/prod/keycloak`       | Security | 180d     | 24h   |
| `KEYCLOAK_CLIENT_SECRET`      | `/tellus/prod/keycloak`       | Security | 180d     | 24h   |
| `KEYCLOAK_ADMIN_USER`         | `/tellus/prod/keycloak`       | Security | 90d      | 0     |
| `KEYCLOAK_ADMIN_PASSWORD`     | `/tellus/prod/keycloak`       | Security | 90d      | 0     |
| `KEYCLOAK_REALM`              | `/tellus/prod/keycloak`       | Security | never    | —     |
| `KEYCLOAK_URL`                | `/tellus/prod/keycloak`       | Security | never    | —     |
| `JWT_SIGNING_KEY`             | `/tellus/prod/jwt`            | Security | 30d      | 72h   |
| `JWT_SIGNING_KEY_PREVIOUS`    | `/tellus/prod/jwt`            | Security | follows active | — |
| `TEMPORAL_ADDRESS`            | `/tellus/prod/temporal`       | Platform | never    | —     |
| `TEMPORAL_NAMESPACE`          | `/tellus/prod/temporal`       | Platform | never    | —     |
| `TEMPORAL_CLIENT_CERT`        | `/tellus/prod/temporal`       | Platform | 365d     | 30d   |
| `TEMPORAL_CLIENT_KEY`         | `/tellus/prod/temporal`       | Platform | 365d     | 30d   |
| `REDIS_URL`                   | `/tellus/prod/redis`          | Platform | on-incident | — |
| `OPENSEARCH_USERNAME`         | `/tellus/prod/opensearch`     | Platform | 90d      | 0     |
| `OPENSEARCH_PASSWORD`         | `/tellus/prod/opensearch`     | Platform | 90d      | 0     |
| `KAFKA_BOOTSTRAP_SERVERS`     | `/tellus/prod/kafka`          | Platform | never    | —     |
| `KAFKA_SASL_USERNAME`         | `/tellus/prod/kafka`          | Platform | 90d      | 0     |
| `KAFKA_SASL_PASSWORD`         | `/tellus/prod/kafka`          | Platform | 90d      | 0     |

"Rotation" is the mandatory maximum age. "Grace" is how long the previous
value is still accepted by verifiers after rotation — applies to signing
keys and API credentials with read-side verification.

---

## 2. Vault topology

Primary vault: **AWS Secrets Manager** in `af-south-1` (Cape Town). Secrets
are replicated to `eu-west-1` for DR. KMS keys are per-environment
(prod / staging / dev) with separate IAM policies.

Delivery path: Secrets Manager → External Secrets Operator (ESO) →
Kubernetes Secret → Pod env via `envFrom: secretRef`. The Pod's container
never speaks to Secrets Manager directly.

Reload trigger: the `reloader.stakater.com/match: "true"` annotation on
the ESO-managed Secret causes the stakater/reloader controller to
rolling-restart the Tellus Deployment when the Secret changes. Zero-
downtime rollout; no code change required to consume a rotation.

## 3. Rotation procedure

Rotation is orchestrated by **AWS Secrets Manager rotation Lambdas**, one
per secret. The Lambda:

1. Generates the new credential (e.g. `openssl rand -base64 32`).
2. Applies it to the external system (`ALTER USER tellus WITH PASSWORD ...`
   on PG; `kubectl patch clientsecret` on Keycloak; `mc admin user add` on
   MinIO; etc.).
3. Writes the new value back to Secrets Manager under the same key.
4. Marks the old value as `AWSPENDING` for the grace period, then retires
   it.

If the Lambda fails, the rotation is NOT applied; the existing secret
remains active; a CloudWatch alarm fires and pages the primary on-call.
There is no silent rotation failure path.

Manual rotation — if the Lambda is unavailable, `scripts/rotate-secret.sh`
performs the same steps from an operator workstation. The script refuses
to run without MFA and logs to the audit channel.

## 4. Incident runbook

### 4.1 Suspected credential compromise

1. Page: Security primary + Platform primary.
2. Invoke `scripts/rotate-secret.sh --emergency <name>` — forces rotation
   with zero grace window. The Lambda path normally has grace; the
   emergency path revokes the old credential in the external system
   before writing the new one to the vault, so there is a ~1 s window
   where no valid credential exists. Accept this to shut out an attacker.
3. Audit the access log for the compromised credential since its last
   rotation. For PG: `pg_stat_activity` history via `action_audit_log`
   cross-reference. For Keycloak: admin events since rotation.
4. File a Sev-1 incident per `INCIDENT_RESPONSE.md`. Blameless post-mortem
   within 72 hours.

### 4.2 ESO sync failure

1. Check `kubectl describe externalsecret <name> -n tellus` for status.
2. If IAM error: rotate the ESO service account's IRSA trust policy.
3. If Secrets Manager error: check regional outage status; fail over to
   `eu-west-1` replica by editing `SecretStore.spec.provider.aws.region`.
4. If reloader did not restart the Deployment: `kubectl rollout restart
   deployment tellus-api -n tellus`.

### 4.3 Rotation grace expiry mid-request

Signing keys (JWT) have 72h grace. If a verifier receives a token signed
with a key older than the grace window, it returns 401 with
`token_signing_key_retired`. This is expected. Operators verify no
long-lived tokens survive past grace by checking
`tellus_jwt_verification_retired_total` — if non-zero, investigate the
issuer or extend grace by updating the relevant ExternalSecret's
`JWT_SIGNING_KEY_PREVIOUS` retention.

---

## 5. Non-compliance detection

CI job `.github/workflows/secrets-audit.yml` runs on every PR:

1. `trufflehog filesystem --no-verification src/` — fails on any committed
   credential-shaped string.
2. `fs_search "\|\| ['\"](tellus123|minioadmin|password|secret)['\"]"` —
   fails on the hardcoded fallback pattern the Block A remediation
   removed.
3. `grep -rE "process\\.env\\.[A-Z_]+PASSWORD.*\\|\\|" src/` — fails on
   `process.env.*PASSWORD ||` (except inside `requireSecret` which is
   explicitly allow-listed by path).

All three are hard gates; a failed PR cannot merge until cleaned.

---

## 6. Local development

`docker-compose.yml` provides local-only credentials (PG=`tellus/tellus123`,
MinIO=`minioadmin/minioadmin`) via `.env.example`. The app refuses to
start in production mode (`NODE_ENV=production`) with these values because
`requireSecret()` fails closed. Local mode is opt-in via
`NODE_ENV != production`.

There is no "prod-like dev" credential set. Developers who need to test
against a prod-shape deployment get time-boxed read-only credentials
minted from a dev-tier vault path — never shared, never committed.

---

*End of SECRETS.md.*
