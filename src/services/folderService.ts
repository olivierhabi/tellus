import { Knex } from 'knex';
import { AppError } from '../utils/foundryAppError';
import { ROOT_SPACE_RID } from '../lib/rid';
import { mirrorToTrash, type TrashMirrorRow } from './trashMirror';
import {
  type FolderSnapshot,
  MAX_TRASH_SUBTREE_SIZE,
  snapshotTotalRows,
} from '../schemas/trashSnapshot';

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

    // B1-C-24: folder insert + Compass `resources` row in one transaction.
    return this.knex.transaction(async (trx) => {
      const [folder] = await trx('folders')
        .insert({ name, parent_folder_id: parentFolderId || null, project_id: projectId })
        .returning('*');

      const folderRid = `ri.compass.main.compass-folder.${folder.id}`;
      const projectRid = `ri.compass.main.project.${projectId}`;
      const parentRid = parentFolderId
        ? `ri.compass.main.compass-folder.${parentFolderId}`
        : projectRid;

      await trx.raw(
        `
        INSERT INTO resources (rid, service, type, display_name,
                               parent_folder_rid, project_rid, space_rid,
                               created_by, created_at, updated_by, updated_at,
                               legacy_uuid)
        VALUES (?, 'compass', 'COMPASS_FOLDER', ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?)
        ON CONFLICT (legacy_uuid) DO NOTHING
        `,
        [
          folderRid,
          folder.name,
          parentRid,
          projectRid,
          ROOT_SPACE_RID,
          ownerId,
          folder.created_at,
          ownerId,
          folder.updated_at,
          folder.id,
        ],
      );

      // Return with has_children = false (newly created folder can't have children)
      return { ...folder, has_children: false, child_count: 0, dataset_count: 0 };
    });
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
  async getOrCreateUploadsFolder(projectId: string, ownerId: string): Promise<string> {
    const UPLOADS_FOLDER_NAME = 'Uploads';

    // Check if an "Uploads" folder already exists at root level
    const existing = await this.knex('folders')
      .where({ name: UPLOADS_FOLDER_NAME, project_id: projectId })
      .whereNull('parent_folder_id')
      .select('id')
      .first();

    if (existing) return existing.id;

    // B1-C-24: Uploads folder insert + Compass `resources` row in one txn.
    return this.knex.transaction(async (trx) => {
      const [folder] = await trx('folders')
        .insert({ name: UPLOADS_FOLDER_NAME, parent_folder_id: null, project_id: projectId })
        .returning(['id', 'created_at', 'updated_at']);

      const folderRid = `ri.compass.main.compass-folder.${folder.id}`;
      const projectRid = `ri.compass.main.project.${projectId}`;

      await trx.raw(
        `
        INSERT INTO resources (rid, service, type, display_name,
                               parent_folder_rid, project_rid, space_rid,
                               created_by, created_at, updated_by, updated_at,
                               legacy_uuid)
        VALUES (?, 'compass', 'COMPASS_FOLDER', ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?)
        ON CONFLICT (legacy_uuid) DO NOTHING
        `,
        [
          folderRid,
          UPLOADS_FOLDER_NAME,
          projectRid,
          projectRid,
          ROOT_SPACE_RID,
          ownerId,
          folder.created_at,
          ownerId,
          folder.updated_at,
          folder.id,
        ],
      );

      return folder.id;
    });
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

  /**
   * Trash a folder and its entire subtree (Foundry-faithful soft delete).
   *
   * Mirrors the dataset-trash pattern (`DatasetService.deleteDataset`):
   *
   *   1. Snapshot the subtree (folders + datasets) BEFORE the transaction.
   *   2. Inside the transaction:
   *        a) Upsert a `resources` row for every folder + every dataset in
   *           the subtree, with `trash_status = DIRECTLY_TRASHED` for the
   *           clicked folder and `ANCESTOR_TRASHED` for everything below.
   *           The clicked folder's row carries the full snapshot in
   *           `metadata.snapshot` so restore can rebuild the tree.
   *        b) Hard-delete from the source-of-truth tables (`folders` —
   *           `foundry_datasets` cascades via FK).
   *   3. S3 objects are DELIBERATELY retained. Physical GC is gated on
   *      the permanent-delete endpoint and only fires after the 30-day
   *      retention window. The previous implementation hard-deleted both
   *      the rows and the S3 objects synchronously, so a folder click
   *      was unrecoverable AND the row never appeared in the trash UI
   *      (its `resources` row stayed at `NOT_TRASHED`). That was a
   *      data-loss bug and is the reason this method was rewritten.
   */
  async deleteFolder(projectId: string, folderId: string, ownerId: string) {
    const project = await this.knex('projects').where({ id: projectId, owner_id: ownerId }).first();
    if (!project) throw new AppError('Project not found', 404, 'NOT_FOUND');
    const folder = await this.knex('folders').where({ id: folderId, project_id: projectId }).first();
    if (!folder) throw new AppError('Folder not found', 404, 'NOT_FOUND');

    const projectRid = `ri.compass.main.project.${projectId}`;

    // Snapshot the subtree (root included). Reads outside the txn are
    // safe because we hold no locks yet.
    const subtreeFolders = ((await this.knex.raw(
      `SELECT id, name, parent_folder_id, path::text AS path, depth,
              created_at, updated_at
       FROM folders
       WHERE path <@ (SELECT path FROM folders WHERE id = ? AND project_id = ?)
         AND project_id = ?`,
      [folderId, projectId, projectId],
    )) as { rows: Array<{
      id: string;
      name: string;
      parent_folder_id: string | null;
      path: string;
      depth: number;
      created_at: Date;
      updated_at: Date;
    }> }).rows;

    const subtreeDatasets = ((await this.knex.raw(
      `SELECT d.*
       FROM foundry_datasets d
       INNER JOIN folders f ON d.folder_id = f.id
       WHERE f.path <@ (SELECT path FROM folders WHERE id = ? AND project_id = ?)
         AND f.project_id = ?`,
      [folderId, projectId, projectId],
    )) as { rows: Array<Record<string, unknown>> }).rows;

    // Capture the *full* set of resources that hang off the trashed
    // subtree, so restore can rebuild every one of them. Each kind has
    // a different storage / linkage:
    //
    //   pipelines.folder_id            UUID  → reference by folder UUID
    //   code_repository.parent_folder_rid  rid string `ri.compass.main.folder.<uuid>`
    //   workshop_module.parent_folder_rid  rid string `ri.compass.main.folder.<uuid>`
    //
    // We compute the folder-rid set once and reuse for the latter two.
    const subtreeFolderUuidList = subtreeFolders.map((f) => f.id);
    const subtreeFolderRidList = subtreeFolderUuidList.map(
      (id) => `ri.compass.main.folder.${id}`,
    );

    const subtreePipelines =
      subtreeFolderUuidList.length === 0
        ? []
        : ((await this.knex.raw(
            `SELECT * FROM pipelines WHERE folder_id = ANY(?::uuid[])`,
            [subtreeFolderUuidList],
          )) as { rows: Array<Record<string, unknown>> }).rows;

    const subtreeCodeRepos =
      subtreeFolderRidList.length === 0
        ? []
        : ((await this.knex.raw(
            `SELECT * FROM code_repository
              WHERE parent_folder_rid = ANY(?::text[])
                AND state = 'ACTIVE'`,
            [subtreeFolderRidList],
          )) as { rows: Array<Record<string, unknown>> }).rows;

    const subtreeWorkshopModules =
      subtreeFolderRidList.length === 0
        ? []
        : ((await this.knex.raw(
            `SELECT * FROM workshop_module
              WHERE parent_folder_rid = ANY(?::text[])
                AND deleted_at IS NULL`,
            [subtreeFolderRidList],
          )) as { rows: Array<Record<string, unknown>> }).rows;

    const snapshotPayload: FolderSnapshot = {
      v: 1,
      kind: 'folder',
      capturedAt: new Date().toISOString(),
      rootFolderId: folderId,
      folders: subtreeFolders.map((f) => ({
        id: f.id,
        name: f.name,
        parent_folder_id: f.parent_folder_id,
        path: f.path,
        depth: f.depth,
        // Coerce timestamps to ISO so the JSONB representation is
        // round-trippable (pg returns Date instances; toJSON yields ISO).
        created_at: f.created_at instanceof Date ? f.created_at.toISOString() : f.created_at,
        updated_at: f.updated_at instanceof Date ? f.updated_at.toISOString() : f.updated_at,
      })),
      datasets: subtreeDatasets,
      pipelines: subtreePipelines,
      codeRepositories: subtreeCodeRepos,
      workshopModules: subtreeWorkshopModules,
    };

    // Enforce the snapshot-total cap before doing any destructive work.
    // `mirrorToTrash` already gates on the resources mirror row count
    // (folders + datasets), but pipelines / code-repos / workshop-modules
    // also count toward total bytes written into `metadata.snapshot`.
    // Without this guard a folder with 50k pipelines would slip past
    // the mirror cap (1k mirror rows) yet write a 100MB+ JSONB blob.
    const totalSnapshotRows = snapshotTotalRows(snapshotPayload);
    if (totalSnapshotRows > MAX_TRASH_SUBTREE_SIZE) {
      throw new AppError(
        `Folder is too large to trash in a single click (` +
          `${totalSnapshotRows} resources > ${MAX_TRASH_SUBTREE_SIZE} cap).` +
          ` Use the bulk-trash worker.`,
        409,
        'RESOURCE_TOO_LARGE',
      );
    }

    // Build the full set of trash-mirror rows up front so we can hand
    // them to the batched primitive in a single round-trip.
    const mirrorRows: TrashMirrorRow[] = [];
    for (const f of subtreeFolders) {
      const isRoot = f.id === folderId;
      mirrorRows.push({
        rid: `ri.compass.main.compass-folder.${f.id}`,
        type: 'COMPASS_FOLDER',
        service: 'compass',
        displayName: f.name,
        parentFolderRid: f.parent_folder_id
          ? `ri.compass.main.compass-folder.${f.parent_folder_id}`
          : projectRid,
        projectRid,
        spaceRid: ROOT_SPACE_RID,
        status: isRoot ? 'DIRECTLY_TRASHED' : 'ANCESTOR_TRASHED',
        legacyUuid: f.id,
        metadata: isRoot ? { snapshot: snapshotPayload } : undefined,
      });
    }
    for (const d of subtreeDatasets) {
      mirrorRows.push({
        rid: `ri.compass.main.foundry-dataset.${d.id as string}`,
        type: 'FOUNDRY_DATASET',
        service: 'foundry-datasets',
        displayName: d.name as string,
        parentFolderRid: `ri.compass.main.compass-folder.${d.folder_id as string}`,
        projectRid,
        spaceRid: ROOT_SPACE_RID,
        status: 'ANCESTOR_TRASHED',
        legacyUuid: d.id as string,
      });
    }

    const startMs = Date.now();
    await this.knex.transaction(async (trx) => {
      // 1) Single batched upsert for every mirror row in the subtree.
      //    `mirrorToTrash` enforces MAX_TRASH_SUBTREE_SIZE (throws 409
      //    above 10k rows) so a runaway click on a huge tree fails
      //    fast instead of locking the table for minutes.
      await mirrorToTrash({ trx, rows: mirrorRows, actorId: ownerId });

      // 2) Hard-delete the satellite resources whose linkage references
      //    a folder we're about to remove. They live in tables that do
      //    NOT cascade off `folders` (separate FK domains for code-repo
      //    and workshop-module which use rid strings; pipelines have
      //    `folder_id` SET NULL, not CASCADE). We delete them here so
      //    the live tables stay consistent with the trash. Restore
      //    rebuilds them from the snapshot.
      if (subtreeFolderUuidList.length > 0) {
        await trx.raw(
          `DELETE FROM pipelines WHERE folder_id = ANY(?::uuid[])`,
          [subtreeFolderUuidList],
        );
        await trx.raw(
          `DELETE FROM code_repository WHERE parent_folder_rid = ANY(?::text[])`,
          [subtreeFolderRidList],
        );
        await trx.raw(
          `DELETE FROM workshop_module WHERE parent_folder_rid = ANY(?::text[])`,
          [subtreeFolderRidList],
        );
      }

      // 3) Hard-delete from the source-of-truth tables. S3 objects are
      //    deliberately retained — the permanent-delete endpoint owns
      //    physical GC after the 30-day retention window.
      //    `foundry_datasets.folder_id` cascades via FK; only the
      //    `folders` subtree needs explicit deletion (parent_folder_id
      //    is ON DELETE SET NULL, not CASCADE).
      await trx.raw(
        `DELETE FROM folders WHERE path <@ (SELECT path FROM folders WHERE id = ? AND project_id = ?) AND project_id = ?`,
        [folderId, projectId, projectId],
      );
    });

    // Structured telemetry on the destructive path so SREs can trace
    // impact later. JSON-shaped so log pipelines can index it.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      event: 'folder.trash',
      project_id: projectId,
      folder_id: folderId,
      actor_id: ownerId,
      subtree_folders: subtreeFolders.length,
      subtree_datasets: subtreeDatasets.length,
      subtree_pipelines: subtreePipelines.length,
      subtree_code_repos: subtreeCodeRepos.length,
      subtree_workshop_modules: subtreeWorkshopModules.length,
      duration_ms: Date.now() - startMs,
    }));

    return {
      deleted: true,
      folderName: folder.name,
      subfolderCount: Math.max(0, subtreeFolders.length - 1),
      datasetCount: subtreeDatasets.length,
      pipelineCount: subtreePipelines.length,
      codeRepoCount: subtreeCodeRepos.length,
      workshopModuleCount: subtreeWorkshopModules.length,
    };
  }
}
