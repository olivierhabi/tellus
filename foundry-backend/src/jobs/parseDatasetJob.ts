import db from '@/config/database';
import { csvParsingService } from '@/services/csvParsingService';
import { emitDatasetEvent } from '@/utils/emitEvent';

/**
 * Schedule a dataset parse job with a short delay.
 * Updates dataset status through: pending -> processing -> ready/error.
 */
export function scheduleParseJob(datasetId: string): void {
  setTimeout(async () => {
    try {
      // Get the dataset
      const dataset = await db('datasets').where({ id: datasetId }).first();
      if (!dataset) {
        console.error(`[parseDatasetJob] Dataset ${datasetId} not found`);
        return;
      }

      // Resolve projectId from folder
      const folder = await db('folders').where({ id: dataset.folder_id }).first();
      if (!folder) {
        console.error(`[parseDatasetJob] Folder ${dataset.folder_id} not found for dataset ${datasetId}`);
        return;
      }
      const projectId = folder.project_id;

      // Update status to processing
      await db('datasets')
        .where({ id: datasetId })
        .update({ status: 'processing' });

      emitDatasetEvent('dataset:processing', projectId, { datasetId, status: 'processing' });

      // Parse the file
      const result = await csvParsingService.parseFile(dataset.file_path);

      // Update dataset with parsed info
      await db('datasets')
        .where({ id: datasetId })
        .update({
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

      // Insert column records
      for (let i = 0; i < result.columns.length; i++) {
        const col = result.columns[i];
        await db('dataset_columns').insert({
          dataset_id: datasetId,
          column_name: col.name,
          column_type: col.inferredType,
          ordinal_position: i + 1,
          nullable: col.nullable,
          sample_values: JSON.stringify(col.sampleValues),
        });
      }

      emitDatasetEvent('dataset:ready', projectId, {
        datasetId,
        status: 'ready',
        rowCount: result.rowCount,
        columnCount: result.columns.length,
      });

      console.log(
        `[parseDatasetJob] Dataset ${datasetId} parsed successfully: ${result.rowCount} rows, ${result.columns.length} columns`
      );
    } catch (error) {
      console.error(`[parseDatasetJob] Error parsing dataset ${datasetId}:`, error);

      try {
        // Get projectId for event emission
        const dataset = await db('datasets').where({ id: datasetId }).first();
        let projectId: string | null = null;
        if (dataset) {
          const folder = await db('folders').where({ id: dataset.folder_id }).first();
          projectId = folder?.project_id ?? null;
        }

        // Update status to error
        await db('datasets')
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
          updateError
        );
      }
    }
  }, 100);
}
