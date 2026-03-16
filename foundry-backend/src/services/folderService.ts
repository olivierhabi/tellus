import { Knex } from 'knex';
import * as fs from 'fs';
import { AppError } from '@/utils/AppError';

export class FolderService {
  constructor(private knex: Knex) {}

  async createFolder(projectId: string, name: string, parentFolderId: string | null, ownerId: string) {
    // Step 1: Verify project exists and belongs to user
    const project = await this.knex('projects')
      .where({ id: projectId, owner_id: ownerId })
      .first();
    if (!project) {
      throw new AppError('Project not found', 404, 'NOT_FOUND');
    }

    // Step 2: If parentFolderId provided, verify it exists and belongs to same project
    if (parentFolderId) {
      const parent = await this.knex('folders')
        .where({ id: parentFolderId })
        .first();
      if (!parent) {
        throw new AppError('Parent folder not found', 404, 'NOT_FOUND');
      }
      if (parent.project_id !== projectId) {
        throw new AppError('Parent folder belongs to a different project', 400, 'VALIDATION_ERROR');
      }
    }

    // Step 3: Check for duplicate name under same parent
    const duplicate = await this.knex('folders')
      .where({ name, project_id: projectId })
      .where(function () {
        if (parentFolderId) {
          this.where({ parent_folder_id: parentFolderId });
        } else {
          this.whereNull('parent_folder_id');
        }
      })
      .first();
    if (duplicate) {
      throw new AppError('A folder with this name already exists in this location', 409, 'CONFLICT');
    }

    // Step 4: Insert folder (trigger computes path and depth)
    const [folder] = await this.knex('folders')
      .insert({
        name,
        parent_folder_id: parentFolderId || null,
        project_id: projectId,
      })
      .returning('*');
    return folder;
  }

  async listFolders(projectId: string, parentId: string | null) {
    const query = this.knex('folders')
      .select(
        'folders.*',
        this.knex.raw(
          '(SELECT COUNT(*) FROM folders f2 WHERE f2.parent_folder_id = folders.id)::integer AS child_count'
        )
      )
      .where({ project_id: projectId });

    if (parentId === null) {
      query.whereNull('parent_folder_id');
    } else {
      query.where({ parent_folder_id: parentId });
    }

    return query.orderBy('name', 'asc');
  }

  async getFolderById(projectId: string, folderId: string) {
    const folder = await this.knex('folders')
      .where({ id: folderId, project_id: projectId })
      .first();
    if (!folder) return null;

    // Get children in parallel
    const [childFolders, childDatasets] = await Promise.all([
      this.knex('folders')
        .where({ parent_folder_id: folderId, project_id: projectId })
        .orderBy('name', 'asc'),
      this.knex('datasets')
        .where({ folder_id: folderId })
        .orderBy('name', 'asc'),
    ]);

    return {
      ...folder,
      children: {
        folders: childFolders,
        datasets: childDatasets,
      },
    };
  }

  async getFolderTree(projectId: string, folderId: string) {
    const rows = await this.knex.raw(
      `SELECT id, name, parent_folder_id, path, depth, created_at
       FROM folders
       WHERE project_id = ? AND path <@ (SELECT path FROM folders WHERE id = ?)
       ORDER BY path ASC`,
      [projectId, folderId]
    );
    return rows.rows;
  }

  async getFolderBreadcrumb(projectId: string, folderId: string) {
    // Get project info
    const project = await this.knex('projects').where({ id: projectId }).first();
    if (!project) {
      throw new AppError('Project not found', 404, 'NOT_FOUND');
    }

    const folder = await this.knex('folders')
      .where({ id: folderId, project_id: projectId })
      .first();
    if (!folder) {
      throw new AppError('Folder not found', 404, 'NOT_FOUND');
    }

    // Get ancestors using LTREE @> operator
    const rows = await this.knex.raw(
      `SELECT id, name, depth
       FROM folders
       WHERE project_id = ? AND path @> (SELECT path FROM folders WHERE id = ?)
       ORDER BY depth ASC`,
      [projectId, folderId]
    );

    const breadcrumb = [
      { id: project.id, name: project.name, type: 'project' },
      ...rows.rows.map((a: { id: string; name: string }) => ({
        id: a.id,
        name: a.name,
        type: 'folder',
      })),
    ];

    return breadcrumb;
  }

  async updateFolder(
    projectId: string,
    folderId: string,
    updates: { name?: string; parentFolderId?: string | null },
    ownerId: string
  ) {
    // Verify project ownership
    const project = await this.knex('projects')
      .where({ id: projectId, owner_id: ownerId })
      .first();
    if (!project) {
      throw new AppError('Project not found', 404, 'NOT_FOUND');
    }

    const folder = await this.knex('folders')
      .where({ id: folderId, project_id: projectId })
      .first();
    if (!folder) {
      throw new AppError('Folder not found', 404, 'NOT_FOUND');
    }

    // If only name update (no move), simple update
    if (updates.parentFolderId === undefined) {
      if (updates.name) {
        // Check duplicate
        const duplicate = await this.knex('folders')
          .where({ name: updates.name, project_id: projectId })
          .where(function () {
            if (folder.parent_folder_id) {
              this.where({ parent_folder_id: folder.parent_folder_id });
            } else {
              this.whereNull('parent_folder_id');
            }
          })
          .whereNot({ id: folderId })
          .first();
        if (duplicate) {
          throw new AppError('A folder with this name already exists in this location', 409, 'CONFLICT');
        }
      }
      const updateData: Record<string, unknown> = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      const [updated] = await this.knex('folders')
        .where({ id: folderId })
        .update(updateData)
        .returning('*');
      return updated;
    }

    // Move operation — use transaction
    return this.moveFolder(projectId, folderId, updates.parentFolderId ?? null, updates.name);
  }

  private async moveFolder(
    projectId: string,
    folderId: string,
    newParentFolderId: string | null,
    newName?: string
  ) {
    return this.knex.transaction(async (trx) => {
      const folder = await trx('folders')
        .where({ id: folderId, project_id: projectId })
        .first();
      if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');
      const oldPath = folder.path;

      if (newParentFolderId) {
        const newParent = await trx('folders')
          .where({ id: newParentFolderId, project_id: projectId })
          .first();
        if (!newParent) {
          throw new AppError('Target parent folder not found', 404, 'NOT_FOUND');
        }

        // Circular reference check
        const isDescendant = await trx('folders')
          .where({ id: newParentFolderId })
          .whereRaw('path <@ ?::ltree', [oldPath])
          .first();
        if (isDescendant) {
          throw new AppError('Cannot move a folder into its own subtree (circular reference)', 400, 'VALIDATION_ERROR');
        }
      }

      // Update the folder's parent_folder_id and optionally name
      const updateData: Record<string, unknown> = {
        parent_folder_id: newParentFolderId,
        updated_at: trx.fn.now(),
      };
      if (newName !== undefined) updateData.name = newName;
      await trx('folders').where({ id: folderId }).update(updateData);

      // Refresh the moved folder to get its new path
      const updatedFolder = await trx('folders').where({ id: folderId }).first();
      const newPath = updatedFolder.path;

      // Update ALL descendants' paths
      await trx.raw(
        `UPDATE folders
         SET path = ?::ltree || subpath(path, nlevel(?::ltree)),
             depth = nlevel(?::ltree || subpath(path, nlevel(?::ltree))) - 1,
             updated_at = NOW()
         WHERE path <@ ?::ltree AND id != ? AND project_id = ?`,
        [newPath, oldPath, newPath, oldPath, oldPath, folderId, projectId]
      );

      return updatedFolder;
    });
  }

  async deleteFolder(projectId: string, folderId: string, ownerId: string) {
    // Verify project ownership
    const project = await this.knex('projects')
      .where({ id: projectId, owner_id: ownerId })
      .first();
    if (!project) {
      throw new AppError('Project not found', 404, 'NOT_FOUND');
    }

    const folder = await this.knex('folders')
      .where({ id: folderId, project_id: projectId })
      .first();
    if (!folder) {
      throw new AppError('Folder not found', 404, 'NOT_FOUND');
    }

    // Find all files in subtree to delete from disk
    const fileRows = await this.knex.raw(
      `SELECT d.file_path FROM datasets d
       INNER JOIN folders f ON d.folder_id = f.id
       WHERE f.path <@ (SELECT path FROM folders WHERE id = ?)
       AND f.project_id = ?`,
      [folderId, projectId]
    );

    // Delete physical files (best-effort)
    for (const row of fileRows.rows) {
      try {
        await fs.promises.unlink(row.file_path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`Failed to delete file ${row.file_path}:`, err);
        }
      }
    }

    // Delete folder (CASCADE handles children)
    await this.knex('folders')
      .where({ id: folderId, project_id: projectId })
      .delete();

    return true;
  }
}
