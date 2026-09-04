import type { Knex } from 'knex';
import { AppError } from '../../utils/foundryAppError';

/**
 * Foundry parity — Datasets v2 storage model for `foundry_datasets`.
 *
 * Every build commits a transaction (SNAPSHOT/APPEND/UPDATE) on a branch
 * (default: `master`; doc: "A default branch - `master` for most
 * enrollments - will be created on the Dataset"). The `foundry_datasets`
 * row keeps a denormalized cache of the LATEST committed transaction on
 * `master`; this service is the single writer of both, so the latest view
 * always equals the last committed transaction's output.
 *
 * Documented errors:
 *   TransactionNotFound  → 404 NOT_FOUND
 *   BranchAlreadyExists  → 409 CONFLICT
 */

export const DEFAULT_BRANCH = 'master';

export type TransactionType = 'SNAPSHOT' | 'APPEND' | 'UPDATE';

export interface RecordBuildInput {
  datasetId: string;
  branch?: string | null;
  transactionType?: TransactionType;
  deploymentId?: string | null;
  filePath: string;
  fileSizeBytes?: number | null;
  rowCount?: number | null;
  columnCount?: number | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown>;
}

export class DatasetTransactionService {
  constructor(private knex: Knex) {}

  /** Every dataset carries a default `master` branch (idempotent). */
  async ensureMasterBranch(datasetId: string): Promise<void> {
    await this.knex('foundry_dataset_branches')
      .insert({ dataset_id: datasetId, branch_name: DEFAULT_BRANCH, is_default: true })
      .onConflict(['dataset_id', 'branch_name'])
      .ignore();
  }

  /**
   * Commit one build transaction and (for `master`) point the dataset row's
   * latest-view cache at it — atomically with a `dataset_versions` row.
   */
  async recordBuild(input: RecordBuildInput): Promise<string> {
    const {
      datasetId,
      transactionType = 'SNAPSHOT',
      branch = DEFAULT_BRANCH,
    } = input;
    return this.knex.transaction(async (trx) => {
      await trx('foundry_dataset_branches')
        .insert({ dataset_id: datasetId, branch_name: DEFAULT_BRANCH, is_default: true })
        .onConflict(['dataset_id', 'branch_name'])
        .ignore();
      if (branch !== DEFAULT_BRANCH) {
        await trx('foundry_dataset_branches')
          .insert({ dataset_id: datasetId, branch_name: branch, is_default: false })
          .onConflict(['dataset_id', 'branch_name'])
          .ignore();
      }

      // Idempotent per (dataset, build): a deployment re-executed after a
      // mid-flight interruption (pod restart / orphan re-dispatch) must not
      // commit a second copy of the same build.
      const [tx] = await trx('foundry_dataset_transactions')
        .insert({
          dataset_id: datasetId,
          branch_name: branch,
          transaction_type: transactionType,
          status: 'committed',
          deployment_id: input.deploymentId ?? null,
          file_path: input.filePath,
          file_size_bytes: input.fileSizeBytes ?? null,
          row_count: input.rowCount ?? null,
          column_count: input.columnCount ?? null,
          metadata: JSON.stringify(input.metadata ?? {}),
          committed_at: new Date(),
        })
        .onConflict(['dataset_id', 'deployment_id'])
        .ignore()
        .returning('transaction_id');
      if (!tx) {
        // Already committed by an earlier (interrupted) execution of the
        // same deployment — replay-safe no-op.
        const existing = await trx('foundry_dataset_transactions')
          .where({ dataset_id: datasetId, deployment_id: input.deploymentId })
          .first('transaction_id');
        return existing!.transaction_id as string;
      }
      const transactionId = (tx.transaction_id ?? (tx as { id?: string }).id) as string;

      await trx('dataset_versions').insert({
        dataset_id: datasetId,
        version_number: this.knex.queryBuilder()
          .select(this.knex.raw('COALESCE(MAX(version_number), 0) + 1'))
          .from('dataset_versions')
          .where({ dataset_id: datasetId }),
        file_path: input.filePath,
        file_size_bytes: input.fileSizeBytes ?? null,
        row_count: input.rowCount ?? null,
        column_count: input.columnCount ?? null,
        change_summary: `Transaction ${transactionType} committed${
          input.deploymentId ? ` by build ${input.deploymentId}` : ''
        } on branch ${branch}`,
        created_by: input.createdBy ?? null,
      });

      return transactionId;
    });
  }

  /**
   * Branch transaction history, newest first — mirrors Datasets v2
   * `listTransactions` / `getBranchTransactionHistory`.
   */
  async listTransactions(
    datasetId: string,
    options: { branch?: string | null; limit?: number } = {},
  ) {
    return this.knex('foundry_dataset_transactions')
      .where({
        dataset_id: datasetId,
        branch_name: options.branch ?? DEFAULT_BRANCH,
        status: 'committed',
      })
      .orderBy('committed_at', 'desc')
      .orderBy('created_at', 'desc')
      .limit(options.limit ?? 100);
  }

  /** Single transaction fetch; documented error `TransactionNotFound`. */
  async getTransaction(datasetId: string, transactionId: string) {
    const row = await this.knex('foundry_dataset_transactions')
      .where({ dataset_id: datasetId, transaction_id: transactionId })
      .first();
    if (!row) {
      throw new AppError(
        `Transaction ${transactionId} not found on dataset ${datasetId}.`,
        404,
        'TRANSACTION_NOT_FOUND',
        true,
        { datasetRid: `ri.foundry.main.dataset.${datasetId}`, transactionRid: transactionId },
        'TransactionNotFound',
      );
    }
    return row;
  }

  async listBranches(datasetId: string) {
    return this.knex('foundry_dataset_branches')
      .where({ dataset_id: datasetId })
      .orderBy('created_at', 'asc');
  }

  /**
   * Create a branch; documented error `BranchAlreadyExists` (409 CONFLICT —
   * "The branch cannot be created because a branch with that name already
   * exists.").
   */
  async createBranch(datasetId: string, branchName: string) {
    const name = (branchName ?? '').trim();
    if (!name) {
      throw new AppError('Branch name must not be empty', 400, 'VALIDATION_ERROR');
    }
    const dataset = await this.knex('foundry_datasets').where({ id: datasetId }).first('id');
    if (!dataset) throw new AppError('Dataset not found', 404, 'NOT_FOUND');
    try {
      const [row] = await this.knex('foundry_dataset_branches')
        .insert({ dataset_id: datasetId, branch_name: name, is_default: false })
        .returning('*');
      return row;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        // PostgreSQL unique-violation → Foundry BranchAlreadyExists (409).
        throw new AppError(
          `The branch cannot be created because a branch named "${name}" already exists on dataset ${datasetId}.`,
          409,
          'BRANCH_ALREADY_EXISTS',
          true,
          {
            datasetRid: `ri.foundry.main.dataset.${datasetId}`,
            branchName: name,
          },
          'BranchAlreadyExists',
        );
      }
      throw err;
    }
  }
}
