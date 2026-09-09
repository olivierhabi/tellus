import type { Knex } from 'knex';
import { AppError } from '../../utils/foundryAppError';

/**
 * Foundry parity — Compass enforces resource-name uniqueness within a
 * folder. The Create Dataset API documents this as:
 *
 *   `ResourceNameAlreadyExists` → 409 CONFLICT
 *   "The provided resource name is already in use by another resource
 *    in the same folder."  (parameters: parentFolderRid, displayName)
 *
 * In Foundry a folder holds datasets, sub-folders and pipelines alike,
 * so the check spans `foundry_datasets`, `folders` and `pipelines`
 * sibling rows ("root" = NULL folder within the same project).
 */

type Q = Knex | Knex.Transaction;

export interface NameCheckArgs {
  /** The resource name being created or renamed to. */
  name: string;
  /** Folder the resource will live in; `null` = project root. */
  folderId: string | null;
  /** Owning project (required to disambiguate root-level siblings). */
  projectId: string;
  /** When renaming/moving an existing dataset, exclude that row. */
  excludeDatasetId?: string;
}

export interface NameConflict {
  resourceType: 'dataset' | 'folder' | 'pipeline';
  resourceId: string;
  resourceName: string;
}

/** Returns the first conflicting sibling resource, or null. */
export async function findFolderNameConflict(
  knex: Q,
  args: NameCheckArgs,
): Promise<NameConflict | null> {
  const { name, folderId, projectId } = args;

  // 1. Sibling datasets in the same folder / project root.
  let datasetQuery = knex('foundry_datasets')
    .select('id', 'name')
    .where({ name });
  if (folderId) {
    datasetQuery = datasetQuery.where({ folder_id: folderId });
  } else {
    datasetQuery = datasetQuery.whereNull('folder_id').where({ project_id: projectId });
  }
  if (args.excludeDatasetId) {
    datasetQuery = datasetQuery.whereNot({ id: args.excludeDatasetId });
  }
  const dataset = await datasetQuery.first();
  if (dataset) {
    return { resourceType: 'dataset', resourceId: dataset.id, resourceName: dataset.name };
  }

  // 2. Sibling sub-folders (folders.parent_folder_id is the container).
  let folderQuery = knex('folders')
    .select('id', 'name')
    .where({ name, project_id: projectId });
  folderQuery = folderId
    ? folderQuery.where({ parent_folder_id: folderId })
    : folderQuery.whereNull('parent_folder_id');
  const folder = await folderQuery.first();
  if (folder) {
    return { resourceType: 'folder', resourceId: folder.id, resourceName: folder.name };
  }

  // 3. Sibling pipelines living in the same folder / root.
  let pipelineQuery = knex('pipelines')
    .select('id', 'name')
    .where({ name, project_id: projectId });
  pipelineQuery = folderId
    ? pipelineQuery.where({ folder_id: folderId })
    : pipelineQuery.whereNull('folder_id');
  const pipeline = await pipelineQuery.first();
  if (pipeline) {
    return { resourceType: 'pipeline', resourceId: pipeline.id, resourceName: pipeline.name };
  }

  return null;
}

/**
 * Hard-block with 409 RESOURCE_NAME_ALREADY_EXISTS when `name` is taken
 * in the target folder. Mirrors Foundry's error: message and parameters
 * name the folder and the conflicting resource.
 */
export async function assertFolderNameAvailable(
  knex: Q,
  args: NameCheckArgs,
): Promise<void> {
  const conflict = await findFolderNameConflict(knex, args);
  if (!conflict) return;

  const folderLabel = args.folderId
    ? ((await knex('folders').where({ id: args.folderId }).first('name'))?.name ?? args.folderId)
    : 'the project root';

  throw new AppError(
    `The name "${args.name}" is already in use by another ${conflict.resourceType} ` +
      `(${conflict.resourceId}) in ${folderLabel === 'the project root' ? folderLabel : `folder "${folderLabel}"`}.`,
    409,
    'RESOURCE_NAME_ALREADY_EXISTS',
    true,
    {
      parentFolderId: args.folderId,
      displayName: args.name,
      conflictingResourceId: conflict.resourceId,
      conflictingResourceType: conflict.resourceType,
    },
    'ResourceNameAlreadyExists',
  );
}
