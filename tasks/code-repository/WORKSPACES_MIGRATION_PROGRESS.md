# Production-Grade VS Code Workspaces Migration Tracking

**Project:** Tellus Code Repository Migration to physical Disk Workspaces & code-server Parity  
**Role:** Lead Senior Dev / Architect  
**Status:** Completed & Successfully Verified  
**Date:** June 21, 2026  

---

## 1. Architectural Strategy & Design

To achieve 1:1 parity with Palantir Foundry Code Workspaces while utilizing the standard `code-server` engine, we successfully migrated the database-backed storage layer to a **durable, physical Disk Workspace representation**.

### 1.1 Multi-Tenant Repository Isolation
Every repository is allocated a safe workspace directory structured as:
`var/tellus/repositories/<repository_rid>/<branch>/`

By organizing under a root path and nesting by repository RID and branch, we achieve complete isolation. Workspaces running concurrent branch modifications will not step on each other's toes.

### 1.2 Dual-Write Sync Bridge
To protect against system crashes, metadata loss, and to maintain backward compatibility with other Tellus components (e.g., Functions Registry, Workshop Modules, Jemma Scheduler), we employ a **hybrid storage engine**:
- **Metadata and Schema backing**: `PostgresStemma` continues to act as the authoritative transactional ledger.
- **Physical workspace backing**: Standard filesystem operations write files and directories directly, accompanied by an active `git init` on creation.

Whenever files are committed via `DiskStemma.commitFiles()`, they are:
1. Written physically to `/var/tellus/repositories/:rid/:branch/`
2. Staged and committed to git local tree
3. Synced synchronously with `PostgresStemma` database records.

### 1.3 Auto-Scaffolding and Fault Tolerance (Self-Healing)
If a workspace directory is lost on a container restart, disk corruption, or replacement:
- `DiskStemma` automatically detects the discrepancy compared to Postgres.
- On file listing (`listTree`) or read (`readBlob`), if directory missing, `DiskStemma` auto-rehydrates the disk directory by fetching all files from the Postgres database and reconstructing the workspace flawlessly!

---

## 2. Implementation Milestones

- [x] **Milestone 1: Progress Tracking Initialization** (Completed)
- [x] **Milestone 2: Design and Implement DiskStemma Adapter** (Completed)
- [x] **Milestone 3: Server Integration & Feature Flagging** (Completed)
- [x] **Milestone 4: Scaffolding / Repository Migration Script** (Completed)
- [x] **Milestone 5: Verification & End-to-End Validation** (Completed)

---

## 3. Implementation Artifacts

The system is delivered with the following new and updated files:

- `src/services/codeRepository/adapters/disk.ts`: The core `DiskStemma` adapter which implements `StemmaAdapter`.
- `src/server.ts`: Configured to dynamically load `DiskStemma` based on `USE_DISK_STORAGE=true`.
- `scripts/migrate-repo-to-disk.ts`: Scaffolder / Data extraction script which converted all existing database records to local disk git structures.
- `tests/integration/code-repos/code-repository/disk-stemma-integration.test.ts`: Integration test verifying double-writing, branch replication, git history, and self-healing.
- `.env` & `.env.example`: Configured with `USE_DISK_STORAGE=true`.

---

## 4. Migration Execution Report

We ran `scripts/migrate-repo-to-disk.ts` to sync the current database into local repositories:
```
[Migration] Starting code repository disk scaffolding under: /var/tellus/repositories
[Migration] Found 210 branches to synchronize to disk.
...
==============================================================
[Migration] Final Report:
- Branches Processed Successfully: 210 / 210
- Total Disk Files Written: 2764
==============================================================
```

---

## 5. Verification & Testing

We verified the implementation using the Vitest test engine. Both existing database adapter tests and our new physical disk workspace tests passed successfully:

- `tests/integration/code-repos/code-repository/postgres-stemma-integration.test.ts`: Passed (5/5)
- `tests/integration/code-repos/code-repository/disk-stemma-integration.test.ts`: Passed (1/1)
- `tests/integration/code-repos/`: Complete integration test suite passed (15/15 files, 65/65 tests)

---

## 6. Decision Log

| ID | Decision | Rationale | Impact |
|---|---|---|---|
| **D-1** | Dual-write Architecture | Avoid breaking compiler engine, execution sagas, and tests during transition. | Zero downtime, instant rollback capacity. |
| **D-2** | Repository Branch Subfolders | Isolation of branches on disk file tree. | Concurrent branch work without git checkout overhead or conflicts. |
| **D-3** | Graceful Directory Fallback | Auto-switch from `/var` to `<cwd>/var` if permission denied. | Run-anywhere capability (CI/CD, local macOS, docker). |

