# Files & Projects — Contract Enumeration

> Source IDs cross-reference `tasks/files-projects/files-projects-tasks.md`.
> Every test cites a contract ID. Contracts are added per-task as that task is opened.
> When a contract is unrooted in the spec, the chosen interpretation is logged in `decisions/files-projects/`.

---

## B1 — Compass Resource Model & RID System
Spec: `tasks/files-projects/files-projects-tasks.md:47-138`

### Wire-format contracts

- **B1-C-01** — RID grammar: `^ri\.[a-z][a-z0-9-]*\.([a-z0-9][a-z0-9-]*)?\.[a-z][a-z0-9-]*\..+$`. Must round-trip every example in Blueprint §1.2 (covered: project, folder, dataset, space, branch, object-type, object-set, link-type).
- **B1-C-02** — `parseRid(s)` → `{service, instance, type, locator}` for valid; throws `INVALID_RID_FORMAT` for invalid (empty service, non-kebab, missing locator, mixed case).
- **B1-C-03** — `formatRid({service, instance, type, locator})` produces a string that round-trips through `parseRid`.
- **B1-C-04** — `mintRid(service, type)` returns RID with empty instance (`..`) and a UUIDv4 locator.
- **B1-C-05** — `Rid` is a TypeScript branded type; non-RID strings are not assignable without `parseRid`/`mintRid`.

### Storage contracts

- **B1-C-10** — `resources` table exists with columns: rid (PK, CHECK regex), service, type, display_name (1..256), description, documentation, parent_folder_rid, project_rid, space_rid, trash_status (CHECK), created_by, created_at, updated_by, updated_at, etag (default 1), metadata (jsonb default `{}`), legacy_uuid (UNIQUE).
- **B1-C-11** — Indexes present: `resources_parent_idx`, `resources_project_idx`, `resources_space_idx`, `resources_type_idx`, `resources_trash_idx` (partial WHERE trash_status<>'NOT_TRASHED').
- **B1-C-12** — Trigger `resources_bump_etag_t` on UPDATE: `etag := OLD.etag+1`, `updated_at := now()`. Verified by issuing UPDATE without setting etag and observing increment.
- **B1-C-13** — Migration is idempotent: re-running `foundryMigrate` produces zero changes after first run.
- **B1-C-14** — Backfill: every `projects` row has a matching `resources` row (`resources.legacy_uuid = projects.id`, `service='compass'`, `type='PROJECT'`). Same for folders (`COMPASS_FOLDER`) and foundry_datasets (`FOUNDRY_DATASET`). Verifier: `SELECT count(*) FROM projects p LEFT JOIN resources r ON r.legacy_uuid=p.id WHERE r.rid IS NULL` → 0.
- **B1-C-15** — `legacy_uuid UNIQUE` prevents drift on re-run.

### Service-layer contracts

- **B1-C-20** — `compassService.getResource(rid)` returns the row; throws `RESOURCE_NOT_FOUND` (404) on miss.
- **B1-C-21** — `compassService.getResourcesBatch(rids)` returns `Map<Rid, Resource>` for ≤1000 rids; throws `BATCH_TOO_LARGE` (400) at 1001+.
- **B1-C-22** — `compassService.getResourceByPath('/A/B/C')` walks segments under root space (introduced in B2; for B1 the root space RID is the seeded constant).
- **B1-C-23** — `compassService.getChildren(parentRid, page)` returns paginated children of `parent_folder_rid=parentRid`.
- **B1-C-24** — Same-row creation in service layer must, in the same transaction, INSERT into `resources` (no second-step insert).
- **B1-C-25** — `display_name` uniqueness per `parent_folder_rid` is enforced in service layer (DB UNIQUE blocked by NULL parents until B2 partial unique index).

### Error codes

- **B1-C-30** — `INVALID_RID_FORMAT (400)` returned for malformed RID input.
- **B1-C-31** — `RESOURCE_NOT_FOUND (404)` returned for absent rid.
- **B1-C-32** — `BATCH_TOO_LARGE (400)` returned for batch >1000.

### Metrics

- **B1-C-40** — `tellus_compass_get_resource_seconds` histogram emitted with canonical buckets (`[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`).
- **B1-C-41** — `tellus_compass_batch_get_size` histogram (input batch size).
- **B1-C-42** — `tellus_compass_rid_parse_errors_total` counter incremented on each parse failure.

### SLO

- **B1-C-50** — `getResource` p95 < 30 ms (warm cache, 100 RPS sustained).
- **B1-C-51** — `getResourcesBatch(1000)` p95 < 200 ms.

### Forbidden behaviors (per task)

- **B1-X-01** — DDL added via `src/foundryMigrate.ts` only; no new files under `src/migrations/`.
- **B1-X-02** — Existing `projects`, `folders`, `foundry_datasets` tables are not dropped; resources is an adapter.

---

## B2 — Spaces & Hierarchy Refactor

### DDL
- **B2-C-01** — `spaces` table exists with columns `rid PK REFERENCES resources(rid)`, `display_name`, `enrollment_rid`, `default_role_set_id` (default `'compass-default'`), `file_system_id uuid NOT NULL`, `usage_account_rid`, `is_root boolean NOT NULL DEFAULT false`, `created_at`.
- **B2-C-02** — Partial unique index `spaces_one_root_idx` enforces at most one row with `is_root = true`.
- **B2-C-03** — Root space row exists in `spaces` after first migrate; `rid = ROOT_SPACE_RID`, `is_root = true`. Idempotent on re-run.
- **B2-C-04** — `spaces.rid` is a FK to `resources.rid` — every spaces row has a matching resources row.
- **B2-C-05** — `getResource(ROOT_SPACE_RID)` resolves; `getResourceByPath('/Root')` returns the same row.

### Service
- **B2-C-10** — `projectService.createProject(name, ownerId, opts?)` accepts optional `spaceRid`. When omitted, defaults to `ROOT_SPACE_RID`. Resulting `resources.space_rid` matches.
- **B2-C-11** — When `spaceRid` is provided but no `spaces` row exists at that rid, the call rejects with `SPACE_NOT_FOUND` (404).
- **B2-C-12** — Provided `spaceRid` must satisfy the RID grammar; malformed input rejects with `INVALID_RID_FORMAT`.

### Path resolution
- **B2-C-20** — `getResourceByPath('/Root/<project>')` returns the same row as `getResourceByPath('/<project>')` (root space implicit per B1-C-22).

### Error codes (registered in queryErrors)
- **B2-C-30** — `SPACE_NOT_FOUND` → 404.
- **B2-C-31** — `MOVE_BETWEEN_SPACES_FORBIDDEN` → 409. (Reachable only when a project-move path is added later; B2 declares the code so B3+ can throw it without a registry round-trip.)
- **B2-C-32** — `ROOT_SPACE_IMMUTABLE` → 409. (Same forward-declaration rationale.)

### Forbidden behaviors
- **B2-X-01** — DDL appended to `src/foundryMigrate.ts` only; no new files under `src/migrations/`.
- **B2-X-02** — `B1-C-15` not regressed: root space remains self-referential after B2's migrate run.

---

## B3 — Filesystem v2 Public API Surface
Spec: `tasks/files-projects/files-projects-tasks.md` §B3.

### Endpoint contracts (17 endpoints)
- **B3-C-01** — `POST /api/v2/filesystem/folders` creates a folder; returns 201 with `Folder` body and `ETag: "v1"`.
- **B3-C-02** — `GET /api/v2/filesystem/folders/{folderRid}` returns the folder + `ETag` header; 404 → `RESOURCE_NOT_FOUND` envelope.
- **B3-C-03** — `POST /api/v2/filesystem/folders/getBatch` accepts `{folderRids: string[]}` ≤1000; returns array preserving input order; 400 `BATCH_TOO_LARGE` at 1001+.
- **B3-C-04** — `GET /api/v2/filesystem/folders/{folderRid}/children?pageSize&pageToken` returns `{data, nextPageToken?}`; pageSize 1..1000 default 100.
- **B3-C-05** — `POST /api/v2/filesystem/projects` creates project (delegates to `projectService.createProject` + B2 space validation).
- **B3-C-06** — `GET /api/v2/filesystem/projects/{projectRid}` returns project; 404 envelope on miss.
- **B3-C-07** — `PUT /api/v2/filesystem/projects/{projectRid}` updates; requires `If-Match`; 412 on mismatch; 428 if missing.
- **B3-C-08** — `DELETE /api/v2/filesystem/projects/{projectRid}` returns 204; requires `If-Match`.
- **B3-C-09** — `GET /api/v2/filesystem/resources/{rid}` returns resource; same shape as compass `getResource`.
- **B3-C-10** — `GET /api/v2/filesystem/resources?path=<path>` resolves by path (root-space implicit per B2-C-20).
- **B3-C-11** — `POST /api/v2/filesystem/resources/getByPathsBatch` accepts `{paths: string[]}` ≤1000 → `Map<path, Resource>`.
- **B3-C-12** — `POST /api/v2/filesystem/resources/{rid}/trash` requires `If-Match`; 204 (B5 wires real trash semantics; B3 stub flips `trash_status` to `DIRECTLY_TRASHED`).
- **B3-C-13** — `POST /api/v2/filesystem/resources/{rid}/restore` requires `If-Match`; 204.
- **B3-C-14** — `POST /api/v2/filesystem/resources/{rid}/permanentlyDelete` requires `If-Match`; 204.
- **B3-C-15** — `POST /api/v2/filesystem/spaces` creates a space row (admin-only stub for B3; B4 wires permissions).
- **B3-C-16** — `GET /api/v2/filesystem/spaces` returns `{data: Space[]}`.
- **B3-C-17** — `GET /api/v2/filesystem/spaces/{spaceRid}` returns the space; 404 envelope on miss.

### ETag/If-Match (B3-C-2x)
- **B3-C-20** — Every mutation endpoint requires `If-Match` header; missing → `428 PRECONDITION_REQUIRED` envelope.
- **B3-C-21** — Stale `If-Match` → `412 PRECONDITION_FAILED` envelope with `{expected, actual}` parameters.
- **B3-C-22** — All read responses set `ETag: "v<n>"` from `resources.etag`.
- **B3-C-23** — Successful PUT/POST mutation responses set new `ETag` reflecting post-mutation version.
- **B3-C-24** — Malformed `If-Match` (not matching `"v<digits>"`) → `400 INVALID_ARGUMENT`.

### Idempotency-Key (B3-C-3x)
- **B3-C-30** — `idempotency_keys` table: `(key uuid PK, request_hash text, status_code int, response_body jsonb, created_at)` with TTL ≥24h. DDL appended to `foundryMigrate.ts`.
- **B3-C-31** — `Idempotency-Key: <uuid>` on a state-allocating POST stores the response under that key; replay within TTL returns the cached response with `Idempotent-Replay: true` header.
- **B3-C-32** — Same key + different request body within TTL → `409 IDEMPOTENCY_KEY_CONFLICT`.
- **B3-C-33** — Malformed key (not UUIDv4) → `400 INVALID_ARGUMENT`.

### Cursor pagination (B3-C-4x)
- **B3-C-40** — `pageToken` is opaque base64 of JSON `{lastUpdatedAt, lastRid}`; cursor encoder/decoder lives in `src/lib/cursor.ts`.
- **B3-C-41** — Decoded cursor must have ISO-8601 timestamp and valid RID; otherwise → `400 INVALID_PAGE_TOKEN`.
- **B3-C-42** — `pageSize` must be in 1..1000 range; default 100; out-of-range → `400 INVALID_ARGUMENT`.

### Error envelope (B3-C-5x)
- **B3-C-50** — All errors emit Conjure shape: `{errorCode, errorName, parameters?, errorInstanceId}`. `errorInstanceId` is a UUIDv4 logged with the request span.
- **B3-C-51** — Error codes registered: `RESOURCE_NOT_FOUND (404)`, `PRECONDITION_FAILED (412)`, `PRECONDITION_REQUIRED (428)`, `INVALID_ARGUMENT (400)`, `RESOURCE_NAME_CONFLICT (409)`, `BATCH_TOO_LARGE (400)`, `INVALID_PAGE_TOKEN (400)`, `IDEMPOTENCY_KEY_CONFLICT (409)`, `PERMISSION_DENIED (403)` (stubbed until B4).

### Metrics (B3-C-6x)
- **B3-C-60** — `tellus_filesystem_v2_request_seconds{endpoint,status}` histogram with canonical buckets.
- **B3-C-61** — `tellus_filesystem_v2_etag_mismatch_total{endpoint}` counter.
- **B3-C-62** — `tellus_filesystem_v2_idempotent_replay_total` counter.

### SLO (B3-C-7x)
- **B3-C-70** — `GET /folders/{rid}` p95 < 50 ms (warm cache, 100 RPS).
- **B3-C-71** — `GET /folders/{rid}/children?pageSize=100` p95 < 100 ms.

### Forbidden (B3-X-xx)
- **B3-X-01** — DDL appended to `foundryMigrate.ts`; no new files under `src/migrations/`.
- **B3-X-02** — v1 routes remain mounted; v2 routes share the same service layer (no parallel data path).

---

## B4..B10 / F1..F10

Contracts are enumerated when each task is opened. Pending tasks: B4 (Gatekeeper), B5 (Trash + audit single-writer), B6 (Resource Graph + project references), B7 (Branching), B8 (OMS), B9 (Funnel), B10 (OSS), F1..F10.

This file is amended (not rewritten) per task open.
