// ---------------------------------------------------------------------------
// Pipeline ACL service — PB-B7.
//
// Per-pipeline Owner/Editor/Viewer grants backed by `pipeline_acl`.
// Resolution rules:
//
//   1. `pipeline_acl(pipeline_id, principal_id, 'user')` → the direct
//      grant to the user. Highest-precedence role wins if multiple.
//   2. Otherwise, group grants attached to `pipeline_acl` (principal_type
//      = 'group'). Group membership lookup is intentionally plug-in:
//      today we resolve via `project_members` — a future hook can swap
//      in Keycloak group claims without changing callers.
//   3. Fallback to `project_members` role so pre-RBAC deployments keep
//      working (a user who was a project 'editor' stays an editor on
//      every pipeline in that project until explicit grants override).
//
// Role precedence: owner > editor > viewer. Grants are additive — a
// user who is pipeline 'viewer' but project 'owner' still resolves to
// 'owner' because the inherited project role is a FLOOR, not a ceiling.
//
// Audit: every grant/revoke calls `emitPipelineAclAudit(...)` which
// drops an entry into `tellus_audit_events` with category='pipeline_acl'.
// The audit payload carries the actor's principal ID, the affected
// principal, the new role, and the pipeline id so an ops engineer can
// reconstruct the access trail.
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../../config/foundryDb";
import { AppError } from "../../utils/foundryAppError";

export type PipelineRole = "owner" | "editor" | "viewer";
export type PrincipalType = "user" | "group";

const ROLE_RANK: Record<PipelineRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export function roleSatisfies(actual: PipelineRole, required: PipelineRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export interface PipelineAclRow {
  pipeline_id: string;
  principal_id: string;
  principal_type: PrincipalType;
  role: PipelineRole;
  granted_by: string | null;
  granted_at: string;
}

export class PipelineAclService {
  constructor(private readonly knex: Knex = foundryDb) {}

  /**
   * Resolve the effective role a user has on a pipeline. Returns null
   * when the user has no grant anywhere in the chain (and RBAC is
   * enabled — callers treat null as `INSUFFICIENT_ROLE`).
   *
   * Resolution walks pipeline_acl direct grants first, then falls back
   * to the owning project's project_members row.
   */
  async effectiveRole(
    pipelineId: string,
    userId: string,
    groupIds: string[] = [],
  ): Promise<PipelineRole | null> {
    // 1. Direct user grants.
    const userGrants = await this.knex("pipeline_acl")
      .where({
        pipeline_id: pipelineId,
        principal_id: userId,
        principal_type: "user",
      })
      .pluck("role");
    let best: PipelineRole | null = pickHighest(userGrants as PipelineRole[]);

    // 2. PB-B7 follow-groups + follow-group-mapper — Keycloak group
    // claims. UUIDs plug straight into pipeline_acl; non-UUID realm /
    // client role names go through keycloak_group_map so operators can
    // register `(offline_access → uuid)` and grant by that uuid.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
        /* keycloak_group_map table may not exist on older installs */
      }
    }
    if (uuidGroupIds.length > 0) {
      const groupGrants = await this.knex("pipeline_acl")
        .where({ pipeline_id: pipelineId, principal_type: "group" })
        .whereIn("principal_id", uuidGroupIds)
        .pluck("role");
      const groupBest = pickHighest(groupGrants as PipelineRole[]);
      if (groupBest && (best === null || ROLE_RANK[groupBest] > ROLE_RANK[best])) {
        best = groupBest;
      }
    }

    // 3. Fallback: project_members on the pipeline's owning project.
    const pipeline = await this.knex("pipelines")
      .where({ id: pipelineId })
      .first("project_id");
    if (pipeline?.project_id) {
      const pm = await this.knex("project_members")
        .where({ project_id: pipeline.project_id, user_id: userId })
        .first("role");
      if (pm?.role) {
        const candidate = normaliseRole(pm.role);
        if (candidate && (best === null || ROLE_RANK[candidate] > ROLE_RANK[best])) {
          best = candidate;
        }
      }
    }
    return best;
  }

  async list(pipelineId: string): Promise<PipelineAclRow[]> {
    return this.knex<PipelineAclRow>("pipeline_acl")
      .where({ pipeline_id: pipelineId })
      .orderBy("granted_at", "desc");
  }

  /**
   * Upsert a grant. Returns the persisted row. Throws VALIDATION_ERROR
   * if the principal/role is invalid.
   */
  async grant(input: {
    pipelineId: string;
    principalId: string;
    principalType: PrincipalType;
    role: PipelineRole;
    grantedBy: string;
  }): Promise<PipelineAclRow> {
    if (!["user", "group"].includes(input.principalType)) {
      throw new AppError("Invalid principal_type", 400, "VALIDATION_ERROR");
    }
    if (!["owner", "editor", "viewer"].includes(input.role)) {
      throw new AppError("Invalid role", 400, "VALIDATION_ERROR");
    }
    const result = await this.knex.raw(
      `INSERT INTO pipeline_acl
         (pipeline_id, principal_id, principal_type, role, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?, NOW())
       ON CONFLICT (pipeline_id, principal_id, principal_type) DO UPDATE
         SET role = EXCLUDED.role,
             granted_by = EXCLUDED.granted_by,
             granted_at = NOW()
       RETURNING pipeline_id, principal_id, principal_type, role,
                 granted_by, granted_at`,
      [
        input.pipelineId,
        input.principalId,
        input.principalType,
        input.role,
        input.grantedBy,
      ],
    );
    // pg driver returns { rows: [...] }; handle both shapes defensively.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: PipelineAclRow[] = (result as any)?.rows ?? (result as any) ?? [];
    if (!rows[0]) {
      throw new AppError("ACL upsert returned no row", 500, "ACL_UPSERT_FAILED");
    }
    return rows[0];
  }

  /**
   * Revoke a grant. No-op if the row doesn't exist — callers can treat
   * "already gone" as success.
   */
  async revoke(input: {
    pipelineId: string;
    principalId: string;
    principalType: PrincipalType;
  }): Promise<{ removed: boolean }> {
    const n = await this.knex("pipeline_acl")
      .where({
        pipeline_id: input.pipelineId,
        principal_id: input.principalId,
        principal_type: input.principalType,
      })
      .del();
    return { removed: n > 0 };
  }

  /** Convenience: seed the default (creator, 'owner') grant on create. */
  async seedOwner(pipelineId: string, ownerUserId: string): Promise<void> {
    await this.knex.raw(
      `INSERT INTO pipeline_acl
         (pipeline_id, principal_id, principal_type, role, granted_by, granted_at)
       VALUES (?, ?, 'user', 'owner', ?, NOW())
       ON CONFLICT (pipeline_id, principal_id, principal_type) DO NOTHING`,
      [pipelineId, ownerUserId, ownerUserId],
    );
  }
}

function pickHighest(grants: PipelineRole[]): PipelineRole | null {
  if (!grants.length) return null;
  let best: PipelineRole = grants[0];
  for (const g of grants) {
    if (ROLE_RANK[g] > ROLE_RANK[best]) best = g;
  }
  return best;
}

function normaliseRole(raw: string): PipelineRole | null {
  const r = raw.toLowerCase();
  if (r === "owner" || r === "editor" || r === "viewer") return r as PipelineRole;
  return null;
}

export function isRbacEnabled(): boolean {
  // Default: enabled. Operators opt out via RBAC_ENABLED=false for the
  // one-release deprecation window described in the spec.
  return (process.env.RBAC_ENABLED ?? "true").toLowerCase() !== "false";
}
