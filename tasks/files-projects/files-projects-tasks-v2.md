# Tellus — Files & Projects — Agent Execution Plan
## 20 Tasks Rewritten as Turn-by-Turn Sequences

> **What this document is.** This is the EXECUTION PLAN paired with the original 20-task spec at `tasks/files-projects/SPEC.md`. The original spec defines the contract (schemas, endpoints, error codes, SLOs). This document defines the per-turn execution: what the agent does in each session, in what order, and how each turn proves itself complete.
>
> **Audience.** AI agent. Each Turn is one session. The agent reads the Turn block, executes its Actions in order, runs the Exit Gate, halts on green, and the next user message picks up at Turn+1.
>
> **What an agent must NOT do.** Skip turns. Combine turns. Invent turns. Negotiate scope. Halt before the Exit Gate exits 0. Producing prose without code or tests when this document says "Action: write file X" is a directive failure.

---

## 0. Universal Per-Turn Protocol (read once, apply every turn)

### 0.1 Turn-start (always, no exceptions)

1. Run the §3 tail command from `tasks/files-projects/CONTINUATION_DIRECTIVE.md`. Paste verbatim.
2. From the tail output, identify which Turn this is by reading `tasks/files-projects/SUBTASKS.md` row marked `IN_PROGRESS` or the first row marked `⏳`.
3. State `## TURN: <task>.<n> — <title>` as the second header in your output.
4. Proceed to that Turn's Actions.

### 0.2 Turn-end (always)

1. Run the Turn's Exit Gate command. If exit 0: continue. If non-zero: re-attempt the failed Action, do not halt.
2. Update `tasks/files-projects/SUBTASKS.md` — mark this Turn `✅`, mark the next Turn `IN_PROGRESS`.
3. Run the §3 tail command again. Paste verbatim.
4. Write `## TURN <task>.<n> EXIT_GREEN` as the closing header. End stream.

### 0.3 Banned (zero tolerance)

- "Discovery only" / "exploratory" / "gate 0" / "warmup" / "planning" turns
- TURN_HALT, "stopping here for next session", "Re-run the loop"
- Skipping a Turn because "B1 already did similar work"
- Combining two Turns to "save time" — agents don't save time, they save turns; saving turns is forbidden
- Any output where the only file change is to `SUBTASKS.md` (means no work was done)

### 0.4 Decisions are locked

Each task below has a `Decisions locked` block. The agent does not deviate from these. If the original spec is ambiguous and this document doesn't resolve the ambiguity, the agent picks the lexicographically-first valid option, documents the choice in `tasks/files-projects/progress/<task>.md` under `## Locked at runtime`, and proceeds.

### 0.5 SUBTASKS.md format (created in Turn 0 of B1, never modified except to flip status)

```
| Turn   | Title                                  | Status | Exit log                |
|--------|----------------------------------------|--------|-------------------------|
| B1.bf1 | B1 Cypress backfill                    | ⏳     |                         |
| B1.bf2 | B1 wiring proof execution              | ⏳     |                         |
| ...    | ...                                    | ...    |                         |
| B4.01  | Roles + role_operations DDL + seed     | ⏳     |                         |
| B4.02  | role_grants DDL + indexes              | ⏳     |                         |
| ...    |                                        |        |                         |
| F10.10 | Auto-save pipeline                     | ⏳     |                         |
```

Status values: `⏳` (pending), `IN_PROGRESS`, `✅`, `❌` (rare; only if blocked).

---

# PART I — BACKFILL TURNS (B1, B2, B3)

These turns close the v2 §4 gaps in tasks already marked DONE. Until they are green, the foundation is not actually green.

## B1 — Backfill (3 turns)

### Turn B1.bf1 — Cypress E2E for Compass resource model

**Entry state.**
- `tests/foundry/integration/compass-b1-integration.test.ts` exists ✅
- `cypress/files-projects/e2e/compass-b1.cy.ts` either does not exist OR exists but is `.skip`'d
- No `.mp4` for B1 in `cypress/videos/` newer than session start

**Actions.**
1. Read `cypress.config.ts`. If absent, create with `baseUrl: 'http://localhost:3000'`, `video: true`, `videosFolder: 'cypress/videos/files-projects'`, `specPattern: 'cypress/files-projects/e2e/**/*.cy.ts'`.
2. Create `cypress/files-projects/e2e/compass-b1.cy.ts`. Spec content:
   - Visit `/login`, authenticate as seeded test user via `cy.request('POST', '/api/auth/login', {...})` (use existing test fixture).
   - Visit `/files`. Assert at least one project row renders.
   - Click first project. Assert URL is `/projects/<uuid>` and folder browser is visible.
   - Programmatically POST `/api/v1/folders` to create a folder. Reload. Assert folder appears.
   - Programmatically GET the new folder via `/api/v2/filesystem/folders/{rid}` (RID resolved via `/api/v2/filesystem/resources?path=...`). Assert response includes `etag`, `rid` matches `^ri\.compass\.main\..+`.
3. Add to `package.json` scripts: `"e2e:b1": "cypress run --headless --spec cypress/files-projects/e2e/compass-b1.cy.ts --reporter json --reporter-options 'output=/tmp/b1-cypress.log'"`.
4. Run `pnpm e2e:b1` against the live docker stack. If the stack is down: `bash scripts/dc-up.sh` first.
5. Verify `/tmp/b1-cypress.log` has non-zero size and `find cypress/videos -name 'compass-b1*' -newer /tmp/SESSION_START` returns one path.

**Exit gate.**
```bash
test -s /tmp/b1-cypress.log && \
  find cypress/videos -name 'compass-b1*.mp4' -newer /tmp/SESSION_START | grep -q . && \
  echo "B1.bf1 GREEN"
```

### Turn B1.bf2 — Wiring proof execution (B1-C-24)

**Entry state.**
- `scripts/b1-c24-proof.ts` exists ✅
- `/tmp/b1-c24-{green,red,green2}.log` either do not exist OR are stale (older than session start)

**Actions.**
1. Read `scripts/b1-c24-proof.ts`. Identify the critical wiring line it stashes (look for `git stash push` invocation).
2. Run `npx tsx scripts/b1-c24-proof.ts 2>&1 | tee /tmp/b1-c24-green.log` — first green pass.
3. The script's RED phase: it `git stash`'s the wiring line, runs the test, expects red. Verify `/tmp/b1-c24-red.log` exists and contains the expected failure signal.
4. Final green pass log: `/tmp/b1-c24-green2.log` exists.
5. If the script does not auto-perform all three phases, augment it to do so (read it; add stash → test → unstash → test logic if missing).

**Exit gate.**
```bash
test -s /tmp/b1-c24-green.log && \
  test -s /tmp/b1-c24-red.log && \
  test -s /tmp/b1-c24-green2.log && \
  grep -q 'PASS' /tmp/b1-c24-green.log && \
  grep -q 'FAIL\|✗\|❌' /tmp/b1-c24-red.log && \
  grep -q 'PASS' /tmp/b1-c24-green2.log && \
  echo "B1.bf2 GREEN"
```

### Turn B1.bf3 — Docker stack snapshot in integration log

**Entry state.**
- `tests/foundry/integration/compass-b1-integration.test.ts` exists ✅
- `/tmp/b1-integration.log` does not contain `docker compose ps` JSON header

**Actions.**
1. Open `tests/foundry/integration/compass-b1-integration.test.ts`. Add at the top of the global `beforeAll` (or create one):
   ```ts
   import { execSync } from 'node:child_process';
   import * as fs from 'node:fs';
   beforeAll(() => {
     const psJson = execSync(
       "docker compose -f docker-compose.test.yml ps --format json"
     ).toString();
     fs.appendFileSync('/tmp/b1-integration.log', `=== docker compose ps ===\n${psJson}\n=== begin tests ===\n`);
     const services = JSON.parse(`[${psJson.trim().split('\n').join(',')}]`);
     const required = ['postgres', 'cassandra', 'keycloak', 'kafka', 'schema-registry', 'minio', 'otel-collector'];
     for (const svc of required) {
       const found = services.find((s: any) => s.Service === svc);
       if (!found || found.Health !== 'healthy') {
         throw new Error(`Required service ${svc} not healthy: ${JSON.stringify(found)}`);
       }
     }
   });
   ```
2. Re-run: `pnpm test tests/foundry/integration/compass-b1-integration.test.ts 2>&1 | tee /tmp/b1-integration.log`.
3. Verify the log header includes the `docker compose ps` block.

**Exit gate.**
```bash
head -1 /tmp/b1-integration.log | grep -q 'docker compose ps' && \
  grep -q 'PASS' /tmp/b1-integration.log && \
  echo "B1.bf3 GREEN"
```

## B2 — Backfill (2 turns)

### Turn B2.bf1 — Cypress E2E for spaces

Mirror B1.bf1 structure. Spec: `cypress/files-projects/e2e/spaces-b2.cy.ts`. Content: visit a project's settings, verify `space_rid` field renders. Attempt to POST `/api/v2/filesystem/projects` with a non-existent `spaceRid`, assert 404 with `errorCode: SPACE_NOT_FOUND`.

**Exit gate.** `find cypress/videos -name 'spaces-b2*.mp4' -newer /tmp/SESSION_START | grep -q .`

### Turn B2.bf2 — Load probe + integration docker snapshot

Mirror B1.bf3 for `tests/foundry/integration/spaces-b2-integration.test.ts`. Author `scripts/b2-load.ts` probing `POST /api/v2/filesystem/projects` with valid `spaceRid`, assert P95 < 100 ms (declared SLO; if absent, record locked decision: 100 ms).

**Exit gate.** `test -s /tmp/b2-load.log && grep -q 'p95=' /tmp/b2-load.log && head -1 /tmp/b2-integration.log | grep -q 'docker compose ps'`

## B3 — Backfill (4 turns)

### Turn B3.bf1 — Integration log docker snapshot

Mirror B1.bf3 for `filesystem-v2-b3-integration.test.ts`.

### Turn B3.bf2 — Load probe `scripts/b3-load.ts`

**Actions.** Author `scripts/b3-load.ts` using `autocannon` (install if needed: `pnpm add -D autocannon`). Probe `GET /api/v2/filesystem/resources/{rid}` with 100 RPS sustained 30s. Assert P95 < 50 ms. Log to `/tmp/b3-load.log`.

**Exit gate.** `test -s /tmp/b3-load.log && grep -E 'p95=[0-9]+(\.[0-9]+)?ms' /tmp/b3-load.log && grep -q 'PASS' /tmp/b3-load.log`

### Turn B3.bf3 — Wiring proof execution (B3-C-15)

Mirror B1.bf2 for `scripts/b3-c15-proof.ts`. The critical line is the `If-Match` check in the PUT handler — stash that, expect red, unstash, expect green.

### Turn B3.bf4 — Cypress E2E for filesystem v2

Mirror B1.bf1. Spec covers: create folder via v2 endpoint, get with ETag, PUT with stale ETag (expect 412), retry with current ETag (expect 200), trash via POST `/trash`, restore.

---

# PART II — BACKEND TASKS (B4 — B10)

## B4 — Roles, Markings, Organizations (Gatekeeper) — 12 Turns

**Original spec section.** SPEC.md §B4.

**Decisions locked (do not deviate).**
- Cache implementation: `lru-cache@10` (already in package.json, verify; if not, `pnpm add lru-cache`).
- Cache key: `${principalId}:${resourceRid}:${operationId}`. Max 100,000 entries. TTL 30 seconds.
- LISTEN/NOTIFY channel name: `gatekeeper_invalidate`. Payload format: JSON `{table, op, id}`.
- Ancestor walk depth limit: 50. If exceeded, return `DENY:LINEAGE_TOO_DEEP`.
- `evaluateBatch` max 50 checks per call (matches contract SLO).
- Service file location: `src/services/gatekeeperService.ts`.
- Middleware location: `src/middleware/requirePermission.ts` (replaces `authorize.ts`'s `authorizeRoles`).
- Test file naming: `tests/foundry/{unit,integration}/gatekeeper-b4-*.test.ts`.
- Migration step number for B4 DDL: `migrate.ts` step 12 (after B3's step 11). Idempotent appends only.

### Turn B4.01 — Roles + role_operations DDL + seed

**Entry state.**
- `src/foundryMigrate.ts` does not contain a `CREATE TABLE roles` statement.
- `tests/foundry/integration/gatekeeper-b4-roles-table.test.ts` does not exist.

**Actions.**
1. Append to `src/foundryMigrate.ts` after the last B3 DDL block, in a new `// === B4 Step 12: roles + role_operations ===` section: the SQL from SPEC.md §B4 for `roles` and `role_operations` tables, all four `INSERT INTO roles` rows, and all `INSERT INTO role_operations` rows from the spec. All inserts use `ON CONFLICT DO NOTHING`.
2. Create `tests/foundry/integration/gatekeeper-b4-roles-table.test.ts`. Three cases:
   - After migrate, `SELECT count(*) FROM roles WHERE is_system = true` returns 4.
   - After migrate, `SELECT count(*) FROM role_operations WHERE role_id = 'compass-owner'` returns 6 (per the spec's seed list).
   - Re-running migrate is idempotent (no row count changes).
3. Add docker-stack snapshot beforeAll (per universal pattern from B1.bf3).
4. Run `pnpm migrate` (against test stack). Run the new test.

**Exit gate.**
```bash
pnpm migrate 2>&1 | tee /tmp/b4-01-migrate.log && \
  pnpm test tests/foundry/integration/gatekeeper-b4-roles-table.test.ts 2>&1 | tee /tmp/b4-01-test.log && \
  grep -q '3 passed' /tmp/b4-01-test.log
```

### Turn B4.02 — role_grants DDL + project_members mirror trigger

**Entry state.**
- `roles` and `role_operations` tables exist (B4.01 ✅).
- No `role_grants` table.

**Actions.**
1. Append to `foundryMigrate.ts` step 13: `role_grants` CREATE TABLE per spec. Add `CREATE INDEX role_grants_principal_idx`.
2. Append step 14: trigger function `mirror_project_members_to_role_grants()`:
   ```sql
   CREATE OR REPLACE FUNCTION mirror_project_members_to_role_grants() RETURNS trigger AS $$
   DECLARE role_id_val text;
   BEGIN
     role_id_val := CASE NEW.role
       WHEN 'owner' THEN 'compass-owner'
       WHEN 'editor' THEN 'compass-editor'
       WHEN 'viewer' THEN 'compass-viewer'
     END;
     INSERT INTO role_grants (resource_rid, principal_id, principal_type, role_id, granted_by)
     SELECT 'ri.compass.main.project.' || NEW.project_id::text, NEW.user_id, 'USER', role_id_val, COALESCE(NEW.created_by, NEW.user_id)
     ON CONFLICT (resource_rid, principal_id, role_id) DO NOTHING;
     RETURN NEW;
   END $$ LANGUAGE plpgsql;
   CREATE TRIGGER project_members_mirror_t AFTER INSERT OR UPDATE ON project_members
     FOR EACH ROW EXECUTE FUNCTION mirror_project_members_to_role_grants();
   ```
3. Append step 15: backfill — for every existing `project_members` row, INSERT the equivalent `role_grants` row (same `ON CONFLICT DO NOTHING`).
4. Test: `tests/foundry/integration/gatekeeper-b4-grants-mirror.test.ts`. Cases:
   - Inserting a `project_members` row creates the corresponding `role_grants` row.
   - Updating `project_members.role` from viewer to owner creates a new role_grants row (existing ones not deleted; that's a separate B4.0X).
   - Existing `project_members` rows are mirrored after backfill.

**Exit gate.**
```bash
pnpm migrate 2>&1 | tee -a /tmp/b4-02-migrate.log && \
  pnpm test tests/foundry/integration/gatekeeper-b4-grants-mirror.test.ts 2>&1 | tee /tmp/b4-02-test.log && \
  grep -q '3 passed' /tmp/b4-02-test.log
```

### Turn B4.03 — Markings DDL (markings, resource_markings, user_markings)

**Actions.**
1. Append migrate step 16: three CREATE TABLE statements per spec.
2. Test `gatekeeper-b4-markings-tables.test.ts`: insert a marking, attach to a resource as DIRECT, attach same marking to a user. Verify queries return expected rows. Verify CHECK constraint rejects `source='INVALID'`.

**Exit gate.** `pnpm test ...gatekeeper-b4-markings-tables` passes.

### Turn B4.04 — Organizations DDL (4 tables)

**Actions.**
1. Append migrate step 17: `organizations`, `user_organizations`, `project_organizations`, `space_organizations`.
2. Append step 18: seed default organization `INSERT INTO organizations (id, name, display_name) VALUES ('00000000-0000-0000-0000-000000000001', 'default', 'Default Organization') ON CONFLICT DO NOTHING;`.
3. Append step 19: backfill — every existing user becomes a member of the default org via `INSERT ... ON CONFLICT DO NOTHING`. Every existing project gets default org via `project_organizations`.
4. Test `gatekeeper-b4-orgs-tables.test.ts`: verify default org exists, every user has a row in `user_organizations`, every project has a row in `project_organizations`.

**Exit gate.** Test passes; `SELECT count(*) FROM users LEFT JOIN user_organizations USING (user_id) WHERE org_id IS NULL` returns 0.

### Turn B4.05 — gatekeeperService skeleton + step 1 (org check)

**Entry state.** All B4.01-B4.04 tables exist.

**Actions.**
1. Create `src/services/gatekeeperService.ts`. Export:
   - `evaluate(input: {principalId, operationId, resourceRid}): Promise<{decision, reason?}>` — implementation only does step 1.
   - `evaluateBatch(...)` stub throwing `not implemented yet (B4.09)`.
2. Step 1 implementation: walk up to project from resource (recursive CTE on `resources.parent_folder_rid`); collect orgs from `project_organizations`; check `user_organizations` for principalId. If no overlap → `{decision: 'DENY', reason: 'NO_ORG_MEMBERSHIP'}`. Else continue (return `{decision: 'ALLOW'}` for now; B4.06 will append step 2).
3. Test `tests/foundry/unit/gatekeeper-b4-step1-orgs.test.ts`: 8 cases — user in org → ALLOW; user not in org → DENY:NO_ORG_MEMBERSHIP; resource is project itself; resource is deeply nested folder; resource has no project ancestor (e.g., space); user is guest (`is_guest=true` still counts as member); multiple orgs on project, user in one → ALLOW; orphan resource (project_rid is null) → ALLOW (no org check applies).

**Exit gate.** Unit test passes (`8 passed`).

### Turn B4.06 — gatekeeperService step 2 (markings check)

**Actions.**
1. In `evaluate`, after step 1's ALLOW return, before returning, perform step 2: collect markings on resource and all ancestor projects (UNION DIRECT/INHERITED/DATA_LINEAGE). Get user's markings. Set difference: `requiredMarkings - userMarkings`. If non-empty → `DENY:MISSING_MARKINGS:<sorted-comma-list>`.
2. Update tests: add `gatekeeper-b4-step2-markings.test.ts`. 6 cases.

**Exit gate.** Both gatekeeper unit tests pass.

### Turn B4.07 — gatekeeperService step 3 (role ancestor walk)

**Actions.**
1. Step 3 implementation: walk resource → ancestors collecting `role_grants` rows where `principal_id = userId OR principal_type = 'EVERYONE'`. Stop walking above any ancestor with `metadata->>'disable_inherited_permissions' = 'true'`. Take UNION of `role_operations.operation_id` from matched roles. If `operationId` ∈ that union → ALLOW. Else `DENY:OPERATION_NOT_GRANTED`.
2. `gatekeeper-b4-step3-roles.test.ts`. 10 cases including the disable_inherited_permissions case.

**Exit gate.** Test passes.

### Turn B4.08 — Integration test: full evaluate flow

**Actions.**
1. `tests/foundry/integration/gatekeeper-b4-evaluate.test.ts`. Sets up a real project with members, markings, orgs in a transaction; calls `gatekeeperService.evaluate` against a real DB; verifies all 5 acceptance cases from SPEC.md §B4.
2. Includes docker-snapshot beforeAll.

**Exit gate.** `5 passed` in integration log.

### Turn B4.09 — evaluateBatch implementation

**Actions.**
1. Replace stub. Implementation: parallelize using `Promise.all` with concurrency limit 10 (use `p-limit`). Returns `Map<string, decision>` keyed by `${operationId}:${resourceRid}`.
2. Test `gatekeeper-b4-batch.test.ts`: 50-check batch returns 50 decisions. Reject batch > 50 with `INVALID_ARGUMENT`.

**Exit gate.** Test passes.

### Turn B4.10 — LRU cache + LISTEN/NOTIFY invalidation

**Actions.**
1. In `gatekeeperService.ts`: wrap `evaluate` with LRU lookup. On miss, compute, cache.
2. Append migrate step 20: triggers on `role_grants`, `resource_markings`, `project_organizations`, `user_organizations` that `pg_notify('gatekeeper_invalidate', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP)::text)`.
3. In `src/services/gatekeeperService.ts`: subscriber via `pg.LISTEN`. On notify → `cache.clear()` (coarse invalidation; matches 200ms SLO).
4. Test `gatekeeper-b4-cache.test.ts`: warm cache, modify role_grants, expect cached entry invalidated within 200ms (poll the cache).

**Exit gate.** Test passes; integration shows cache invalidation latency P95 < 200ms.

### Turn B4.11 — requirePermission middleware swap

**Actions.**
1. Create `src/middleware/requirePermission.ts`. Function `requirePermission(operationId: string)` returns Express middleware that extracts `principalId` from `req.user`, `resourceRid` from `req.params.rid` (or `ridFromParams` arg), calls `gatekeeperService.evaluate`, on DENY returns 403 with `{errorCode: 'PERMISSION_DENIED', parameters: {reason}}`.
2. Replace usages of `authorizeRoles(...)` in `src/routes/filesystemV2/*.ts` with `requirePermission('compass:view-resource')` etc., per SPEC.md §B4 acceptance examples.
3. Update existing tests that mocked `authorizeRoles` to mock `requirePermission` instead.

**Exit gate.** Full backend test suite green (`pnpm test`); no test references `authorizeRoles`.

### Turn B4.12 — verify-B4.sh + load probe + cypress + tail

**Actions.**
1. Author `scripts/verify-B4.sh` following B1/B2/B3 pattern: 8 gates (dc-up, migrate, unit, integration, cypress, load probe, wiring proof, typecheck).
2. Author `scripts/b4-load.ts` — probe `gatekeeperService.evaluate` directly (10k calls, P95 < 5ms warm).
3. Author `scripts/b4-cache-proof.ts` — GREEN/RED/GREEN (stash the cache invalidation listener, expect cache staleness; restore, expect freshness).
4. Author `cypress/files-projects/e2e/b4-permissions.cy.ts` — login as viewer, assert edit buttons disabled with permission tooltip.
5. Run `bash scripts/verify-B4.sh`. Update `verify-all.sh` to include verify-B4.

**Exit gate.** `bash scripts/verify-B4.sh; echo $?` is 0; `bash scripts/verify-all.sh; echo $?` is 0.

---

## B5 — Trash, ETag & Optimistic Concurrency — 8 Turns

**Decisions locked.**
- Trash retention: 7 days (env var `TRASH_RETENTION_DAYS=7`).
- Audit log writer: `src/db/audit.ts` is sole writer (enforce by lint rule + code review).
- Recursive trash: single SQL with recursive CTE; max depth 1000 to prevent runaway.
- ETag middleware: applies to v2 endpoints only; v1 untouched.

### Turn B5.01 — audit_log DDL + audit.ts writer

Append migrate step 21 (audit_log table). Create `src/db/audit.ts`: single function `appendAudit({actorId, resourceRid, operationId, requestId, beforeJson, afterJson, outcome})`. Test: `audit-b5-writer.test.ts` — 4 cases.

### Turn B5.02 — etag middleware

Create `src/middleware/etag.ts`. Parse `If-Match` header (numeric); on response, set `ETag: "<n>"` from `res.locals.etag`. Test: middleware unit test 6 cases.

### Turn B5.03 — Wire etag middleware into v2 router

Modify `src/server.ts:704-727` to register middleware on `/api/v2/*`. Update each v2 controller to set `res.locals.etag = result.etag` before sending. Integration test: GET response includes `ETag` header; PUT without `If-Match` returns 428.

### Turn B5.04 — trashService.trash with recursive CTE

Create `src/services/trashService.ts` exporting `trash(rid)`. Implementation: single `WITH RECURSIVE descendants AS ...` UPDATE. Locks: `SELECT ... FOR UPDATE` on target. Audit-log every trashed row.

Test: trash a project with 5 nested folders + 10 datasets → all 15 marked appropriately.

### Turn B5.05 — trashService.restore

Implementation: flip target from DIRECTLY_TRASHED to NOT_TRASHED; for descendants currently ANCESTOR_TRASHED, recompute (unset only if no remaining trashed ancestor). Single SQL transaction.

Test: 6 cases including the "restore sub-folder of trashed project does not flip its descendants" case.

### Turn B5.06 — trashService.permanentlyDelete + retention enforcement

Implementation: check `trashed_at + interval '7 days' < now()`; check user has `compass:permanently-delete-resource`; cascade delete; dispatch `blobCleanupJob` for each deleted dataset's underlying blob.

Create `src/jobs/blobCleanupJob.ts` skeleton (queue interface; actual blob deletion implementation can be a stub that logs the intended path — since blob storage is MinIO and B5's scope is the logical delete).

Test: 4 cases.

### Turn B5.07 — Endpoint wiring (POST /trash, /restore, /permanentlyDelete)

Create routes in `src/routes/filesystemV2/resources.ts`. Each requires `If-Match`, gated by `requirePermission`. Audit on entry.

Integration test: full lifecycle — trash → restore → trash again → wait → permanent delete (in test, mock the retention check).

### Turn B5.08 — verify-B5.sh + load + cypress + tail

Mirror B4.12. Cypress spec covers trash from UI menu, restore, attempt permanent delete (expect retention error).

---

## B6 — Resource Graph & Cross-Project References — 8 Turns

**Decisions locked.**
- Lineage default depth: 5; max: 20 (per spec).
- Cycle detection: precompute via recursive CTE before INSERT; no `CHECK` constraint (Postgres can't express recursive constraints).
- Cross-project reference visibility: gatekeeper.evaluate considers `project_references` as an additional ALLOW path for `compass:view-resource` only.

### Turn B6.01 — resource_dependencies DDL + indexes

Migrate step 22. Test: insert/query 3 cases.

### Turn B6.02 — project_references DDL

Migrate step 23. Test: 3 cases.

### Turn B6.03 — resourceGraphService.addEdge + removeEdge + cycle detection

Create `src/services/resourceGraphService.ts`. `addEdge` runs cycle-check CTE first; rejects with `CYCLE_DETECTED` on hit. Test: 5 cases including 3-node cycle.

### Turn B6.04 — getUpstream / getDownstream / getLineage

Recursive CTE up to `depth`. Returns DAG as flat list with parent links. Test: 4 cases.

### Turn B6.05 — projectReferenceService

Methods: add/list/remove. Permission checks before each: `compass:import-resource-from` on referenced + `compass:import-resource-to` on project. Test: 4 cases.

### Turn B6.06 — Gatekeeper extension for cross-project visibility

Modify `gatekeeperService.evaluate`: in step 3, if user lacks role-based grant, check whether the resource is referenced by a project the user can `view-resource` on. If yes and operation is `compass:view-resource` only → ALLOW. Test extends `gatekeeper-b4-step3` with 2 new cases.

### Turn B6.07 — Endpoint wiring

`POST /api/v2/filesystem/projects/{rid}/references`, `GET`, `DELETE`, `GET /api/v2/filesystem/resources/{rid}/lineage`. Integration test.

### Turn B6.08 — verify-B6.sh + load + cypress + tail

Cypress: navigate to project's References tab, add a reference, observe target resource visible to project member.

---

## B7 — Foundry Branching: Branches, Proposals & Approval Policies — 12 Turns

**Decisions locked.**
- Branch RID format: `ri.branch..branch.<uuid>` (matches CHECK constraint).
- Inactive auto-close threshold: 60 days, configurable via env `BRANCH_INACTIVE_DAYS`.
- Daily cron: implemented as `node-cron` job in `src/jobs/branchAutoCloseJob.ts`, runs at 03:00 UTC.
- Merge conflict detection: two branches modifying the same `(resource_rid, field)` tuple within the overlay JSON. Conflict surfaced as `MERGE_CONFLICT` with `parameters.conflictingResources: [{rid, fields: [...]}, ...]`.
- Kafka topic `tellus.branch.merged` partition count: 12. Replication factor: 1 (test stack).

### Turn B7.01 — branches table DDL + branch_resources

Migrate step 24. Mint master branch row at migrate time: `INSERT INTO branches (rid, name, ...) VALUES ('ri.branch..branch.master', 'master', NULL, ...) ON CONFLICT DO NOTHING`.

Test: master exists post-migrate; can insert child branch.

### Turn B7.02 — proposals + proposal_approvals DDL

Migrate step 25. Test: 4 cases.

### Turn B7.03 — approval_policies DDL + branch_overlays DDL

Migrate step 26. Test: insert/query default policy.

### Turn B7.04 — branchService.create + read

`src/services/branchService.ts`. `createBranch({name, fromBranchRid?})`, `getBranch(rid)`. Test: 5 cases.

### Turn B7.05 — proposalService skeleton (open + status)

Create proposal, transition status. Test: 4 cases.

### Turn B7.06 — proposalService.approve

Validates approver in `eligible_reviewers`; honors `contributor_can_approve`; inserts into `proposal_approvals`. Test: 6 cases.

### Turn B7.07 — Merge algorithm (conflict detection)

Pre-merge check: query overlapping `branch_overlays` rows across open branches against same target. If overlap exists → `MERGE_CONFLICT`. Test: 5 cases including conflict-detection case.

### Turn B7.08 — Merge algorithm (apply overlays + audit + Kafka emit)

Single tx: apply each overlay (merge JSON into the target resource's metadata or ontology row); update `branches.status='MERGED'`; audit; emit `BranchMerged` to `tellus.branch.merged`.

Implement Kafka producer in `src/lib/kafkaProducer.ts` (using `kafkajs`). Test verifies message landed (consume in test).

### Turn B7.09 — Idempotent merge replay

Wrap merge endpoint with `Idempotency-Key` middleware (extends B3's idempotency store). Test: replayed merge of merged proposal returns cached response.

### Turn B7.10 — Inactive auto-close cron

`src/jobs/branchAutoCloseJob.ts`. Test: simulate 60-day-old branch (manually set created_at), run job, assert status=CLOSED.

### Turn B7.11 — Endpoint wiring

All 7 endpoints from spec. Each requires permission. Integration test exercises full flow.

### Turn B7.12 — verify-B7.sh + load + cypress + tail

Cypress: create branch via UI (uses F7's BranchSwitcher; if F7 not done yet, use API directly in cy spec).

---

## B8 — OMS — Object Types & Link Types — 15 Turns

**Decisions locked.**
- Ontology RID format per spec.
- ObjectType `apiName` regex: `^[a-z][a-zA-Z0-9]*$`. Max 64 chars. Enforced at insert via Postgres CHECK + service-layer validation.
- Mandatory_control format: `{requiredMarkings: [<markingId>], action: 'NULL_OUT' | 'DENY'}`.
- Kafka topic `tellus.oms.object-type.updated` partition: 12.
- Validation runs in service layer BEFORE DB insert; DB CHECK constraints are belt-and-suspenders.

### Turn B8.01 — ontologies table DDL + seed default ontology

Migrate step 27. Default ontology: `ri.ontology.main.ontology.default`, `api_name='default'`, `space_rid=root`. Test.

### Turn B8.02 — object_types DDL + UNIQUE constraint

Migrate step 28. Test: cannot create two with same (ontology, branch, api_name).

### Turn B8.03 — object_type_properties DDL

Migrate step 29. Test: PK enforces unique api_name per object type.

### Turn B8.04 — object_type_datasources DDL

Migrate step 30. Test.

### Turn B8.05 — link_types DDL

Migrate step 31. Test: cardinality + backing_type combinations.

### Turn B8.06 — shared_property_types + interfaces DDL

Migrate step 32. Test.

### Turn B8.07 — omsService.createObjectType (validation + insert)

`src/services/omsService.ts`. Validation per spec (apiName regex, immutability check for ACTIVE, primary_keys constraints, title_property exists, property_mapping subset check, primary_key_columns length check). Multi-table insert in single tx. Test: 12 cases (one per validation rule + happy path).

### Turn B8.08 — omsService.getObjectType + listObjectTypes (branch-aware)

Reads with `branch=` param. Test: 5 cases.

### Turn B8.09 — omsService.updateObjectType (If-Match, immutability)

Test: 6 cases including `IMMUTABLE_API_NAME` after ACTIVE.

### Turn B8.10 — BACKS edge registration + lineage chain

On createObjectType, write `resource_dependencies` rows (BACKS object_type → datasource; INPUT_OF datasource → object_type). Test: 3 cases.

### Turn B8.11 — Kafka emit on update

`tellus.oms.object-type.updated` event payload: `{objectTypeRid, ontologyRid, branchRid, etag, updatedAt}`. Test: emit verified by consumer.

### Turn B8.12 — omsService for linkTypes

createLinkType with FK / JOIN_TABLE / OBJECT_BACKED variants. Validation per spec. Test: 9 cases.

### Turn B8.13 — omsService for sharedPropertyTypes + interfaces

CRUD methods. Test.

### Turn B8.14 — Endpoints (6 routes)

Register routes; each gated by requirePermission. Integration test.

### Turn B8.15 — verify-B8.sh + load + cypress + tail

Cypress (or API-only spec): create ontology → create object type from existing dataset → assert visible in DB.

---

## B9 — Funnel — Indexing Pipeline — 12 Turns

**Decisions locked.**
- OpenSearch client: `@opensearch-project/opensearch@2`.
- Index naming: `obj-{objectTypeRid}-{branchRid}` (lowercased, dots → hyphens).
- Bulk batch size: 1000 docs (per spec).
- Throughput cap: 2 MB/s per object type, env `FUNNEL_MAX_MBPS=2`.
- Live cadence: 6h, env `FUNNEL_RESCAN_HOURS=6`.
- DLQ topic: `tellus.funnel.dlq`.
- Iceberg snapshot library: deferred — for v1, the "changelog" phase reads dataset rows directly from postgres `dataset_rows` (a view over foundry_datasets' parsed content). Note this in `progress/B9.md` as a v1 simplification.

### Turn B9.01 — funnel_pipeline_state DDL

Migrate step 33. Test.

### Turn B9.02 — OpenSearch client setup + index template

`src/jobs/funnel/openSearchClient.ts`. Connection pool. Index template defining property type mappings (text, keyword, long, double, date, geo_point, etc.). Test: connect to test cluster, verify template applied.

### Turn B9.03 — Changelog phase

`src/jobs/funnel/changelog.ts`. Function `produceChangelog(objectTypeRid, branchRid)`. Returns `{primaryKey, op, row}[]`. Test: 3 datasets → 3 changelog entries.

### Turn B9.04 — MergeChanges phase

`src/jobs/funnel/mergeChanges.ts`. Joins changelog with Action edits from Kafka offset state. Test: changelog INSERT + Action UPDATE → final UPDATE row.

### Turn B9.05 — Indexer phase (bulk OpenSearch writes)

`src/jobs/funnel/indexer.ts`. Batches of 1000. Validation per `object_type_properties` types; rows that fail validation → DLQ. Test: 5 cases.

### Turn B9.06 — Hydrator phase

`src/jobs/funnel/hydrator.ts`. Refresh index, mark state READY, publish `tellus.oms.object-type.indexed`. Test.

### Turn B9.07 — funnelService orchestrator (per-objectType pipeline)

`src/jobs/funnelService.ts`. Sequence: changelog → merge → index → hydrate. Updates `funnel_pipeline_state` at each phase. Test: full pipeline 100-row dataset.

### Turn B9.08 — Kafka consumer for `tellus.oms.object-type.updated`

Subscribes; on event, dispatches `funnelService.run(objectTypeRid, branchRid)`. Test.

### Turn B9.09 — Replacement pipeline (schema change)

When schema changes detected: spawn parallel pipeline writing to `obj-{rid}-{branch}-v{n+1}`. On complete, atomic alias swap. Test: schema change → both indices exist → alias points to new.

### Turn B9.10 — Throughput cap + backpressure

Token-bucket throttle in indexer. Test: 10MB/s input → 2MB/s output observed; FUNNEL_BACKPRESSURE event emitted.

### Turn B9.11 — 6h scheduled re-run

`node-cron` job. Test: simulate, assert all active pipelines re-run.

### Turn B9.12 — verify-B9.sh + 1M-row test + cypress + tail

Load probe: 1M rows indexed, assert <5min wall clock. Cypress (API-driven): create object type with 1M-row dataset, poll `/api/v2/ontologies/.../objectTypes/...?expand=indexStatus` until READY.

---

## B10 — OSS — Object Set Service — 10 Turns

**Decisions locked.**
- IR validation: zod schema in `src/lib/objectSetIr.ts`.
- OpenSearch DSL compiler: pure function `compileToOpenSearch(ir, propertyTypes): OpenSearchQuery`.
- Property strip: implemented as a post-query transform; nulled values replaced with `null` (not omitted) so client sees the structure.
- KNN vector search: requires OpenSearch `knn-vector` field type; assume B9's index template includes this.
- Saved object sets: stored in `resources` table with `type='OBJECT_SET'`, IR in `metadata->>'objectSet'`.

### Turn B10.01 — IR types + zod schema

`src/lib/objectSetIr.ts`. Type definitions per spec; zod runtime validation. Test: 12 cases (each IR variant + invalid cases).

### Turn B10.02 — IR → OpenSearch DSL compiler (filters)

`src/services/ossService.ts` internal helper. Compiles `eq/gt/lt/in/contains/and/or/not` to OpenSearch query DSL. Test: 10 cases.

### Turn B10.03 — IR compiler (geoDistance, knn)

Test: 4 cases.

### Turn B10.04 — load endpoint

`POST /api/v2/ontologies/{rid}/objectSets/load`. Pagination via cursor (reuse B3 base64 encoding). Permission stripping post-fetch. Test: 6 cases.

### Turn B10.05 — aggregate endpoint

OpenSearch aggregations: count, sum, avg, min, max, approxDistinct. groupBy via terms aggregation. Test: 5 cases.

### Turn B10.06 — searchAround endpoint (M:1, 1:M)

Compiles to terms-lookup against the link's join-table index OR direct link traversal for FK-backed. Test: 4 cases. M:M with >100k source returns `OBJECT_SET_TOO_LARGE`.

### Turn B10.07 — save / get object set as Compass resource

Persists IR in `resources.metadata`. Test: 4 cases.

### Turn B10.08 — load-by-PK convenience endpoint

GET single object. Test.

### Turn B10.09 — Permission stripping (mandatory_control)

When loading: for each property with `mandatory_control`, check user's markings; if missing → null out value. Test: 4 cases.

### Turn B10.10 — verify-B10.sh + load + cypress + tail

Load probe: load(pageSize=100) P95 < 100ms. Cypress.

---

# PART III — FRONTEND TASKS (F1 — F10)

**General convention.** Frontend turns are typically smaller (1 component or 1 page per turn). Each turn ends with: TypeScript build clean, component-level Vitest passing, Playwright/Cypress E2E spec passing.

**Decisions locked (all F-tasks).**
- State management: TanStack Query (already in use) + Zustand for local UI state.
- Styling: existing Tailwind config; no new design system.
- Component library: existing in `tellus-fe/components/ui/*` (shadcn-derived).
- Testing: Vitest for unit, Cypress for E2E.
- All components are `default export` functional components, no class components.

---

## F1 — Files Hub Page — 6 Turns

**Depends on.** B1, B3 ✅ (after backfill).

### Turn F1.01 — FilesPageHeader + FilesTabBar refactor

Existing files in `tellus-fe/components/files/`. Update to support 4 tabs: Portfolios, Projects, Your files, Shared with you. Tab keyboard nav (←/→). Tab state in URL `?tab=...` with `localStorage` fallback. Test: render, tab-switch, URL update.

### Turn F1.02 — Projects tab (virtualized table)

Use `@tanstack/react-virtual`. Columns per spec. Sortable by Name, Last updated. Row context menu. Test: render 1000 rows, scroll smoothness, column sort.

### Turn F1.03 — Your files tab

Query: `created_by = currentUser AND project_rid = personal-project`. New endpoint `/api/v2/filesystem/resources/myFiles` (add to backend B3 if missing — extend in same turn). Test.

### Turn F1.04 — Shared with you tab

Endpoint `/api/v2/filesystem/resources/sharedWithMe` (add if missing). Test.

### Turn F1.05 — Portfolios tab (Recents portfolio)

Query top-50 view events from a new `recent_views` table (add migrate step in this turn for the table; updates on each resource view via middleware). Test.

### Turn F1.06 — Header search bar + empty states + verify-F1.sh

Debounced 200ms search. Empty state per tab. verify-F1.sh runs: `pnpm typecheck` → `pnpm test components/files` → `pnpm e2e:f1`.

---

## F2 — Project Detail Page — 7 Turns

### Turn F2.01 — Project header (sticky, inline-renamable)

`app/projects/[projectId]/page.tsx`. Header component with name, description, markings/orgs chips, action buttons. Inline rename gated by `useResourcePermissions`. Test.

### Turn F2.02 — Sub-tab strip + URL routing

5 tabs. URL `?tab=...`. Test.

### Turn F2.03 — Files sub-tab (folder browser embedded)

Reuses F3's `FolderBrowser` component (will be implemented in F3). For F2, embed a placeholder until F3 done. Note in `progress/F2.md`: requires F3 turn 8 for full functionality.

### Turn F2.04 — Autosaved sub-tab

Virtualized list filtered by `(created_by=user, parent_folder=personal-autosave, type IN (...))`. Test.

### Turn F2.05 — References sub-tab

Lists `project_references`. Add Reference dialog (resource picker). Test.

### Turn F2.06 — Trash sub-tab

Lists trashed resources for this project. Restore + Permanent delete buttons. Test.

### Turn F2.07 — Members sub-tab + verify-F2.sh

Three sections: Members, Organizations, Markings. Add Member dialog (reuses existing `AddMemberDialog`). Test.

---

## F3 — Folder Browser — 8 Turns

### Turn F3.01 — Tree sidebar (collapsible, lazy-load)

`components/folders/FolderTreeSidebar.tsx`. Test.

### Turn F3.02 — Table view (configurable columns, virtualized at 200+)

Update `FolderTable.tsx`. Columns persist to user prefs (`/api/v2/users/me/preferences` — add backend endpoint in this turn). Test.

### Turn F3.03 — Multi-select (shift-range, cmd-toggle)

Test.

### Turn F3.04 — Multi-select toolbar (Move, Trash, Add markings, Copy paths)

Test.

### Turn F3.05 — Drag-drop move (HTML5 DnD)

Test: 50-row drag-drop into tree node fires correct API.

### Turn F3.06 — Keyboard shortcuts + help overlay

`↑↓ Enter F2 Del ⌘C ⌘D ⌘⇧M ⌘?`. Help overlay component. Test.

### Turn F3.07 — Concurrency UX (412 handling, auto-refetch)

Toast + retry once on 412. Inline error on RESOURCE_NAME_CONFLICT. Test.

### Turn F3.08 — Breadcrumb truncation + verify-F3.sh

Cypress: full keyboard nav scenario.

---

## F4 — Resource Sharing & Permissions Dialog — 7 Turns

**Depends on.** B4 ✅.

### Turn F4.01 — ShareDialog scaffold + tab switcher

`components/sharing/ShareDialog.tsx`. 4 tabs: Roles, Markings, Organizations, Effective. Test.

### Turn F4.02 — PrincipalPicker (autocomplete users + groups)

Extracted from existing `AddMemberDialog`. Test.

### Turn F4.03 — Roles tab (grant + revoke + role select)

Per-principal role select. Disable inherited permissions toggle (with confirm). Test.

### Turn F4.04 — Markings tab

Searchable picker scoped to user's `Apply marking` permission. Remove with double-confirm. Test.

### Turn F4.05 — Organizations tab (project-only)

Add org with `Expand access` permission. Shows new user surface preview. Test.

### Turn F4.06 — Effective permissions tab

Calls `POST /api/v2/permissions/evaluateBatch` (B4.09). Renders matrix. Test: 50 principals < 200ms.

### Turn F4.07 — Concurrency, A11y, verify-F4.sh

Each tab Save sends If-Match. Dialog A11y. Cypress full sharing flow.

---

## F5 — Quick-Open Palette — 5 Turns

### Turn F5.01 — QuickOpenProvider + global ⌘K binding

Top-level provider in root layout. Test.

### Turn F5.02 — QuickOpenDialog + result rendering

Test: 100 results render < 100ms.

### Turn F5.03 — Filter chips (type, owner, marking, project, recent)

Parse from input. Test.

### Turn F5.04 — Backend `/api/v2/filesystem/search` (add if missing)

In this turn, extend B3 with the search endpoint. Test full-text + filter combinations.

### Turn F5.05 — Recent visited + abort-on-keystroke + verify-F5.sh

IndexedDB store for recents. AbortController on each new query. Cypress.

---

## F6 — Trash, Restore & Permanent Delete — 5 Turns

### Turn F6.01 — Global /trash page + TrashTable

`app/trash/page.tsx`. Virtualized at 200+. Test.

### Turn F6.02 — RestoreDialog (confirms target, blocks if ancestor trashed)

Test: 4 cases.

### Turn F6.03 — PermanentDeleteDialog (typed-confirm)

Disabled until retention met. Test.

### Turn F6.04 — Status pills + auto-purge live timer

Updates every minute via setInterval. Test.

### Turn F6.05 — Empty trash bulk action + verify-F6.sh

Owners-only. Cypress.

---

## F7 — Branch Switcher & Proposal Review UI — 9 Turns

**Depends on.** B7 ✅.

### Turn F7.01 — branchStore (Zustand)

`stores/branchStore.ts`. `currentBranchRid`, `setBranch`. Test.

### Turn F7.02 — BranchSwitcher dropdown component

Header integration. Test.

### Turn F7.03 — Hooks pass `?branch=` to all queries

Update `useFolderChildren`, `useProjects`, `useObjectType*` to read store. Test: branch switch refetches.

### Turn F7.04 — BranchCreateDialog

Test.

### Turn F7.05 — `/branches` list page

Filter by status (Open/Merged/Closed/Mine). Test.

### Turn F7.06 — `/branches/[rid]` detail page

Test.

### Turn F7.07 — `/proposals/[rid]` review page (4 panels)

Diff, Approvals, Discussion, Merge controls. Test.

### Turn F7.08 — Diff renderer (per-resource-type)

ObjectType / LinkType / Dataset / Folder. Test: 4 cases.

### Turn F7.09 — Merge flow + MERGE_CONFLICT panel + verify-F7.sh

Cypress full proposal lifecycle.

---

## F8 — Ontology Manager — 10 Turns

**Depends on.** B8 ✅.

### Turn F8.01 — `/ontology` ontology list page

Test.

### Turn F8.02 — `/ontology/[rid]` object types list

Test.

### Turn F8.03 — Object type editor scaffold (3-pane layout)

Test.

### Turn F8.04 — Properties list pane (left)

Add/remove/reorder. Inline edit api_name, display_name, base_type. Star/crown indicators. Test.

### Turn F8.05 — Property detail pane (center)

Type-specific config: array, struct, vector, mandatory_control. Test.

### Turn F8.06 — Datasources panel (right) + property mapping table

Type-compat badge per mapped column. Auto-fill button. Test.

### Turn F8.07 — Header (apiName, status, visibility, icon, type classes, groups)

Immutability badge after ACTIVE. IconPicker. Test.

### Turn F8.08 — Save flow with If-Match + validation banner

Test: type-incompat mapping blocks save.

### Turn F8.09 — Link type editor (single column)

FK / JOIN_TABLE / OBJECT_BACKED variants with conditional config. Test.

### Turn F8.10 — verify-F8.sh

Cypress: create object type from dataset, save, verify Funnel kicked off.

---

## F9 — Object Explorer — 8 Turns

**Depends on.** B10 ✅.

### Turn F9.01 — `/object-explorer/[rid]/[apiName]` page scaffold (3-pane)

Test.

### Turn F9.02 — Results table (virtualized, configurable columns)

Test.

### Turn F9.03 — Facet sidebar (top-N + numeric histogram)

Calls `aggregate` endpoint per searchable property. Test.

### Turn F9.04 — Filter chip bar

Add/remove filters → IR rebuild. Test.

### Turn F9.05 — Query box (Lucene-like → IR)

Parser in `lib/queryBox/parser.ts`. AND/OR/NOT/parens/quotes/wildcards/fuzzy. Test: 20 parse cases.

### Turn F9.06 — Search-around action

Kebab → "Find related <linkType>" → navigates to target with searchAround IR pre-applied. Test.

### Turn F9.07 — Object set save dialog

Calls `POST /api/v2/ontologies/{rid}/objectSets/save`. Test.

### Turn F9.08 — Mandatory-control rendering + verify-F9.sh

Restricted properties render `—` with lock icon. Cypress.

---

## F10 — Quiver — 10 Turns

**Depends on.** B10 ✅.

### Turn F10.01 — Canvas scaffold (`@xyflow/react`)

Test.

### Turn F10.02 — Card library + CardEdge typed connections

Type system: OBJECT_SET / TIME_SERIES / NUMBER / CATEGORY / TABLE / PLOT. Reject mismatched edges. Test.

### Turn F10.03 — ObjectSetSourceCard

Server-side execution via OSS load. Test.

### Turn F10.04 — FilterCard

Inspector: filter chips. Test.

### Turn F10.05 — SearchAroundCard

Test.

### Turn F10.06 — AggregateCard

groupBy + aggs. Output: TABLE. Test.

### Turn F10.07 — TransformTableCard (DuckDB-WASM)

`@duckdb/duckdb-wasm`. Sort/filter/derive/rename. 50k row cap. Test.

### Turn F10.08 — ChartCard (vega-embed)

Vega-Lite spec from x/y/mark UI. Test.

### Turn F10.09 — Auto-save (debounced 1.5s) + URL state

PATCH `/api/v2/quiver/analyses/{rid}` with full graph. Test: page reload preserves graph.

### Turn F10.10 — Keyboard shortcuts + verify-F10.sh

⌘D / Del / ⌘Z / ⌘⇧Z (50-step history). Cypress: 4-card chain end-to-end.

---

# PART IV — Cross-Task Verification

After all 20 tasks are ✅ in SUBTASKS.md, the agent runs the integration-level verification scenarios from SPEC.md "Verification matrix":

### Turn FINAL.01 — End-to-end scenario 1

Create project → folder → upload dataset → create object type → query in Object Explorer → save object set → use in Quiver.

Implemented as `cypress/files-projects/e2e/scenario-1.cy.ts`. Single spec, 60+ second run. Asserts each step's API response and UI state.

### Turn FINAL.02 — End-to-end scenario 2

Share project as Viewer; verify visibility from second account.

### Turn FINAL.03 — End-to-end scenario 3

Branch → modify object type → propose → approve → merge.

### Turn FINAL.04 — End-to-end scenario 4

Trash → restore → permanent-delete.

### Turn FINAL.05 — End-to-end scenario 5

Cross-project reference visibility.

### Turn FINAL.06 — End-to-end scenario 6

Quick-open finds deeply-nested folder.

### Turn FINAL.07 — Definition of Done

Run `pnpm migrate && pnpm dev` (backend) + `pnpm dev` (frontend). Manually walk through SPEC.md "Definition of Done" steps 1-6. Document the run as a screencast or sequence of screenshots in `tasks/files-projects/progress/FINAL.md`.

**Exit gate.** All 7 FINAL turns ✅. `verify-all.sh` exits 0. Spec.md acceptance for every B and F task all checked.

---

# PART V — Troubleshooting (when a Turn's Exit Gate doesn't exit 0)

The agent does not halt on a failing Exit Gate. The protocol is:

1. Read the failing command's stderr.
2. Identify the failure category:
   - Missing dependency → install it (`pnpm add ...`), retry.
   - Type error in just-written code → fix and retry.
   - Test assertion failure → re-read the spec section, correct the implementation, retry.
   - Migration error → check idempotency, fix DDL, retry.
   - Docker service unhealthy → `bash scripts/dc-up.sh` and retry.
   - OpenSearch / Kafka not running → start them, retry.
3. After 3 retries with the same failure, halt under v4 §5 STRUCTURAL_BLOCK with the failing command + stderr + 3 attempted resolutions documented.

Do not halt under any other condition. Specifically: never halt because "this turn has been long" or "I've made many tool calls." The Exit Gate is the only legitimate stopping criterion.

---

# Closing

This document is the execution plan. The original `tasks/files-projects/SPEC.md` is the contract. The agent reads both at every turn-start.

There are 158 turns across 20 tasks (20 backfill + B4-B10 = 65 + F1-F10 = 76 + 7 FINAL — cross-check against SUBTASKS.md after seeding). Each turn is one session. Each session has one Exit Gate. The agent does not negotiate with this document; it executes it.

When SUBTASKS.md shows all rows ✅ and `verify-all.sh` exits 0, Tellus's Files & Projects DAG is GREEN.