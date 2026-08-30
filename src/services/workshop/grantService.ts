// Workshop per-module grants — effective role resolution for
// module-scoped Viewer/Editor access.
//
// Resolution order (maximum role wins, editor > viewer):
//  1. JWT realm super roles (tellus-superadmin, ontology-admin, ontology-editor)
//     → editor.
//  2. Legacy global workshop roles (workshop-editor, workshop-viewer) for
//     backward compatibility during migration.
//  3. Direct user grant (principal_type = 'user', principal_id = user local id).
//  4. Group membership grants (principal_type = 'group',
//     principal_id IN caller.normalizedGroups).
//  5. Implicit default groups: "Workshop Builders" → editor,
//     "Workshop Users" → viewer (Foundry spec).
//  6. None of the above → no access (null).

import { getWorkshopDb } from "./db";
import { SUPER_EDITOR_ROLES, ROLE_EDITOR, ROLE_VIEWER } from "./rbac";

// Per-module effective role cache (30s TTL). Invalidated on grant mutation
// so stale permissions clear within the TTL window.

interface CachedRole {
  role: GrantRole | null;
  expiresAt: number;
}

const roleCache = new Map<string, CachedRole>();
const ROLE_CACHE_TTL_MS = 30_000;

function roleCacheKey(moduleRid: string, userId: string): string {
  return `${moduleRid}:${userId}`;
}

function invalidateRoleCache(moduleRid: string): void {
  const prefix = `${moduleRid}:`;
  for (const key of roleCache.keys()) {
    if (key.startsWith(prefix)) roleCache.delete(key);
  }
}

export type GrantRole = "viewer" | "editor";
export type PrincipalType = "user" | "group";

export interface ModuleGrant {
  moduleRid: string;
  principalType: PrincipalType;
  principalId: string;
  role: GrantRole;
  grantedBy: string;
  grantedAt: string;
}

export interface EffectiveRoleInput {
  userId: string;
  roles: string[];
  groups?: string[];
}

const DEFAULT_GROUP_GRANTS: Readonly<Record<string, GrantRole>> = {
  "workshop builders": "editor",
  "workshop users": "viewer",
};

function normalizeGroupName(name: string): string {
  return name.replace(/^[/\s]+/, "").replace(/[\s-]+/g, " ").toLowerCase();
}

export function effectiveRoleFromInputs(
  input: EffectiveRoleInput,
  grants: ModuleGrant[],
): GrantRole | null {
  if (SUPER_EDITOR_ROLES.some((r) => input.roles.includes(r))) return "editor";
  if (input.roles.includes(ROLE_EDITOR)) return "editor";
  if (input.roles.includes(ROLE_VIEWER)) return "viewer";

  const normalizedGroups = new Set(
    (input.groups ?? []).map(normalizeGroupName),
  );

  // Explicity group + default-group grants.
  const groupRole = grants
    .filter((g) => g.principalType === "group")
    .reduce<GrantRole | null>((best, g) => {
      if (normalizedGroups.has(normalizeGroupName(g.principalId))) {
        if (g.role === "editor" || best === "editor") return "editor";
        return "viewer";
      }
      return best;
    }, null);

  // Default group grants from well-known names.
  let defaultGroupRole: GrantRole | null = null;
  for (const [groupName, role] of Object.entries(DEFAULT_GROUP_GRANTS)) {
    if (normalizedGroups.has(groupName)) {
      if (role === "editor") defaultGroupRole = "editor";
      else if (defaultGroupRole !== "editor") defaultGroupRole = "viewer";
    }
  }

  // Direct user grant.
  const userRole = grants
    .filter((g) => g.principalType === "user" && g.principalId === input.userId)
    .reduce<GrantRole | null>((best, g) => {
      if (g.role === "editor" || best === "editor") return "editor";
      return "viewer";
    }, null);

  return userRole ?? groupRole ?? defaultGroupRole ?? null;
}

export async function getModuleEffectiveRole(
  moduleRid: string,
  input: EffectiveRoleInput,
): Promise<GrantRole | null> {
  // Super/global roles don't need a DB roundtrip.
  if (SUPER_EDITOR_ROLES.some((r) => input.roles.includes(r))) return "editor";
  if (input.roles.includes(ROLE_EDITOR)) return "editor";
  if (input.roles.includes(ROLE_VIEWER)) return "viewer";

  const cacheKey = roleCacheKey(moduleRid, input.userId);
  const cached = roleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.role;

  const db = getWorkshopDb();
  const normalizedGroups = (input.groups ?? []).map(normalizeGroupName);

  // Fetch direct + group grants.
  const grants = await db.query<{
    principal_type: PrincipalType;
    principal_id: string;
    role: GrantRole;
    granted_by: string;
    granted_at: string;
  }>(
    `SELECT principal_type, principal_id, role, granted_by, granted_at::text
       FROM workshop_module_grants
      WHERE module_rid = $1
        AND (
          (principal_type = 'user' AND principal_id = $2)
          OR (principal_type = 'group' AND principal_id = ANY ($3::text[]))
        )`,
    [moduleRid, input.userId, normalizedGroups],
  );

  // Also fetch grants for default group names.
  const defaultGroupNames = Object.keys(DEFAULT_GROUP_GRANTS).filter((gn) =>
    normalizedGroups.includes(gn),
  );
  let defaultGroupGrants: typeof grants.rows = [];
  if (defaultGroupNames.length > 0) {
    const dg = await db.query<{
      principal_type: PrincipalType;
      principal_id: string;
      role: GrantRole;
      granted_by: string;
      granted_at: string;
    }>(
      `SELECT principal_type, principal_id, role, granted_by, granted_at::text
         FROM workshop_module_grants
        WHERE module_rid = $1
          AND principal_type = 'group'
          AND principal_id = ANY ($2::text[])`,
      [moduleRid, defaultGroupNames],
    );
    defaultGroupGrants = dg.rows;
  }

  const allGrants: ModuleGrant[] = [...grants.rows, ...defaultGroupGrants].map(
    (r) => ({
      moduleRid,
      principalType: r.principal_type,
      principalId: r.principal_id,
      role: r.role,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    }),
  );

  const result = effectiveRoleFromInputs(input, allGrants);
  roleCache.set(cacheKey, { role: result, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  return result;
}

export async function listModuleGrants(
  moduleRid: string,
): Promise<ModuleGrant[]> {
  const db = getWorkshopDb();
  const rows = await db.query<{
    principal_type: PrincipalType;
    principal_id: string;
    role: GrantRole;
    granted_by: string;
    granted_at: string;
  }>(
    `SELECT principal_type, principal_id, role, granted_by, granted_at::text
       FROM workshop_module_grants
      WHERE module_rid = $1
      ORDER BY principal_type, principal_id`,
    [moduleRid],
  );
  return rows.rows.map((r) => ({
    moduleRid,
    principalType: r.principal_type,
    principalId: r.principal_id,
    role: r.role,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }));
}

export async function upsertModuleGrant(
  moduleRid: string,
  principalType: PrincipalType,
  principalId: string,
  role: GrantRole,
  grantedBy: string,
): Promise<ModuleGrant> {
  const db = getWorkshopDb();
  const row = await db.query<{
    principal_type: PrincipalType;
    principal_id: string;
    role: GrantRole;
    granted_by: string;
    granted_at: string;
  }>(
    `INSERT INTO workshop_module_grants
       (module_rid, principal_type, principal_id, role, granted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (module_rid, principal_type, principal_id)
     DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by,
                   granted_at = now()
     RETURNING principal_type, principal_id, role,
               granted_by, granted_at::text`,
    [moduleRid, principalType, principalId, role, grantedBy],
  );
  const r = row.rows[0];
  invalidateRoleCache(moduleRid);
  return {
    moduleRid,
    principalType: r.principal_type,
    principalId: r.principal_id,
    role: r.role,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  };
}

export async function removeModuleGrant(
  moduleRid: string,
  principalType: PrincipalType,
  principalId: string,
): Promise<boolean> {
  const db = getWorkshopDb();
  const result = await db.query(
    `DELETE FROM workshop_module_grants
      WHERE module_rid = $1 AND principal_type = $2 AND principal_id = $3
      RETURNING 1`,
    [moduleRid, principalType, principalId],
  );
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) invalidateRoleCache(moduleRid);
  return deleted;
}

/**
 * Insert a creator grant on module creation. Best-effort — if the grants
 * table is missing (42P01, pre-migration test lane), silently skip.
 */
export async function insertCreatorGrant(
  moduleRid: string,
  userId: string,
  client?: unknown,
): Promise<void> {
  try {
    if (client) {
      await (client as { query: (sql: string, params: unknown[]) => Promise<unknown> }).query(
        `INSERT INTO workshop_module_grants
           (module_rid, principal_type, principal_id, role, granted_by)
         VALUES ($1, 'user', $2, 'editor', $2)
         ON CONFLICT (module_rid, principal_type, principal_id) DO NOTHING`,
        [moduleRid, userId],
      );
    } else {
      await getWorkshopDb().query(
        `INSERT INTO workshop_module_grants
           (module_rid, principal_type, principal_id, role, granted_by)
         VALUES ($1, 'user', $2, 'editor', $2)
         ON CONFLICT (module_rid, principal_type, principal_id) DO NOTHING`,
        [moduleRid, userId],
      );
    }
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: string }).code === "42P01"
    ) {
      return; // Table doesn't exist — migration hasn't been applied yet.
    }
    throw err;
  }
}