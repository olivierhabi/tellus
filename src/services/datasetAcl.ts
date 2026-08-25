// ---------------------------------------------------------------------------
// Dataset ACL service — FOUNDRY-GAPS §6 (per-dataset permissions).
//
// Per-dataset Owner/Editor/Viewer grants backed by `dataset_acl`, mirroring
// the pipeline ACL model (PB-B7). Resolution rules:
//
//   1. `dataset_acl(dataset_id, principal_id, 'user')` — direct user grant.
//      Highest-precedence role wins if multiple.
//   2. Group grants on `dataset_acl` (principal_type='group'). Keycloak group
//      claims plug in via UUIDs directly, or via keycloak_group_map for named
//      realm/client roles — same convention as PipelineAclService.
//   3. Fallback to `project_members` on the dataset's owning project
//      (foundry_datasets.folder_id → folders.project_id) so pre-ACL tenants
//      keep working and a project role is a FLOOR, not a ceiling.
//
// Role precedence: owner > editor > viewer; grants are additive.
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../config/foundryDb";
import { AppError } from "../utils/foundryAppError";

export type DatasetRole = "owner" | "editor" | "viewer";
export type PrincipalType = "user" | "group";

const ROLE_RANK: Record<DatasetRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function datasetRoleSatisfies(actual: DatasetRole, required: DatasetRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export interface DatasetAclRow {
  dataset_id: string;
  principal_id: string;
  principal_type: PrincipalType;
  role: DatasetRole;
  granted_by: string | null;
  granted_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DatasetAclService {
  constructor(private readonly knex: Knex = foundryDb) {}

  /**
   * Resolve the effective role a user has on a dataset. Returns null when
   * the user has no grant anywhere in the chain (callers treat null as
   * INSUFFICIENT_ROLE when RBAC is enabled).
   */
  async effectiveRole(
    datasetId: string,
    userId: string,
    groupIds: string[] = [],
  ): Promise<DatasetRole | null> {
    // 1. Direct user grants. principal_id is a UUID column — a non-UUID userId
    // (a dev/email principal, or a malformed JWT sub) can't match, so skip the
    // query rather than letting Postgres throw "invalid input syntax for type
    // uuid" (a check error that surfaces as a fail-closed deny instead of a clean
    // null = "no grant"). Group grants (step 2) are UUID-filtered already.
    let best: DatasetRole | null = null;
    if (UUID_RE.test(userId)) {
      const userGrants = await this.knex("dataset_acl")
        .where({ dataset_id: datasetId, principal_id: userId, principal_type: "user" })
        .pluck("role");
      best = pickHighest(userGrants as DatasetRole[]);
    }

    // 2. Group grants — UUIDs plug straight in; named groups go through
    // keycloak_group_map (same as PipelineAclService).
    const uuidGroupIds: string[] = [];
    const namedGroupIds: string[] = [];
    for (const g of groupIds) {
      (UUID_RE.test(g) ? uuidGroupIds : namedGroupIds).push(g);
    }
    if (namedGroupIds.length > 0) {
      try {
        const mapped = await this.knex("keycloak_group_map")
          .whereIn("group_name", namedGroupIds)
          .pluck("group_uuid");
        for (const u of mapped as string[]) uuidGroupIds.push(u);
      } catch {
        /* keycloak_group_map may not exist on older installs */
      }
    }
    if (uuidGroupIds.length > 0) {
      const groupGrants = await this.knex("dataset_acl")
        .where({ dataset_id: datasetId, principal_type: "group" })
        .whereIn("principal_id", uuidGroupIds)
        .pluck("role");
      const groupBest = pickHighest(groupGrants as DatasetRole[]);
      if (groupBest && (best === null || ROLE_RANK[groupBest] > ROLE_RANK[best])) {
        best = groupBest;
      }
    }

    // 3. Fallback: project_members on the dataset's owning project, reached
    // through folder_id → folders.project_id. project_members.user_id is also a
    // UUID column — same non-UUID guard as step 1 (skip the whole block; a
    // non-UUID userId can't be a project member, so resolving the project is moot).
    if (UUID_RE.test(userId)) {
      const owning = await this.knex("foundry_datasets as d")
        .join("folders as f", "f.id", "d.folder_id")
        .where("d.id", datasetId)
        .first("f.project_id as project_id");
      if (owning?.project_id) {
        const pm = await this.knex("project_members")
          .where({ project_id: owning.project_id, user_id: userId })
          .first("role");
        if (pm?.role) {
          const candidate = normaliseRole(pm.role);
          if (candidate && (best === null || ROLE_RANK[candidate] > ROLE_RANK[best])) {
            best = candidate;
          }
        }
      }
    }
    return best;
  }

  async list(datasetId: string): Promise<DatasetAclRow[]> {
    return this.knex<DatasetAclRow>("dataset_acl")
      .where({ dataset_id: datasetId })
      .orderBy("granted_at", "desc");
  }

  async grant(input: {
    datasetId: string;
    principalId: string;
    principalType: PrincipalType;
    role: DatasetRole;
    grantedBy: string;
  }): Promise<DatasetAclRow> {
    if (!["user", "group"].includes(input.principalType)) {
      throw new AppError("Invalid principal_type", 400, "VALIDATION_ERROR");
    }
    if (!["owner", "editor", "viewer"].includes(input.role)) {
      throw new AppError("Invalid role", 400, "VALIDATION_ERROR");
    }
    const result = await this.knex.raw(
      `INSERT INTO dataset_acl
         (dataset_id, principal_id, principal_type, role, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON CONFLICT (dataset_id, principal_id, principal_type) DO UPDATE
         SET role = EXCLUDED.role,
             granted_by = EXCLUDED.granted_by,
             granted_at = NOW()
       RETURNING dataset_id, principal_id, principal_type, role,
                 granted_by, granted_at`,
      [input.datasetId, input.principalId, input.principalType, input.role, input.grantedBy],
    );
    const rows: DatasetAclRow[] = (result as { rows?: DatasetAclRow[] })?.rows ?? (result as DatasetAclRow[]) ?? [];
    if (!rows[0]) {
      throw new AppError("ACL upsert returned no row", 500, "ACL_UPSERT_FAILED");
    }
    return rows[0];
  }

  async revoke(input: {
    datasetId: string;
    principalId: string;
    principalType: PrincipalType;
  }): Promise<{ removed: boolean }> {
    const n = await this.knex("dataset_acl")
      .where({
        dataset_id: input.datasetId,
        principal_id: input.principalId,
        principal_type: input.principalType,
      })
      .del();
    return { removed: n > 0 };
  }

  /** Seed the default (creator, 'owner') grant when a dataset is created. */
  async seedOwner(datasetId: string, ownerUserId: string): Promise<void> {
    await this.knex.raw(
      `INSERT INTO dataset_acl
         (dataset_id, principal_id, principal_type, role, granted_by, granted_at)
       VALUES (?, ?, 'user', 'owner', ?, NOW())
       ON CONFLICT (dataset_id, principal_id, principal_type) DO NOTHING`,
      [datasetId, ownerUserId, ownerUserId],
    );
  }
}

function pickHighest(grants: DatasetRole[]): DatasetRole | null {
  if (!grants.length) return null;
  let best: DatasetRole = grants[0];
  for (const g of grants) {
    if (ROLE_RANK[g] > ROLE_RANK[best]) best = g;
  }
  return best;
}

function normaliseRole(raw: string): DatasetRole | null {
  const r = raw.toLowerCase();
  if (r === "owner" || r === "editor" || r === "viewer") return r as DatasetRole;
  return null;
}

export function isDatasetRbacEnabled(): boolean {
  // Per-dataset ACL enforcement is OPT-IN (separate from pipeline RBAC's
  // default-on) so it can be rolled out without surprising existing dataset
  // callers. Enable with DATASET_RBAC_ENABLED=true.
  return (process.env.DATASET_RBAC_ENABLED ?? "false").toLowerCase() === "true";
}
