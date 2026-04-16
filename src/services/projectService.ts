import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';
import { deletePrefix } from './storageService';

export class ProjectService {
  constructor(private knex: Knex) {}

  async createProject(name: string, ownerId: string) {
    const existing = await this.knex('projects').where({ name, owner_id: ownerId }).first();
    if (existing) throw new AppError('A project with this name already exists', 409, 'CONFLICT');

    const [project] = await this.knex('projects').insert({ name, owner_id: ownerId }).returning('*');

    // Auto-add the creator as an owner member so authorizeRoles works
    await this.knex('project_members')
      .insert({ project_id: project.id, user_id: ownerId, role: 'owner' })
      .onConflict(['project_id', 'user_id'])
      .ignore();

    return project;
  }

  async listProjects(ownerId: string, fields?: string[]) {
    const query = this.knex('projects').where({ owner_id: ownerId });
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
      `SELECT p.*, COALESCE(json_agg(json_build_object('id', f.id, 'name', f.name, 'createdAt', f.created_at) ORDER BY f.name ASC) FILTER (WHERE f.id IS NOT NULL), '[]'::json) AS root_folders FROM projects p LEFT JOIN folders f ON f.project_id = p.id AND f.parent_folder_id IS NULL WHERE p.id = ? AND p.owner_id = ? GROUP BY p.id`,
      [projectId, ownerId]
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
