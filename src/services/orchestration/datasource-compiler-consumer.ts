import { eventBus } from "../../websocket/eventBus";
import { query, withTransaction } from "../../db";
import { sendSignal } from "../funnel/durableWorkflow";

/**
 * Datasource Compiler Consumer
 * Reads DataSourceAddedEvent events, executes a simulated merge schema, and
 * updates the legacy `backing_datasource` (Runtime Layer) so the older ingestion
 * pipelines remain fully backwards compatible without executing real runtime joins.
 */

interface DataSourceAddedPayload {
  objectTypeRid: string;
  datasourceRid: string;
  primaryKeyMapping: string;
  resolutionStrategy: string;
  conflictPolicy: string;
  propertyMappings: Array<{ sourceColumn: string; targetPropertyId: string }>;
}

export function startDatasourceCompilerConsumer(): void {
  console.log("[Compiler Consumer] Initializing Multi-Source Compilation Worker...");

  eventBus.on("ws:event", async (evt: { event: string; payload: unknown }) => {
    if (evt.event !== "DataSourceAddedEvent") return;

    const payload = evt.payload as DataSourceAddedPayload;
    const start = Date.now();

    console.log(
      JSON.stringify({
        level: "info",
        message: "Asynchronous view compilation triggered for attached backing source.",
        objectTypeRid: payload.objectTypeRid,
        datasourceRid: payload.datasourceRid,
        resolutionStrategy: payload.resolutionStrategy,
        timestamp: new Date().toISOString(),
      })
    );

    try {
      // 1. Map B8 `object_types` RID to legacy `object_type` UUID and get ontology_id.
      // We must handle cases where the ontology_rid in B8 is a string RID (e.g. "ri.ontology.main.ontology.default"),
      // but in legacy `object_type`, the ontology_id is a UUID (the singleton UUID: 00000000-0000-0000-0000-000000000001).
      // Since the funnel_signal table expects ontology_id as a UUID column, we always map or fall back
      // to the canonical legacy ontology UUID.
      const otResult = await query(
        `SELECT ot.object_type_id, ot.api_name, ot.ontology_id
         FROM object_type ot
         WHERE LOWER(ot.api_name) = (
           SELECT LOWER(b8.api_name) FROM object_types b8 WHERE b8.rid = $1
         )`,
        [payload.objectTypeRid]
      );

      if (otResult.rows.length === 0) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "Failed to map object type RID to UUID during view compilation.",
            objectTypeRid: payload.objectTypeRid,
          })
        );
        return;
      }

      const { object_type_id: objectTypeId, api_name: apiName, ontology_id: ontologyId } = otResult.rows[0];

      // 2. Fetch all active datasources from Blueprint Layer to construct the unified merge
      const bps = await query(
        "SELECT * FROM object_type_datasources WHERE object_type_rid = $1",
        [payload.objectTypeRid]
      );

      // Construct simulated Logical Union view dataset representation
      const filePaths = [
        `#foundry-dataset:${payload.datasourceRid}`,
        ...bps.rows.filter(r => r.datasource_rid !== payload.datasourceRid).map(r => `#foundry-dataset:${r.datasource_rid}`)
      ];

      const compiledFilePath = `compiled_logical_view://${apiName}?sources=${encodeURIComponent(
        JSON.stringify(filePaths)
      )}`;

      // 3. Upsert compiled representation back to legacy `backing_datasource` table (Runtime Layer)
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO backing_datasource
             (object_type_id, dataset_name, file_path, file_format, column_mapping, primary_key_column, row_count, column_names, schema_hash)
           VALUES ($1, $2, $3, 'csv', $4, $5, 0, $6, $7)
           ON CONFLICT (object_type_id)
           DO UPDATE SET
             file_path = EXCLUDED.file_path,
             column_mapping = EXCLUDED.column_mapping,
             primary_key_column = EXCLUDED.primary_key_column`,
          [
            objectTypeId,
            `${apiName} Consolidated Source`,
            compiledFilePath,
            JSON.stringify(
              payload.propertyMappings.reduce<Record<string, string>>((acc, curr) => {
                acc[curr.targetPropertyId] = curr.sourceColumn;
                return acc;
              }, {})
            ),
            payload.primaryKeyMapping,
            payload.propertyMappings.map((p) => p.sourceColumn),
            `hash_${Date.now()}`,
          ]
        );
      });

      const duration = Date.now() - start;
      console.log(
        JSON.stringify({
          level: "info",
          message: "Legacy runtime layer synced and logical view compiled.",
          objectTypeRid: payload.objectTypeRid,
          durationMs: duration,
          compiledFilePath,
          timestamp: new Date().toISOString(),
        })
      );

      // 4. Trigger funnel indexing/reindex after datasource attachment
      // The datasource has been compiled and the runtime layer updated.
      // Signal the funnel to start the indexing pipeline for this object type.
      try {
        const signalId = await sendSignal({
          ontologyId,
          objectTypeApiName: apiName,
          signalType: "schemaChanged",
          payload: {
            reason: "datasource_attached",
            datasourceRid: payload.datasourceRid,
            objectTypeRid: payload.objectTypeRid,
          },
          fingerprint: `ds-attach-${payload.objectTypeRid}-${payload.datasourceRid}`,
        });

        console.log(
          JSON.stringify({
            level: "info",
            message: "Funnel indexing signal sent after datasource attachment.",
            objectTypeRid: payload.objectTypeRid,
            objectTypeApiName: apiName,
            signalId,
            timestamp: new Date().toISOString(),
          })
        );
      } catch (signalErr: any) {
        // Non-fatal: the datasource was attached successfully,
        // indexing can be triggered manually later if needed.
        console.error(
          JSON.stringify({
            level: "warn",
            message: "Failed to send funnel signal after datasource attachment (non-fatal).",
            objectTypeRid: payload.objectTypeRid,
            error: signalErr.message,
            timestamp: new Date().toISOString(),
          })
        );
      }
    } catch (err: any) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Failed logical compilation for appends.",
          objectTypeRid: payload.objectTypeRid,
          error: err.message,
          timestamp: new Date().toISOString(),
        })
      );
    }
  });
}
