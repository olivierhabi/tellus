import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';
import { deletePrefix } from './storageService';
import { ROOT_SPACE_RID, parseRid, InvalidRidFormatError } from '../lib/rid';
import { OntologyError } from '../utils/queryErrors';

export interface CreateProjectOptions {
  /**
   * Compass space RID. When omitted, defaults to ROOT_SPACE_RID.
   * Per B2-C-10/B2-C-11: validated against the `spaces` table; missing
   * rows reject with `SPACE_NOT_FOUND`.
   */
  spaceRid?: string;
}

export class ProjectService {
  constructor(private knex: Knex) {}

  async createProject(name: string, ownerId: string, opts: CreateProjectOptions = {}) {
    const existing = await this.knex('projects').where({ name, owner_id: ownerId }).first();
    if (existing) throw new AppError('A project with this name already exists', 409, 'CONFLICT');

    // B2-C-10..C-12: validate the space rid (defaulting to ROOT_SPACE_RID).
    let spaceRid: string = ROOT_SPACE_RID;
    if (opts.spaceRid !== undefined) {
      try {
        // B2-C-12 — RID grammar enforced.
        parseRid(opts.spaceRid);
      } catch (e) {
        if (e instanceof InvalidRidFormatError) {
          throw new OntologyError(
            `Invalid spaceRid: ${e.message}`,
            'INVALID_RID_FORMAT',
            undefined,
            { value: opts.spaceRid },
          );
        }
        throw e;
      }
      // B2-C-11 — verify spaces row exists.
      const found = await this.knex('spaces').where({ rid: opts.spaceRid }).select('rid').first();
      if (!found) {
        throw new OntologyError(
          `Space not found: ${opts.spaceRid}`,
          'SPACE_NOT_FOUND',
          undefined,
          { spaceRid: opts.spaceRid },
        );
      }
      spaceRid = opts.spaceRid;
    }

    // B1-C-24: project insert + Compass `resources` row + project_members must
    // be a single transaction. A failure in any step rolls all back; a
    // successful return guarantees the resources row exists with
    // legacy_uuid = project.id (matching the foundryMigrate backfill, so
    // re-running migrate is a no-op via ON CONFLICT (legacy_uuid)).
    return this.knex.transaction(async (trx) => {
      const [project] = await trx('projects')
        .insert({ name, owner_id: ownerId })
        .returning('*');

      const projectRid = `ri.compass.main.project.${project.id}`;
      await trx.raw(
        `
        INSERT INTO resources (rid, service, type, display_name,
                               parent_folder_rid, project_rid, space_rid,
                               created_by, created_at, updated_by, updated_at,
                               legacy_uuid)
        VALUES (?, 'compass', 'PROJECT', ?,
                NULL, ?, ?,
                ?, ?, ?, ?,
                ?)
        ON CONFLICT (legacy_uuid) DO NOTHING
        `,
        [
          projectRid,
          project.name,
          projectRid,
          spaceRid,
          ownerId,
          project.created_at,
          ownerId,
          project.updated_at,
          project.id,
        ],
      );

      await trx('project_members')
        .insert({ project_id: project.id, user_id: ownerId, role: 'owner' })
        .onConflict(['project_id', 'user_id'])
        .ignore();

      return project;
    });
  }

  /**
   * Org-shared read visibility (knex subquery, must be nested inside
   * `.where(projectId, ...)` / `.where({ owner_id })` OR-combinators by
   * callers that pass a `projects` table alias of `projects`).
   *
   * A project is visible to a user when at least one of its
   * organizations is also one of the user's organizations. Together with
   * the auto-enroll triggers (users + projects join the default org at
   * creation), this gives every org member read access to every project
   * in their org — without it `listProjects` was owner-only and plain
   * members saw an empty file browser for anything they didn't create.
   *
   * Intentionally READ-scoped: mutations (createFolder/update/delete,
   * project update/delete, uploads) remain owner/membership-gated.
   */
  private orgSharedProjects(userId: string) {
    return this.knex('project_organizations')
      .select(this.knex.raw('1'))
      .whereRaw(
        "project_organizations.project_rid = 'ri.compass.main.project.' || projects.id::text",
      )
      .whereExists(
        this.knex('user_organizations')
          .select(this.knex.raw('1'))
          .whereRaw('user_organizations.org_id = project_organizations.org_id')
          .where('user_organizations.user_id', userId),
      );
  }

  async listProjects(ownerId: string, fields?: string[]) {
    const query = this.knex('projects').where((qb) => {
      qb.where({ owner_id: ownerId }).orWhereExists(this.orgSharedProjects(ownerId));
    });
    if (fields && fields.length > 0) {
      query.select(fields.map(f => `projects.${f}`));
    }
    return query.orderBy('updated_at', 'desc');
  }

  /**
   * Check if a project exists (no ownership filter).
   * Used by endpoints where authorizeRoles already verified membership.
   */
  async projectExists(projectId: string): Promise<boolean> {
    const row = await this.knex('projects').where({ id: projectId }).select('id').first();
    return !!row;
  }

  async getProjectById(projectId: string, ownerId: string) {
    const rows = await this.knex.raw(
      `SELECT p.*, COALESCE(json_agg(json_build_object('id', f.id, 'name', f.name, 'createdAt', f.created_at) ORDER BY f.name ASC) FILTER (WHERE f.id IS NOT NULL), '[]'::json) AS root_folders
         FROM projects p
         LEFT JOIN folders f ON f.project_id = p.id AND f.parent_folder_id IS NULL
         WHERE p.id = ?
           AND (p.owner_id = ? OR EXISTS (
                 SELECT 1 FROM project_organizations po
                 JOIN user_organizations uo ON uo.org_id = po.org_id
                 WHERE po.project_rid = 'ri.compass.main.project.' || p.id::text
                   AND uo.user_id = ?))
         GROUP BY p.id`,
      [projectId, ownerId, ownerId]
    );
    return rows.rows[0] || null;
  }

  async updateProject(projectId: string, ownerId: string, updates: { name?: string; description?: string; defaultRole?: string }) {
    if (updates.name) {
      const existing = await this.knex('projects').where({ name: updates.name, owner_id: ownerId }).whereNot({ id: projectId }).first();
      if (existing) throw new AppError('A project with this name already exists.', 409, 'CONFLICT');
    }
    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name.trim();
    if (updates.description !== undefined) updateData.description = updates.description.trim();
    if (updates.defaultRole !== undefined) updateData.default_role = updates.defaultRole;
    updateData.updated_at = new Date();
    const [updated] = await this.knex('projects').where({ id: projectId, owner_id: ownerId }).update(updateData).returning('*');
    return updated || null;
  }

  /**
   * Owner-gated mutations resolve "missing" vs "exists but not yours"
   * differently so the controller can answer 404 vs 403 correctly: the
   * projects list exposes org-shared (read-scoped) rows, so a caller may
   * well address a project that exists but that they do not own — that
   * is a permission failure, not a missing resource.
   */
  async exists(projectId: string): Promise<boolean> {
    const row = await this.knex('projects').where({ id: projectId }).first();
    return Boolean(row);
  }

  async deleteProject(projectId: string, ownerId: string) {
    const deleted = await this.knex('projects').where({ id: projectId, owner_id: ownerId }).delete();
    if (!deleted) return false;

    // Delete all S3 objects under this project prefix
    try {
      await deletePrefix(`projects/${projectId}/`);
    } catch (err) {
      console.error(`[projectService] Failed to delete S3 objects for project ${projectId}:`, err);
    }

    return true;
  }

  async getProjectStats(projectId: string) {
    // Verify project exists first
    const project = await this.knex('projects').where({ id: projectId }).first();
    if (!project) return null;

    const result = await this.knex.raw(`
      SELECT
        (SELECT COUNT(*)::integer FROM folders WHERE project_id = ?) AS folder_count,
        (SELECT COUNT(*)::integer FROM foundry_datasets d JOIN folders f ON f.id = d.folder_id WHERE f.project_id = ?) AS dataset_count,
        (SELECT COALESCE(SUM(d.file_size_bytes), 0)::bigint FROM foundry_datasets d JOIN folders f ON f.id = d.folder_id WHERE f.project_id = ?) AS total_size_bytes,
        (SELECT COUNT(*)::integer FROM project_members WHERE project_id = ?) AS member_count
    `, [projectId, projectId, projectId, projectId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      folderCount: Number(row.folder_count) || 0,
      datasetCount: Number(row.dataset_count) || 0,
      totalSizeBytes: Number(row.total_size_bytes) || 0,
      memberCount: Number(row.member_count) || 0,
    };
  }
}
