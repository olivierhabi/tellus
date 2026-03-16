import { Knex } from 'knex';
import { AppError } from '@/utils/AppError';

export class ProjectService {
  constructor(private knex: Knex) {}

  async createProject(name: string, ownerId: string) {
    // Check for duplicate name per owner
    const existing = await this.knex('projects')
      .where({ name, owner_id: ownerId })
      .first();
    if (existing) {
      throw new AppError('A project with this name already exists', 409, 'CONFLICT');
    }

    const [project] = await this.knex('projects')
      .insert({ name, owner_id: ownerId })
      .returning('*');
    return project;
  }

  async listProjects(ownerId: string) {
    return this.knex('projects')
      .where({ owner_id: ownerId })
      .orderBy('updated_at', 'desc');
  }

  async getProjectById(projectId: string, ownerId: string) {
    const rows = await this.knex.raw(
      `SELECT p.*,
        json_agg(
          json_build_object('id', f.id, 'name', f.name, 'createdAt', f.created_at)
          ORDER BY f.name ASC
        ) FILTER (WHERE f.id IS NOT NULL) AS root_folders
      FROM projects p
      LEFT JOIN folders f ON f.project_id = p.id AND f.parent_folder_id IS NULL
      WHERE p.id = ? AND p.owner_id = ?
      GROUP BY p.id`,
      [projectId, ownerId]
    );
    return rows.rows[0] || null;
  }

  async updateProject(
    projectId: string,
    ownerId: string,
    updates: { name?: string; description?: string }
  ) {
    // If name is provided, check for duplicates
    if (updates.name) {
      const existing = await this.knex('projects')
        .where({ name: updates.name, owner_id: ownerId })
        .whereNot({ id: projectId })
        .first();
      if (existing) {
        throw new AppError('A project with this name already exists', 409, 'CONFLICT');
      }
    }

    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;

    const [updated] = await this.knex('projects')
      .where({ id: projectId, owner_id: ownerId })
      .update(updateData)
      .returning('*');

    return updated || null;
  }

  async deleteProject(projectId: string, ownerId: string) {
    const deleted = await this.knex('projects')
      .where({ id: projectId, owner_id: ownerId })
      .delete();
    return deleted > 0;
  }
}
