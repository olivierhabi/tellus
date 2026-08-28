// Workshop B01 — module service.
//
// Spec: tasks/workshop/workshop-tasks.md §B01.
// Decisions referenced: D-06 (RID format), D-07 (case-insensitive uniqueness),
// D-08 (canonical-JSON ETag), D-10 (concurrent PUT semantics).
//
// This module is the in-process service surface used by both the route
// layer and (per D-02) other in-tree adapters. It does not depend on
// Express; injecting actor/branch/JWT through the explicit `Actor`
// argument keeps the surface testable without HTTP.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getWorkshopDb } from "./db";
import { computeEtag, isoToMicros } from "./etag";
import {
  invalidModuleSchema,
  moduleNameConflict,
  moduleNotFound,
  moduleTooLarge,
  resourceVersionMismatch,
} from "./errors";
import {
  IDEMPOTENCY_KEY_HEADER,
  hashBody,
  isValidIdempotencyKey,
  lookupIdempotency,
  recordResponse,
} from "./idempotency";
import {
  CreateModuleRequest,
  ModuleResponse,
  ModuleRow,
  RID_REGEX,
  UpdateModuleRequest,
  rowToResponse,
} from "./types";
import {
  counterEtagMismatch,
  histCreate,
  histDelete,
  histList,
  histLoad,
  histSave,
  histSizeBytes,
  startTimer,
  startTimerNoLabel,
} from "./metrics";
import { emitWorkshopAudit } from "./audit";
import { WorkshopError } from "./errors";
import { validateModule } from "./validator";

const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;

export interface Actor {
  /** Multipass JWT subject (`sub` claim). */
  userId: string;
  /** Optional branch RID forwarded verbatim downstream (G-05). */
  branchRid?: string | null;
}

export interface IdempotencyOptions {
  key: string | null;
  /** The exact route token used for cache scoping, e.g. `POST /modules`. */
  route: string;
  /** The body bytes to hash (typed JSON object — see hashBody). */
  body: unknown;
}

export interface CreatedModule {
  module: ModuleResponse;
  etag: string;
  /** True when this response was returned from the idempotency cache. */
  fromCache: boolean;
}

export interface UpdatedModule {
  module: ModuleResponse;
  etag: string;
}

const SELECT_COLUMNS = `
  rid, ontology_rid, display_name, description, current_semver,
  published_semver, definition, etag, schema_version, parent_folder_rid,
  branch_rid, created_at, created_by, updated_at, updated_by, deleted_at`;

function ridForNewModule(): string {
  return `ri.workshop.main.module.${randomUUID()}`;
}

function definitionByteSize(definition: unknown): number {
  return Buffer.byteLength(JSON.stringify(definition), "utf8");
}

/**
 * Look up an existing module by RID. Soft-deleted rows return null (mapped
 * to 404 at the route layer).
 */
export async function getModule(rid: string): Promise<ModuleResponse> {
  const stop = startTimer(histLoad);
  try {
    if (!RID_REGEX.test(rid)) {
      throw moduleNotFound(rid);
    }
    const result = await getWorkshopDb().query(
      `SELECT ${SELECT_COLUMNS} FROM workshop_module
        WHERE rid = $1 AND deleted_at IS NULL`,
      [rid],
    );
    if (result.rows.length === 0) {
      throw moduleNotFound(rid);
    }
    stop("success");
    return rowToResponse(result.rows[0] as ModuleRow);
  } catch (err) {
    stop("error");
    throw err;
  }
}

/**
 * Read the current ETag for a module without returning the full document.
 * Used by callers that need to set an `ETag` response header on a related
 * resource.
 */
export async function getModuleEtag(
  rid: string,
): Promise<{ etag: string; updatedAt: string }> {
  const result = await getWorkshopDb().query(
    `SELECT etag, updated_at FROM workshop_module
      WHERE rid = $1 AND deleted_at IS NULL`,
    [rid],
  );
  if (result.rows.length === 0) {
    throw moduleNotFound(rid);
  }
  const row = result.rows[0] as { etag: string; updated_at: string };
  return { etag: row.etag, updatedAt: row.updated_at };
}

/**
 * Create a new module. POST `/api/v1/workshop/modules`. Honors the
 * Idempotency-Key header per G-03 — same key + same body returns the
 * cached response and `fromCache: true`.
 */
export async function createModule(
  request: CreateModuleRequest,
  actor: Actor,
  idem: IdempotencyOptions,
): Promise<CreatedModule> {
  const stopCreate = startTimer(histCreate);
  const size = definitionByteSize(request.definition);
  histSizeBytes.observe({}, size);
  if (size > MAX_DEFINITION_BYTES) {
    stopCreate("error");
    throw moduleTooLarge(size);
  }

  // B02 in-process validation (defense in depth — F01 also calls
  // /_validate up front but this is the canonical gate). Schema +
  // nine semantic rules; throws 400 with the precise errorName.
  try {
    validateModule(request.definition);
  } catch (e) {
    stopCreate("error");
    throw e;
  }

  const idemCtx = idem.key
    ? {
        key: idem.key,
        userId: actor.userId,
        route: idem.route,
        bodySha256: hashBody(idem.body),
      }
    : null;

  if (idem.key && !isValidIdempotencyKey(idem.key)) {
    stopCreate("error");
    throw invalidModuleSchema("Idempotency-Key must be a UUID v4", {
      header: IDEMPOTENCY_KEY_HEADER,
    });
  }

  let succeeded: { module: ModuleResponse; etag: string; fromCache: boolean } | null = null;
  try {
    succeeded = await getWorkshopDb().withTransaction(async (client: PoolClient) => {
    if (idemCtx) {
      const hit = await lookupIdempotency(idemCtx, client);
      if (hit) {
        return {
          module: hit.responseBody as ModuleResponse,
          etag: hit.responseEtag ?? "",
          fromCache: true,
        };
      }
    }

    const rid = ridForNewModule();
    const updatedAtIso = await currentMicroTimestamp(client);
    const micros = isoToMicros(updatedAtIso);
    const etag = computeEtag(request.definition, micros);

    let row: ModuleRow;
    try {
      const insert = await client.query<ModuleRow>(
        `INSERT INTO workshop_module
           (rid, ontology_rid, display_name, description, current_semver,
            published_semver, definition, etag, schema_version,
            parent_folder_rid, branch_rid,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,'0.1.0', NULL, $5::jsonb, $6, 4,
                 $7, $8, $9::timestamptz, $10, $9::timestamptz, $10)
         RETURNING ${SELECT_COLUMNS}`,
        [
          rid,
          request.ontologyRid,
          request.displayName,
          request.description ?? null,
          JSON.stringify(request.definition),
          etag,
          request.parentFolderRid,
          actor.branchRid ?? null,
          updatedAtIso,
          actor.userId,
        ],
      );
      row = insert.rows[0];
    } catch (err) {
      if (isUniqueViolation(err, "uq_workshop_module_folder_name_ci")) {
        throw moduleNameConflict(
          request.parentFolderRid,
          request.displayName,
        );
      }
      throw err;
    }

    const response = rowToResponse(row);
    if (idemCtx) {
      await recordResponse(idemCtx, 201, response, etag, client);
    }
    return { module: response, etag, fromCache: false };
    });
    stopCreate("success");
  } catch (err) {
    stopCreate("error");
    throw err;
  }
  // Audit AFTER commit. Failure here surfaces to the caller; the row is
  // already persisted, but the next idempotent retry will return the
  // cached response and skip audit (a known gap acknowledged in the
  // session decision log; revisit when audit moves into the same DB).
  await emitWorkshopAudit({
    actorSubject: actor.userId,
    action: "WORKSHOP_MODULE_CREATED",
    rid: succeeded.module.rid,
    result: "SUCCESS",
    details: {
      fromCache: succeeded.fromCache,
      branchRid: actor.branchRid ?? null,
      sizeBytes: size,
    },
  });
  return succeeded;
}

/**
 * Update a module. PUT `/api/v1/workshop/modules/{rid}`. Spec §B01:
 *   - `If-Match` REQUIRED (G-02). Missing or stale → 412.
 *   - `parentFolderRid` cannot change here (folder-move is a Compass op).
 *   - SemVer minor bump is delegated to B03 — for now we only bump
 *     `updated_at` and recompute the ETag; B03 will add a row to
 *     `workshop_module_version` inside this same transaction.
 */
export async function updateModule(
  rid: string,
  ifMatch: string | null,
  request: UpdateModuleRequest,
  actor: Actor,
): Promise<UpdatedModule> {
  if (!RID_REGEX.test(rid)) {
    throw moduleNotFound(rid);
  }
  const stopSave = startTimer(histSave);
  if (!ifMatch) {
    stopSave("error");
    counterEtagMismatch.inc();
    throw resourceVersionMismatch(rid, null);
  }

  const size = definitionByteSize(request.definition);
  histSizeBytes.observe({}, size);
  if (size > MAX_DEFINITION_BYTES) {
    stopSave("error");
    throw moduleTooLarge(size);
  }

  // B02 in-process validation — same gate as POST.
  try {
    validateModule(request.definition);
  } catch (e) {
    stopSave("error");
    throw e;
  }

  let succeeded: { module: ModuleResponse; etag: string } | null = null;
  try {
    succeeded = await getWorkshopDb().withTransaction(async (client: PoolClient) => {
    const lockResult = await client.query<ModuleRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM workshop_module
        WHERE rid = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [rid],
    );
    if (lockResult.rows.length === 0) {
      throw moduleNotFound(rid);
    }
    const current = lockResult.rows[0];

    if (current.etag !== ifMatch) {
      counterEtagMismatch.inc();
      throw resourceVersionMismatch(rid, current.etag);
    }

    const updatedAtIso = await currentMicroTimestamp(client);
    const micros = isoToMicros(updatedAtIso);
    const newEtag = computeEtag(request.definition, micros);

    let updated: ModuleRow;
    try {
      const result = await client.query<ModuleRow>(
        `UPDATE workshop_module
            SET display_name = COALESCE($2, display_name),
                description  = $3,
                definition   = $4::jsonb,
                etag         = $5,
                updated_at   = $6::timestamptz,
                updated_by   = $7
          WHERE rid = $1 AND deleted_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
        [
          rid,
          request.displayName ?? null,
          request.description === undefined
            ? current.description
            : request.description,
          JSON.stringify(request.definition),
          newEtag,
          updatedAtIso,
          actor.userId,
        ],
      );
      updated = result.rows[0];
    } catch (err) {
      if (isUniqueViolation(err, "uq_workshop_module_folder_name_ci")) {
        throw moduleNameConflict(
          current.parent_folder_rid,
          request.displayName ?? current.display_name,
        );
      }
      throw err;
    }

    return { module: rowToResponse(updated), etag: newEtag };
    });
    stopSave("success");
  } catch (err) {
    if (!(err instanceof WorkshopError) || err.errorName !== "Tellus:Workshop:ResourceVersionMismatch") {
      stopSave("error");
    } else {
      stopSave("error");
    }
    throw err;
  }
  await emitWorkshopAudit({
    actorSubject: actor.userId,
    action: "WORKSHOP_MODULE_UPDATED",
    rid,
    result: "SUCCESS",
    details: { branchRid: actor.branchRid ?? null, sizeBytes: size },
  });
  return succeeded;
}

/**
 * Soft-delete a module. DELETE `/api/v1/workshop/modules/{rid}`. Repeated
 * deletes return 200/no-op (idempotent). Requires `If-Match` like PUT.
 */
export async function deleteModule(
  rid: string,
  ifMatch: string | null,
  actor: Actor,
): Promise<{ deleted: boolean }> {
  if (!RID_REGEX.test(rid)) {
    throw moduleNotFound(rid);
  }
  const stopDelete = startTimer(histDelete);
  if (!ifMatch) {
    stopDelete("error");
    counterEtagMismatch.inc();
    throw resourceVersionMismatch(rid, null);
  }

  let succeeded: { deleted: boolean } | null = null;
  try {
    succeeded = await getWorkshopDb().withTransaction(async (client: PoolClient) => {
    const lockResult = await client.query<ModuleRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM workshop_module
        WHERE rid = $1
        FOR UPDATE`,
      [rid],
    );
    if (lockResult.rows.length === 0) {
      throw moduleNotFound(rid);
    }
    const current = lockResult.rows[0];
    if (current.deleted_at !== null) {
      // Idempotent: already soft-deleted.
      return { deleted: false };
    }
    if (current.etag !== ifMatch) {
      counterEtagMismatch.inc();
      throw resourceVersionMismatch(rid, current.etag);
    }
    await client.query(
      `UPDATE workshop_module
          SET deleted_at = now(), updated_by = $2
        WHERE rid = $1`,
      [rid, actor.userId],
    );

    // Mirror the soft-deleted module into Compass Trash. Workshop stores
    // legacy `ri.compass.main.folder.*` parents, while Compass resources use
    // `compass-folder`; resolve through the folders table to keep both root
    // and nested modules recoverable.
    const parentSegments = current.parent_folder_rid.split('.');
    const parentUuid = parentSegments[parentSegments.length - 1] ?? '';
    const folderResult = await client.query<{ project_id: string }>(
      `SELECT project_id FROM folders WHERE id = $1::uuid`,
      [parentUuid],
    );
    const projectId = folderResult.rows[0]?.project_id ?? parentUuid;
    const projectRid = `ri.compass.main.project.${projectId}`;
    const canonicalParentRid = folderResult.rows.length > 0
      ? `ri.compass.main.compass-folder.${parentUuid}`
      : projectRid;
    const projectResource = await client.query<{ space_rid: string }>(
      `SELECT space_rid FROM resources WHERE rid = $1`,
      [projectRid],
    );
    // Standalone Workshop installations/tests may not have Compass enabled.
    // In a project workspace the project resource always exists, and the
    // module is mirrored into its Trash atomically with the soft delete.
    if (projectResource.rows[0]?.space_rid) {
      await client.query(
        `INSERT INTO resources
           (rid, service, type, display_name, description,
            parent_folder_rid, project_rid, space_rid,
            trash_status, trashed_at, trashed_by, retention_until,
            created_by, created_at, updated_by, updated_at)
         VALUES ($1, 'workshop', 'WORKSHOP_MODULE', $2, $3,
                 $4, $5, $6,
                 'DIRECTLY_TRASHED', now(), $7::uuid, now() + interval '30 days',
                 $7::uuid, $8, $7::uuid, now())
         ON CONFLICT (rid) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           parent_folder_rid = EXCLUDED.parent_folder_rid,
           project_rid = EXCLUDED.project_rid,
           space_rid = EXCLUDED.space_rid,
           trash_status = 'DIRECTLY_TRASHED',
           trashed_at = now(),
           trashed_by = EXCLUDED.trashed_by,
           retention_until = now() + interval '30 days',
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
        [
          rid,
          current.display_name,
          current.description,
          canonicalParentRid,
          projectRid,
          projectResource.rows[0].space_rid,
          actor.userId,
          current.created_at,
        ],
      );
    }
    return { deleted: true };
    });
    stopDelete("success");
  } catch (err) {
    stopDelete("error");
    throw err;
  }
  if (succeeded.deleted) {
    await emitWorkshopAudit({
      actorSubject: actor.userId,
      action: "WORKSHOP_MODULE_DELETED",
      rid,
      result: "SUCCESS",
      details: { branchRid: actor.branchRid ?? null },
    });
  }
  return succeeded;
}

export interface ListModulesArgs {
  parentFolderRid: string;
  pageToken?: string | null;
  pageSize?: number;
}

export interface ListModulesResult {
  modules: ModuleResponse[];
  nextPageToken: string | null;
}

/**
 * List modules in a folder. Pagination is keyset on (display_name, rid)
 * — cheaper than offset for common B01 access patterns.
 */
export async function listModules(
  args: ListModulesArgs,
): Promise<ListModulesResult> {
  const pageSize = Math.min(Math.max(args.pageSize ?? 100, 1), 200);
  const tokenParts = args.pageToken
    ? decodePageToken(args.pageToken)
    : null;
  const where = tokenParts
    ? `parent_folder_rid = $1 AND deleted_at IS NULL
       AND (display_name, rid) > ($2, $3)`
    : `parent_folder_rid = $1 AND deleted_at IS NULL`;
  const params: unknown[] = tokenParts
    ? [args.parentFolderRid, tokenParts.displayName, tokenParts.rid]
    : [args.parentFolderRid];
  const stopList = startTimerNoLabel(histList);
  const result = await getWorkshopDb().query(
    `SELECT ${SELECT_COLUMNS}
       FROM workshop_module
      WHERE ${where}
      ORDER BY display_name, rid
      LIMIT ${pageSize + 1}`,
    params,
  );
  stopList();
  const rows = result.rows as ModuleRow[];
  const modules = rows.slice(0, pageSize).map(rowToResponse);
  const nextPageToken =
    rows.length > pageSize
      ? encodePageToken(modules[modules.length - 1])
      : null;
  return { modules, nextPageToken };
}

function encodePageToken(m: ModuleResponse): string {
  return Buffer.from(JSON.stringify({ d: m.displayName, r: m.rid })).toString(
    "base64url",
  );
}

function decodePageToken(t: string): { displayName: string; rid: string } {
  try {
    const parsed = JSON.parse(Buffer.from(t, "base64url").toString("utf8"));
    if (
      typeof parsed.d === "string" &&
      typeof parsed.r === "string" &&
      RID_REGEX.test(parsed.r)
    ) {
      return { displayName: parsed.d, rid: parsed.r };
    }
  } catch {
    // fall through
  }
  throw invalidModuleSchema("invalid pageToken");
}

async function currentMicroTimestamp(client: PoolClient): Promise<string> {
  // `clock_timestamp()` returns the actual wall-clock time at the moment
  // of the call (not the transaction-start time of `now()`), which is what
  // we want for ETag uniqueness across PUTs in the same transaction. We
  // do NOT cast to text here — the pg type-parser override at db.ts (OID
  // 1184) returns the value as an ISO-8601 string, which is what
  // `isoToMicros` expects.
  const r = await client.query<{ ts: string }>(
    `SELECT clock_timestamp() AS ts`,
  );
  return r.rows[0].ts;
}

function isUniqueViolation(err: unknown, indexName?: string): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code !== "23505") return false;
  if (!indexName) return true;
  const constraint = (err as { constraint?: string }).constraint;
  return constraint === indexName;
}
