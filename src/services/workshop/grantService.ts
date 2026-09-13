// Workshop per-module grants — effective role resolution for
// module-scoped Viewer/Editor access.
//
// Effective permissions are additive. The caller receives the strongest
// role supplied by any applicable source (editor > viewer > no access):
// platform super role, legacy global Workshop role, direct user grant,
// explicit group grant, or the well-known default Workshop groups.

import { getWorkshopDb } from "./db";
import { SUPER_EDITOR_ROLES, ROLE_EDITOR, ROLE_VIEWER } from "./rbac";

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

const ROLE_RANK: Readonly<Record<GrantRole, number>> = {
  viewer: 1,
  editor: 2,
};

function strongestRole(
  ...roles: ReadonlyArray<GrantRole | null | undefined>
): GrantRole | null {
  let best: GrantRole | null = null;
  for (const role of roles) {
    if (role && (!best || ROLE_RANK[role] > ROLE_RANK[best])) best = role;
  }
  return best;
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

  const globalRole: GrantRole | null = input.roles.includes(ROLE_EDITOR)
    ? "editor"
    : input.roles.includes(ROLE_VIEWER)
      ? "viewer"
      : null;

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

  return strongestRole(globalRole, userRole, groupRole, defaultGroupRole);
}

export async function getModuleEffectiveRole(
  moduleRid: string,
  input: EffectiveRoleInput,
): Promise<GrantRole | null> {
  // Editor is the strongest possible role, so these two cases can safely
  // short-circuit. A global Viewer cannot: a module/group grant may elevate
  // the same caller to Editor.
  if (SUPER_EDITOR_ROLES.some((r) => input.roles.includes(r))) return "editor";
  if (input.roles.includes(ROLE_EDITOR)) return "editor";

  const db = getWorkshopDb();
  // Platform pseudo-group convention (pipelineRbac/datasetRbac
  // `extractGroupIds`): Keycloak realm roles double as group identifiers
  // for ACL matching, since the realm models authorization groups
  // (fraud-analyst, fraud-investigator, …) as realm roles rather than
  // Keycloak groups.
  const effectiveInput: EffectiveRoleInput = {
    ...input,
    groups: [...(input.groups ?? []), ...input.roles],
  };
  const normalizedGroups = effectiveInput.groups!.map(normalizeGroupName);

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

  const allGrants: ModuleGrant[] = grants.rows.map((r) => ({
      moduleRid,
      principalType: r.principal_type,
      principalId: r.principal_id,
      role: r.role,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    }));

  // Authorization is intentionally resolved from the shared database on
  // every request. This makes role downgrade/revocation immediately visible
  // across horizontally scaled API instances; an in-process TTL cache can
  // otherwise preserve stale Editor privileges after a revoke.
  return effectiveRoleFromInputs(effectiveInput, allGrants);
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
  // Group principals are stored in normalized form — the effective-role
  // lookup compares caller group/role identifiers after the same
  // normalization (`normalizeGroupName`), so persisting the canonical form
  // keeps writes and reads symmetric ("Fraud-Analyst" ≡ "fraud analyst").
  const storedPrincipalId =
    principalType === "group" ? normalizeGroupName(principalId) : principalId;
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
    [moduleRid, principalType, storedPrincipalId, role, grantedBy],
  );
  const r = row.rows[0];
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
  const storedPrincipalId =
    principalType === "group" ? normalizeGroupName(principalId) : principalId;
  const result = await db.query(
    `DELETE FROM workshop_module_grants
      WHERE module_rid = $1 AND principal_type = $2 AND principal_id = $3
      RETURNING 1`,
    [moduleRid, principalType, storedPrincipalId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Access decision with provenance — backs Workshop's "Check access" surface.
// Foundry shows WHY a principal has access (direct grant vs group vs global
// role); the bare effective-role endpoint cannot reconstruct that, so the
// resolution order is replayed here with the matched path recorded.
// ---------------------------------------------------------------------------

export type AccessDecisionVia =
  | "super-role"
  | "global-role"
  | "direct-grant"
  | "group-grant"
  | "default-group"
  | "none";

export interface ModuleAccessDecision {
  readonly role: GrantRole | null;
  readonly via: AccessDecisionVia;
  /** The matched role name / grant principal id (when applicable). */
  readonly detail: string | null;
}

export interface WorkshopDependencyAccess {
  readonly objectTypes: boolean;
  readonly linkTypes: boolean;
  readonly actionTypes: boolean;
  readonly functions: boolean;
  readonly reason: string;
}

export interface WorkshopOrganizationRequirement {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly satisfied: boolean;
}

export interface WorkshopMarkingRequirement {
  readonly id: string;
  readonly displayName: string;
  readonly satisfied: boolean;
}

export interface WorkshopFileAccessRequirements {
  readonly organizations: {
    readonly mode: "anyOf";
    readonly required: readonly WorkshopOrganizationRequirement[];
    readonly meets: boolean;
  };
  readonly markings: {
    readonly required: readonly WorkshopMarkingRequirement[];
    readonly meets: boolean;
  };
}

async function resolveWorkshopProjectRid(moduleRid: string): Promise<string | null> {
  const db = getWorkshopDb();
  const moduleRow = await db.query<{ parent_folder_rid: string }>(
    `SELECT parent_folder_rid
       FROM workshop_module
      WHERE rid = $1 AND deleted_at IS NULL
      LIMIT 1`,
    [moduleRid],
  );
  const parentRid = moduleRow.rows[0]?.parent_folder_rid;
  if (!parentRid) return null;
  if (parentRid.startsWith("ri.compass.main.project.")) return parentRid;

  const parentSegments = parentRid.split(".");
  const parentId = parentSegments[parentSegments.length - 1] ?? "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parentId)) {
    const folder = await db.query<{ project_id: string }>(
      `SELECT project_id::text AS project_id FROM folders WHERE id = $1::uuid LIMIT 1`,
      [parentId],
    );
    if (folder.rows[0]?.project_id) {
      return `ri.compass.main.project.${folder.rows[0].project_id}`;
    }
  }

  const resource = await db.query<{ project_rid: string | null }>(
    `SELECT project_rid FROM resources WHERE rid = $1 LIMIT 1`,
    [parentRid],
  );
  return resource.rows[0]?.project_rid ?? null;
}

async function getWorkshopFileAccessRequirementsForLocalUser(
  moduleRid: string,
  localUserId: string | null,
): Promise<WorkshopFileAccessRequirements> {
  const db = getWorkshopDb();
  const projectRid = await resolveWorkshopProjectRid(moduleRid);

  const organizations = projectRid
    ? await db.query<{ id: string; name: string; display_name: string | null }>(
        `SELECT o.id::text AS id, o.name, o.display_name
           FROM project_organizations po
           JOIN organizations o ON o.id = po.org_id
          WHERE po.project_rid = $1
          ORDER BY COALESCE(o.display_name, o.name), o.id`,
        [projectRid],
      )
    : { rows: [] as Array<{ id: string; name: string; display_name: string | null }> };

  const userOrgIds = localUserId && organizations.rows.length > 0
    ? await db.query<{ org_id: string }>(
        `SELECT org_id::text AS org_id FROM user_organizations WHERE user_id = $1::uuid`,
        [localUserId],
      )
    : { rows: [] as Array<{ org_id: string }> };
  const orgMembership = new Set(userOrgIds.rows.map((row) => row.org_id));
  const organizationRows: WorkshopOrganizationRequirement[] = organizations.rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? row.name,
    satisfied: orgMembership.has(row.id),
  }));

  const markingResourceRids = projectRid ? [moduleRid, projectRid] : [moduleRid];
  const markings = await db.query<{ id: string; display_name: string }>(
    `SELECT DISTINCT m.id, m.display_name
       FROM resource_markings rm
       JOIN markings m ON m.id = rm.marking_id
      WHERE rm.resource_rid = ANY($1::text[])
        AND rm.source IN ('DIRECT', 'INHERITED')
      ORDER BY m.display_name, m.id`,
    [markingResourceRids],
  );
  const userMarkings = localUserId && markings.rows.length > 0
    ? await db.query<{ marking_id: string }>(
        `SELECT marking_id FROM user_markings WHERE user_id = $1::uuid`,
        [localUserId],
      )
    : { rows: [] as Array<{ marking_id: string }> };
  const markingMembership = new Set(userMarkings.rows.map((row) => row.marking_id));
  const markingRows: WorkshopMarkingRequirement[] = markings.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    satisfied: markingMembership.has(row.id),
  }));

  return {
    organizations: {
      mode: "anyOf",
      required: organizationRows,
      meets: organizationRows.length === 0 || organizationRows.some((row) => row.satisfied),
    },
    markings: {
      required: markingRows,
      meets: markingRows.every((row) => row.satisfied),
    },
  };
}

export async function getWorkshopFileAccessRequirements(
  moduleRid: string,
  email: string | null,
): Promise<WorkshopFileAccessRequirements> {
  const db = getWorkshopDb();
  const localUser = email
    ? await db.query<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
        [email],
      )
    : { rows: [] as Array<{ id: string }> };
  return getWorkshopFileAccessRequirementsForLocalUser(
    moduleRid,
    localUser.rows[0]?.id ?? null,
  );
}

export async function meetsWorkshopFileAccessRequirements(
  moduleRid: string,
  localUserId: string | null,
): Promise<boolean> {
  const requirements = await getWorkshopFileAccessRequirementsForLocalUser(
    moduleRid,
    localUserId,
  );
  return requirements.organizations.meets && requirements.markings.meets;
}

/**
 * Evaluate the ontology catalogue access used by Workshop dependencies for
 * a directory principal. This deliberately stays separate from module
 * grants: being able to open a module does not grant access to its data or
 * executable resources.
 *
 * Tellus currently authorizes reads for these four catalogue/resource
 * families through the ontology read roles. Keep this helper aligned with
 * TellusAuthService ROLE_OP_MAP until resource-specific ACLs are introduced.
 */
export function getWorkshopDependencyAccess(
  roles: readonly string[],
): WorkshopDependencyAccess {
  const readRole = ["ontology-admin", "ontology-editor", "ontology-viewer"]
    .find((role) => roles.includes(role));
  const allowed = readRole != null;
  return {
    objectTypes: allowed,
    linkTypes: allowed,
    actionTypes: allowed,
    functions: allowed,
    reason: allowed ? `User has ${readRole} role` : "INSUFFICIENT_ONTOLOGY_READ_ROLE",
  };
}

export async function getModuleAccessDecision(
  moduleRid: string,
  input: EffectiveRoleInput,
): Promise<ModuleAccessDecision> {
  const superRole = SUPER_EDITOR_ROLES.find((r) => input.roles.includes(r));
  if (superRole) return { role: "editor", via: "super-role", detail: superRole };
  if (input.roles.includes(ROLE_EDITOR)) {
    return { role: "editor", via: "global-role", detail: ROLE_EDITOR };
  }

  const db = getWorkshopDb();
  const rows = await db.query<{
    principal_type: PrincipalType;
    principal_id: string;
    role: GrantRole;
  }>(
    `SELECT principal_type, principal_id, role
       FROM workshop_module_grants
      WHERE module_rid = $1`,
    [moduleRid],
  );

  const candidates: ModuleAccessDecision[] = [];
  const userGrant = rows.rows
    .filter(
      (r) => r.principal_type === "user" && r.principal_id === input.userId,
    )
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0];
  if (userGrant) {
    candidates.push({
      role: userGrant.role,
      via: "direct-grant",
      detail: input.userId,
    });
  }

  // Pseudo-group convention: realm roles are valid group identifiers.
  const normalizedIds = new Set(
    [...(input.groups ?? []), ...input.roles].map(normalizeGroupName),
  );
  const groupGrant = rows.rows
    .filter(
      (r) =>
        r.principal_type === "group" && normalizedIds.has(r.principal_id),
    )
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0];
  if (groupGrant) {
    candidates.push({
      role: groupGrant.role,
      via: "group-grant",
      detail: groupGrant.principal_id,
    });
  }

  for (const [groupName, role] of Object.entries(DEFAULT_GROUP_GRANTS)) {
    if (normalizedIds.has(groupName)) {
      candidates.push({ role, via: "default-group", detail: groupName });
    }
  }

  if (input.roles.includes(ROLE_VIEWER)) {
    candidates.push({
      role: "viewer",
      via: "global-role",
      detail: ROLE_VIEWER,
    });
  }

  const editor = candidates.find((candidate) => candidate.role === "editor");
  if (editor) return editor;
  const viewer = candidates.find((candidate) => candidate.role === "viewer");
  if (viewer) return viewer;

  return { role: null, via: "none", detail: null };
}

/**
 * Insert a creator grant on module creation. Best-effort — if the grants
 * table is missing (42P01, pre-migration test lane), silently skip.
 */
export async function insertCreatorGrant(
  moduleRid: string,
  principalId: string,
  grantedBy: string = principalId,
  client?: unknown,
): Promise<void> {
  try {
    if (client) {
      await (client as { query: (sql: string, params: unknown[]) => Promise<unknown> }).query(
        `INSERT INTO workshop_module_grants
           (module_rid, principal_type, principal_id, role, granted_by)
         VALUES ($1, 'user', $2, 'editor', $3)
         ON CONFLICT (module_rid, principal_type, principal_id) DO NOTHING`,
        [moduleRid, principalId, grantedBy],
      );
    } else {
      await getWorkshopDb().query(
        `INSERT INTO workshop_module_grants
           (module_rid, principal_type, principal_id, role, granted_by)
         VALUES ($1, 'user', $2, 'editor', $3)
         ON CONFLICT (module_rid, principal_type, principal_id) DO NOTHING`,
        [moduleRid, principalId, grantedBy],
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
