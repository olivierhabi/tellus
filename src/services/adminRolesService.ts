/**
 * Orchestration layer for the superadmin roles console (/admin/roles*).
 *
 * Keycloak's own admin API is deliberately low-level: role deletion doesn't
 * refuse built-in roles, composite edges accept cycles silently (they only
 * blow up at token-issuance), and parallel sessions can interleave writes.
 * This service owns the invariants so the routes stay thin:
 *
 *   - built-in roles (platform defaults + tellus-superadmin) cannot be
 *     deleted and their composition cannot be edited;
 *   - a role cannot composite itself, directly or transitively (cycle → the
 *     token mapper would recurse at login and Keycloak 500s);
 *   - a role still referenced by another composite role cannot be deleted;
 *   - the last tellus-superadmin cannot be revoked (the console would lose
 *     its gatekeeper with no recovery path short of Keycloak admin access);
 *   - composite updates are applied as an add/remove DIFF, so two concurrent
 *     reverse-edits (add-and-remove-in-the-same-breath) leave a sane result.
 *
 * Response shapes match the FE contract in tellus-fe/lib/rolesApi.ts
 * verbatim — that file is the source of truth for the wire format.
 */
import { AppError } from '../utils/foundryAppError';
import { getKeycloakAdminService, KeycloakRealmRole } from './keycloakAdminService';
import { TELLUS_SUPERADMIN_ROLE } from '../middleware/requireSuperAdmin';
import { getKeycloakRealm } from '../auth/keycloakConfig';

export interface AdminRole {
  id: string;
  name: string;
  description: string;
  composite: boolean;
  clientRole: boolean;
  builtIn: boolean;
  compositeRoleIds: string[];
  memberCount: number;
}

export interface AdminUserRow {
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enabled: boolean;
  emailVerified: boolean;
  createdTimestamp: number | null;
  roles: string[];
}

/**
 * The NON-admin roles directory row — what GET /api/v1/auth/roles returns.
 *
 * Deliberately a separate, narrower shape from AdminRole: membership counts
 * and composite edges belong to the superadmin console, and the directory
 * must stay a single paged Keycloak read (no N+1 hydration) because authoring
 * surfaces (Ontology Manager submission criteria) hit it on every page load.
 * `name` is the value subject-role submission criteria compare against
 * (JWT realm_access.roles), so the name — never the id — is what pickers
 * must persist.
 */
export interface RoleDirectoryEntry {
  id: string;
  name: string;
  description: string;
}

/**
 * Security decision: these roles cannot be deleted and their composition
 * cannot be edited through the console. `tellus-superadmin` is on the list
 * deliberately — deleting it would lock every superadmin out with no
 * recovery path short of direct Keycloak-admin access.
 */
export function isBuiltInRoleName(name: string): boolean {
  if (name === TELLUS_SUPERADMIN_ROLE) return true;
  if (name === 'offline_access' || name === 'uma_authorization') return true;
  return name === `default-roles-${getKeycloakRealm()}`;
}

/** Members fetched per role for the details/members views. Hard cap: the
 * response payload must stay bounded for roles like default-roles-*. */
const MEMBER_HYDRATE_CAP = 1000;

/** Same idea for the list view's memberCount column: exact up to 100,
 * capped at 101 (the cap is displayed as-is; it is not a promise of
 * exactness, just a bound on our per-row probe cost). */
const MEMBER_COUNT_PROBE_CAP = 101;

export class AdminRolesService {
  private kc() {
    return getKeycloakAdminService();
  }

  // --- Listing -----------------------------------------------------------

  async listRoles(opts: { search?: string; first?: number; max?: number }): Promise<{
    roles: AdminRole[];
    total: number;
  }> {
    const all = await this.listAllRoleReps();
    const needle = (opts.search ?? '').trim().toLowerCase();
    const filtered = needle
      ? all.filter((r) => r.name.toLowerCase().includes(needle))
      : all;
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    const total = filtered.length;
    const first = opts.first ?? 0;
    const max = opts.max ?? 200;
    const window = filtered.slice(first, first + max);

    // N+1 by design: realm counts are small (tens), and per-role composite
    // hydration + member-count probe are the only way Keycloak offers the
    // data. Both calls are parallelized across the window.
    const roles = await Promise.all(
      window.map(async (rep) => {
        const [compositeIds, memberCount] = await Promise.all([
          this.compositeIdsOf(rep.name),
          this.kc().countRoleUsers(rep.name, MEMBER_COUNT_PROBE_CAP),
        ]);
        return this.toAdminRole(rep, compositeIds, memberCount);
      }),
    );
    return { roles, total };
  }

  /**
   * The non-admin roles directory: every realm role, id + name + description
   * only (see RoleDirectoryEntry for why the shape is narrower than
   * AdminRole). Built-in realm roles are INCLUDED — an existing submission
   * criterion may reference one (e.g. `default-roles-tellus` as
   * "any authenticated user"), and the directory must round-trip every name
   * an authoring UI can encounter rather than silently hiding it.
   */
  async listRoleDirectory(): Promise<RoleDirectoryEntry[]> {
    const all = await this.listAllRoleReps();
    return all
      .map((rep) => ({
        id: rep.id,
        name: rep.name,
        description: rep.description ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getRole(roleId: string): Promise<AdminRole> {
    const rep = await this.mustGetRole(roleId);
    const [compositeIds, memberCount] = await Promise.all([
      this.compositeIdsOf(rep.name),
      this.kc().countRoleUsers(rep.name, MEMBER_COUNT_PROBE_CAP),
    ]);
    return this.toAdminRole(rep, compositeIds, memberCount);
  }

  // --- Create / update / delete ------------------------------------------

  async createRole(input: {
    name: string;
    description?: string;
    compositeRoleIds?: string[];
  }): Promise<AdminRole> {
    const description = (input.description ?? '').trim();

    const existing = await this.kc().getRoleByName(input.name);
    if (existing) {
      throw new AppError(`A role named "${input.name}" already exists`, 409, 'ROLE_NAME_TAKEN');
    }

    const composites = await this.resolveCompositeIds(input.compositeRoleIds ?? []);
    // A brand-new role cannot be referenced by anything yet, so a composed
    // edge pointing back at it is impossible EXCEPT if a client-side race
    // created it in the meantime — the catch below maps that 409 too.

    try {
      await this.kc().createRole(input.name, description);
    } catch (err) {
      if (err instanceof AppError) {
        // Keycloak 409 = another session won the name race between our
        // getRoleByName probe and this POST.
        if (err.statusCode === 409) {
          throw new AppError(`A role named "${input.name}" already exists`, 409, 'ROLE_NAME_TAKEN');
        }
      }
      throw err;
    }
    const created = await this.kc().getRoleByName(input.name);
    if (!created) {
      // Keycloak returned 201 but the role is not retrievable — upstream
      // misbehaviour worth surfacing loudly rather than inventing state.
      throw new AppError('Role was created but could not be reloaded', 502, 'UPSTREAM_ERROR');
    }

    if (composites.length > 0) {
      await this.applyCompositeDiff(created, composites.map((c) => c.id), { skipCycleGuard: true });
    }

    return this.getRole(created.id);
  }

  async updateRole(
    roleId: string,
    input: { description?: string; compositeRoleIds?: string[] },
  ): Promise<AdminRole> {
    const rep = await this.mustGetRole(roleId);
    const builtIn = isBuiltInRoleName(rep.name);

    if (input.description !== undefined) {
      await this.kc().updateRoleDescription(rep.id, input.description.trim());
    }

    if (input.compositeRoleIds !== undefined) {
      if (builtIn) {
        throw new AppError(
          'The composition of a platform-managed role cannot be edited through the console',
          409,
          'BUILT_IN_ROLE',
        );
      }
      await this.applyCompositeDiff(rep, input.compositeRoleIds, { skipCycleGuard: false });
    }

    return this.getRole(roleId);
  }

  async deleteRole(roleId: string): Promise<void> {
    const rep = await this.mustGetRole(roleId);

    if (isBuiltInRoleName(rep.name)) {
      throw new AppError('This role is managed by the platform and cannot be deleted', 409, 'BUILT_IN_ROLE');
    }

    // Refuse to delete a role that other roles still composite: the edges
    // would dangle, and Keycloak's own composite resolution silently
    // ignores broken Forward-refs. Report exactly who references it so the
    // caller can unwind the graph from the FE.
    const referrers = await this.rolesCompositing(rep.id);
    if (referrers.length > 0) {
      throw new AppError(
        `Role is still composed into ${referrers.map((r) => `"${r}"`).join(', ')}`,
        409,
        'ROLE_REFERENCED',
      );
    }

    await this.kc().deleteRole(rep.name);
  }

  // --- Members -----------------------------------------------------------

  async listMembers(roleId: string): Promise<{ users: AdminUserRow[]; total: number }> {
    const rep = await this.mustGetRole(roleId);
    const users = await this.kc().listRoleUsers({ name: rep.name, first: 0, max: MEMBER_HYDRATE_CAP });
    users.sort((a, b) => a.username.localeCompare(b.username));
    return { users, total: users.length };
  }

  async addMember(roleId: string, userId: string): Promise<void> {
    const rep = await this.mustGetRole(roleId);
    // Cheap existence probe so a bogus userId surfaces as a clean 404
    // rather than Keycloak's raw mapping-POST failure.
    const user = await this.kc().getUserById(userId);
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');
    await this.kc().assignRoleToUserById(userId, { id: rep.id, name: rep.name });
  }

  async removeMember(roleId: string, userId: string): Promise<void> {
    const rep = await this.mustGetRole(roleId);
    const user = await this.kc().getUserById(userId);
    if (!user) throw new AppError('User not found', 404, 'NOT_FOUND');

    // Security decision: the console must not be able to strand itself
    // with zero superadmins. Revoking any OTHER superadmin is fine.
    if (rep.name === TELLUS_SUPERADMIN_ROLE) {
      const holders = await this.kc().listRoleUsers({ name: rep.name, first: 0, max: 2 });
      const isSolitary = holders.length === 1 && holders[0].id === userId;
      if (isSolitary) {
        throw new AppError(
          'Cannot revoke the last superadmin — grant the role to another account first',
          409,
          'LAST_SUPERADMIN',
        );
      }
    }

    await this.kc().removeRoleFromUserById(userId, { id: rep.id, name: rep.name });
  }

  // --- Internals ----------------------------------------------------------

  private async mustGetRole(roleId: string): Promise<KeycloakRealmRole> {
    const rep = await this.kc().getRoleById(roleId);
    if (!rep) throw new AppError('Role not found', 404, 'NOT_FOUND');
    return rep;
  }

  private async compositeIdsOf(roleName: string): Promise<string[]> {
    const composites = await this.kc().getRoleComposites(roleName);
    // Only realm roles — client-role composites arrive with clientRole=true
    // and reference client scopes this console deliberately doesn't manage.
    return composites.filter((r) => !r.clientRole).map((r) => r.id);
  }

  private toAdminRole(rep: KeycloakRealmRole, compositeRoleIds: string[], memberCount: number): AdminRole {
    return {
      id: rep.id,
      name: rep.name,
      description: rep.description ?? '',
      composite: rep.composite ?? false,
      clientRole: rep.clientRole ?? false,
      builtIn: isBuiltInRoleName(rep.name),
      compositeRoleIds,
      memberCount,
    };
  }

  /** Every realm role, paged through Keycloak in 200-row chunks. */
  private async listAllRoleReps(): Promise<KeycloakRealmRole[]> {
    const out: KeycloakRealmRole[] = [];
    let first = 0;
    const page = 200;
    for (;;) {
      const rows = await this.kc().listRoles({ first, max: page });
      out.push(...rows.filter((r) => r.id && r.name));
      if (rows.length < page) return out;
      first += page;
    }
  }

  /**
   * Names of every realm role whose composite set includes `roleId`. Reads
   * are O(N) over the realm's roles — unavoidable: Keycloak offers no
   * reverse edge index.
   */
  private async rolesCompositing(roleId: string): Promise<string[]> {
    const all = await this.listAllRoleReps();
    const pairs = await Promise.all(
      all.map(async (rep) => ({
        name: rep.name,
        ids: await this.compositeIdsOf(rep.name),
      })),
    );
    return pairs.filter((p) => p.ids.includes(roleId)).map((p) => p.name);
  }

  /** Resolve id → representation, exploding unknown ids into a 400. */
  private async resolveCompositeIds(ids: string[]): Promise<KeycloakRealmRole[]> {
    const unique = [...new Set(ids)];
    const resolved = await Promise.all(unique.map((id) => this.kc().getRoleById(id)));
    const bad = unique.filter((_, i) => !resolved[i]);
    if (bad.length > 0) {
      throw new AppError(
        `Unknown role id(s) in compositeRoleIds: ${bad.join(', ')}`,
        400,
        'VALIDATION_ERROR',
      );
    }
    return (resolved as KeycloakRealmRole[]).filter((r) => r.clientRole !== true);
  }

  /**
   * Diff-apply a new composite set for `rep`. Additions/deletions are
   * computed against the CURRENT edges so concurrent edits settle on a
   * bounded, explainable state; a cycle check runs when creating NEW edges.
   */
  private async applyCompositeDiff(
    rep: KeycloakRealmRole,
    desiredIds: string[],
    opts: { skipCycleGuard: boolean },
  ): Promise<void> {
    if (desiredIds.includes(rep.id)) {
      throw new AppError('A role cannot composite itself', 400, 'ROLE_COMPOSITION_CYCLE');
    }

    const desired = await this.resolveCompositeIds(desiredIds);
    const currentIds = await this.compositeIdsOf(rep.name);

    const toAdd = desired.filter((d) => !currentIds.includes(d.id));
    const toRemoveIds = currentIds.filter((id) => !desiredIds.includes(id));

    if (toAdd.length > 0 && !opts.skipCycleGuard) {
      // Would adding rep -> candidate[y] create a back-edge to rep?
      // Equivalent: is rep reachable from candidate[y] in the CURRENT graph?
      const graph = await this.compositeGraph();
      for (const cand of toAdd) {
        if (this.reaches(cand.id, rep.id, graph)) {
          throw new AppError(
            `Composing "${cand.name}" would create a cycle through "${rep.name}"`,
            400,
            'ROLE_COMPOSITION_CYCLE',
          );
        }
      }
    }

    if (toAdd.length > 0) {
      await this.kc().addRoleComposites(rep.name, toAdd.map((c) => ({ id: c.id, name: c.name })));
    }
    if (toRemoveIds.length > 0) {
      const removed = await Promise.all(toRemoveIds.map((id) => this.kc().getRoleById(id)));
      const reps = removed.filter((r): r is KeycloakRealmRole => !!r);
      await this.kc().removeRoleComposites(rep.name, reps.map((r) => ({ id: r.id, name: r.name })));
    }
  }

  /** role-id → composite-role-ids adjacency for cycle analysis. */
  private async compositeGraph(): Promise<Map<string, string[]>> {
    const all = await this.listAllRoleReps();
    const entries = await Promise.all(
      all.map(async (rep) => [rep.id, await this.compositeIdsOf(rep.name)] as const),
    );
    return new Map(entries);
  }

  /** DFS: is `to` reachable from `from`? */
  private reaches(from: string, to: string, graph: Map<string, string[]>): boolean {
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === to) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const next of graph.get(node) ?? []) stack.push(next);
    }
    return false;
  }
}

let adminRolesService: AdminRolesService | null = null;

export function getAdminRolesService(): AdminRolesService {
  if (!adminRolesService) adminRolesService = new AdminRolesService();
  return adminRolesService;
}
