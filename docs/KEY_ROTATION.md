# Key Rotation

| Key | Cadence | Mechanism | Downtime |
|---|---|---|---|
| PG password | 90 days | External Secrets + rolling restart | 0 (connection pool re-auth) |
| S3 credentials | 90 days | External Secrets | 0 |
| Keycloak client secret | 90 days | External Secrets + Keycloak Admin API | 0 |
| JWT signing key | 90 days | Multi-key JWKS (old valid 7d after rotation) | 0 |
| WebAuthn relying-party key | 365 days | K8s Secret rotation + Keycloak config | 0 |
| KMS data-encryption key | 365 days | KMS key ring multi-version | 0 |
| Audit WORM anchor signing key | 365 days | KMS rotation | 0 |

All rotation flows execute without deploy. See `docs/SECRETS.md` for vault paths.

Custodians: security team + DBA. Dual-control on production rotations.
