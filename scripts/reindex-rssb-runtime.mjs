import pg from 'pg';
import { Client, Connection } from '@temporalio/client';

const ontologyId = '00000000-0000-0000-0000-000000000001';
const db = new pg.Client();
await db.connect();
const { rows } = await db.query(`
  SELECT object_type_id, api_name
  FROM object_type
  WHERE object_type_id IN (
    SELECT source_object_type FROM link_type WHERE api_name ILIKE 'rssb%'
    UNION SELECT target_object_type FROM link_type WHERE api_name ILIKE 'rssb%'
    UNION SELECT object_type_id FROM object_type WHERE display_name ILIKE '[RSSB]%'
  ) ORDER BY api_name
`);
const namespace = process.env.TEMPORAL_NAMESPACE;
const taskQueue = process.env.TEMPORAL_TASK_QUEUE;
const address = process.env.TEMPORAL_ADDRESS;
const environmentId = process.env.TELLUS_ENVIRONMENT_ID;
if (!namespace || !taskQueue || !address || !environmentId) throw new Error('Missing deployment identity');
const connection = await Connection.connect({ address });
const temporal = new Client({ connection, namespace });
let count = 0;
for (const row of rows) {
  await temporal.workflow.signalWithStart('ObjectTypeFunnelWorkflow', {
    workflowId: `ObjectTypeFunnelWorkflow/${ontologyId}/${row.object_type_id}`,
    taskQueue,
    args: [{ ontologyId, objectTypeApiName: row.api_name, objectTypeRid: row.object_type_id, environmentId }],
    signal: 'sourceTransactionCommitted',
    signalArgs: [{ signalId: `rssb-import-${row.api_name.toLowerCase()}-${Date.now()}` }],
    workflowIdConflictPolicy: 'USE_EXISTING',
  });
  count++;
}
await connection.close();
await db.end();
console.log(`RSSB_REINDEX_SIGNALED=${count}`);
