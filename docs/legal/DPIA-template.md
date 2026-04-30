# Data Protection Impact Assessment (DPIA) — Tellus Ontology Platform

**Regulatory anchor:** Rwandan Law No. 058/2021 on Data Protection, Articles 20–22.

**Controller:** Rwanda Revenue Authority (RRA).

**Processor:** Tellus platform operator.

**Date:** TBD before production launch.

---

## 1. Processing description

Tellus processes taxpayer identity, transaction, and filing data on behalf of RRA to support tax administration. Data categories:

- Identity: TIN, names, national ID where applicable, contact.
- Financial: declarations, payments, assessments, arrears.
- Audit trails: every read and write with subject, timestamp, hash-chain entry.

Purposes: tax assessment, compliance verification, dispute resolution, legal evidence, statistical reporting.

Legal basis: Rwandan tax law (explicit statutory authority for processing by RRA).

## 2. Necessity and proportionality

Each data category is required to perform the statutory function. Retention aligns with the 7-year legal retention period for tax records.

Data minimization applied at:
- Object-type schema: only fields specified by statute or operational necessity.
- Markings: fine-grained clearance required per dataset.
- RBAC + CBAC: default-deny on every data-plane route.

## 3. Risks to data subjects

| Risk | Mitigation | Residual |
|---|---|---|
| Unauthorized access | Keycloak + WebAuthn MFA, CBAC, Markings, encryption at rest and in transit | Low |
| Data exfiltration | NetworkPolicy restriction, read-audit logs, anomaly detection via synthetics | Medium |
| Integrity tampering | Hash-chained audit (migration 036), tamper-evidence verifier | Low |
| Cross-tenant leak | `ontologyId` prefix on caches + OS indices (F-P5-03 closure in Block D) | Low (single-tenant today; multi-tenant ready) |
| Audit evasion | Durable-before-ack on Action and Branch paths (F-P3-11) | Low |
| Retention overrun | DATA_LIFECYCLE.md documented; monthly archival job | Low |
| Regulatory non-compliance | DPIA + DPA consultation before launch; 72h breach notification | TBD |

## 4. Mechanism choices

| Mechanism | Choice | Rationale |
|---|---|---|
| Tamper evidence | SHA-256 hash chain + daily forward-walk verifier | Operationally simple; in-DB verifiable. External WORM anchor deferred to Appendix J. |
| Access control | CBAC (allow+deny+markings) via `action_type` policy columns | Expressive enough for RRA roles; default-deny on miss. |
| Identity | Keycloak realm `tellus-prod` with WebAuthn + OIDC | Industry standard; FedRAMP-grade. |
| Encryption at rest | PG + S3 + OS KMS-backed | No plaintext data on disk. |
| Encryption in transit | TLS 1.3 everywhere including intra-cluster | No cleartext. |
| Retention | 7 years (Law 058/2021) + archival to Iceberg cold tier after 12 months | Statute-compliant. |
| Breach notification | DPA within 72 hours per Art. 31 | Runbook in INCIDENT_RESPONSE.md step 6. |

## 5. Cross-border data flow

Single-region, in-country deployment. No cross-border flow in the initial launch scope. If cross-border flow is introduced later (for backup or DR), this DPIA must be re-run and the DPA re-consulted per Art. 22.

## 6. Controller / Processor split

The operator (Tellus) acts as processor under RRA's direction. Contract to be signed covering:
- Purposes and means of processing.
- Sub-processor list (cloud provider, KMS provider).
- Security obligations.
- Audit rights.
- Breach notification SLAs.
- Data portability on contract exit.

## 7. Consultation

DPA consultation required before launch. Consultation record appended to this DPIA.

## 8. Review

Annually or on material change (new data category, new processing purpose, new cross-border flow).

---

**Sign-off:**

| Role | Name | Date | Signature |
|---|---|---|---|
| Data Protection Officer | | | |
| Security Lead | | | |
| Engineering Lead | | | |
| RRA sponsor | | | |
