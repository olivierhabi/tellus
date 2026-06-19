# Files & Projects — PROGRESS

> Drives the 20-task spec at `tasks/files-projects/files-projects-tasks.md`.
> A task is DONE only when its DoD checklist is fully satisfied (per the brief, §"Definition of Done — per task") **and** all three test lanes are green **and** `verify-T-XX.sh` exits 0 on a clean Docker stack.
> Per the brief: partial implementation is **not** Done. Snapshot here, continue next iteration.

## Status snapshot — 2026-05-04

### Starting Protocol

- [x] Read all 20 tasks (`tasks/files-projects/files-projects-tasks.md`, 1307 lines).
- [x] Inventory existing code surface (`src/foundryMigrate.ts:1-722`, `src/services/{projectService,folderService,foundryUploadService}.ts`, `src/middleware/{auth,etag,authorize}.ts`).
- [x] Render dependency graph (`tasks/files-projects/dag.md`).
- [x] Open contract enumeration with B1 (`tasks/files-projects/contracts.md`).
- [ ] Wire `docker-compose.test.yml` (a `docker-compose-test.yml` exists in the repo root — review for completeness against the brief's required services: Postgres 16+pg_trgm+ltree, OpenSearch 2.x single-node, Redis 7, Kafka+Zookeeper, MinIO).
- [ ] `scripts/test-up.sh` / `test-down.sh` / `test-seed.sh` (alice, bob, carol).
- [ ] `scripts/test-all.sh` (lint → typecheck → unit → integration → cypress).
- [ ] Baseline run on a clean clone, results recorded.

### Backend tasks

| ID  | Title | Status | Notes |
|-----|-------|--------|-------|
| B1  | Compass Resource Model & RID System | **DONE** | 56 unit + 15 integration PASS; verify-B1.sh exit 0; load p95 5.82ms<30ms / 6.85ms<200ms; B1-C-24 triplet GREEN/RED/GREEN. See `progress/B1.md`. |
| B2  | Spaces & Hierarchy Refactor | **DONE** | spaces table + partial unique idx + root row; 5 unit + 8 integration PASS; verify-B2.sh exit 0; B2-C-11 triplet GREEN/RED/GREEN; B1 NOT regressed. See `progress/B2.md`. |
| B3  | Filesystem v2 Public API | **DONE** | 17 endpoints + Conjure error envelope + ETag/If-Match middleware (412/428) + Idempotency-Key store w/ 24h TTL + cursor pagination. 24 unit + 18 integration PASS; verify-B3.sh exit 0; verify-all.sh exit 0; B1+B2 NOT regressed. See `progress/B3.md`. |
| B4  | Roles, Markings & Organizations | PENDING | Gates on B3. |
| B5  | Trash, ETag & Audit | PENDING | Gates on B4. |
| B6  | Resource Graph & Cross-Project References | PENDING | Gates on B5. |
| B7  | Branching, Proposals & Approval Policies | PENDING | Gates on B6. |
| B8  | OMS — Object Types & Link Types | PENDING | Gates on B7. |
| B9  | Funnel — Indexing Pipeline | PENDING | Gates on B8. |
| B10 | OSS — Object Set Service | PENDING | Gates on B9. |

### Frontend tasks

| ID  | Title | Status | Deps |
|-----|-------|--------|------|
| F1  | Files Hub Page | PENDING | B1, B3 |
| F2  | Project Detail Page | PENDING | B3, B6 |
| F3  | Folder Browser | PENDING | B3, B5 |
| F4  | Sharing & Permissions | PENDING | B4 |
| F5  | Quick-Open Palette | PENDING | B3 |
| F6  | Trash & Restore | PENDING | B5 |
| F7  | Branch Switcher & Proposals | PENDING | B7 |
| F8  | Object Type Editor | PENDING | B8 |
| F9  | Object Explorer | PENDING | B10 |
| F10 | Quiver Canvas | PENDING | B10 |

### End-to-End Gate

- [ ] `cypress/e2e/files-projects-end-to-end.cy.ts` written (six steps from spec DoD §1305).
- [ ] Three consecutive clean-stack passes.
- [ ] `scripts/verify-all.sh` exits 0 on the same clean stack, three consecutive runs.
- [ ] `tasks/files-projects/FINAL_REPORT.md` produced.

---

## Cadence log (per task)

Entries appended below as each task reaches DONE per the cadence template in the brief.

<!-- T-XX entries go below; oldest first -->

## Iteration log (in-flight; not DONE markers)

### Iteration 1 — 2026-05-04 — Starting Protocol + B1 foundations

- Starting Protocol artifacts authored: `tasks/files-projects/dag.md`, `tasks/files-projects/contracts.md` (B1 enumerated), `tasks/files-projects/PROGRESS.md`, `tasks/files-projects/progress/B1.md`, `decisions/files-projects/` directory.
- B1 — `src/lib/rid.ts` + 40 unit tests (PASS, 165 ms): RID grammar / round-trip / brand / mintRid UUIDv4 / `INVALID_RID_FORMAT (400)` / `tellus_compass_rid_parse_errors_total` counter.
- B1 — `src/foundryMigrate.ts:710-909`: idempotent `resources` table + indexes + ETag bump trigger + backfill from projects/folders/foundry_datasets keyed on `legacy_uuid`.
- B1 typecheck clean (pre-existing unrelated TS2802 errors in funnel/metrics noted but out of scope).
- B1 NOT YET DONE — `compassService.ts`, same-transaction INSERT wiring on existing services, integration test against Docker, `verify-B1.sh`, load probe, SLO measurement remain. Continuing in next iteration per `tasks/files-projects/progress/B1.md` § "Next iteration entry point".

### Iteration 2 — 2026-05-04 — B1 service layer + error registry

- B1 — `src/services/compassService.ts:1-452` — `getResource`, `getResourcesBatch` (cap 1000), `getResourceByPath` (root-space-implicit), `getChildren` (cursor pagination via base64url-JSON of `(updated_at, rid)`), `mintRid` re-export. Histograms `tellus_compass_get_resource_seconds{outcome}` and `tellus_compass_batch_get_size` registered idempotently with the canonical bucket set.
- B1 — `src/utils/queryErrors.ts:78-83` — registered `INVALID_RID_FORMAT (400)`, `RESOURCE_NOT_FOUND (404)`, `BATCH_TOO_LARGE (400)` in the existing `STANDARD_ERROR_CODES` so the canonical envelope (`{errorCode, errorName, message, statusCode, parameters, errorInstanceId}`) is produced without divergence (single-source-of-truth invariant preserved).
- B1 — `tests/foundry/unit/compass-service-b1-unit.test.ts:1-162` — 16/16 PASS (207 ms). Combined B1 unit total: **56/56 PASS** (40 rid + 16 service). Typecheck clean for all B1 files.
- B1 NOT YET DONE — items 1–5 in `tasks/files-projects/progress/B1.md` § "Still NOT done in B1": Docker integration test, same-tx INSERT wiring on legacy services, `verify-B1.sh`, load probe (P50/P95/P99 vs B1-C-50/51), `docker-compose-test.yml` + `test-up.sh`/`test-down.sh`/`test-seed.sh`/`test-all.sh`. Continuing.
