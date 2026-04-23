# Security Policy

## Reporting a vulnerability

Report via email to **security@tellus.example** with subject `VULN: <short>`.

PGP key fingerprint: TBD (placeholder — to be generated and published before launch).

We commit to:
- Acknowledge within 48 hours.
- Triage within 5 business days.
- Remediate Critical / High within 30 days of triage.
- Coordinate disclosure timeline with the reporter.

## Scope

The entire `tellus` codebase and its production / staging deployments. In-scope APIs are documented in `docs/API_REFERENCE.md`.

Out of scope: social engineering of RRA staff, physical access, network-edge DDoS.

## SBOM

An SBOM is generated on every release via `scripts/generate-sbom.sh` (CycloneDX format) and stored under `ops/sbom/`.

## CVE scanning

`.github/workflows/cve-scan.yml` runs on every PR and nightly on `main`:
- `npm audit --production`
- `grype` or `trivy` image scan
- Fail CI on Critical or High CVE.

## Container hardening

- Non-root UID 10001 via `USER` directive.
- Read-only root filesystem where possible.
- Capabilities dropped to bare minimum.
- Seccomp profile committed at `ops/seccomp/tellus.json`.

## K8s hardening

- `PodSecurityStandards: restricted`.
- `NetworkPolicy` per pod denying all egress by default.
- Service accounts with minimal IAM.
- Secrets via ExternalSecrets / CSI only — no Docker image embeds.

## Audit trail

Every security-relevant action is logged to the hash-chained audit log. See `docs/AUDIT_CONTRACT.md`.
