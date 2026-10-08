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

/**
 * Name of the backstop unique index created by migration
 * 190_dataset_name_uniqueness.sql: one live dataset name per
 * (project, folder). Root-level rows (folder_id NULL) participate via
 * NULLS NOT DISTINCT.
 */
export const DATASET_NAME_UNIQUE_INDEX =
  'uq_foundry_datasets_project_folder_name';

/**
 * Typed domain error for a 23505 raised by DATASET_NAME_UNIQUE_INDEX.
 * Thrown by the atomic registration path (which has no pre-check to
 * throw from); carries the same 409 code surface as the guard so callers
 * and the HTTP layer treat both identically.
 *
 * NOTE: intentionally a factory returning the BASE AppError, not a
 * subclass. foundryAppError sets `name = constructor.name`, and the
 * error middleware (2b) duck-type-matches `name === 'AppError'` — a
 * subclass would fall through to a generic 500. Discriminate with
 * isDatasetNameConflict() (code check), never instanceof.
 */
export const DATASET_NAME_ALREADY_EXISTS = 'DATASET_NAME_ALREADY_EXISTS';

export function datasetNameConflict(args: {
  name: string;
  projectId: string;
  folderId: string | null;
  conflictingDatasetId?: string;
}): AppError {
  return new AppError(
    `The name "${args.name}" is already in use by another dataset ` +
      `(${args.conflictingDatasetId ?? 'unknown'}) in ` +
      `${args.folderId ? `folder "${args.folderId}"` : 'the project root'}.`,
    409,
    DATASET_NAME_ALREADY_EXISTS,
    true,
    {
      parentFolderId: args.folderId,
      displayName: args.name,
      conflictingResourceId: args.conflictingDatasetId,
      conflictingResourceType: 'dataset',
    },
    'ResourceNameAlreadyExists',
  );
}

/** Discriminate DATASET_NAME_ALREADY_EXISTS failures (code, not class). */
export function isDatasetNameConflict(err: unknown): boolean {
  return (err as { code?: unknown })?.code === DATASET_NAME_ALREADY_EXISTS;
}

/**
 * Pure predicate: is this a unique violation from our dataset-name index?
 * Usable from raw-pool call sites (routes, restore paths) that cannot pass
 * a knex handle to asDatasetNameConflict.
 */
export function isDatasetNameUniqueViolation(err: unknown): boolean {
  if ((err as { code?: unknown })?.code !== '23505') return false;
  const constraint = (err as { constraint?: unknown })?.constraint;
  return (
    typeof constraint !== 'string' ||
    constraint.length === 0 ||
    constraint === DATASET_NAME_UNIQUE_INDEX
  );
}
export async function asDatasetNameConflict(
  db: Q,
  err: unknown,
  args: { name: string; projectId: string; folderId: string | null },
): Promise<AppError | null> {
  if (!isDatasetNameUniqueViolation(err)) return null;
  let conflictingDatasetId: string | undefined;
  try {
    const q = db('foundry_datasets').select('id').where({
      name: args.name,
      project_id: args.projectId,
    });
    if (args.folderId) q.andWhere({ folder_id: args.folderId });
    else q.andWhereRaw('folder_id IS NULL');
    conflictingDatasetId = (await q.first('id'))?.id;
  } catch {
    /* best-effort only; the conflict itself is the fact that matters */
  }
  return datasetNameConflict({ ...args, conflictingDatasetId });
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
