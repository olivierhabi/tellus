import foundryDb from '../config/foundryDb';
import { csvParsingService } from '../services/csvParsingService';
import { emitDatasetEvent } from '../utils/emitEvent';

/**
 * Run the parse-dataset pipeline for a single dataset, **synchronously
 * inside a single transaction**, and return when the dataset row is in
 * its terminal state (`ready` or `error`).
 *
 * Exposed for two callers:
 *   1. `scheduleParseJob` — the legacy fire-and-forget entry point used
 *      by the upload pipeline (kept for backwards compatibility).
 *   2. Admin re-parse — when an operator needs to recover a dataset that
 *      was ingested with a corrupted schema (see runbook
 *      `runbooks/csv-header-sanitization.md` and the
 *      `POST /admin/datasets/:id/reparse` route).
 *
 * Idempotency: the previous implementation inserted into
 * `dataset_columns` without first clearing existing rows, so a second
 * run would either violate the `(dataset_id, ordinal_position)` unique
 * constraint (if present) or, worse, leave stale + new rows side-by-side
 * and corrupt downstream column lookups. We now perform the row
 * replacement inside a single transaction so the dataset is never
 * observable mid-rewrite.
 *
 * Failures roll the transaction back and mark the dataset `error`. The
 * caller's promise rejects so it can react (admin route returns 500,
 * scheduler swallows for fire-and-forget semantics).
 */
export async function runParseJob(datasetId: string): Promise<void> {
  const dataset = await foundryDb('foundry_datasets')
    .where({ id: datasetId })
    .first();
  if (!dataset) {
    throw new Error(`[parseDatasetJob] Dataset ${datasetId} not found`);
  }

  // Resolve project ID — folder-based or project-level upload. Used for
  // event emission; the parse itself does not need it.
  let projectId: string | null = null;
  if (dataset.folder_id) {
    const folder = await foundryDb('folders')
      .where({ id: dataset.folder_id })
      .first();
    if (!folder) {
      throw new Error(
        `[parseDatasetJob] Folder ${dataset.folder_id} not found for dataset ${datasetId}`,
      );
    }
    projectId = folder.project_id;
  } else if (dataset.project_id) {
    projectId = dataset.project_id;
  }

  await foundryDb('foundry_datasets')
    .where({ id: datasetId })
    .update({ status: 'processing' });
  if (projectId) {
    emitDatasetEvent('dataset:processing', projectId, {
      datasetId,
      status: 'processing',
    });
  }

  try {
    // file_path stores the S3 object key — csvParsingService reads from
    // S3 and applies sanitizeCsvHeader so duplicate/blank header cells
    // no longer collapse into a single key.
    const result = await csvParsingService.parseFile(dataset.file_path);

    await foundryDb.transaction(async (trx) => {
      await trx('foundry_datasets').where({ id: datasetId }).update({
        status: 'ready',
        row_count: result.rowCount,
        column_count: result.columns.length,
        schema_info: JSON.stringify({
          columns: result.columns.map((col) => ({
            name: col.name,
            type: col.inferredType,
            nullable: col.nullable,
          })),
          previewRows: result.previewRows,
        }),
      });

      // Wipe-and-rewrite is safe inside the txn — any concurrent reader
      // sees either the old set or the new set, never a partial mix.
      // ON DELETE CASCADE on `dataset_columns.dataset_id` is *not*
      // sufficient because we want to retain the row for the dataset
      // itself and only swap its column listing.
      await trx('dataset_columns').where({ dataset_id: datasetId }).delete();

      if (result.columns.length > 0) {
        // Bulk insert. Per-row inserts on a 100-column file cost 100
        // network round-trips — we've seen this spike upload latency on
        // wide telemetry exports.
        await trx('dataset_columns').insert(
          result.columns.map((col, i) => ({
            dataset_id: datasetId,
            column_name: col.name,
            column_type: col.inferredType,
            ordinal_position: i + 1,
            nullable: col.nullable,
            sample_values: JSON.stringify(col.sampleValues),
          })),
        );
      }
    });

    if (projectId) {
      emitDatasetEvent('dataset:ready', projectId, {
        datasetId,
        status: 'ready',
        rowCount: result.rowCount,
        columnCount: result.columns.length,
      });
    }
    console.log(
      `[parseDatasetJob] Dataset ${datasetId} parsed successfully: ` +
        `${result.rowCount} rows, ${result.columns.length} columns`,
    );
  } catch (error) {
    console.error(
      `[parseDatasetJob] Error parsing dataset ${datasetId}:`,
      error,
    );
    try {
      await foundryDb('foundry_datasets')
        .where({ id: datasetId })
        .update({
          status: 'error',
          schema_info: JSON.stringify({
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          }),
        });
      if (projectId) {
        emitDatasetEvent('dataset:error', projectId, {
          datasetId,
          status: 'error',
          error: (error as Error).message,
        });
      }
    } catch (updateError) {
      console.error(
        `[parseDatasetJob] Failed to update error status for dataset ${datasetId}:`,
        updateError,
      );
    }
    throw error;
  }
}

/**
 * Fire-and-forget wrapper preserved for the upload pipeline. Errors are
 * logged but not surfaced to the caller — by design, since the upload
 * HTTP request has already returned 202 by the time this runs.
 *
 * The 100ms delay matches the original behaviour (gives the upload
 * transaction time to commit before this task reads `foundry_datasets`).
 */
export function scheduleParseJob(datasetId: string): void {
  setTimeout(() => {
    runParseJob(datasetId).catch((err) => {
      // Already logged inside `runParseJob`; this catch is the
      // unhandled-rejection guard.
      console.error(
        `[parseDatasetJob] scheduled run for ${datasetId} failed:`,
        err,
      );
    });
  }, 100);
}
