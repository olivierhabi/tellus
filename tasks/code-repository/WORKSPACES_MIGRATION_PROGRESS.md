# Code Repository Storage - Disk Workspace Revert and Postgres-Only State

**Project:** Tellus Code Repository Storage Layer
**Role:** Lead Senior Dev / Architect
**Status:** Disk backing reverted; Postgres is the sole durable storage adapter
**Last updated:** June 24, 2026

> Correction notice: an earlier version of this document (June 21, 2026)
> described a DiskStemma adapter and on-disk workspace migration as Completed
> and Successfully Verified. That work was reverted on June 23 (commit c2fd3fc).
> The files it referenced (disk.ts, migrate-repo-to-disk.ts, the disk-stemma
> integration test) no longer exist. This document reflects the actual state.

---

## 1. History - what was reverted and why

An earlier iteration introduced a hybrid DiskStemma adapter that dual-wrote
committed files both to Postgres (the transactional ledger) and to physical
on-disk git working copies under var/tellus/repositories/rid/branch. The
intent was to back a future code-server / VS Code Workspaces editor surface.

That approach was reverted (commit c2fd3fc, June 23, 2026):

- src/services/codeRepository/adapters/disk.ts - deleted.
- scripts/migrate-repo-to-disk.ts - deleted.
- tests/integration/code-repos/code-repository/disk-stemma-integration.test.ts - deleted.

Rationale: the disk backing added a second source of truth with no live
consumer. No code-server / IDE integration was ever wired into the source tree,
and every read/write path (create, commit, branch, transform build, function
invoke) goes through the Stemma adapter, which is PostgresStemma in production.
A dual-write disk layer that nothing read was pure complexity and drift risk.

## 2. Current architecture - Postgres-only

The durable storage adapter is PostgresStemma
(src/services/codeRepository/adapters/postgres.ts), wired at boot in server.ts
via mountCodeRepository({ pool, stemma: new PostgresStemma({ pool }) }).

Schema (migration 086_durable_stemma.sql):
- coderepo_stemma_repo: one row per repository; tombstoned soft-delete flag.
- coderepo_stemma_branch: one row per branch; head_sha; FK ON DELETE CASCADE.
- coderepo_stemma_blob: one row per file blob (BYTEA); FK cascade from branch.

commitFiles is transactional: BEGIN + SELECT FOR UPDATE on the branch head row
+ parentSha CAS (optimistic concurrency; returns stale-ref on mismatch).
Content survives restart. Tested in postgres-stemma-integration.test.ts (5/5)
and commit-route-integration.test.ts (20/20, incl. real racing-commit CAS).

## 3. Cleanup of disk leftovers (June 24, 2026)

The reverted DiskStemma left three classes of orphan, now removed:

- On-disk git working copies under var/tellus/repositories/ (214 gitlinks,
  all unresolvable SHAs, no .gitmodules). Untracked from git; var/ added
  to .gitignore. Working-tree copies left on disk (no longer tracked).
- Dead config: USE_DISK_STORAGE=true in .env / .env.example (no code read
  it). Removed.
- This document itself, which previously described the deleted adapter as
  Completed. Rewritten to match the actual Postgres-only state.

## 4. Known follow-up

DELETE /:rid trashes the code_repository metadata row but does not call
stemma.tombstone(), so coderepo_stemma_* content for deleted repos is left
behind (GC gap). See the delete-route fix and the reconcile sweep.
