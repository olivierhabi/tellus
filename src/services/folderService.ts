import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';

export class FolderService {
  constructor(private knex: Knex) {}

  async createFolder(projectId: string, name: string, parentFolderId: string | null, ownerId: string) {
    const project = await this.knex('projects').where({ id: projectId, owner_id: ownerId }).first();
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');

    if (parentFolderId) {
      const parent = await this.knex('folders').where({ id: parentFolderId, project_id: projectId }).first();
      if (!parent) throw new AppError('Parent folder not found', 404, 'NOT_FOUND');
    }

    const duplicate = await this.knex('folders')
      .where({ name, project_id: projectId })
      .where(function () {
        if (parentFolderId) { this.where({ parent_folder_id: parentFolderId }); }
        else { this.whereNull('parent_folder_id'); }
      })
      .first();
    if (duplicate) throw new AppError('A folder with this name already exists in this location', 409, 'CONFLICT');

    const [folder] = await this.knex('folders')
      .insert({ name, parent_folder_id: parentFolderId || null, project_id: projectId })
      .returning('*');

    // Return with has_children = false (newly created folder can't have children)
    return { ...folder, has_children: false, child_count: 0, dataset_count: 0 };
  }

  async listFolders(projectId: string, parentId: string | null) {
    const query = this.knex('folders')
      .select(
        'folders.*',
        this.knex.raw('(SELECT COUNT(*) FROM folders f2 WHERE f2.parent_folder_id = folders.id)::integer AS child_count'),
        this.knex.raw('(SELECT COUNT(*) FROM foundry_datasets d WHERE d.folder_id = folders.id)::integer AS dataset_count'),
        this.knex.raw('EXISTS(SELECT 1 FROM folders f2 WHERE f2.parent_folder_id = folders.id) AS has_children'),
      )
      .where({ project_id: projectId });
    if (parentId === null) { query.whereNull('parent_folder_id'); }
    else { query.where({ parent_folder_id: parentId }); }
    return query.orderBy('name', 'asc');
  }

  private static readonly ALLOWED_SORT_COLUMNS = new Set([
    'name', 'status', 'file_size_bytes', 'row_count', 'column_count',
    'original_filename', 'mime_type', 'created_at', 'updated_at',
  ]);

  async folderExists(projectId: string, folderId: string): Promise<boolean> {
    const row = await this.knex('folders').where({ id: folderId, project_id: projectId }).select('id').first();
    return !!row;
  }

  /**
   * Find or create an "Uploads" folder at the root level of a project.
   * Used by project-level uploads to ensure files always have a folder.
   */
  async getOrCreateUploadsFolder(projectId: string, _ownerId: string): Promise<string> {
    const UPLOADS_FOLDER_NAME = 'Uploads';

    // Check if an "Uploads" folder already exists at root level
    const existing = await this.knex('folders')
      .where({ name: UPLOADS_FOLDER_NAME, project_id: projectId })
      .whereNull('parent_folder_id')
      .select('id')
      .first();

    if (existing) return existing.id;

    // Create the "Uploads" folder at root level
    const [folder] = await this.knex('folders')
      .insert({ name: UPLOADS_FOLDER_NAME, parent_folder_id: null, project_id: projectId })
      .returning('id');

    return folder.id;
  }

  async getFolderById(projectId: string, folderId: string, sortBy = 'name', sortOrder: 'asc' | 'desc' = 'asc') {
    const folder = await this.knex('folders')
      .select(
        'folders.*',
        this.knex.raw('(SELECT COUNT(*) FROM folders f2 WHERE f2.parent_folder_id = folders.id)::integer AS child_count'),
        this.knex.raw('(SELECT COUNT(*) FROM foundry_datasets d WHERE d.folder_id = folders.id)::integer AS dataset_count'),
        this.knex.raw('EXISTS(SELECT 1 FROM folders f2 WHERE f2.parent_folder_id = folders.id) AS has_children'),
      )
      .where({ id: folderId, project_id: projectId })
      .first();
    if (!folder) return null;

    // Defense-in-depth: validate sortBy and sortOrder at the service layer
    if (!FolderService.ALLOWED_SORT_COLUMNS.has(sortBy)) {
      sortBy = 'name';
    }
    const safeSortOrder = sortOrder === 'desc' ? 'desc' : 'asc';

    const [childFolders, childDatasets, childPipelines] = await Promise.all([
      this.knex('folders')
        .select(
          'folders.id', 'folders.name', 'folders.parent_folder_id', 'folders.project_id',
          'folders.depth', 'folders.created_at', 'folders.updated_at',
          this.knex.raw('(SELECT COUNT(*) FROM folders f2 WHERE f2.parent_folder_id = folders.id)::integer AS child_folder_count'),
          this.knex.raw('(SELECT COUNT(*) FROM foundry_datasets d WHERE d.folder_id = folders.id)::integer AS dataset_count'),
          this.knex.raw('EXISTS(SELECT 1 FROM folders f2 WHERE f2.parent_folder_id = folders.id) AS has_children'),
        )
        .where({ parent_folder_id: folderId, project_id: projectId })
        .orderBy('name', 'asc'),
      this.knex('foundry_datasets')
        .select('id', 'name', 'status', 'file_size_bytes', 'row_count', 'column_count',
                'original_filename', 'mime_type', 'created_at', 'updated_at')
        .where({ folder_id: folderId })
        .orderByRaw(`?? ${safeSortOrder} NULLS LAST, id ASC`, [sortBy]),
      this.knex('pipelines')
        .select('id', 'name', 'description', 'pipeline_type', 'compute_type',
                'status', 'created_by', 'created_at', 'updated_at')
        .where({ folder_id: folderId, project_id: projectId })
        .orderBy('name', 'asc'),
    ]);

    return { ...folder, children: { folders: childFolders, datasets: childDatasets, pipelines: childPipelines } };
  }

  async getFolderTree(projectId: string, folderId: string) {
    const rows = await this.knex.raw(
      `SELECT id, name, parent_folder_id, path, depth, created_at FROM folders WHERE project_id = ? AND path <@ (SELECT path FROM folders WHERE id = ?) ORDER BY path ASC`,
      [projectId, folderId]
    );
    return rows.rows;
  }

  async getFolderBreadcrumb(projectId: string, folderId: string) {
    const project = await this.knex('projects').where({ id: projectId }).first();
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    const folder = await this.knex('folders').where({ id: folderId, project_id: projectId }).first();
    if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');
    const rows = await this.knex.raw(
      `SELECT id, name, depth FROM folders WHERE project_id = ? AND path @> (SELECT path FROM folders WHERE id = ?) ORDER BY depth ASC`,
      [projectId, folderId]
    );
    const breadcrumb = [
      { id: project.id, name: project.name, type: 'project' },
      ...rows.rows.map((a: { id: string; name: string }) => ({ id: a.id, name: a.name, type: 'folder' })),
    ];
    return breadcrumb;
  }

  async getProjectFolderTree(projectId: string) {
    const rows = await this.knex('folders')
      .select(
        'folders.id', 'folders.name', 'folders.parent_folder_id', 'folders.path', 'folders.depth', 'folders.created_at',
        this.knex.raw('(SELECT COUNT(*) FROM foundry_datasets d WHERE d.folder_id = folders.id)::integer AS dataset_count'),
      )
      .where({ project_id: projectId })
      .orderBy('depth', 'asc')
      .orderBy('name', 'asc');

    // Build nested tree
    const nodeMap = new Map<string, any>();
    const roots: any[] = [];

    for (const folder of rows) {
      nodeMap.set(folder.id, {
        id: folder.id,
        name: folder.name,
        parentFolderId: folder.parent_folder_id,
        depth: folder.depth,
        datasetCount: folder.dataset_count,
        children: [],
      });
    }

    for (const folder of rows) {
      const node = nodeMap.get(folder.id)!;
      if (folder.parent_folder_id === null) {
        roots.push(node);
      } else {
        const parent = nodeMap.get(folder.parent_folder_id);
        if (parent) parent.children.push(node);
        else roots.push(node); // orphan → root
      }
    }

    return roots;
  }

  async getFlatFolderList(projectId: string) {
    return this.knex('folders')
      .select('id', 'name', 'parent_folder_id', 'path', 'depth', 'created_at', 'updated_at')
      .where({ project_id: projectId })
      .orderByRaw('path ASC');
  }

  async updateFolder(projectId: string, folderId: string, updates: { name?: string; parentFolderId?: string | null }, ownerId: string) {
    const project = await this.knex('projects').where({ id: projectId, owner_id: ownerId }).first();
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    const folder = await this.knex('folders').where({ id: folderId, project_id: projectId }).first();
    if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');

    if (updates.parentFolderId === undefined) {
      if (updates.name) {
        const duplicate = await this.knex('folders')
          .where({ name: updates.name, project_id: projectId })
          .where(function () {
            if (folder.parent_folder_id) { this.where({ parent_folder_id: folder.parent_folder_id }); }
            else { this.whereNull('parent_folder_id'); }
          })
          .whereNot({ id: folderId })
          .first();
        if (duplicate) throw new AppError('A folder with this name already exists in this location', 409, 'CONFLICT');
      }
      const updateData: Record<string, unknown> = {};
      if (updates.name !== undefined) updateData.name = updates.name;
      if (Object.keys(updateData).length === 0) {
        return folder; // Nothing to update — return existing folder
      }
      const [updated] = await this.knex('folders').where({ id: folderId }).update(updateData).returning('*');
      return updated;
    }

    return this.moveFolder(projectId, folderId, updates.parentFolderId ?? null, updates.name);
  }

  private async moveFolder(projectId: string, folderId: string, newParentFolderId: string | null, newName?: string) {
    return this.knex.transaction(async (trx) => {
      const folder = await trx('folders').where({ id: folderId, project_id: projectId }).first();
      if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');
      const oldPath = folder.path;

      if (newParentFolderId) {
        const newParent = await trx('folders').where({ id: newParentFolderId, project_id: projectId }).first();
        if (!newParent) throw new AppError('Target parent folder not found', 404, 'NOT_FOUND');
        const isDescendant = await trx('folders').where({ id: newParentFolderId }).whereRaw('path <@ ?::ltree', [oldPath]).first();
        if (isDescendant) throw new AppError('Cannot move a folder into its own subtree (circular reference)', 400, 'VALIDATION_ERROR');
      }

      const nameToCheck = newName ?? folder.name;
      const duplicate = await trx('folders')
        .where({ name: nameToCheck, project_id: projectId })
        .where(function () {
          if (newParentFolderId) { this.where({ parent_folder_id: newParentFolderId }); }
          else { this.whereNull('parent_folder_id'); }
        })
        .whereNot({ id: folderId })
        .first();
      if (duplicate) throw new AppError('A folder with this name already exists in the target location', 409, 'CONFLICT');

      const updateData: Record<string, unknown> = { parent_folder_id: newParentFolderId, updated_at: trx.fn.now() };
      if (newName !== undefined) updateData.name = newName;
      await trx('folders').where({ id: folderId }).update(updateData);

      const updatedFolder = await trx('folders').where({ id: folderId }).first();
      const newPath = updatedFolder.path;

      await trx.raw(
        `UPDATE folders SET path = ?::ltree || subpath(path, nlevel(?::ltree)), depth = nlevel(?::ltree || subpath(path, nlevel(?::ltree))) - 1, updated_at = NOW() WHERE path <@ ?::ltree AND id != ? AND project_id = ?`,
        [newPath, oldPath, newPath, oldPath, oldPath, folderId, projectId]
      );

      return updatedFolder;
    });
  }

  async deleteFolder(projectId: string, folderId: string, ownerId: string) {
    const project = await this.knex('projects').where({ id: projectId, owner_id: ownerId }).first();
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    const folder = await this.knex('folders').where({ id: folderId, project_id: projectId }).first();
    if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');

    // Count descendant folders and datasets for feedback
    const [descendantStats] = await this.knex.raw(
      `SELECT 
        (SELECT COUNT(*)::integer FROM folders WHERE path <@ (SELECT path FROM folders WHERE id = ?) AND project_id = ? AND id != ?) AS subfolder_count,
        (SELECT COUNT(*)::integer FROM foundry_datasets d INNER JOIN folders f ON d.folder_id = f.id WHERE f.path <@ (SELECT path FROM folders WHERE id = ?) AND f.project_id = ?) AS dataset_count`,
      [folderId, projectId, folderId, folderId, projectId]
    ).then((r: any) => r.rows);

    const fileRows = await this.knex.raw(
      `SELECT d.file_path FROM foundry_datasets d INNER JOIN folders f ON d.folder_id = f.id WHERE f.path <@ (SELECT path FROM folders WHERE id = ?) AND f.project_id = ?`,
      [folderId, projectId]
    );

    // Delete files from S3 object storage
    const { deleteObjects } = await import('./storageService');
    const s3Keys = fileRows.rows.map((row: any) => row.file_path as string).filter(Boolean);
    if (s3Keys.length > 0) {
      try { await deleteObjects(s3Keys); }
      catch (err) { console.error(`Failed to delete S3 objects during folder delete:`, err); }
    }

    // Delete entire subtree using ltree path (parent_folder_id has ON DELETE SET NULL,
    // so we must explicitly delete all descendants, not just the root folder)
    await this.knex.raw(
      `DELETE FROM folders WHERE path <@ (SELECT path FROM folders WHERE id = ? AND project_id = ?) AND project_id = ?`,
      [folderId, projectId, projectId]
    );
    return {
      deleted: true,
      folderName: folder.name,
      subfolderCount: descendantStats?.subfolder_count ?? 0,
      datasetCount: descendantStats?.dataset_count ?? 0,
    };
  }
}
