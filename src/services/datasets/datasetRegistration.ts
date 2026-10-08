import type { Knex } from 'knex';
import { AppError } from '../../utils/foundryAppError';
import {
  DATASET_NAME_UNIQUE_INDEX,
  datasetNameConflict,
  asDatasetNameConflict,
  findFolderNameConflict,
} from './folderNameGuard';

/**
 * Atomic dataset registration — the single writer for foundry_datasets
 * rows for ALL producers (deploy executors, uploads, clone, restore,
 * synced registry, verify scripts). Incident 3ec397d5.
 *
 * Replaces the SELECT-then-INSERT pattern (assertFolderNameAvailable +
 * insert), which is a TOCTOU race across pooled connections: two
 * concurrent writers both pass the check before either commits and both
 * INSERT. Correctness here comes from the database, in two layers:
 *
 *   1. INSERT ... ON CONFLICT (project_id, folder_id, name) DO NOTHING —
 *      one atomic statement; exactly one writer wins. The arbiter column
 *      list infers the NULLS NOT DISTINCT unique index from migration 190
 *      (verified on PG16; ON CONFLICT ON CONSTRAINT cannot name a
 *      standalone unique index — only a table constraint — so the column
 *      list is the correct form). Without the index the statement fails
 *      with 42P10 and we throw a loud internal error naming the migration
 *      instead of a cryptic PG message.
 *   2. The unique index itself as backstop for every other path
 *      (renames, restores): a 23505 from it maps to DATASET_NAME_ALREADY_EXISTS.
 *
 * Conflict (loser) handling: the winner row is re-read and adopted ONLY
 * when lineage permits — bound to our node, or bound to nothing (orphan).
 * A winner bound to a DIFFERENT node is a genuine collision and raises
 * a 409 DATASET_NAME_ALREADY_EXISTS. Callers that must preserve "refuse on
 * any conflict" semantics (uploads, clone) pass `adoptIf: () => false`.
 *
 * Everything (dataset row, dataset_columns rewrite, node rebind,
 * deployment registration record) runs in ONE transaction.
 */

export interface RegisterDatasetColumn {
  column_name: string;
  column_type?: string | null;
  ordinal_position: number;
  nullable?: boolean;
  logical_type?: string | null;
  /** Passthrough for writers that carry per-column samples (clone). */
  sample_values?: unknown;
}

export interface RegisterDatasetArgs {
  projectId: string;
  /** Resolved output folder; null = project root. */
  folderId: string | null;
  name: string;
  /** Columns to set on insert AND on adopt-update. */
  patch: Record<string, unknown>;
  createdBy?: string | null;
  /** When provided, dataset_columns is replaced with these rows. */
  columns?: RegisterDatasetColumn[];
  /** Rebind a pipeline output node to the winning dataset row. */
  bindNode?: {
    pipelineId: string;
    nodeId: string;
    /**
     * Full new config object — or a builder receiving the winning
     * datasetId (deploy callers set outputDatasetId to the winner, which
     * is only known after the atomic INSERT).
     */
    config: Record<string, unknown> | ((datasetId: string) => Record<string, unknown>);
  };
  /** Exactly-once record per (deployment, node); first writer wins. */
  recordDeployment?: { deploymentId: string; nodeId: string };
  /**
   * Revalidate the caller's existing binding (ghost-safe: must return
   * undefined for missing rows). When it resolves to a LIVE row we take
   * the update-in-place path (common case, no behavior change).
   */
  resolveBoundId?: () => Promise<string | undefined>;
  /**
   * Lineage predicate for adopting the conflict winner. Defaults to the
   * lineage rule (our node or orphan). Pass `() => false` to preserve
   * refuse-on-conflict semantics.
   */
  adoptIf?: (winner: { id: string }) => Promise<boolean>;
  /** Log label for the actor (deploy worker id, script name, ...). */
  actor?: string;
}

export interface RegisterDatasetResult {
  datasetId: string;
  created: boolean;
  adopted: boolean;
}

type Db = Knex | Knex.Transaction;

async function defaultAdoptIf(
  trx: Knex.Transaction,
  winnerId: string,
  bindNode?: RegisterDatasetArgs['bindNode'],
): Promise<boolean> {
  const binders = (await trx('pipeline_nodes')
    .where({ dataset_id: winnerId })
    .select('id', 'pipeline_id')) as Array<{ id: string; pipeline_id: string }>;
  if (binders.length === 0) return true; // orphan: leftover of a failed run
  if (!bindNode) return false;
  return binders.every(
    (b) => b.id === bindNode.nodeId && b.pipeline_id === bindNode.pipelineId,
  );
}

async function writeSideEffects(
  trx: Knex.Transaction,
  datasetId: string,
  args: RegisterDatasetArgs,
): Promise<void> {
  if (args.columns) {
    await trx('dataset_columns').where({ dataset_id: datasetId }).del();
    if (args.columns.length > 0) {
      await trx('dataset_columns').insert(
        args.columns.map((c) => ({
          dataset_id: datasetId,
          column_name: c.column_name,
          column_type: c.column_type ?? 'string',
          ordinal_position: c.ordinal_position,
          nullable: c.nullable ?? true,
          logical_type: c.logical_type ?? null,
          ...(c.sample_values !== undefined
            ? {
                sample_values:
                  typeof c.sample_values === 'string'
                    ? c.sample_values
                    : JSON.stringify(c.sample_values ?? []),
              }
            : {}),
        })),
      );
    }
  }
  if (args.bindNode) {
    const config =
      typeof args.bindNode.config === 'function'
        ? args.bindNode.config(datasetId)
        : args.bindNode.config;
    await trx('pipeline_nodes')
      .where({ id: args.bindNode.nodeId, pipeline_id: args.bindNode.pipelineId })
      .update({
        dataset_id: datasetId,
        config: JSON.stringify(config),
      });
  }
  if (args.recordDeployment) {
    // Savepoint-guarded: a failed statement inside a PG transaction poisons
    // the whole transaction, so the best-effort record write runs inside a
    // savepoint it can roll back without dooming the registration. The two
    // known-benign failures (42P01 table missing, 23503 synthetic
    // deployment id from verify scripts) warn and continue; anything else
    // rethrows and aborts the registration, as it should.
    await trx.raw('SAVEPOINT deploy_output_record');
    try {
      await trx.raw(
        `INSERT INTO pipeline_deploy_output_registrations
           (deployment_id, node_id, dataset_id)
         VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          args.recordDeployment.deploymentId,
          args.recordDeployment.nodeId,
          datasetId,
        ],
      );
      await trx.raw('RELEASE SAVEPOINT deploy_output_record');
    } catch (e) {
      await trx.raw('ROLLBACK TO SAVEPOINT deploy_output_record');
      const code = (e as { code?: string })?.code;
      if (code === '42P01' || code === '23503') {
        console.warn(
          '[datasetRegistration] skipping exactly-once record ' +
            `(${args.recordDeployment.deploymentId}/${args.recordDeployment.nodeId}): ${code}`,
        );
      } else {
        throw e;
      }
    }
  }
}

/** Columns every foundry_datasets row must carry; patch wins on overlap. */
function baseRow(args: RegisterDatasetArgs): Record<string, unknown> {
  return {
    project_id: args.projectId,
    folder_id: args.folderId,
    name: args.name,
    created_by: args.createdBy ?? null,
    ...args.patch,
  };
}

/**
 * Update-in-place for a caller-validated live binding (common case).
 * Returns the bound id, or undefined when the binding is a ghost (row
 * gone) so the caller falls through to the atomic path.
 */
async function tryBoundUpdate(
  trx: Knex.Transaction,
  args: RegisterDatasetArgs,
): Promise<string | undefined> {
  if (!args.resolveBoundId) return undefined;
  const boundId = await args.resolveBoundId();
  if (!boundId) return undefined;
  const live = (await trx('foundry_datasets')
    .where({ id: boundId })
    .first('id', 'name')) as { id: string; name: string } | undefined;
  if (!live) return undefined;
  if (live.name !== args.name) {
    // Rename: keep the friendly pre-check message, but the unique
    // index is the real backstop (a concurrent rename to the same
    // name fails the UPDATE with 23505 -> conflict error below).
    const conflict = await findFolderNameConflict(trx, {
      name: args.name,
      folderId: args.folderId,
      projectId: args.projectId,
      excludeDatasetId: boundId,
    });
    if (conflict) {
      throw datasetNameConflict({
        ...args,
        conflictingDatasetId: conflict.resourceId,
      });
    }
  }
  try {
    await trx('foundry_datasets').where({ id: boundId }).update(args.patch);
  } catch (e) {
    const mapped = await asDatasetNameConflict(trx, e, args);
    if (mapped) throw mapped;
    throw e;
  }
  await writeSideEffects(trx, boundId, args);
  return boundId;
}

export async function registerDataset(
  db: Knex,
  args: RegisterDatasetArgs,
): Promise<RegisterDatasetResult> {
  return db.transaction(async (trx) => {
    // Fast path: caller holds a live binding (common case). Ghost ids
    // (row gone) fall through to the atomic path below.
    const boundId = await tryBoundUpdate(trx, args);
    if (boundId) return { datasetId: boundId, created: false, adopted: false };

    // Atomic path: exactly one concurrent writer wins the INSERT.
    const cols = Object.keys(baseRow(args));
    const row = baseRow(args);
    // pg raw bindings need scalars; plain objects (jsonb payloads built by
    // callers as objects) travel as JSON text, mirroring knex insert().
    const bindings = cols.map((c) => {
      const v: unknown = row[c];
      if (v !== null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
        return JSON.stringify(v);
      }
      return v as string | number | boolean | null;
    });
    let insertedId: string | undefined;
    try {
      const res = await trx.raw(
        `INSERT INTO foundry_datasets (${cols.join(', ')})
           VALUES (${cols.map(() => '?').join(', ')})
         ON CONFLICT (project_id, folder_id, name) DO NOTHING
         RETURNING id`,
        bindings,
      );
      insertedId = (res?.rows ?? res ?? [])[0]?.id as string | undefined;
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === '42P10') {
        // No unique/exclusion constraint matches the ON CONFLICT target:
        // migration 190 has not been applied to this database.
        throw new AppError(
          'Dataset registration requires migration 190_dataset_name_uniqueness ' +
            '(unique index uq_foundry_datasets_project_folder_name missing). ' +
            'Apply migrations, then retry the deploy.',
          500,
          'DATASET_NAME_INDEX_MISSING',
        );
      }
      const mapped = await asDatasetNameConflict(trx, e, args);
      if (mapped) throw mapped;
      throw e;
    }

    if (insertedId) {
      await writeSideEffects(trx, insertedId, args);
      return { datasetId: insertedId, created: true, adopted: false };
    }

    // Lost the race: a winner row exists. Re-read it (it is committed —
    // either ours from microseconds ago or a genuine sibling).
    const winnerQ = trx('foundry_datasets')
      .select('id')
      .where({ name: args.name, project_id: args.projectId });
    if (args.folderId) winnerQ.andWhere({ folder_id: args.folderId });
    else winnerQ.andWhereRaw('folder_id IS NULL');
    const winner = (await winnerQ.first()) as { id: string } | undefined;
    if (!winner) {
      throw new AppError(
        `Dataset name conflict on "${args.name}" with no surviving row; retry the operation.`,
        409,
        'DATASET_REGISTRATION_RACE',
      );
    }
    const adopt = args.adoptIf
      ? await args.adoptIf({ id: winner.id })
      : await defaultAdoptIf(trx, winner.id, args.bindNode);
    if (!adopt) {
      throw datasetNameConflict({ ...args, conflictingDatasetId: winner.id });
    }
    await trx('foundry_datasets').where({ id: winner.id }).update(args.patch);
    await writeSideEffects(trx, winner.id, args);
    console.log(
      `[datasetRegistration] ${args.actor ?? 'unknown actor'} adopted ` +
        `dataset ${winner.id} ("${args.name}") after name conflict`,
    );
    return { datasetId: winner.id, created: false, adopted: true };
  });
}
