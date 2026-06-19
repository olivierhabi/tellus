# Tellus — Files & Projects Implementation Tasks
**20 tasks (10 backend + 10 frontend) — production contracts**

> **Audience.** AI agent operating on the existing Tellus repos at `~/Desktop/projects/{tellus,tellus-fe}`.
> **Reference docs.** (a) *Compass Replication Blueprint* (the Foundry research artifact in this thread). (b) *Discovery — Files & Projects Feature Surface* (the on-disk inventory).
> **Style.** Each task is a contract. No "TODOs", no "investigate", no "consider" — every checkbox is binary-verifiable. Modify existing files where they exist; only create new files when none of the existing files cover the responsibility. Do not introduce parallel implementations of anything already on disk.

---

## Sequencing & Dependencies

```
B1 ── B2 ── B3 ── B4 ── B5 ── B6 ── B7
                         └──> B8 ── B9 ── B10
F1 (deps: B1, B3)
F2 (deps: B3, B6)
F3 (deps: B3, B5)
F4 (deps: B4)
F5 (deps: B3)
F6 (deps: B5)
F7 (deps: B7)
F8 (deps: B8)
F9 (deps: B10)
F10 (deps: B10)
```

`B1`–`B7` form the Compass core and must land before any ontology work. `B8`–`B10` are the Ontology stack (OMS / Funnel / OSS). Frontend tasks gate on the marked backend tasks.

---

## Conventions used in every task

- **DDL changes** are appended to `src/foundryMigrate.ts` as new idempotent steps (`CREATE … IF NOT EXISTS`, `ALTER … ADD COLUMN IF NOT EXISTS`). Do **not** add numbered Knex migrations under `src/migrations/`; the discovery confirms the runtime uses `foundryMigrate.ts`.
- **RID format** (verbatim from `palantir/resource-identifier`): `ri.<service>.<instance>.<type>.<locator>`. Service/instance/type are kebab-case lowercase; instance may be empty (`..`); locator is a UUIDv4 unless otherwise specified.
- **Optimistic concurrency.** Every mutating endpoint accepts `If-Match: <etag>` (where `<etag>` is the integer `etag` column). Mismatch → `412 Precondition Failed` with body `{errorCode: "PRECONDITION_FAILED", expected, actual}`.
- **Errors.** All errors return JSON `{errorCode: SCREAMING_SNAKE, message, parameters?: {...}, errorInstanceId: <uuid>}`. `errorInstanceId` is logged with the request span.
- **Auth.** Every route is gated by `authenticate` (`src/middleware/auth.ts`) and a permission check (after B4) via `requirePermission(operationId, ridFromParams)`.
- **Metric naming.** `tellus_<subsystem>_<verb>_<unit>` (e.g. `tellus_compass_get_resource_seconds_bucket`). Histograms always include `le` buckets `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.
- **SLO targets** apply at p95, single-region, warm cache, sustained 100 RPS unless stated.

---

# BACKEND TASKS

---

## B1. Compass Resource Model & RID System

**Goal.** Introduce a single `resources` table that is the canonical addressing layer for every Compass-tracked entity (project, folder, dataset, code repo, ontology object, …) and an `Rid` value type used everywhere a row is referenced cross-table.

**Reference.** Blueprint §1 (Compass), §1.2 (RID grammar), §1.5 (storage).

**Existing code to modify.**
- `src/foundryMigrate.ts:24-36, 40-54, 93-112` — projects/folders/foundry_datasets all currently use `uuid` PKs. Do **not** drop them. Wrap each row in a `resources` row (a thin adapter table) so existing code continues to work.
- `src/services/projectService.ts`, `src/services/folderService.ts`, `src/services/foundryUploadService.ts` — every row creation must, in the same transaction, emit a `resources` row.
- `src/types/project.ts`, `src/types/folder.ts` — add `Rid` brand type.

**New files.**
- `src/lib/rid.ts` — `parseRid`, `formatRid`, `mintRid(service, type)`, `Rid` branded type. Mirror the regex from §1.2.
- `src/services/compassService.ts` — `getResource(rid)`, `getResourcesBatch(rids[])`, `getResourceByPath(path)`, `getChildren(parentRid, page)`. Wraps the resources table.

**Schema (append to `src/foundryMigrate.ts`).**
```sql
CREATE TABLE IF NOT EXISTS resources (
  rid                  text PRIMARY KEY
                       CHECK (rid ~ '^ri\.[a-z][a-z0-9-]*\.([a-z0-9][a-z0-9-]*)?\.[a-z][a-z0-9-]*\..+$'),
  service              text NOT NULL,
  type                 text NOT NULL,
  display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  description          text,
  documentation        text,
  parent_folder_rid    text REFERENCES resources(rid) ON DELETE RESTRICT,
  project_rid          text REFERENCES resources(rid) ON DELETE RESTRICT,
  space_rid            text NOT NULL REFERENCES resources(rid) ON DELETE RESTRICT, -- nullable only for the root space itself; enforce via partial CHECK after B2
  trash_status         text NOT NULL DEFAULT 'NOT_TRASHED'
                       CHECK (trash_status IN ('NOT_TRASHED','DIRECTLY_TRASHED','ANCESTOR_TRASHED')),
  created_by           uuid NOT NULL REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NOT NULL REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  etag                 bigint NOT NULL DEFAULT 1,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_uuid          uuid UNIQUE  -- backref to projects.id / folders.id / foundry_datasets.id during migration
);
CREATE INDEX IF NOT EXISTS resources_parent_idx ON resources (parent_folder_rid);
CREATE INDEX IF NOT EXISTS resources_project_idx ON resources (project_rid);
CREATE INDEX IF NOT EXISTS resources_space_idx ON resources (space_rid);
CREATE INDEX IF NOT EXISTS resources_type_idx ON resources (type);
CREATE INDEX IF NOT EXISTS resources_trash_idx ON resources (trash_status) WHERE trash_status <> 'NOT_TRASHED';

CREATE OR REPLACE FUNCTION resources_bump_etag() RETURNS trigger AS $$
BEGIN
  NEW.etag := OLD.etag + 1;
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER resources_bump_etag_t BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION resources_bump_etag();
```

**Backfill (idempotent, append to migrate).**
```sql
INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, created_at, updated_by, updated_at, legacy_uuid)
SELECT
  'ri.compass.main.project.' || p.id::text,
  'compass', 'PROJECT', p.name, NULL, NULL,
  'ri.compass.main.space.00000000-0000-0000-0000-000000000000', -- root space mint in B2
  p.created_by, p.created_at, COALESCE(p.updated_by, p.created_by), p.updated_at, p.id
FROM projects p
ON CONFLICT (legacy_uuid) DO NOTHING;
-- analogous INSERTs for folders (type='COMPASS_FOLDER') and foundry_datasets (type='FOUNDRY_DATASET')
```

**API surface.** Internal only at this stage (consumed by other services). Public v2 lands in B3.
- `getResource(rid: Rid): Promise<Resource>`
- `getResourcesBatch(rids: Rid[]): Promise<Map<Rid, Resource>>` — max 1000
- `getResourceByPath(path: string): Promise<Resource>`
- `mintRid(service: string, type: string): Rid`

**Invariants.**
- One `resources` row per addressable entity. The `legacy_uuid` UNIQUE prevents drift during migration.
- `display_name` is unique per `parent_folder_rid` (enforce in service layer; SQL UNIQUE blocked by NULL parents — use `coalesce(parent_folder_rid, '∅') || '/' || display_name` partial unique index later in B2).
- `etag` increments on every UPDATE (trigger-enforced).

**Error codes.** `INVALID_RID_FORMAT (400)`, `RESOURCE_NOT_FOUND (404)`, `BATCH_TOO_LARGE (400, max=1000)`.

**Metrics.** `tellus_compass_get_resource_seconds`, `tellus_compass_batch_get_size`, `tellus_compass_rid_parse_errors_total`.

**SLO.** `getResource` p95 < 30 ms; `getResourcesBatch(1000)` p95 < 200 ms.

**Acceptance.**
- [ ] `src/lib/rid.ts` exports `parseRid` that round-trips every example RID in Blueprint §1.2.
- [ ] After running `foundryMigrate`, every existing project/folder/dataset has a matching `resources` row (verify with `SELECT count(*) FROM projects p LEFT JOIN resources r ON r.legacy_uuid = p.id WHERE r.rid IS NULL` returning 0; same for folders and foundry_datasets).
- [ ] `compassService.getResourceByPath('/<existing project>/<existing folder>')` returns the folder's RID.
- [ ] Updating any field in `resources` increments `etag` and `updated_at` automatically.
- [ ] Unit tests cover RID grammar boundary cases (empty instance, max-length locator, invalid characters).

**Out of scope.** Spaces (B2), permissions (B4), public v2 API (B3).

---

## B2. Spaces & Hierarchy Refactor

**Goal.** Make the container hierarchy `Space → Project → Folder → Resource` complete, with a synthetic root space, bidirectional consistency between `resources.space_rid` and the project's space, and ltree path maintenance unchanged for the folders subtree.

**Reference.** Blueprint §1.1, §1.4 (organizations apply to spaces/projects), §10.4 (open-source mapping uses ltree).

**Existing code to modify.**
- `src/foundryMigrate.ts:40-89` — folders table & `update_folder_path()` trigger stays. Add `space_rid` column; trigger preserved.
- `src/services/projectService.ts` — every project create accepts an optional `spaceRid`; defaults to root space.
- `src/services/folderService.ts:1-305` — when reading children, JOIN through `resources` to surface `trashStatus` and `etag` already.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS spaces (
  rid                       text PRIMARY KEY REFERENCES resources(rid) ON DELETE RESTRICT,
  display_name              text NOT NULL,
  enrollment_rid            text NOT NULL,
  default_role_set_id       text NOT NULL DEFAULT 'compass-default',
  file_system_id            uuid NOT NULL,
  usage_account_rid         text,
  is_root                   boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS spaces_one_root_idx ON spaces ((true)) WHERE is_root;

-- Mint the root space if absent
INSERT INTO resources (rid, service, type, display_name, space_rid, created_by, updated_by)
SELECT 'ri.compass.main.space.00000000-0000-0000-0000-000000000000', 'compass', 'COMPASS_SPACE',
       'Root', 'ri.compass.main.space.00000000-0000-0000-0000-000000000000',
       (SELECT id FROM users ORDER BY created_at LIMIT 1),
       (SELECT id FROM users ORDER BY created_at LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM resources WHERE rid = 'ri.compass.main.space.00000000-0000-0000-0000-000000000000');

INSERT INTO spaces (rid, display_name, enrollment_rid, file_system_id, is_root)
VALUES ('ri.compass.main.space.00000000-0000-0000-0000-000000000000', 'Root',
        'ri.compass.main.enrollment.default', gen_random_uuid(), true)
ON CONFLICT DO NOTHING;
```

**Invariant** (enforce in service layer + DB constraint after the partial unique index is in place):
- For every resource, `space_rid` equals its project's `space_rid` (or, if it *is* a project, its declared space).
- A space may not be moved.
- A project may not be moved between spaces (returns `MOVE_BETWEEN_SPACES_FORBIDDEN`).

**Error codes.** `SPACE_NOT_FOUND`, `MOVE_BETWEEN_SPACES_FORBIDDEN (409)`, `ROOT_SPACE_IMMUTABLE (409)`.

**Acceptance.**
- [ ] Root space exists after first migrate, idempotent on re-run.
- [ ] Every existing project's `resources.space_rid` points at the root space.
- [ ] `getResourceByPath('/Root/<project>')` resolves identically to `getResourceByPath('/<project>')` (root space is implicit in path resolution).
- [ ] Unit test: creating a project in a non-existent space returns `SPACE_NOT_FOUND`.

**Out of scope.** Org-to-space membership (B4).

---

## B3. Filesystem v2 Public API Surface

**Goal.** Expose a Conjure-compatible `/api/v2/filesystem/*` API matching the public Foundry surface verbatim. Internal `/api/v1/projects` and `/api/v1/projects/:projectId/folders` remain in place during transition; both share the same service layer.

**Reference.** Blueprint §1.3 (full endpoint list), §1.4 (permissions), §1.5 (concurrency).

**Existing code to modify.**
- `src/server.ts:704-727` — mount `/api/v2/filesystem` router.
- `src/routes/projects.ts`, `src/routes/folders.ts`, `src/routes/uploads.ts`, `src/routes/projectUploads.ts` — keep exporting v1, but extract handlers into controllers and reuse them from v2.

**New files.**
- `src/routes/filesystemV2/{folders,projects,resources,spaces,resourceRoles}.ts`
- `src/controllers/filesystemV2/*.ts` — thin adapters to existing services.

**Endpoints.** Exact paths, methods, request/response shapes match `palantir/foundry-platform-python` `docs/v2/Filesystem/*.md`. Implement at minimum:

| # | Method | Path | Body | Response |
|---|--------|------|------|----------|
| 1 | POST | `/api/v2/filesystem/folders` | `{parentFolderRid, displayName}` | `Folder` |
| 2 | GET | `/api/v2/filesystem/folders/{folderRid}` | — | `Folder` |
| 3 | POST | `/api/v2/filesystem/folders/getBatch` | `{folderRids: string[]}` (≤1000) | `Folder[]` |
| 4 | GET | `/api/v2/filesystem/folders/{folderRid}/children?pageSize&pageToken` | — | `{data: Resource[], nextPageToken?}` |
| 5 | POST | `/api/v2/filesystem/projects` | `CreateProjectRequest` | `Project` |
| 6 | GET | `/api/v2/filesystem/projects/{projectRid}` | — | `Project` |
| 7 | PUT | `/api/v2/filesystem/projects/{projectRid}` | `UpdateProjectRequest` (requires `If-Match`) | `Project` |
| 8 | DELETE | `/api/v2/filesystem/projects/{projectRid}` | (requires `If-Match`) | `204` |
| 9 | GET | `/api/v2/filesystem/resources/{rid}?decorations=...` | — | `Resource` |
| 10 | GET | `/api/v2/filesystem/resources?path=<path>` | — | `Resource` |
| 11 | POST | `/api/v2/filesystem/resources/getByPathsBatch` | `{paths: string[]}` (≤1000) | `Map<path, Resource>` |
| 12 | POST | `/api/v2/filesystem/resources/{rid}/trash` | (requires `If-Match`) | `204` |
| 13 | POST | `/api/v2/filesystem/resources/{rid}/restore` | (requires `If-Match`) | `204` |
| 14 | POST | `/api/v2/filesystem/resources/{rid}/permanentlyDelete` | (requires `If-Match`) | `204` |
| 15 | POST | `/api/v2/filesystem/spaces` | `CreateSpaceRequest` | `Space` |
| 16 | GET | `/api/v2/filesystem/spaces` | — | `{data: Space[]}` |
| 17 | GET | `/api/v2/filesystem/spaces/{spaceRid}` | — | `Space` |

**Pagination.** `pageToken` is opaque base64 of `{lastUpdatedAt, lastRid}`; cursor-based. `pageSize` 1–1000, default 100.

**Headers.** All mutations require `If-Match`. All responses include `ETag: "<etag>"`. All requests support `Idempotency-Key: <uuid>` (stored in `idempotency_keys` table for 24h, replays return cached response).

**Error codes.** `RESOURCE_NOT_FOUND (404)`, `PRECONDITION_FAILED (412)`, `INVALID_ARGUMENT (400)`, `PERMISSION_DENIED (403)` *(stub until B4)*, `RESOURCE_NAME_CONFLICT (409)`, `BATCH_TOO_LARGE (400)`, `INVALID_PAGE_TOKEN (400)`.

**Metrics.** `tellus_filesystem_v2_request_seconds{endpoint,status}`, `tellus_filesystem_v2_etag_mismatch_total{endpoint}`, `tellus_filesystem_v2_idempotent_replay_total`.

**SLO.** `GET /folders/{rid}` p95 < 50 ms. `GET /folders/{rid}/children?pageSize=100` p95 < 100 ms.

**Acceptance.**
- [ ] OSDK Python client (`palantir/foundry-platform-python`) configured to point at Tellus can list folder children, create a folder, trash a resource, and restore it without modification.
- [ ] Every mutation rejects requests without `If-Match` (`428 Precondition Required`).
- [ ] Replay of a successful POST with the same `Idempotency-Key` within 24h returns the original response with `Idempotent-Replay: true` header.
- [ ] Cursor pagination is stable under concurrent inserts (no skips, possible duplicates allowed but flagged in test).

**Out of scope.** Permission enforcement beyond a stub (B4 wires gatekeeper).

---

## B4. Roles, Markings & Organizations (Gatekeeper)

**Goal.** Implement a permission service that evaluates `(principal, resource, operation) → ALLOW | DENY` using three layered controls: **Roles** (default + custom), **Markings** (conjunctive CBAC), **Organizations** (project/space-level membership). Existing `project_members` is extended, not replaced.

**Reference.** Blueprint §1.4 (full model), §10.1 (gatekeeper service).

**Existing code to modify.**
- `src/foundryMigrate.ts:154-161` — `project_members` enum stays but becomes one source of role grants among many.
- `src/middleware/authorize.ts` — replace `authorizeRoles('editor','owner')` with `requirePermission(operationId)` which calls `gatekeeperService.evaluate`.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS roles (
  id            text PRIMARY KEY,                -- 'compass-discoverer','compass-viewer','compass-editor','compass-owner', or custom 'rs-<uuid>'
  display_name  text NOT NULL,
  role_set_id   text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS role_operations (
  role_id       text REFERENCES roles(id) ON DELETE CASCADE,
  operation_id  text NOT NULL,                   -- e.g. 'compass:view-resource'
  PRIMARY KEY (role_id, operation_id)
);

CREATE TABLE IF NOT EXISTS role_grants (
  resource_rid  text REFERENCES resources(rid) ON DELETE CASCADE,
  principal_id  uuid NOT NULL,                   -- user or group id
  principal_type text NOT NULL CHECK (principal_type IN ('USER','GROUP','EVERYONE')),
  role_id       text REFERENCES roles(id),
  granted_by    uuid NOT NULL REFERENCES users(id),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_rid, principal_id, role_id)
);
CREATE INDEX IF NOT EXISTS role_grants_principal_idx ON role_grants(principal_id);

CREATE TABLE IF NOT EXISTS markings (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  category      text NOT NULL,
  description   text,
  org_scope     uuid[] NOT NULL DEFAULT '{}',    -- empty = unrestricted
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS resource_markings (
  resource_rid  text REFERENCES resources(rid) ON DELETE CASCADE,
  marking_id    uuid REFERENCES markings(id),
  source        text NOT NULL CHECK (source IN ('DIRECT','INHERITED','DATA_LINEAGE')),
  PRIMARY KEY (resource_rid, marking_id, source)
);
CREATE TABLE IF NOT EXISTS user_markings (
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  marking_id    uuid REFERENCES markings(id),
  PRIMARY KEY (user_id, marking_id)
);

CREATE TABLE IF NOT EXISTS organizations (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  display_name  text NOT NULL
);
CREATE TABLE IF NOT EXISTS user_organizations (
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  org_id        uuid REFERENCES organizations(id),
  is_guest      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS project_organizations (
  project_rid   text REFERENCES resources(rid) ON DELETE CASCADE,
  org_id        uuid REFERENCES organizations(id),
  PRIMARY KEY (project_rid, org_id)
);
CREATE TABLE IF NOT EXISTS space_organizations (
  space_rid     text REFERENCES resources(rid) ON DELETE CASCADE,
  org_id        uuid REFERENCES organizations(id),
  PRIMARY KEY (space_rid, org_id)
);

-- Seed system roles
INSERT INTO roles VALUES
  ('compass-discoverer','Discoverer','compass-default',true),
  ('compass-viewer','Viewer','compass-default',true),
  ('compass-editor','Editor','compass-default',true),
  ('compass-owner','Owner','compass-default',true)
ON CONFLICT DO NOTHING;
INSERT INTO role_operations VALUES
  ('compass-discoverer','compass:discover-resource'),
  ('compass-viewer','compass:discover-resource'),('compass-viewer','compass:view-resource'),
  ('compass-editor','compass:discover-resource'),('compass-editor','compass:view-resource'),('compass-editor','compass:edit-resource'),
  ('compass-owner','compass:discover-resource'),('compass-owner','compass:view-resource'),('compass-owner','compass:edit-resource'),
  ('compass-owner','compass:manage-permissions'),('compass-owner','compass:trash-resource'),('compass-owner','compass:permanently-delete-resource')
ON CONFLICT DO NOTHING;
```

**Service: `src/services/gatekeeperService.ts`.**
```ts
async function evaluate(input: {
  principalId: string;
  operationId: string;
  resourceRid: Rid;
}): Promise<{ decision: 'ALLOW' | 'DENY'; reason?: string }>;

async function evaluateBatch(
  principalId: string,
  checks: Array<{operationId: string; resourceRid: Rid}>
): Promise<Map<string, {decision: 'ALLOW'|'DENY'; reason?: string}>>;
```

**Algorithm (deterministic order; first DENY wins).**
1. **Org check** (if resource is or has ancestor project): user must be a member or guest of ≥1 of the project's orgs. Else `DENY:NO_ORG_MEMBERSHIP`.
2. **Marking check**: collect all DIRECT + INHERITED + DATA_LINEAGE markings on the resource and every ancestor project. User must hold *all* of them. Else `DENY:MISSING_MARKINGS:<ids>`.
3. **Role check**: walk ancestor chain (resource → folders → project → space) collecting role grants; if `disable_inherited_permissions=true` is set on a resource, stop walking above it. Take the union of operations from all matched roles. If `operationId` ∈ union → `ALLOW`. Else `DENY:OPERATION_NOT_GRANTED`.

**Migration of existing `project_members`** — at migrate time, mirror each row into `role_grants` mapping `owner→compass-owner`, `editor→compass-editor`, `viewer→compass-viewer`. Keep `project_members` writable; updates trigger sync (single trigger function).

**Error codes.** `PERMISSION_DENIED (403)` with `parameters.reason` echoing the algorithm step that denied.

**Metrics.** `tellus_gatekeeper_evaluate_seconds`, `tellus_gatekeeper_decisions_total{decision,reason}`.

**SLO.** `evaluate` p95 < 5 ms (warm cache). `evaluateBatch(50)` p95 < 20 ms.

**Cache.** In-process LRU keyed by `(principalId, resourceRid, operationId)` with 30s TTL; invalidated by a Postgres `LISTEN/NOTIFY` channel `gatekeeper_invalidate` triggered on writes to `role_grants`, `resource_markings`, `project_organizations`, `user_organizations`.

**Acceptance.**
- [ ] An owner of project P can `compass:edit-resource` on every folder/dataset transitively in P; a viewer cannot.
- [ ] A user lacking marking M cannot `view-resource` on any resource carrying M, even if otherwise granted Editor.
- [ ] A user not in any of project P's orgs is denied at step 1 even if they hold an Owner role grant.
- [ ] Setting `disable_inherited_permissions=true` on folder F prevents project-level grants from cascading into F.
- [ ] Cache invalidation propagates within 200 ms of a `role_grants` change (verified by integration test).

**Out of scope.** OAuth2 scope checking (handled by Multipass/Keycloak).

---

## B5. Trash, ETag & Optimistic Concurrency

**Goal.** Wire trash/restore/permanent-delete semantics with `DIRECTLY_TRASHED` vs `ANCESTOR_TRASHED` propagation, and audit every write.

**Reference.** Blueprint §1.1 (trash semantics), §1.5 (concurrency invariants).

**Existing code to modify.**
- `src/services/folderService.ts` and `projectService.ts` — replace any `DELETE FROM` with `UPDATE resources SET trash_status='DIRECTLY_TRASHED'`.
- `src/server.ts` — register `etagMiddleware` parsing `If-Match` and writing `ETag` on responses.

**New files.**
- `src/middleware/etag.ts`
- `src/services/trashService.ts`
- `src/db/audit.ts` — append to `audit_log` on every mutation.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS audit_log (
  id              bigserial PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_id        uuid NOT NULL,
  resource_rid    text NOT NULL,
  operation_id    text NOT NULL,
  request_id      uuid NOT NULL,
  before_json     jsonb,
  after_json      jsonb,
  outcome         text NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE'))
);
CREATE INDEX IF NOT EXISTS audit_log_resource_idx ON audit_log(resource_rid, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_id, occurred_at DESC);
```

**Trash propagation.**
- `trashService.trash(rid)` — set `DIRECTLY_TRASHED` on the resource; recursively set `ANCESTOR_TRASHED` on every descendant (single SQL with recursive CTE over `resources` joined on `parent_folder_rid`).
- `trashService.restore(rid)` — flip `DIRECTLY_TRASHED → NOT_TRASHED`. Walk descendants: any descendant whose `trash_status='ANCESTOR_TRASHED'` AND no ancestor remains trashed → `NOT_TRASHED`. (Recompute by checking `EXISTS(SELECT 1 FROM ancestors WHERE trash_status='DIRECTLY_TRASHED')`.)
- `trashService.permanentlyDelete(rid)` — only allowed if `DIRECTLY_TRASHED` and ≥7 days in trash (config) AND user holds `compass:permanently-delete-resource`. Cascades to descendants. Underlying blob storage cleanup is dispatched via `parseDatasetJob`-style background queue (`src/jobs/blobCleanupJob.ts`).

**Concurrency.** All three operations are single transactions with `SELECT ... FOR UPDATE` on the target resource and `If-Match` enforcement.

**Error codes.** `TRASH_RETENTION_NOT_MET (409)`, `RESOURCE_ALREADY_TRASHED (409)`, `RESOURCE_NOT_TRASHED (409)`.

**Metrics.** `tellus_trash_operation_seconds{op}`, `tellus_trash_descendants_affected_total`, `tellus_audit_writes_total{outcome}`.

**SLO.** Trash of a project with 10k descendants p95 < 2 s.

**Acceptance.**
- [ ] Trashing a project marks all descendants `ANCESTOR_TRASHED` in one SQL roundtrip.
- [ ] Restoring a sub-folder of a trashed project does **not** flip its descendants out of `ANCESTOR_TRASHED` (because the project ancestor is still trashed).
- [ ] Permanent delete before retention window returns `TRASH_RETENTION_NOT_MET`.
- [ ] Every successful mutation produces exactly one `audit_log` row.

**Out of scope.** Cross-region replication of audit log.

---

## B6. Resource Graph & Cross-Project References

**Goal.** Persist edges between resources (input/output, backs, materializes, references) and allow cross-project visibility via project references without copying data.

**Reference.** Blueprint §1.5 (resource_dependencies), §1.4 (project references), §3 (BACKS edge from dataset → object type).

**Existing code to modify.**
- `src/services/foundryUploadService.ts:1-74` — when a dataset is created from a parsed file, add nothing here; B8 will register the BACKS edge from object type to dataset.
- Anywhere a resource references another resource by ID (currently `pipelines.project_id`, `pipelines.folder_id`), add a parallel `resource_dependencies` write.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS resource_dependencies (
  upstream_rid    text NOT NULL REFERENCES resources(rid) ON DELETE CASCADE,
  downstream_rid  text NOT NULL REFERENCES resources(rid) ON DELETE CASCADE,
  edge_type       text NOT NULL CHECK (edge_type IN
                    ('INPUT_OF','OUTPUT_OF','BACKS','MATERIALIZES','IMPLEMENTS','REFERENCES','EMBEDS')),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upstream_rid, downstream_rid, edge_type),
  CHECK (upstream_rid <> downstream_rid)
);
CREATE INDEX IF NOT EXISTS rd_downstream_idx ON resource_dependencies(downstream_rid, edge_type);
CREATE INDEX IF NOT EXISTS rd_upstream_idx   ON resource_dependencies(upstream_rid, edge_type);

CREATE TABLE IF NOT EXISTS project_references (
  project_rid       text REFERENCES resources(rid) ON DELETE CASCADE,
  referenced_rid    text NOT NULL REFERENCES resources(rid) ON DELETE CASCADE,
  added_by          uuid NOT NULL REFERENCES users(id),
  added_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_rid, referenced_rid)
);
```

**Service: `src/services/resourceGraphService.ts`.**
- `addEdge(upstream, downstream, type, metadata)`
- `removeEdge(...)`
- `getUpstream(rid, edgeType?)`
- `getDownstream(rid, edgeType?)`
- `getLineage(rid, depth)` — recursive CTE returning a DAG up to `depth` (default 5, max 20).

**Service: `src/services/projectReferenceService.ts`.**
- `add(projectRid, referencedRid)` — requires `compass:import-resource-from` on referenced + `compass:import-resource-to` on project.
- `list(projectRid)`, `remove(projectRid, referencedRid)`.

**Endpoints.**
- `POST /api/v2/filesystem/projects/{rid}/references` body `{requests:[{resourceRid}]}`
- `GET  /api/v2/filesystem/projects/{rid}/references`
- `DELETE /api/v2/filesystem/projects/{rid}/references/{referencedRid}`
- `GET  /api/v2/filesystem/resources/{rid}/lineage?direction=upstream|downstream&depth=`

**Error codes.** `CYCLE_DETECTED (409)` (lineage write would create cycle), `REFERENCE_ALREADY_EXISTS (409)`, `LINEAGE_DEPTH_EXCEEDED (400)`.

**Metrics.** `tellus_lineage_query_seconds{direction}`, `tellus_lineage_edges_returned`.

**SLO.** `getLineage(depth=5)` p95 < 200 ms for graphs ≤1000 nodes.

**Acceptance.**
- [ ] Creating a transform whose output is dataset D writes one INPUT_OF edge per declared input + one OUTPUT_OF edge to D.
- [ ] Adding project reference grants the project's members visibility of the referenced resource through `gatekeeperService` (verified by test where U lacks direct grant on R but R is referenced from a project U can view).
- [ ] Cycle detection: attempting to add an INPUT_OF where downstream is already an ancestor returns `CYCLE_DETECTED`.

**Out of scope.** Column-level lineage (future).

---

## B7. Foundry Branching: Branches, Proposals & Approval Policies

**Goal.** Implement unified branching across resources (datasets, code repos in B-future, ontology in B8) and proposal workflow with per-project approval policies.

**Reference.** Blueprint §1.6 (foundry branching, sunset of legacy ontology proposals), §3 (cross-application branches).

**Existing code to modify.**
- `src/services/folderService.ts` and `projectService.ts` — when reading resources, allow a `branch` query parameter; reads default to `master`.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS branches (
  rid              text PRIMARY KEY
                   CHECK (rid LIKE 'ri.branch..branch.%'),
  name             text NOT NULL,
  parent_branch_rid text REFERENCES branches(rid),  -- NULL = master
  status           text NOT NULL CHECK (status IN ('PENDING','IN_PROGRESS','READY_FOR_PREVIEW','MERGED','CLOSED')),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE TABLE IF NOT EXISTS branch_resources (
  branch_rid       text REFERENCES branches(rid) ON DELETE CASCADE,
  resource_rid     text REFERENCES resources(rid) ON DELETE CASCADE,
  PRIMARY KEY (branch_rid, resource_rid)
);

CREATE TABLE IF NOT EXISTS proposals (
  rid              text PRIMARY KEY,
  branch_rid       text NOT NULL REFERENCES branches(rid),
  title            text NOT NULL,
  description      text,
  status           text NOT NULL CHECK (status IN ('OPEN','APPROVED','MERGED','CLOSED')),
  author_id        uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  merged_at        timestamptz
);
CREATE TABLE IF NOT EXISTS proposal_approvals (
  proposal_rid     text REFERENCES proposals(rid) ON DELETE CASCADE,
  approver_id      uuid REFERENCES users(id),
  approved_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proposal_rid, approver_id)
);
CREATE TABLE IF NOT EXISTS approval_policies (
  project_rid              text PRIMARY KEY REFERENCES resources(rid) ON DELETE CASCADE,
  eligible_reviewers       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{type:USER|GROUP,id}]
  num_approvals_required   int  NOT NULL DEFAULT 1 CHECK (num_approvals_required >= 0),
  contributor_can_approve  boolean NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS branch_overlays (
  branch_rid       text REFERENCES branches(rid) ON DELETE CASCADE,
  resource_rid     text REFERENCES resources(rid) ON DELETE CASCADE,
  overlay          jsonb NOT NULL,   -- the diff against master representation
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_rid, resource_rid)
);
```

**Endpoints.**
- `POST /api/v2/branches` `{name, fromBranchRid?}` → `Branch`
- `GET /api/v2/branches/{rid}`
- `POST /api/v2/branches/{rid}/proposals` `{title, description}` → `Proposal`
- `POST /api/v2/proposals/{rid}/approve`
- `POST /api/v2/proposals/{rid}/merge`
- `POST /api/v2/proposals/{rid}/close`

**Merge algorithm.** Wrap in single tx: validate `numApprovalsRequired` met, `contributorCanApprove` honored, no conflicting branch open against master for the same resource set, then for each `branch_overlays` row apply overlay to master representation, update `branches.status='MERGED'`, write audit log, emit `BranchMerged` event on Kafka topic `tellus.branch.merged`.

**Inactive auto-close.** Daily cron closes branches with no commits in 60 days (configurable) and `status IN ('PENDING','IN_PROGRESS')`.

**Error codes.** `BRANCH_NAME_CONFLICT (409)`, `INSUFFICIENT_APPROVALS (409)`, `BRANCH_NOT_READY (409)`, `MERGE_CONFLICT (409, parameters.conflictingResources)`.

**Metrics.** `tellus_branch_merge_seconds`, `tellus_proposal_open_age_seconds`, `tellus_branches_active`.

**SLO.** Merge of a branch with ≤100 overlays p95 < 5 s.

**Acceptance.**
- [ ] Creating a branch off `master` is visible to readers passing `?branch=<rid>` but invisible at default reads.
- [ ] Proposal cannot be merged with fewer approvals than `num_approvals_required`.
- [ ] Author cannot self-approve when `contributor_can_approve=false`.
- [ ] Merging is idempotent: a `Idempotency-Key`-replayed merge of an already-merged proposal is a no-op returning the same response.

**Out of scope.** Conflict resolution UI (F7); Code-Repository Git branch tie-in (future).

---

## B8. OMS — Object Types & Link Types

**Goal.** Implement the Ontology Metadata Service: durable, branchable, versioned definitions of `ObjectType`, `LinkType`, `SharedPropertyType`, `ValueType`, `Interface`, `ObjectTypeGroup`. Each definition is a Compass resource. Object types are bound to one or more datasource datasets (`foundry_datasets`).

**Reference.** Blueprint §3, §4.1 (full ObjectType schema), §7 (LinkType schema).

**Existing code to modify.**
- `src/services/foundryUploadService.ts` — on dataset creation, no change here; OMS reads from `foundry_datasets` when an object type is bound.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS ontologies (
  rid              text PRIMARY KEY
                   CHECK (rid LIKE 'ri.ontology.main.ontology.%'),
  api_name         text NOT NULL UNIQUE,
  display_name     text NOT NULL,
  space_rid        text NOT NULL REFERENCES resources(rid),
  default_branch   text REFERENCES branches(rid)
);

CREATE TABLE IF NOT EXISTS object_types (
  rid              text PRIMARY KEY,
  ontology_rid     text NOT NULL REFERENCES ontologies(rid) ON DELETE CASCADE,
  api_name         text NOT NULL,
  display_name     text NOT NULL,
  description      text,
  status           text NOT NULL CHECK (status IN ('EXPERIMENTAL','ACTIVE','DEPRECATED','ENDORSED')),
  visibility       text NOT NULL CHECK (visibility IN ('NORMAL','PROMINENT','HIDDEN')),
  primary_keys     text[] NOT NULL CHECK (cardinality(primary_keys) BETWEEN 1 AND 4),
  title_property   text NOT NULL,
  icon             jsonb NOT NULL DEFAULT '{"icon":"cube","color":"#4A90E2"}'::jsonb,
  type_classes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  groups           text[] NOT NULL DEFAULT '{}',
  edits_enabled    boolean NOT NULL DEFAULT true,
  track_edit_history boolean NOT NULL DEFAULT false,
  branch_rid       text NOT NULL REFERENCES branches(rid),
  etag             bigint NOT NULL DEFAULT 1,
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ontology_rid, branch_rid, api_name)
);

CREATE TABLE IF NOT EXISTS object_type_properties (
  object_type_rid  text REFERENCES object_types(rid) ON DELETE CASCADE,
  api_name         text NOT NULL,
  display_name     text NOT NULL,
  base_type        text NOT NULL CHECK (base_type IN
    ('STRING','INTEGER','LONG','DOUBLE','FLOAT','BOOLEAN','DATE','TIMESTAMP',
     'GEOPOINT','GEOSHAPE','GEOHASH','ATTACHMENT','MEDIA_REFERENCE',
     'STRUCT','ARRAY','MAP','MARKING','VECTOR','TIMESERIES')),
  array_element_type jsonb,
  struct_fields    jsonb,
  vector_dimension int CHECK (vector_dimension IS NULL OR vector_dimension BETWEEN 1 AND 2048),
  required         boolean NOT NULL DEFAULT false,
  searchable       boolean NOT NULL DEFAULT true,
  render_hints     text[] NOT NULL DEFAULT '{}',
  shared_property_type_rid text,
  value_type_rid   text,
  mandatory_control jsonb,
  PRIMARY KEY (object_type_rid, api_name)
);

CREATE TABLE IF NOT EXISTS object_type_datasources (
  object_type_rid  text REFERENCES object_types(rid) ON DELETE CASCADE,
  ordinal          int  NOT NULL,
  datasource_rid   text NOT NULL REFERENCES resources(rid),
  primary_key_columns text[] NOT NULL,
  property_mapping jsonb NOT NULL,            -- {propertyApiName: columnName}
  materialization  jsonb,                      -- optional in OSv2
  PRIMARY KEY (object_type_rid, ordinal)
);

CREATE TABLE IF NOT EXISTS link_types (
  rid              text PRIMARY KEY,
  ontology_rid     text NOT NULL REFERENCES ontologies(rid),
  api_name         text NOT NULL,
  display_name     text NOT NULL,
  status           text NOT NULL CHECK (status IN ('EXPERIMENTAL','ACTIVE','DEPRECATED')),
  visibility       text NOT NULL CHECK (visibility IN ('NORMAL','PROMINENT','HIDDEN')),
  endpoint_a_rid   text NOT NULL REFERENCES object_types(rid),
  endpoint_b_rid   text NOT NULL REFERENCES object_types(rid),
  cardinality_a    text NOT NULL CHECK (cardinality_a IN ('ONE','MANY')),
  cardinality_b    text NOT NULL CHECK (cardinality_b IN ('ONE','MANY')),
  backing_type     text NOT NULL CHECK (backing_type IN ('FOREIGN_KEY','JOIN_TABLE','OBJECT_BACKED')),
  backing_config   jsonb NOT NULL,
  branch_rid       text NOT NULL REFERENCES branches(rid),
  etag             bigint NOT NULL DEFAULT 1,
  UNIQUE (ontology_rid, branch_rid, api_name)
);

CREATE TABLE IF NOT EXISTS shared_property_types (
  rid              text PRIMARY KEY,
  ontology_rid     text NOT NULL REFERENCES ontologies(rid),
  api_name         text NOT NULL,
  display_name     text NOT NULL,
  base_type        text NOT NULL,
  description      text,
  UNIQUE (ontology_rid, api_name)
);

CREATE TABLE IF NOT EXISTS interfaces (
  rid              text PRIMARY KEY,
  ontology_rid     text NOT NULL REFERENCES ontologies(rid),
  api_name         text NOT NULL,
  display_name     text NOT NULL,
  description      text,
  required_properties jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (ontology_rid, api_name)
);
```

**Endpoints (Conjure-style).** Mirror Foundry's public API where possible:
- `POST /api/v2/ontologies/{ontologyRid}/objectTypes` `{apiName, displayName, primaryKeys, titleProperty, properties, datasources, ...}` → `ObjectType`
- `GET /api/v2/ontologies/{ontologyRid}/objectTypes/{apiName}?branch=...`
- `PUT /api/v2/ontologies/{ontologyRid}/objectTypes/{apiName}` (If-Match required)
- `POST /api/v2/ontologies/{ontologyRid}/linkTypes` (similar)
- `POST /api/v2/ontologies/{ontologyRid}/sharedPropertyTypes`
- `POST /api/v2/ontologies/{ontologyRid}/interfaces`

**Validation.**
- `apiName` matches `^[a-z][a-zA-Z0-9]*$`, ≤64 chars; immutable once status=ACTIVE.
- Every property in `primary_keys` must be `required=true` and `base_type IN ('STRING','LONG','INTEGER')`.
- `title_property` must exist in properties.
- For each `object_type_datasources` row: `property_mapping` keys must be a subset of declared property api_names; `primary_key_columns` length must equal `cardinality(primary_keys)`.
- Cross-property uniqueness of `api_name` is enforced by the composite PK.

**On create**, register a BACKS edge (B6) from `object_type` → `datasource` and an INPUT_OF/OUTPUT_OF chain back through dataset lineage. Emit `ObjectTypeUpdated` event on Kafka topic `tellus.oms.object-type.updated`.

**Error codes.** `ONTOLOGY_NOT_FOUND`, `OBJECT_TYPE_API_NAME_CONFLICT (409)`, `INVALID_PROPERTY_MAPPING (400)`, `IMMUTABLE_API_NAME (409)`, `DATASOURCE_NOT_FOUND (404)`, `INVALID_PRIMARY_KEY (400)`.

**Metrics.** `tellus_oms_object_type_count`, `tellus_oms_validation_failures_total{rule}`.

**SLO.** Create object type p95 < 100 ms. Get object type p95 < 30 ms.

**Acceptance.**
- [ ] Creating an object type backed by an existing `foundry_datasets` row succeeds and emits `tellus.oms.object-type.updated`.
- [ ] Validation rejects an object type whose primary key column is `nullable` in the datasource.
- [ ] Updating `apiName` after status=ACTIVE returns `IMMUTABLE_API_NAME`.
- [ ] Link type with `backing_type=FOREIGN_KEY` fails creation if the referenced FK property is missing on endpoint A.

**Out of scope.** Indexing into OpenSearch (B9). Action types (later task).

---

## B9. Funnel — Indexing Pipeline

**Goal.** A worker service that consumes `tellus.oms.object-type.updated` events and dataset commit events, runs **changelog → merge-changes → index → hydrate** pipelines, and writes per-(objectType × branch) OpenSearch indices.

**Reference.** Blueprint §4.2 (OSv2 storage), §4.3 (edits flow), implementation maps to Spark + Flink + OpenSearch.

**Existing code to modify.**
- `src/jobs/parseDatasetJob.ts` — already drives pending → processing → ready/error for raw uploads. Funnel is a **separate** worker: triggered after parseDatasetJob completes for a dataset that backs an active object type.

**New files.**
- `src/jobs/funnelService.ts` — orchestrator.
- `src/jobs/funnel/{changelog,mergeChanges,indexer,hydrator}.ts` — phases.
- `src/jobs/funnel/openSearchClient.ts`.

**Pipeline.**
1. **Changelog.** Compare current dataset commit with previous indexed commit (tracked in `funnel_pipeline_state.last_indexed_commit`). Produce a changelog dataset (Iceberg snapshot diff) of `(primaryKey, op ∈ {INSERT,UPDATE,DELETE}, row)`.
2. **Merge changes.** Join changelog with the Action edit log (Kafka topic `tellus.actions.edits`, replayed by primary key, since `funnel_pipeline_state.last_processed_edit_offset`). Result: authoritative `(primaryKey, finalRow, op)`.
3. **Index.** For each row, transform through `property_mapping`, validate against `object_type_properties` types, write to OpenSearch via bulk API in batches of 1000. Use `_id = base64(primaryKey)`. Index name: `obj-{objectTypeRid}-{branchRid}`.
4. **Hydrate.** OpenSearch refresh; mark `funnel_pipeline_state.status='READY'`; publish `tellus.oms.object-type.indexed`.

**Schema.**
```sql
CREATE TABLE IF NOT EXISTS funnel_pipeline_state (
  object_type_rid           text NOT NULL REFERENCES object_types(rid) ON DELETE CASCADE,
  branch_rid                text NOT NULL REFERENCES branches(rid) ON DELETE CASCADE,
  last_indexed_commit       text,
  last_processed_edit_offset bigint NOT NULL DEFAULT 0,
  status                    text NOT NULL CHECK (status IN ('PENDING','RUNNING','READY','ERROR','REPLACING')),
  last_error                text,
  last_run_started_at       timestamptz,
  last_run_finished_at      timestamptz,
  PRIMARY KEY (object_type_rid, branch_rid)
);
```

**Live cadence.** A scheduled job re-runs every active pipeline every 6h regardless of input churn — required to flush user edits durably.

**Replacement pipeline.** When schema changes (e.g. new property), spawn a parallel pipeline (`status=REPLACING`) writing to a fresh index `obj-{objectTypeRid}-{branchRid}-v{n+1}`. When caught up to live, atomic alias swap (`obj-{...}` alias points to `-v{n+1}`).

**Caps.** Max indexing throughput 2 MB/s/object type (configurable). Streaming object types ≤250 properties, record ≤1 MB.

**Error codes.** `FUNNEL_VALIDATION_FAILED` (rows that violate property types, surfaced as percentage in metric, dead-lettered to `tellus.funnel.dlq`), `FUNNEL_BACKPRESSURE` (when ingestion saturates configured throughput).

**Metrics.** `tellus_funnel_pipeline_seconds{phase}`, `tellus_funnel_rows_indexed_total{object_type}`, `tellus_funnel_dlq_rows_total{object_type}`, `tellus_funnel_backlog_bytes`.

**SLO.** End-to-end p95 (commit → query-visible) < 60 s for datasets ≤10 GB.

**Acceptance.**
- [ ] Creating an object type with 1M rows results in 1M indexed docs in OpenSearch within 5 minutes (single-node OpenSearch test cluster).
- [ ] Edits applied via Actions are visible in OpenSearch within 60 s.
- [ ] Schema change triggers a replacement pipeline; live queries continue serving old index until alias swap.
- [ ] DLQ contains exactly the rows whose primary key is null (verified with crafted dataset).

**Out of scope.** Vector indexing (extension), geo indexing (extension), search nodes' local-disk hydration model (we use OpenSearch's native sharding instead).

---

## B10. OSS — Object Set Service

**Goal.** Read API for object queries: `loadObjects`, `aggregate`, `search`, `searchAround` (link traversal). Object Sets persist as Compass resources with stable RIDs.

**Reference.** Blueprint §5 (Object Explorer queries OSS), §6 (Quiver queries OSS), §7 (link traversal).

**Existing code to modify.**
- None (new surface).

**New files.**
- `src/services/ossService.ts`
- `src/routes/ontologiesV2/{objectSets,objects,links}.ts`
- `src/lib/objectSetIr.ts` — IR encoding (a serializable filter tree).

**Object Set IR.** A discriminated union:
```ts
type ObjectSet =
  | {type:'base', objectTypeRid: Rid}
  | {type:'static', primaryKeys: Array<string|number>}
  | {type:'filter', source: ObjectSet, where: Filter}
  | {type:'union', sets: ObjectSet[]}
  | {type:'intersect', sets: ObjectSet[]}
  | {type:'subtract', a: ObjectSet, b: ObjectSet}
  | {type:'searchAround', source: ObjectSet, linkTypeRid: Rid};

type Filter =
  | {op:'eq'|'gt'|'lt'|'gte'|'lte'|'ne'; property:string; value:unknown}
  | {op:'in'; property:string; values:unknown[]}
  | {op:'isNull'|'isNotNull'; property:string}
  | {op:'contains'; property:string; substring:string}
  | {op:'and'|'or'; clauses: Filter[]}
  | {op:'not'; clause: Filter}
  | {op:'geoDistance'; property:string; center:[number,number]; radiusMeters:number}
  | {op:'knn'; property:string; vector:number[]; k:number};
```

**Endpoints.**
- `POST /api/v2/ontologies/{ontologyRid}/objectSets/load` `{objectSet, pageSize?, pageToken?, select?, orderBy?}` → `{data: Object[], nextPageToken?, totalCount?}`
- `POST /api/v2/ontologies/{ontologyRid}/objectSets/aggregate` `{objectSet, aggregations:[{type:'count'|'sum'|'avg'|'min'|'max'|'approxDistinct', property?}], groupBy?}` → `{groups:[{key,values}]}`
- `POST /api/v2/ontologies/{ontologyRid}/objectSets/save` `{objectSet, name, projectRid}` → `{rid: 'ri.object-set.main.versioned-object-set.<uuid>'}`
- `GET  /api/v2/ontologies/{ontologyRid}/objectSets/{rid}` → `{objectSet}`
- `POST /api/v2/ontologies/{ontologyRid}/objectSets/searchAround` `{source, linkTypeRid}` → object set IR
- `GET /api/v2/ontologies/{ontologyRid}/objectTypes/{apiName}/objects/{primaryKey}` — convenience load-by-PK

**Compilation.** `objectSetIr → OpenSearch DSL` for filter/aggregate/load. Search-around with cardinality M:M → either (a) join via OpenSearch terms-lookup against the link's join-table index, or (b) for >100k source set, dispatch a Spark job (out of scope for v1; return `OBJECT_SET_TOO_LARGE` for now).

**Permissioning.** Every load passes through gatekeeper batch-evaluate against the (caller, object types touched) tuples. Property-level mandatory controls (B8 `mandatory_control` jsonb) are enforced by stripping properties the caller can't read.

**Error codes.** `OBJECT_TYPE_NOT_INDEXED`, `OBJECT_SET_TOO_LARGE` (>100k for search-around), `INVALID_FILTER`, `UNKNOWN_PROPERTY`, `INVALID_PAGE_TOKEN`.

**Metrics.** `tellus_oss_load_seconds`, `tellus_oss_aggregate_seconds`, `tellus_oss_search_around_seconds`, `tellus_oss_property_strip_total`.

**SLO.** `load(pageSize=100)` p95 < 100 ms. `aggregate` p95 < 300 ms. `searchAround` p95 < 500 ms (≤10k source).

**Acceptance.**
- [ ] An IR like `{type:'filter', source:{type:'base',...}, where:{op:'eq', property:'status', value:'ACTIVE'}}` returns the expected rows from OpenSearch.
- [ ] Saving an object set creates a Compass resource of type `OBJECT_SET` with the IR as metadata.
- [ ] Calling `searchAround` with an M:M link type returns the expected counterpart rows.
- [ ] A user lacking marking M sees object rows but with property values nulled where they touch M.

**Out of scope.** On-demand Spark dispatch for large search-arounds; full OSDK code generation (separate workstream).

---

# FRONTEND TASKS

---

## F1. Files Hub Page — Tabs & Resource Lists

**Goal.** The `/files` page becomes the Foundry-equivalent unified Files Hub with four tabs: **Portfolios**, **Projects**, **Your files**, **Shared with you**. Top-level entry point for the Compass surface.

**Depends on.** B1, B3.

**Reference.** Blueprint §1.1 (Files page tabs), §10 caveat about Portfolios as saved-search-of-projects.

**Existing code to modify.**
- `app/files/page.tsx`, `app/files/loading.tsx`
- `components/files/{FilesPageHeader,FilesTabBar,ProjectRow,ProjectsTable,TabPill}.tsx`
- `hooks/useProjects.ts`

**Behavior.**
- Default tab: **Projects** (persists to `localStorage` per user). Tab keyboard nav: ←/→ between tabs.
- **Projects** tab: virtualized table (use `@tanstack/react-virtual`) of projects user can `compass:discover-resource` on, columns: Name (with icon), Description, Last updated, Updated by, Members count, Actions (kebab → Open / Star / Move / Trash). Sortable by Name (asc default), Last updated.
- **Your files** tab: lists resources where `created_by = current user` AND `project_rid = personal-project`. Shows datasets, autosaved Quiver analyses, autosaved Workshop apps.
- **Shared with you** tab: resources where current user has `compass:view-resource` but `created_by != current user` AND project owner != current user. (Computed server-side via a new `GET /api/v2/filesystem/resources/sharedWithMe` endpoint *(add to B3 if not present; trivial filter)*.)
- **Portfolios** tab (initial): single hardcoded "Recents" portfolio = top 50 `view-resource`-events by current user in last 30 days; UI is identical to Projects table. Future portfolios are saved searches; out of scope here.

**Empty states** per tab: distinct illustration + CTA ("Create project", "Upload your first file", "Ask a teammate to share with you", "—").

**Search bar in header.** Filters the active tab in-memory (debounced 200 ms). For ≥1000 rows, search routes to `POST /api/v2/filesystem/search` (covered in F5).

**A11y.** Tab list `role="tablist"`; each tab `role="tab"` with `aria-selected`. Table is `role="table"` with proper row/cell semantics.

**Performance.**
- Initial render TTI < 1 s on 200-project user.
- Scrolling 10k projects holds 60 fps (virtualized).

**Telemetry events.** `files_hub.tab_switched`, `files_hub.row_clicked`, `files_hub.create_project_clicked`.

**Acceptance.**
- [ ] `/files` renders all four tabs without flashing layout shift (CLS < 0.05).
- [ ] Switching tabs preserves scroll within each tab.
- [ ] Cmd/Ctrl-K from this page opens the Quick-Open palette (F5).
- [ ] Right-click on a row opens a context menu mirroring the kebab menu.
- [ ] Tab choice persists across navigations.

**Out of scope.** Real Portfolios CRUD (future).

---

## F2. Project Detail Page — Layout & Sub-tabs

**Goal.** The `/projects/[projectId]` page shows a project header and 5 sub-tabs: **Files**, **Autosaved**, **References**, **Trash**, **Members**. (Sensitive Data Scanner from Foundry is omitted.)

**Depends on.** B3, B6.

**Reference.** Blueprint §1.1.

**Existing code to modify.**
- `app/projects/[projectId]/` subtree (currently listed only).
- `components/folders/*` reused inside Files tab.
- `components/projects/AddMemberDialog.tsx` reused inside Members tab.

**Layout.**
- Sticky project header: icon + name (inline-renamable if user has `compass:edit-resource`), description (truncated, expandable), markings chip row, organizations chip row, "Open in Branching", "Open in Search" actions, kebab menu (Move, Trash, Permission, Settings).
- Sub-tab strip below header.

**Sub-tabs.**
1. **Files** — folder browser (F3) rooted at the project's root folder. Toolbar: New folder, Upload files, New dataset, New code repo (link to F-future), New Quiver analysis (F10), New Object Type (F8).
2. **Autosaved** — virtualized list of `created_by=current_user`, `parent_folder` is `personal-project-autosave`, type ∈ {QUIVER_ANALYSIS, WORKSHOP_APP, NOTEPAD_DOCUMENT}.
3. **References** — list of `project_references`, columns: Resource, Type, Source project, Added by, Added at. Add reference button opens a resource picker dialog.
4. **Trash** — list of resources with `trashStatus IN ('DIRECTLY_TRASHED','ANCESTOR_TRASHED')` whose project_rid = current. Each row: Restore, Permanent delete.
5. **Members** — combines `project_members` and `project_organizations`. Three sections: Members (users + groups, with role), Organizations (orgs the project belongs to), Markings (markings applied to project).

**Routing.** Sub-tab is reflected in URL `?tab=files|autosaved|references|trash|members`. Default `files`.

**Loading.** Each tab fetches independently with React Query, cached 30s. Project header is always fetched fresh.

**Permissions UX.**
- Edit/Move/Trash buttons disabled with tooltip "You need Editor on this project" for users below threshold (operations checked via a new `useResourcePermissions(rid)` hook fetching from `GET /api/v2/filesystem/resources/{rid}?decorations=operations`).

**Acceptance.**
- [ ] Project page renders within 500 ms after route enter, with header + active tab content streamed.
- [ ] Switching tabs is instant (data already cached).
- [ ] Trash tab correctly shows ANCESTOR_TRASHED rows in a muted style with tooltip "Trashed because ancestor X is trashed".
- [ ] Members tab supports adding a user with role and immediately reflects after invalidation.

**Out of scope.** Sensitive Data Scanner; pipelines tab (already a separate route).

---

## F3. Folder Browser & Hierarchy Operations

**Goal.** Polish the existing folder browser into a Foundry-grade file manager: tree sidebar, table view, breadcrumbs, multi-select, drag-drop move, keyboard shortcuts.

**Depends on.** B3, B5.

**Reference.** Blueprint §1.1 (folder hierarchy), §1.4 (operations).

**Existing code to modify.**
- `components/folders/{BreadcrumbBar,CreateFolderDialog,FileSystemTable,FolderTable,FolderToolbar,InlineRenameInput,MoveFolderDialog,SubfolderGrid,UploadFilesDialog}.tsx`
- `hooks/useFolderChildren.ts`

**Features.**
- **Tree sidebar** (collapsible, left). Lazy-loads children on expand. Drag from table, drop into tree node = move.
- **Table view** central. Columns (configurable, persist to user prefs): Name, Type, Last updated, Size (for datasets), Actions. Sort by any column. Inline rename on F2 (already exists, polish).
- **Multi-select** with shift-click range and cmd/ctrl-click toggle. Multi-select toolbar appears with: Move (opens MoveFolderDialog with multi support), Trash, Add markings, Copy paths.
- **Drag-drop**: HTML5 drag-drop into tree nodes or breadcrumb segments. During drag, show a count badge on the cursor; preview drop target by highlighting receiving node.
- **Keyboard**: `↑`/`↓` move selection, `Enter` open, `F2` rename, `Del` trash, `⌘C` copy path, `⌘D` duplicate, `⌘⇧M` open Move dialog.
- **Breadcrumbs** clickable each segment; truncation with `…` for ≥6 segments; right-click on segment opens that folder's context menu.

**Concurrency UX.**
- All mutations send `If-Match`. On `412 PRECONDITION_FAILED`, toast "This folder was changed by someone else — refreshing", then refetch and retry once. Surface `RESOURCE_NAME_CONFLICT` as inline form error on rename/create.

**Empty state.** Per-folder: illustration + "Drop files here or click Upload".

**Performance.**
- Virtualize table when ≥200 rows.
- Background prefetch of `getChildren` for the next probable folder (mouseover for >500 ms on a tree node triggers prefetch).

**Acceptance.**
- [ ] Move 50 selected resources via drag-drop in one operation; success toast shows "Moved 50 resources to <folder>".
- [ ] Inline rename to a colliding name shows red error with `RESOURCE_NAME_CONFLICT` message; original name restored on cancel.
- [ ] Breadcrumb truncation collapses cleanly at 1024 px width.
- [ ] All keyboard shortcuts have a discoverable help overlay (⌘?).

**Out of scope.** Spreadsheet-style cell editing of dataset rows (separate workstream).

---

## F4. Resource Sharing & Permissions Dialog

**Goal.** A single dialog reachable from any resource's kebab → "Share" that lets users grant Roles, manage Markings, manage Organizations (project-level), and view effective permissions.

**Depends on.** B4.

**Reference.** Blueprint §1.4.

**Existing code to modify.**
- `components/projects/AddMemberDialog.tsx` — extract the user-picker logic into `components/sharing/PrincipalPicker.tsx` and reuse in the new dialog.

**New files.**
- `components/sharing/ShareDialog.tsx` — orchestrator.
- `components/sharing/{RolesTab,MarkingsTab,OrganizationsTab,EffectivePermissionsTab}.tsx`
- `components/sharing/PrincipalPicker.tsx`

**Tabs.**
1. **Roles** (default).
   - Two columns: principals (user/group), role.
   - Add principal: PrincipalPicker (autocomplete users + groups; supports Everyone in Project).
   - Role select per principal: Discoverer / Viewer / Editor / Owner / (custom roles from the resource's role set).
   - Toggle: "Disable inherited permissions on this resource" (only available to Owners; warns about implications).
2. **Markings**. List current direct markings + inherited markings (read-only). Add marking → searchable picker scoped to user's `Apply marking` permissions. Remove marking requires `Remove marking` permission; double-confirms.
3. **Organizations** *(project/space resources only)*. List orgs applied to the project. Add org requires `Expand access` permission and shows the new user surface that will gain visibility.
4. **Effective permissions**. Read-only matrix: principal × operation, evaluated server-side via `POST /api/v2/permissions/evaluateBatch` (B4).

**Concurrency.** Each tab's "Save" sends If-Match. On 412, refresh tab data and re-show diff.

**A11y.**
- Dialog is `role="dialog"`, focus trap, Esc closes only when no unsaved changes (else confirm).
- All form fields have visible labels.

**Acceptance.**
- [ ] Sharing a project with a user as Editor results in that user seeing the project in their Files Hub immediately on next load.
- [ ] Adding a marking the current user lacks `Apply marking` for is disabled in the picker with tooltip explaining why.
- [ ] Disabling inherited permissions warns and requires typing the resource name to confirm.
- [ ] Effective permissions table renders ≤200 ms for ≤50 principals.

**Out of scope.** Custom role authoring UI (Control Panel territory).

---

## F5. Cross-Resource Search & Quick-Open Palette

**Goal.** A `⌘K` palette that searches every Compass resource by name, type, path, owner, and markings, with debounced server-side fuzzy search.

**Depends on.** B3.

**Existing code to modify.** None directly; integrates into root layout.

**New files.**
- `components/quickOpen/{QuickOpenProvider,QuickOpenDialog,ResultRow,FilterChips}.tsx`
- `hooks/useQuickOpen.ts`

**Behavior.**
- Global keyboard shortcut `⌘K` / `Ctrl+K`. Also reachable from header search input.
- Input is split into terms; each term is matched as fuzzy substring against name + path. Filter chips: `type:DATASET`, `owner:me`, `marking:CONFIDENTIAL`, `project:<name>`, `recent`.
- Server endpoint (add to B3 if not yet present): `GET /api/v2/filesystem/search?q=&type=&owner=&marking=&project=&pageSize=&pageToken=`.
- Recent visited resources (top 10) shown when input is empty (sourced from a per-user `recent_resources` table or local IndexedDB).
- Result row: icon + name + path (highlighted matches) + type chip + last updated.
- Keyboard nav `↑`/`↓`, `Enter` opens, `⌘Enter` opens in new tab, `→` reveals quick actions submenu (Open, Copy path, Add to favorites, Trash).

**Performance.**
- Open palette → first results ≤ 300 ms p95.
- Dispatches search no more than once per 200 ms (debounced).
- Aborts in-flight requests on new keystroke.

**Acceptance.**
- [ ] Searching for an exact name returns it as the top hit.
- [ ] `type:DATASET marketing` returns only datasets with "marketing" in name/path.
- [ ] Pressing Esc closes; focus returns to the originally focused element.
- [ ] Works on a user with 100k accessible resources without UI lag.

**Out of scope.** Fuzzy search of dataset row content.

---

## F6. Trash, Restore & Permanent Delete

**Goal.** A consistent UI for all trash flows, exposed in: row context menus, Project's Trash sub-tab (F2), a global `/trash` page.

**Depends on.** B5.

**Existing code to modify.**
- `components/folders/FolderTable.tsx` — strike-through styling for ANCESTOR_TRASHED rows.

**New files.**
- `app/trash/page.tsx`
- `components/trash/{TrashTable,RestoreDialog,PermanentDeleteDialog}.tsx`

**Behavior.**
- **Trash table** columns: Name, Type, Original location, Trashed at, Trashed by, Trash status, Auto-purge in (Trashed at + retention − now), Actions.
- **Restore**: dialog confirms restore target (defaults to original parent; if original parent is also trashed → must restore parent first; show inline warning).
- **Permanent delete**: typed-confirm dialog (must type "delete" + resource name). Destructive button red. Disabled until retention met (B5).
- **Empty trash** (Project Trash tab only): bulk action "Empty all" (Owners only). Shows count and total size estimate.

**Status pills.**
- `DIRECTLY_TRASHED` — orange pill "Trashed".
- `ANCESTOR_TRASHED` — gray pill "Auto-trashed", tooltip names the trashed ancestor.

**Acceptance.**
- [ ] Restoring a folder whose project is still trashed is blocked with explanation.
- [ ] Permanent delete before retention window shows server's `TRASH_RETENTION_NOT_MET` message inline.
- [ ] Auto-purge timer ticks live (updates every minute).
- [ ] Trash table virtualizes for ≥200 rows.

**Out of scope.** Cross-region undelete after permanent delete.

---

## F7. Branch Switcher & Proposal Review UI

**Goal.** A header dropdown that lets users switch branches across the entire app, plus a proposal-list and proposal-detail (review) page.

**Depends on.** B7.

**Reference.** Blueprint §1.6.

**New files.**
- `components/branching/{BranchSwitcher,BranchCreateDialog,BranchStatusPill}.tsx`
- `app/branches/page.tsx` (list)
- `app/branches/[branchRid]/page.tsx` (detail)
- `app/proposals/[proposalRid]/page.tsx` (review)
- `stores/branchStore.ts` (Zustand) — `currentBranchRid`, `setBranch`.

**Behavior.**
- **BranchSwitcher** in app header: button shows current branch name + status pill (PENDING/IN_PROGRESS/READY_FOR_PREVIEW). Click opens a popover listing user's open branches + "Create branch" + "View all branches".
- All `useFolderChildren`, `useProjects`, `useObjectType*` hooks read `currentBranchRid` and pass `?branch=...` to queries.
- **Proposal review page** has 4 panels: Diff (per-resource list of changes; click a resource to see structured diff), Approvals (list, with "Approve" button if user is eligible), Discussion (comments, MVP plain-text), Merge controls (Merge / Close).
- **Diff renderer** is per-resource-type:
  - For ObjectType: side-by-side property table.
  - For LinkType: side-by-side endpoint/cardinality/backing.
  - For Dataset: column schema diff + row count delta.
  - For Folder: child resource list diff.

**Permissions UX.**
- Approve button enabled only if user is in `eligible_reviewers` AND (not author OR `contributor_can_approve`).
- Merge button enabled when `numApprovalsRequired` is met.

**Acceptance.**
- [ ] Switching branch in header refreshes the current page's data with `?branch=...` and persists across navigations.
- [ ] A user not in eligible reviewers sees the Approve button disabled with tooltip.
- [ ] Merge with conflicts shows a structured `MERGE_CONFLICT` panel listing conflicting resources.
- [ ] Branch list page filters by status (Open/Merged/Closed/Mine).

**Out of scope.** Conflict-resolution editor (manual rebase guidance only for v1).

---

## F8. Ontology Manager — Object Type Editor

**Goal.** The Ontology Manager UI: list, create, and edit object types and link types, with a property mapping editor against backing datasets.

**Depends on.** B8.

**Reference.** Blueprint §3, §4.1.

**New files.**
- `app/ontology/page.tsx` (ontology list/select)
- `app/ontology/[ontologyRid]/page.tsx` (object types list)
- `app/ontology/[ontologyRid]/object-types/[apiName]/page.tsx` (object type editor)
- `app/ontology/[ontologyRid]/link-types/[apiName]/page.tsx` (link type editor)
- `components/ontology/{ObjectTypeEditor,PropertyEditorRow,DatasourceMappingPanel,IconPicker,LinkTypeEditor,EndpointPicker}.tsx`
- `hooks/{useObjectType,useObjectTypeList,useLinkType}.ts`

**Object Type Editor layout (3-pane).**
- Left: Properties list. Add/remove/reorder. Each row inline-edits api_name, display_name, base_type. Star = primary key, crown = title.
- Center: Selected property detail panel — base type (dropdown), array element type (if ARRAY), struct fields (if STRUCT, ≤10), vector dim (if VECTOR), required, searchable, render hints, mandatory control.
- Right: **Datasources** panel. Each datasource row: dataset picker (autocomplete from `foundry_datasets`), primary key columns picker, property mapping table (property api_name → dataset column, with type-compat badge: green ✓ or red ✗ with reason). "Generate mapping from column names" auto-fill button.

**Header.** apiName (immutable badge once ACTIVE), displayName, status (dropdown), visibility, icon picker, type classes selector, groups multi-select.

**Validation UX.** Inline errors per field. A persistent banner at top lists blocking errors that prevent save.

**Save.** Calls `PUT /api/v2/ontologies/{ontologyRid}/objectTypes/{apiName}` with If-Match. On success, toast + redirect remains on edit page with refreshed etag. Save is disabled when no diff.

**Link Type Editor layout (single column).**
- Endpoint A: object type picker, cardinality (ONE/MANY).
- Endpoint B: same.
- Backing type: radio (FOREIGN_KEY / JOIN_TABLE / OBJECT_BACKED).
- Conditional config:
  - FK → property picker on the "many" side.
  - JOIN_TABLE → dataset picker + two column pickers; "Generate join table" creates a new dataset stub.
  - OBJECT_BACKED → intermediary object type picker.

**Branch awareness.** Header shows `BranchStatusPill`. Save under a non-master branch creates an overlay (B7).

**Acceptance.**
- [ ] Creating an object type from a `foundry_datasets` with auto-mapping correctly fills properties.
- [ ] Type-incompatible mapping (e.g., string → integer) shows red ✗ inline and blocks save.
- [ ] Editing apiName when status=ACTIVE is disabled with tooltip explaining immutability.
- [ ] Saving emits `tellus.oms.object-type.updated` (verifiable via WebSocket toast on Funnel acknowledgment).

**Out of scope.** Action types, interfaces editor (later task).

---

## F9. Object Explorer — Faceted Browser & Object Sets

**Goal.** A `/object-explorer/[ontologyRid]/[objectTypeApiName]` page that loads paginated objects with facets, search, filter chips, sort, and saved object sets.

**Depends on.** B10.

**Reference.** Blueprint §5.

**New files.**
- `app/object-explorer/[ontologyRid]/[objectTypeApiName]/page.tsx`
- `components/objectExplorer/{ResultsTable,FacetSidebar,FilterChipBar,QueryBox,ObjectSetSaveDialog,SearchAroundMenu}.tsx`
- `hooks/{useObjectSetLoad,useObjectSetAggregate}.ts`

**Layout (3-pane).**
- Left: facet sidebar. For each searchable property, show top-N facet values via `aggregate` (count by value, top 10) + a "More" button. Numeric properties get a histogram and range slider. Geo properties get a map snippet (deferred).
- Center: results table (virtualized). Columns user-configurable (persist in user prefs). Each row clickable → object detail page (out of scope; placeholder).
- Right: query summary panel. Shows object set IR as human-readable bullets (e.g., "status = ACTIVE", "AND created_at > 2025-01-01"). "Save as object set" button.

**Query box** at top: Lucene-like syntax (`AND`, `OR`, `NOT`, parens, quoted strings, `?` single-char wildcard, `~` fuzzy). Compiled client-side to filter IR. Errors highlighted inline.

**Search-around** action on selected rows: kebab → "Find related <linkType>". Compiles a `searchAround` IR and navigates to the resulting object type's Object Explorer with the new IR pre-applied.

**Object set save**: dialog with name + project picker + branch indicator. Calls `POST /api/v2/ontologies/{rid}/objectSets/save`.

**Performance.**
- Initial page TTI < 1 s.
- Facet recompute on filter change p95 < 500 ms (server SLO + render).

**Acceptance.**
- [ ] Adding a facet filter updates the URL and the IR; deep-link works.
- [ ] Search-around from 100 selected source rows over a M:1 link returns the related rows ≤500 ms.
- [ ] Saving an object set creates a Compass resource visible in the parent project's Files (F3).
- [ ] Property values nulled by mandatory-control stripping render as `—` with a lock icon and tooltip "Restricted by marking".

**Out of scope.** Map view (geo facets); column-level chart panels (covered by Quiver, F10).

---

## F10. Quiver — Card-Graph Analysis Canvas

**Goal.** A `/quiver/[analysisRid]` page hosting a card-graph analysis: object set source cards, filter cards, transform table cards, chart cards, with typed connections between them. Saves as a Compass resource.

**Depends on.** B10.

**Reference.** Blueprint §6.

**New files.**
- `app/quiver/page.tsx` (list)
- `app/quiver/[analysisRid]/page.tsx` (canvas)
- `components/quiver/{Canvas,Card,CardLibrary,CardEdge,SaveDialog,InspectorPanel}.tsx`
- `components/quiver/cards/{ObjectSetSourceCard,FilterCard,TransformTableCard,ChartCard,SearchAroundCard,AggregateCard}.tsx`
- `hooks/useQuiverAnalysis.ts`
- `lib/quiver/types.ts` — typed input/output enum (OBJECT_SET, TIME_SERIES, NUMBER, CATEGORY, TABLE, PLOT).

**Canvas.** Built on `@xyflow/react` (formerly react-flow). Nodes are cards; edges are typed connections. New edge between A.output and B.input is allowed only if types match; else preview shows a "Convert?" affordance to insert a conversion card.

**Cards** (v1 set):
1. **ObjectSetSource** — picks object type (or saved object set). Output: OBJECT_SET.
2. **Filter** — input OBJECT_SET, output OBJECT_SET. Inspector: filter chips builder (subset of F9 query box).
3. **SearchAround** — input OBJECT_SET, output OBJECT_SET. Inspector: link type picker.
4. **Aggregate** — input OBJECT_SET, output TABLE. Inspector: groupBy + aggregations.
5. **TransformTable** — input TABLE, output TABLE. **In-browser** sequential transforms (sort, filter, derive, rename). Hard cap 50,000 rows; warn at 10,000.
6. **Chart** — input TABLE, output PLOT. Vega-Lite spec generated from a small UI (x, y, mark type).

**Card execution.**
- ObjectSetSource, Filter, SearchAround, Aggregate run server-side via OSS (B10).
- TransformTable runs client-side using DuckDB-WASM or Polars-WASM (pick DuckDB-WASM for v1: `@duckdb/duckdb-wasm`).
- Chart renders via `vega-embed`.
- Per-card status pill: idle / running / ok / error. Errors show in the inspector.

**Save model.** Auto-save: debounced 1.5 s after change → `PATCH /api/v2/quiver/analyses/{rid}` with full graph JSON in `metadata.graph`. Explicit save: snapshots a versioned record (RID `ri.quiver.main.analysis-version.<uuid>`).

**URL state.** Selected card, zoom, pan persisted in query params.

**Keyboard.** `⌘D` duplicate selected; `Del` delete; `⌘Z`/`⌘⇧Z` undo/redo (graph-level, 50-step history).

**Acceptance.**
- [ ] Building a 4-card chain (ObjectSetSource → Filter → Aggregate → Chart) renders a chart in <2 s on a 10k-row dataset.
- [ ] Disconnected output type from input type is visually rejected.
- [ ] TransformTable card refuses input >50k rows with explicit error and link to "convert to materialized dataset" doc.
- [ ] Auto-save survives page reload (revisit shows the latest graph).
- [ ] Analysis is visible in the parent project's Files tab (F3).

**Out of scope.** Dashboards, Visual Functions, AIP Generate.

---

# Verification matrix (cross-task)

| Capability | Validates |
|---|---|
| Create project → folder → upload dataset → create object type → query in Object Explorer → save object set → use in Quiver | B1 → B3 → B8 → B9 → B10 → F8 → F9 → F10 |
| Share project with another user as Viewer | B4 → F4 |
| Create branch → modify object type → open proposal → approve → merge | B7 → B8 → F7 → F8 |
| Trash a project, restore, permanent delete | B5 → F6 |
| Cross-project reference visibility | B6 → F2 (References tab) |
| Quick-open finds a deeply nested folder | B3 → F5 |

---

# What you must NOT do

- Do not create parallel tables for projects/folders/datasets; the existing `projects`, `folders`, `foundry_datasets` stay. The new `resources` table is an adapter overlay.
- Do not implement legacy ontology proposals (sunset upstream — Blueprint §1.6).
- Do not implement OSv1 / Phonograph patterns (writeback datasets, direct edit APIs). All edits go through the Actions service (out of scope here, but design must not preclude it).
- Do not introduce new auth mechanisms; reuse the existing Multipass/Keycloak adapter (`src/middleware/auth.ts`).
- Do not write to `audit_log` from anywhere except `src/db/audit.ts`. Single writer.
- Do not store derived state in the frontend that should come from the server (effective permissions, etag, branch). React Query is the source of truth.
- Do not bypass `If-Match` "for convenience". Every mutation honors it.

---

# Definition of Done (overall)

A reviewer should be able to:
1. Run `pnpm migrate && pnpm dev` on backend and `pnpm dev` on frontend.
2. Sign in.
3. Create a project, upload a CSV, register an object type backed by it, see rows indexed in OpenSearch within 60s, query them in Object Explorer, save an object set, open a Quiver analysis, build a 4-card pipeline ending in a chart.
4. Create a branch, modify the object type, open a proposal, approve it from a second account, merge.
5. Share the project with a third user as Viewer; that user sees the project in their Files Hub Shared tab and can open it but not edit.
6. Trash the project; observe descendants flip to ANCESTOR_TRASHED in the trash tab; restore; verify status returns to NOT_TRASHED.

If any step fails, the corresponding task's acceptance checklist has missed items.