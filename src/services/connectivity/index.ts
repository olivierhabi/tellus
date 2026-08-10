// ---------------------------------------------------------------------------
// Connectivity module bootstrap (B1, spec §42 line 1 — module entrypoint).
//
// Exports:
//   - createConnectivityRouter(): Router — mount under /api/v1/connectivity
//     in server.ts.
//   - initConnectivity(): void — starts the Compass outbox poller. Safe to
//     call multiple times (poller is idempotent).
//   - shutdownConnectivity(): void — stops poller; for graceful shutdown.
//
// Mount example (in src/server.ts):
//   import { createConnectivityRouter, initConnectivity } from
//     './services/connectivity';
//   app.use('/api/v1/connectivity', createConnectivityRouter());
//   initConnectivity();
//
// The router does NOT mount the global authenticate middleware itself — the
// caller is expected to apply it upstream (server.ts already mounts it
// globally). The router DOES mount Idempotency-Key replay on POST and the
// connectivity-specific error envelope normalizer as its tail.
// ---------------------------------------------------------------------------

import { Router } from "express";
import { pool } from "../../db";
import { idempotencyKeyMiddleware } from "../../middleware/idempotencyKey";
import * as handler from "./handlers/connections.handler";
import * as secretsHandler from "./handlers/secrets.handler";
import * as testHandler from "./handlers/test.handler";
import * as discoveryHandler from "./handlers/discovery.handler";
import * as importsHandler from "./imports/handlers";
import * as virtualTablesHandler from "./virtual-tables/handlers";
import { runPreflight } from "./cdc/preflight";
import * as cdcHandler from "./cdc/handlers";
import * as connectorTypesHandler from "./handlers/connector-types.handler";
import * as foldersHandler from "./handlers/folders.handler";
import * as egressPoliciesHandler from "./handlers/egress-policies.handler";
import * as webhooksHandler from "./webhooks/handlers";
import { startWebhookReaper, stopWebhookReaper } from "./webhooks/reaper.worker";
import * as outbox from "./store/outbox";
import {
  startRotationWorker,
  stopRotationWorker,
} from "./credentials/rotation.worker";
import { startHealthProber, stopHealthProber } from "./health/prober";
import {
  startTableImportScheduler,
  stopTableImportScheduler,
} from "./imports/scheduler";
import { drainAll as drainPgPools } from "./connectors/postgresql/pool";
import { extractUser, requireScope } from "./handlers/connections.handler";
import { TellusError } from "../../lib/errors/envelope";
import { ConnectionNotFound } from "../../lib/errors/connectivity.errors";

export function createConnectivityRouter(): Router {
  const router = Router({ mergeParams: true });

  // Connector types registry — consumed by /data-connection/new-source.
  router.get("/connector-types", connectorTypesHandler.listConnectorTypes);

  // Folder picker — lists Compass folders/spaces from the resources table.
  router.get("/folders", foldersHandler.listFolders);

  // Output-folder creation — backs the new-source wizard's "Generate a new
  // default output folder" affordance. Idempotent by (parent, name). Requires
  // connectivity:write scope. One path segment, no collision with :rid routes.
  router.post(
    "/folders",
    idempotencyKeyMiddleware(pool, "connectivity.createOutputFolder"),
    foldersHandler.createOutputFolder,
  );

  // Resolve a single folder-like resource by RID — backs connection-settings
  // prefill (stored compassFolderRid -> location name + path). Two-segment
  // path, registered after the one-segment /folders routes so it never
  // swallows them.
  router.get("/folders/:rid", foldersHandler.getFolder);

  // Named egress policies — reusable, approvable allowlists referenced by
  // connections. List precedes :eprid so it never swallows the collection GET;
  // the /decision sub-route is registered last.
  router.post(
    "/egress-policies",
    idempotencyKeyMiddleware(pool, "connectivity.postEgressPolicy"),
    egressPoliciesHandler.postEgressPolicy,
  );
  router.get("/egress-policies", egressPoliciesHandler.listEgressPolicies);
  router.get("/egress-policies/:eprid", egressPoliciesHandler.getEgressPolicy);
  router.put("/egress-policies/:eprid", egressPoliciesHandler.putEgressPolicy);
  router.delete("/egress-policies/:eprid", egressPoliciesHandler.deleteEgressPolicy);
  router.post(
    "/egress-policies/:eprid/decision",
    egressPoliciesHandler.decideEgressPolicy,
  );

  // POST /connections — write, Idempotency-Key replay 24h.
  router.post(
    "/connections",
    idempotencyKeyMiddleware(pool, "connectivity.postConnection"),
    handler.postConnection,
  );

  // POST /connections/test-config — transient, non-persisted connection probe
  // used by the new-source wizard's "Test connection" button before the
  // connection exists. One path segment, so it never collides with the
  // two-segment `/connections/:rid/test` route below.
  router.post(
    "/connections/test-config",
    testHandler.testRateLimit,
    testHandler.testConfig,
  );

  // Read endpoints — list must precede :rid to avoid swallow.
  router.get("/connections", handler.listConnections);
  router.get("/connections/:rid", handler.getConnection);
  router.get(
    "/connections/:rid/configuration",
    handler.getConfiguration,
  );
  router.get("/connections/:rid/status", handler.getStatus);

  // Mutating endpoints — require If-Match (checked inside handler).
  router.put("/connections/:rid", handler.putConnection);
  router.delete("/connections/:rid", handler.deleteConnection);

  // B2: secrets endpoints — credential vault (POST/PUT/DELETE/rotate/issue).
  router.post(
    "/connections/:rid/secrets",
    idempotencyKeyMiddleware(pool, "connectivity.postSecret"),
    secretsHandler.postSecret,
  );
  router.put("/connections/:rid/secrets/:name", secretsHandler.putSecret);
  router.delete(
    "/connections/:rid/secrets/:name",
    secretsHandler.deleteSecret,
  );
  router.post(
    "/connections/:rid/secrets/:name/rotate",
    idempotencyKeyMiddleware(pool, "connectivity.rotateSecret"),
    secretsHandler.rotateSecret,
  );
  // Server-side managed rotation — generates fresh material in-process (no
  // caller-supplied plaintext) and evicts the pool.
  router.post(
    "/connections/:rid/secrets/:name/rotate-managed",
    idempotencyKeyMiddleware(pool, "connectivity.rotateManagedSecret"),
    secretsHandler.rotateManagedSecret,
  );
  router.post(
    "/connections/:rid/credentials/issue",
    secretsHandler.issueCredential,
  );

  // Source-linked webhooks inherit domains, egress policy, and credentials
  // from their REST API connection while retaining an immutable version
  // history and an independently managed activation lifecycle.
  router.get("/connections/:rid/webhooks", webhooksHandler.listWebhooks);
  router.post(
    "/connections/:rid/webhooks",
    idempotencyKeyMiddleware(pool, "connectivity.createWebhook"),
    webhooksHandler.createWebhook,
  );
  router.get("/webhooks/:webhookRid", webhooksHandler.getWebhook);
  router.get("/webhooks/:webhookRid/versions", webhooksHandler.listWebhookVersions);
  router.put("/webhooks/:webhookRid", webhooksHandler.updateWebhook);
  router.post("/webhooks/:webhookRid/ready", webhooksHandler.markWebhookReady);
  router.post("/webhooks/:webhookRid/activate", webhooksHandler.activateWebhook);
  router.post("/webhooks/:webhookRid/disable", webhooksHandler.disableWebhook);
  router.delete("/webhooks/:webhookRid", webhooksHandler.archiveWebhook);
  router.post(
    "/webhooks/:webhookRid/test",
    idempotencyKeyMiddleware(pool, "connectivity.testWebhook"),
    webhooksHandler.testWebhook,
  );
  router.post(
    "/webhooks/:webhookRid/execute",
    idempotencyKeyMiddleware(pool, "connectivity.executeWebhook"),
    webhooksHandler.executeProductionWebhook,
  );
  router.get(
    "/webhooks/:webhookRid/executions",
    webhooksHandler.listExecutions,
  );
  router.get(
    "/webhook-executions/:executionRid",
    webhooksHandler.getExecution,
  );

  // Worker credential unwrap — the foundry-worker child posts here with a
  // short-lived workload JWT (verified inside the handler; this path is
  // allowlisted in globalAuth since the bearer is a workload token, not a
  // Keycloak user token). Returns the full connect credential set.
  router.post(
    "/internal/credentials/unwrap",
    secretsHandler.internalUnwrapWorker,
  );

  // B3: PostgreSQL connector — testConnection + schema discovery.
  router.post(
    "/connections/:rid/test",
    testHandler.testRateLimit,
    idempotencyKeyMiddleware(pool, "connectivity.testConnection"),
    testHandler.testConnection,
  );
  router.get(
    "/connections/:rid/discovery/catalog",
    discoveryHandler.getCatalog,
  );
  router.get(
    "/connections/:rid/discovery/schemas",
    discoveryHandler.getSchemas,
  );
  router.get(
    "/connections/:rid/discovery/tables",
    discoveryHandler.getTables,
  );
  router.get(
    "/connections/:rid/discovery/columns",
    discoveryHandler.getColumns,
  );
  router.get(
    "/connections/:rid/discovery/primary-keys",
    discoveryHandler.getPrimaryKeys,
  );
  router.get(
    "/connections/:rid/discovery/imported-keys",
    discoveryHandler.getImportedKeys,
  );
  router.get(
    "/connections/:rid/discovery/preview",
    discoveryHandler.getPreview,
  );

  // B5: TableImport CRUD + execution.
  router.get("/connections/:rid/imports", importsHandler.listImportsByConnection);
  router.get("/connections/:rid/snapshots", importsHandler.listSnapshots);
  router.post(
    "/connections/:rid/imports",
    idempotencyKeyMiddleware(pool, "connectivity.postImport"),
    importsHandler.postImport,
  );
  router.get("/imports/:importRid", importsHandler.getImport);
  router.put("/imports/:importRid", importsHandler.putImport);
  router.delete("/imports/:importRid", importsHandler.deleteImport);
  router.post(
    "/imports/:importRid/execute",
    idempotencyKeyMiddleware(pool, "connectivity.executeImport"),
    importsHandler.executeImport,
  );
  // Multi-table run: enqueue ONE Build with N jobs (one per import) so a
  // "Create sync for N tables" action is a single Build the job-tracker shows
  // in full. Literal "execute-batch" segment — no collision with :importRid.
  router.post(
    "/imports/execute-batch",
    idempotencyKeyMiddleware(pool, "connectivity.executeImportBatch"),
    importsHandler.executeImportBatch,
  );
  router.get("/imports/:importRid/builds", importsHandler.listBuilds);
  // Single build — the job-tracker "build details" view (status, timings,
  // counts, the resource it builds, and the append-only event log).
  router.get("/builds/:buildRid", importsHandler.getBuild);
  // Live build progress over Server-Sent Events (Redis pub/sub push + DB
  // reconcile, resumable via Last-Event-ID).
  router.get("/builds/:buildRid/events", importsHandler.streamBuildEvents);
  // Cancel an in-flight or queued build.
  router.post("/builds/:buildRid/cancel", importsHandler.cancelBuild);

  // B7: CDC preflight + stream creation.
  router.post(
    "/connections/:rid/cdc/preflight",
    async (req, res, next) => {
      try {
        // Extract user and require read scope
        const user = extractUser(req);
        requireScope(user, "connectivity:read");

        // Verify the connection exists and belongs to the user's tenant.
        const connResult = await pool.query(
          `SELECT 1 FROM connectivity_connections WHERE rid=$1 AND tenant=$2 AND deleted_at IS NULL`,
          [req.params.rid, user.tenant],
        );
        if (connResult.rowCount === 0) {
          new TellusError(ConnectionNotFound, {
            rid: req.params.rid,
          }).send(res);
          return;
        }

        res.json(await runPreflight(req.params.rid));
      } catch (err) {
        next(err);
      }
    },
  );
  router.post(
    "/connections/:rid/cdc/streams",
    idempotencyKeyMiddleware(pool, "connectivity.postCdcStream"),
    cdcHandler.postCdcStream,
  );

  // B8: Virtual Tables CRUD + refreshSchema.
  router.get(
    "/connections/:rid/virtual-tables",
    virtualTablesHandler.listVirtualTablesByConnection,
  );
  router.post(
    "/connections/:rid/virtual-tables",
    idempotencyKeyMiddleware(pool, "connectivity.postVirtualTable"),
    virtualTablesHandler.postVirtualTable,
  );
  router.get(
    "/virtual-tables/:vrid",
    virtualTablesHandler.getVirtualTable,
  );
  router.delete(
    "/virtual-tables/:vrid",
    virtualTablesHandler.deleteVirtualTable,
  );
  router.post(
    "/virtual-tables/:vrid/refreshSchema",
    virtualTablesHandler.refreshSchema,
  );

  return router;
}

/**
 * Start background work:
 *   - B1: Compass outbox poller.
 *   - B2: credential rotation worker.
 *   - B3: connection health prober.
 *   - B5: table-import scheduler.
 *   - F2: webhook execution reaper (orphan recovery).
 * Safe to call multiple times.
 */
export function initConnectivity(): void {
  if (process.env.TELLUS_DISABLE_CONNECTIVITY_POLLER !== "1") {
    outbox.startPoller();
  }
  startRotationWorker();
  startHealthProber();
  startTableImportScheduler();
  startWebhookReaper();
}

/** Stop background workers and drain PG pools for graceful shutdown. */
export async function shutdownConnectivity(): Promise<void> {
  outbox.stopPoller();
  stopRotationWorker();
  stopHealthProber();
  stopTableImportScheduler();
  stopWebhookReaper();
  await drainPgPools().catch(() => undefined);
}

// Re-export contracts for downstream callers (frontend client generator,
// tests, sibling services like B5 imports which embed a ConnectionRid).
export type {
  Connection,
  ConnectionCreateRequest,
  ConnectionUpdateRequest,
  ConnectionRid,
  PostgresConfig,
  TableImport,
  VirtualTable,
  Driver,
} from "./contracts";
export type {
  ConnectivityWebhook,
  WebhookExecutionSummary,
  WebhookVersionConfiguration as WebhookVersionConfigurationValue,
} from "./webhooks/contracts";
