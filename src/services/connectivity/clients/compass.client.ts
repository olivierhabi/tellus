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
  await client.query(
    `INSERT INTO resources (
       rid, service, type, display_name, description,
       parent_folder_rid, space_rid,
       created_by, updated_by, metadata
     )
     VALUES (
       $1, 'magritte', 'source', $2, $3,
       $4, $5,
       $6::uuid, $6::uuid, $7::jsonb
     )
     ON CONFLICT (rid) DO NOTHING`,
    [
      params.rid,
      params.displayName,
      params.description,
      params.parentFolderRid,
      params.spaceRid,
      params.createdBy,
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
  await client.query(
    `UPDATE resources
        SET trash_status = 'DIRECTLY_TRASHED',
            updated_by = $2::uuid
      WHERE rid = $1
        AND trash_status = 'NOT_TRASHED'`,
    [rid, deletedBy],
  );
}

/** Future-proof for B1.PUT name change; idempotent. */
export async function renameConnectionResource(
  client: PoolClient,
  rid: string,
  newDisplayName: string,
  updatedBy: string,
): Promise<void> {
  await client.query(
    `UPDATE resources
        SET display_name = $2,
            updated_by = $3::uuid
      WHERE rid = $1`,
    [rid, newDisplayName, updatedBy],
  );
}
