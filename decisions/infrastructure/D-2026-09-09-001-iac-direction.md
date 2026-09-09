# D-2026-09-09-001 — IaC direction: Helm-first, Terraform deferred

## Ambiguity

Static analysis reports `IaC Quality 25.0`: no Terraform / Pulumi, only
`docker-compose.yml` plus raw k8s manifests, with no validate-in-CI. The
question is what the IaC layer should become.

## Options

1. **Adopt Terraform now.** Rejected — the repo provisions no cloud
   resources. Everything is either local Docker Compose (dev/test) or
   manifests applied to an existing cluster. Terraform with no provider
   footprint would be scaffolding theatre: unapplied code that rots.
2. **Migrate all raw manifests into the Helm chart.** Rejected for now —
   `k8s/` (pgbouncer, external-secrets) and `infra/k8s/` (clickhouse,
   quickwit) are cluster-operator concerns with different lifecycles from
   the tenant app chart in `deploy/substrate/charts/tellus-tenant`.
   Forced unification would couple independent release cadences.
3. **Helm-first with enforced validation.** The tenant app ships as a
   versioned Helm chart; raw manifests stay where their lifecycle lives;
   everything is linted/validated in CI.

## Chosen

Option 3, effective immediately:

- `deploy/substrate/charts/tellus-tenant` is the canonical app
  packaging — `helm lint` runs in `.github/workflows/deploy.yml`.
- `k8s/` and `infra/k8s/` manifests are client-side dry-run validated
  in the same workflow.
- Terraform gets adopted if and only if a cloud-provisioned dependency
  lands (managed Postgres, object storage, or cluster itself) — at
  which point this decision is superseded by a provisioning RFC, not
  extended ad hoc.
