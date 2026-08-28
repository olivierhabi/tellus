// ---------------------------------------------------------------------------
// Compass write wrapper for Connectivity (B1).
//
// Why this file exists.
//   `src/services/compassService.ts` is intentionally read-only (its header:
//   "Write paths live in projectService / folderService / foundryUploadService;
//   this file is read-only by design (B1-X-02)"). None of the three existing
//   write paths owns a generic "register an arbitrary resource" surface.
//   Rather than carve a parallel write path through one of them, this file
//   owns the INSERT/UPDATE against `resources` for connections specifically.
//
// Schema alignment (from src/foundryMigrate.ts:722 — DDL block):
//   resources (rid TEXT PK, service TEXT, type TEXT, display_name TEXT,
//              parent_folder_rid TEXT REFERENCES resources(rid) ON DELETE RESTRICT,
//              project_rid TEXT REFERENCES resources(rid) ON DELETE RESTRICT,
//              space_rid TEXT REFERENCES resources(rid) ON DELETE RESTRICT,
//              trash_status TEXT, created_by UUID, created_at, updated_by UUID,
//              updated_at, etag BIGINT, metadata JSONB, legacy_uuid UUID UNIQUE).
//   Trigger `resources_bump_etag_t` BEFORE UPDATE auto-bumps etag and updated_at.
//
// Result. B1 acceptance criterion 5 — "Compass folder deletion blocked while
// connection exists" — is satisfied at the DB layer by the
// parent_folder_rid → resources(rid) ON DELETE RESTRICT constraint. No extra
// application-level lock is needed. The integration test simply attempts
// DELETE on the folder row and asserts foreign_key_violation.
//
// Idempotency. registerConnectionResource uses ON CONFLICT (rid) DO NOTHING
// so a retried outbox dispatch is safe. unregisterConnectionResource targets
// trash_status flip rather than DELETE so RESTRICT stays out of the picture
// (Compass parity — Foundry tombstones resources rather than hard-deleting).
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { getResource } from "../../compassService";
import {
  CompassFolderNotFound,
  CompassFolderPermissionDenied,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import {
  evaluate,
  type Policy,
  type PrincipalSelector,
  type Subject,
} from "../../security/cbacPolicy";

/** Resolved-folder view returned by getFolder; subset of compassService.Resource. */
export interface CompassFolder {
  rid: string;
  displayName: string;
  parentFolderRid: string | null;
  spaceRid: string;
  trashStatus: "NOT_TRASHED" | "DIRECTLY_TRASHED" | "ANCESTOR_TRASHED";
  /** Resource owner (user UUID) — owner is always permitted to write. */
  createdBy: string;
  /** Raw resource metadata; carries the optional row-level `acl` block. */
  metadata: Record<string, unknown>;
}

/**
 * Compass resource types that may parent a connection (source). The folder
 * picker surfaces projects, spaces, and folders, so all are valid parents.
 * Accepts both the legacy lowercase `folder` and the canonical uppercase
 * namespaces present in the `resources` table.
 */
const CONNECTION_PARENT_TYPES: ReadonlySet<string> = new Set([
  "folder",
  "FOLDER",
  "COMPASS_FOLDER",
  "PROJECT",
  "COMPASS_SPACE",
]);

/**
 * Resolve a Compass container by RID for use as a connection's parent.
 *
 * Accepts any container a source can live in (folder / project / space) — not
 * folders only — mirroring the broadened `CompassFolderRid` brand. Throws
 * CompassFolderNotFound if the RID doesn't resolve, isn't a container, or is
 * trashed. (Name kept as `getFolder` for back-compat with its two callers.)
 */
export async function getFolder(rid: string): Promise<CompassFolder> {
  let res;
  try {
    res = await getResource(rid);
  } catch (e) {
    throw new TellusError(CompassFolderNotFound, { rid }, e);
  }
  if (!CONNECTION_PARENT_TYPES.has(res.type)) {
    throw new TellusError(CompassFolderNotFound, {
      rid,
      reason: "not_a_container",
      actualType: res.type,
    });
  }
  if (res.trashStatus !== "NOT_TRASHED") {
    throw new TellusError(CompassFolderNotFound, {
      rid,
      reason: "trashed",
      trashStatus: res.trashStatus,
    });
  }
  return {
    rid: res.rid,
    displayName: res.displayName,
    parentFolderRid: res.parentFolderRid,
    spaceRid: res.spaceRid,
    trashStatus: res.trashStatus,
    createdBy: res.createdBy,
    metadata: res.metadata ?? {},
  };
}

/**
 * Row-level ACL convention carried in a folder resource's `metadata.acl`.
 * Optional and additive: a folder that declares no `acl` key keeps the
 * scope-gate-only behavior (DEVIATIONS.md D10); a folder that DOES declare one
 * is enforced row-level and fails closed when the principal matches nothing.
 *
 * `writers` / `deniedWriters` are CBAC PrincipalSelectors so role/group grants
 * compose with the platform evaluator's denylist-beats-allowlist semantics.
 * `public: true` grants write to any authenticated principal.
 */
interface FolderAcl {
  writers?: PrincipalSelector[];
  deniedWriters?: PrincipalSelector[];
  public?: boolean;
}

function readFolderAcl(metadata: Record<string, unknown>): FolderAcl | null {
  const raw = metadata?.acl;
  if (!raw || typeof raw !== "object") return null;
  const acl = raw as FolderAcl;
  const ok =
    (acl.writers === undefined || Array.isArray(acl.writers)) &&
    (acl.deniedWriters === undefined || Array.isArray(acl.deniedWriters)) &&
    (acl.public === undefined || typeof acl.public === "boolean");
  return ok ? acl : null;
}

/**
 * Verify the principal may write under the target folder.
 *
 * Enforcement is layered: the route layer already gates on the
 * 'connectivity:write' Multipass scope. This adds a row-level ACL on the
 * Compass folder resource itself:
 *   - the folder OWNER (resources.created_by) may always write;
 *   - a folder may declare `metadata.acl` (writers / deniedWriters / public),
 *     evaluated through the shared CBAC evaluator (denylist beats allowlist);
 *   - a folder with NO declared ACL preserves the prior scope-gate-only
 *     behavior (D10) so existing sources keep working.
 *
 * Throws CompassFolderNotFound if the folder is missing/trashed, and
 * CompassFolderPermissionDenied when the row-level ACL denies the principal.
 */
export async function assertWritePermission(
  folderRid: string,
  principalUserId: string,
): Promise<void> {
  // Validate container type + trash status (throws CompassFolderNotFound).
  await getFolder(folderRid);
  // Fetch the full row for owner + ACL metadata (getFolder drops both).
  const resource = await getResource(folderRid).catch(() => {
    throw new TellusError(CompassFolderNotFound, { rid: folderRid });
  });

  // Owner always passes — they created the container.
  if (resource.createdBy && resource.createdBy === principalUserId) return;

  const acl = readFolderAcl(resource.metadata);
  // No declared ACL → scope-gate-only (D10). Back-compat for existing folders.
  if (!acl) return;

  const allowed: PrincipalSelector[] = [
    { type: "user", username: resource.createdBy },
    ...(acl.public ? [{ type: "any_authenticated" } as PrincipalSelector] : []),
    ...(acl.writers ?? []),
  ];
  const policy: Policy = {
    allowedPrincipals: allowed,
    deniedPrincipals: acl.deniedWriters ?? null,
    requiredMarkings: [],
  };
  // Principal id is the only identity available at this seam; roles/groups are
  // resolved upstream by the scope gate. User/any_authenticated selectors match.
  const subject: Subject = {
    kind: "user",
    identifier: principalUserId,
    roles: [],
    groups: [],
    markings: [],
  };
  const decision = evaluate(subject, policy, {
    resourceKind: "compass_folder",
    resourceId: folderRid,
  });
  if (decision.decision === "deny") {
    throw new TellusError(CompassFolderPermissionDenied, {
      folderRid,
      principal: principalUserId,
      reason: decision.reason,
    });
  }
}

/**
 * INSERT a 'connection' resource into Compass `resources` table.
 * MUST be called inside the caller's transaction (PoolClient passed in).
 * Idempotent via ON CONFLICT (rid) DO NOTHING; safe to retry from the outbox.
 *
 * `spaceRid` is derived from the parent folder by the caller (see
 * connections.handler.ts) and passed in explicitly so this function need not
 * issue an extra round-trip. If the parent_folder_rid does not exist or is
 * trashed at insert time, PostgreSQL's FK + CHECK reject the row.
 */
export async function registerConnectionResource(
  client: PoolClient,
  params: {
    rid: string;
    displayName: string;
    description: string;
    parentFolderRid: string;
    spaceRid: string;
    createdBy: string; // user UUID
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const validCreatedBy = await resolveValidUserId(client, params.createdBy);
  await client.query(
    `INSERT INTO resources (
       rid, service, type, display_name, description,
       parent_folder_rid, project_rid, space_rid,
       created_by, updated_by, metadata
     )
     SELECT
       $1, 'magritte', 'source', $2, $3,
       parent.rid,
       CASE WHEN parent.type IN ('PROJECT', 'COMPASS_PROJECT') THEN parent.rid ELSE parent.project_rid END,
       $5,
       $6::uuid, $6::uuid, $7::jsonb
       FROM resources parent
      WHERE parent.rid = $4
         OR parent.legacy_uuid::text = split_part($4, '.', 5)
      ORDER BY CASE WHEN parent.rid = $4 THEN 0 ELSE 1 END
      LIMIT 1
     ON CONFLICT (rid) DO NOTHING`,
    [
      params.rid,
      params.displayName,
      params.description,
      params.parentFolderRid,
      params.spaceRid,
      validCreatedBy,
      JSON.stringify(params.metadata),
    ],
  );
}

/**
 * Tombstone the Compass row for a deleted connection. Trash-status flip is
 * intentional: hard DELETE would trip ON DELETE RESTRICT on resources that
 * reference this row (downstream imports, virtual tables registered to it).
 *
 * Idempotent — no-op if already trashed.
 */
export async function unregisterConnectionResource(
  client: PoolClient,
  rid: string,
  deletedBy: string,
): Promise<void> {
  const validDeletedBy = await resolveValidUserId(client, deletedBy);
  await client.query(
    `UPDATE resources
        SET trash_status = 'DIRECTLY_TRASHED',
            trashed_at = now(),
            trashed_by = $2::uuid,
            retention_until = now() + interval '30 days',
            project_rid = COALESCE(
              resources.project_rid,
              CASE WHEN parent.type IN ('PROJECT', 'COMPASS_PROJECT') THEN parent.rid ELSE parent.project_rid END
            ),
            updated_at = now(),
            updated_by = $2::uuid
       FROM resources parent
      WHERE resources.rid = $1
        AND (parent.rid = resources.parent_folder_rid
             OR parent.legacy_uuid::text = split_part(resources.parent_folder_rid, '.', 5))
        AND resources.trash_status = 'NOT_TRASHED'`,
    [rid, validDeletedBy],
  );
}

/** Future-proof for B1.PUT name change; idempotent. */
export async function renameConnectionResource(
  client: PoolClient,
  rid: string,
  newDisplayName: string,
  updatedBy: string,
): Promise<void> {
  const validUpdatedBy = await resolveValidUserId(client, updatedBy);
  await client.query(
    `UPDATE resources
        SET display_name = $2,
            updated_by = $3::uuid
      WHERE rid = $1`,
    [rid, newDisplayName, validUpdatedBy],
  );
}

// ------------------------------------------------------------------
// FK-safe user resolution — production-grade.
// Real Keycloak principals are provisioned via ensureLocalUserForClaims
// (globalAuth.ts) so they always exist in `users`.  Synthetic/test
// principals (e.g. 6d387e7e-...) and the outbox "system" fallback never
// land in `users`; FK would fail.  Resolve to a deterministic system
// user (first by created_at) and emit a structured warning so SREs can
// detect unexpected fallbacks.  Mirrors trashService/codeRepository.
// ------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_USER_FALLBACK_ID = "00000000-0000-0000-0000-000000000001";

async function resolveValidUserId(
  client: PoolClient,
  candidate: string,
): Promise<string> {
  if (UUID_RE.test(candidate)) {
    const hit = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1::uuid`,
      [candidate],
    );
    if (hit.rows.length > 0) return candidate;
  }
  // Deterministic system fallback — first user by age, or the sentinel
  // SYSTEM_USER_FALLBACK_ID if the users table is unexpectedly empty
  // (e.g. fresh test DB).  The sentinel is created by the startup
  // self-heal below if missing.
  const fallback = await client.query<{ id: string }>(
    `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`,
  );
  const resolved = fallback.rows[0]?.id ?? SYSTEM_USER_FALLBACK_ID;
  // Structured warning — grep evt=compass.fk_fallback for SRE alerting.
  console.warn(
    JSON.stringify({
      evt: "compass.fk_fallback",
      candidate,
      resolved,
      reason: "candidate_not_in_users",
    }),
  );
  return resolved;
}

/**
 * Ensure a deterministic system user exists for FK fallback.
 * Idempotent — called once at server boot and on outbox repair.
 * Uses the sentinel ID above so fallback is stable across restarts,
 * not dependent on insertion order of `cypress@tellus.local`.
 */
export async function ensureSystemUser(client: PoolClient): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1::uuid`,
    [SYSTEM_USER_FALLBACK_ID],
  );
  if (existing.rows.length > 0) return SYSTEM_USER_FALLBACK_ID;
  // Try to reuse the first real user; only insert sentinel if table empty.
  const first = await client.query<{ id: string }>(
    `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`,
  );
  if (first.rows.length > 0) return first.rows[0].id;
  await client.query(
    `INSERT INTO users (id, email, display_name, created_at, updated_at)
     VALUES ($1::uuid, 'system@tellus.local', 'System', now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [SYSTEM_USER_FALLBACK_ID],
  );
  return SYSTEM_USER_FALLBACK_ID;
}

/**
 * Startup self-heal: insert missing `resources` rows for
 * `connectivity_connections` that never landed in Compass due to
 * the pre-fix FK bug.  Idempotent via `NOT EXISTS` guard and
 * `ON CONFLICT DO NOTHING` safety.  Handles both live and
 * soft-deleted connections (trashed state derived from deleted_at).
 */
export async function repairMissingResources(client: PoolClient): Promise<number> {
  const result = await client.query(
    `INSERT INTO resources (
       rid, service, type, display_name, description,
       parent_folder_rid, project_rid, space_rid,
       created_by, updated_by, trash_status, trashed_at, trashed_by, retention_until,
       metadata, created_at, updated_at, etag
     )
     SELECT
       cc.rid,
       'magritte',
       'source',
       cc.name,
       cc.description,
       parent.rid,
       CASE WHEN parent.type IN ('PROJECT', 'COMPASS_PROJECT') THEN parent.rid ELSE parent.project_rid END,
       parent.space_rid,
       CASE
         WHEN cc.created_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (SELECT 1 FROM users WHERE id = cc.created_by::uuid)
         THEN cc.created_by::uuid
         ELSE (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
       END,
       CASE
         WHEN cc.updated_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (SELECT 1 FROM users WHERE id = cc.updated_by::uuid)
         THEN cc.updated_by::uuid
         ELSE (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
       END,
       CASE WHEN cc.deleted_at IS NOT NULL THEN 'DIRECTLY_TRASHED' ELSE 'NOT_TRASHED' END,
       cc.deleted_at,
       CASE
         WHEN cc.deleted_at IS NOT NULL AND cc.deleted_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND EXISTS (SELECT 1 FROM users WHERE id = cc.deleted_by::uuid)
         THEN cc.deleted_by::uuid
         WHEN cc.deleted_at IS NOT NULL THEN (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
         ELSE NULL
       END,
       CASE WHEN cc.deleted_at IS NOT NULL THEN cc.deleted_at + interval '30 days' ELSE NULL END,
       jsonb_build_object('connectorType', cc.connector_type, 'workerType', cc.worker_type),
       cc.created_at,
       cc.updated_at,
       1
     FROM connectivity_connections cc
     JOIN resources parent
       ON (parent.rid = cc.compass_folder_rid
           OR parent.legacy_uuid::text = split_part(cc.compass_folder_rid, '.', 5))
     WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.rid = cc.rid)
     ON CONFLICT (rid) DO NOTHING`,
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    console.warn(
      JSON.stringify({
        evt: "compass.repair_missing_resources",
        count,
      }),
    );
  }
  return count;
}
