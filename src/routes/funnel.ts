// ---------------------------------------------------------------------------
// /api/v1/funnel — Object Data Funnel control plane (B1–B10)
//
// Endpoints:
//   POST /api/v1/funnel/signals              — Send a workflow signal.
//   POST /api/v1/funnel/drain                — Force-drain pending signals (test).
//   GET  /api/v1/funnel/runs/:objectType     — Latest funnel_run rows.
//   GET  /api/v1/funnel/snapshots            — Iceberg snapshots for a table.
//   GET  /api/v1/funnel/instances/:objectType/:pk — Current object_instances row.
//   GET  /api/v1/funnel/overlay/:objectType/:pk   — Current overlay:<ot>:<pk>.
//   GET  /api/v1/funnel/slis                 — Writeback overlay SLI snapshot.
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import { query } from "../db";
import { sendSignal, SignalType } from "../services/funnel/durableWorkflow";
import { signalTemporalWorkflow, isTemporalConnected } from "../services/funnel/temporal/worker";
import { drainPendingSignals } from "../services/funnel/funnelDispatcher";
import { getInstance } from "../models/objectInstance";
import { getOverlayStore } from "../services/overlay/getOverlayStore";
import { readOverlay } from "../services/overlay/writebackOverlay";
import { readBranchHeader } from "../middleware/branchHeader";
import { getOverlaySloSnapshot, renderOverlaySliPrometheus } from "../services/overlay/slis";
import { renderPrometheus as renderFunnelMetrics } from "../services/funnel/metrics";
import { ensureLinkTablesForAllLinkTypes } from "../services/funnel/clickhouseBootstrap";
import {
  ensureLinkTable,
  ensureLinkIngestTopology,
  rebuildLinkIngestTopology,
  linkTableName,
} from "../services/searchAround/linkMaterializedView";
import { readAllCdcLag } from "../services/searchAround/cdcLag";
import { publishLinkCdc, linkCdcTopic } from "../services/searchAround/cdcLinkProducer";
import {
  startReplacement,
  runBackfill,
  completeBackfill,
  approveCutover,
  rollbackCutover,
  sweepRetainedIndexes,
} from "../services/quickwit/replacement/orchestrator";
import {
  tick as replacementTick,
  previewCutover,
} from "../services/funnel/replacementScheduler";
import { bootstrapLakekeeper } from "../services/funnel/lakekeeperBootstrap";
import { getLakekeeperClient } from "../services/funnel/lakekeeperClient";

const router = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/funnel/signals — enqueue a workflow signal
// ---------------------------------------------------------------------------

router.post("/signals", async (req: Request, res: Response) => {
  const { ontologyId: bodyOntologyId, objectTypeApiName, signalType, payload } = req.body as {
    ontologyId?: string;
    objectTypeApiName?: string;
    signalType?: SignalType;
    payload?: Record<string, unknown>;
  };
  if (!objectTypeApiName || !signalType) {
    res.status(400).json({
      error: "BAD_REQUEST",
      message: "objectTypeApiName and signalType are required",
    });
    return;
  }
  // `ontologyId` is optional in the request but required for durable
  // audit + Temporal addressing. Fall back to the ontology the Object
  // Type belongs to — the frontend may not know the id on a fresh
  // Object Type that has never run the Funnel before.
  let ontologyId = bodyOntologyId;
  if (!ontologyId) {
    const lookup = await query(
      `SELECT ontology_id FROM object_type WHERE api_name = $1 LIMIT 1`,
      [objectTypeApiName]
    );
    ontologyId = lookup.rows[0]?.ontology_id;
  }
  if (!ontologyId) {
    res.status(404).json({
      error: "OBJECT_TYPE_NOT_FOUND",
      message: `Object type '${objectTypeApiName}' not found — cannot resolve ontology_id`,
    });
    return;
  }
  try {
    // Always append to the Postgres signal inbox (durable audit trail).
    const signalId = await sendSignal({
      ontologyId,
      objectTypeApiName,
      signalType,
      payload,
    });
    // If the Temporal worker is connected, signal-with-start the real
    // workflow too. The PG dispatcher will no-op on already-consumed
    // signals; Temporal is authoritative.
    const temporal = isTemporalConnected()
      ? await signalTemporalWorkflow(ontologyId, objectTypeApiName, signalType, {
          signalId,
          ...(payload ?? {}),
        })
      : false;
    res.status(202).json({ signalId, temporal });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/funnel/drain — synchronously drain pending signals
// ---------------------------------------------------------------------------

router.post("/drain", async (req: Request, res: Response) => {
  const { objectTypes } = req.body as { objectTypes?: string[] };
  try {
    const runs = await drainPendingSignals({ objectTypes });
    res.status(200).json({ runsStarted: runs });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GET runs — most recent runs for an Object Type.
//
// Two URL shapes:
//
//   GET /api/v1/funnel/runs/objectTypeId/:objectTypeId   ← preferred
//   GET /api/v1/funnel/runs/:objectType                  ← legacy apiName
//
// The UUID shape is what the frontend navigates with (stable across
// apiName renames); the apiName shape is preserved for any other
// caller still wired to the original contract. Both resolve to the
// same underlying query — the funnel_run table is keyed on
// `object_type_api_name`, so the UUID route resolves UUID → apiName
// once and then shares the read path.
// ---------------------------------------------------------------------------

async function respondWithFunnelRuns(
  req: Request,
  res: Response,
  objectTypeApiName: string
): Promise<void> {
  const limit = Math.min(Number(req.query.limit ?? 20), 100);
  try {
    // Exclude the `temporal_handoff` bookkeeping rows — those are
    // inserted by the PG dispatcher when Temporal owns execution, and
    // they carry `status=completed + stages=[]` from the moment they're
    // created. Returning them to the UI caused every pipeline node
    // badge to flash green instantly (`iconFor` falls back to
    // "succeeded" when stageByName is empty and the latest run is
    // completed). Only the authoritative workflow runs are returned
    // here — the ones that actually own stage execution + projection.
    const runs = await query(
      `SELECT run_id, ontology_id, object_type_api_name, workflow_type, status,
              current_stage, objects_indexed, error_message,
              started_at, completed_at
         FROM funnel_run
        WHERE object_type_api_name = $1
          AND workflow_type <> 'temporal_handoff'
        ORDER BY started_at DESC
        LIMIT $2`,
      [objectTypeApiName, limit]
    );
    const stages = await query(
      `SELECT stage_run_id, run_id, stage, status, attempt,
              input_json, output_json, error_message,
              started_at, finished_at
         FROM funnel_stage_run
        WHERE run_id = ANY($1::uuid[])
        ORDER BY started_at ASC`,
      [runs.rows.map((r: { run_id: string }) => r.run_id)]
    );
    res.json({ runs: runs.rows, stages: stages.rows });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
}

// UUID-keyed route. Declared BEFORE the apiName route so Express's
// registration order gives it precedence — the apiName route's
// `:objectType` placeholder is a single path segment, so "objectTypeId"
// would otherwise swallow requests intended for the UUID handler.
router.get(
  "/runs/objectTypeId/:objectTypeId",
  async (req: Request, res: Response) => {
    const { objectTypeId } = req.params as { objectTypeId?: string };
    if (!objectTypeId) {
      res.status(400).json({
        error: "BAD_REQUEST",
        message: "objectTypeId is required",
      });
      return;
    }
    try {
      const resolve = await query(
        `SELECT api_name FROM object_type WHERE object_type_id = $1 LIMIT 1`,
        [objectTypeId]
      );
      if (resolve.rows.length === 0) {
        res.status(404).json({
          error: "OBJECT_TYPE_NOT_FOUND",
          message: `Object type '${objectTypeId}' not found.`,
        });
        return;
      }
      await respondWithFunnelRuns(req, res, resolve.rows[0].api_name as string);
    } catch (err) {
      res
        .status(500)
        .json({ error: "INTERNAL", message: (err as Error).message });
    }
  }
);

router.get("/runs/:objectType", async (req: Request, res: Response) => {
  await respondWithFunnelRuns(req, res, req.params.objectType);
});

// ---------------------------------------------------------------------------
// GET /api/v1/funnel/snapshots — snapshots for a (namespace, table)
// ---------------------------------------------------------------------------

router.get("/snapshots", async (req: Request, res: Response) => {
  const namespace = String(req.query.namespace ?? "");
  const tableName = String(req.query.table ?? "");
  if (!namespace || !tableName) {
    res.status(400).json({ error: "BAD_REQUEST", message: "namespace and table are required" });
    return;
  }
  try {
    const result = await query(
      `SELECT s.snapshot_id, s.parent_snapshot_id, s.operation, s.summary_json,
              s.added_rows, s.added_files, s.committed_at
         FROM funnel_snapshot s
         JOIN funnel_dataset d ON d.dataset_table_id = s.dataset_table_id
        WHERE d.namespace = $1 AND d.table_name = $2
        ORDER BY s.committed_at ASC`,
      [namespace, tableName]
    );
    // Redact internal row-storage metadata before exposing summary_json to
    // clients: `parquet_ref` (bucket/key — internal MinIO addressing) and
    // legacy `inline_rows` (the actual row payload) are NOT for direct
    // client consumption. Clients that need rows go through the authorized
    // API surface, never the raw MinIO object. (Access-control parity for
    // the by-reference path — Point 3 of the parquet-ref production bar.)
    const snapshots = result.rows.map((r: { summary_json?: Record<string, unknown> }) => {
      if (r.summary_json && typeof r.summary_json === "object") {
        const { parquet_ref: _pr, inline_rows: _ir, ...rest } = r.summary_json;
        r.summary_json = rest;
      }
      return r;
    });
    res.json({ snapshots });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/funnel/instances/:objectType/:pk — read one SoR row
// ---------------------------------------------------------------------------

router.get("/instances/:objectType/:pk", async (req: Request, res: Response) => {
  const { objectType, pk } = req.params;
  const ontologyId = String(req.query.ontologyId ?? "");
  if (!ontologyId) {
    res.status(400).json({ error: "BAD_REQUEST", message: "ontologyId is required" });
    return;
  }
  // Wrap in try/catch — `getInstance` can throw (e.g. the
  // `object_instances` table hasn't been migrated in this
  // environment). Without this, the rejected promise leaks out of
  // the async handler, Express never sends a response, and the
  // client hangs until its own timeout fires.
  try {
    const row = await getInstance(ontologyId, objectType, pk);
    if (!row) {
      res.status(404).json({ error: "NOT_FOUND", objectType, primary_key: pk });
      return;
    }
    res.json(row);
  } catch (err) {
    res
      .status(500)
      .json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/funnel/overlay/:objectType/:pk — inspect overlay cache
// ---------------------------------------------------------------------------

router.get("/overlay/:objectType/:pk", async (req: Request, res: Response) => {
  const { objectType, pk } = req.params;
  // T-04: branchId comes from the standard branch header (defaults to
  // `_main` when absent). Reads route through `readOverlay` so the
  // legacy-fallback gate and branch-mismatch counter are enforced.
  const branchId = readBranchHeader(req) ?? null;
  try {
    const store = await getOverlayStore();
    const hit = await readOverlay(branchId, objectType, pk, store);
    if (!hit) {
      res.status(404).json({ error: "NOT_FOUND", objectType, primary_key: pk });
      return;
    }
    res.json(hit);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/funnel/slis — writeback overlay lag SLI snapshot
// ---------------------------------------------------------------------------

router.get("/slis", async (_req: Request, res: Response) => {
  try {
    res.json(getOverlaySloSnapshot());
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// B7: Prometheus-format exposition of overlay_to_index_lag_p99 so a
// scraper can ingest the SLI as a first-class metric and page on
// alerting=1 per the spec's 60s threshold.
router.get("/slis/metrics", async (_req: Request, res: Response) => {
  try {
    res
      .set("content-type", "text/plain; version=0.0.4")
      .send(renderOverlaySliPrometheus());
  } catch (err) {
    res.status(500).send(`# error: ${(err as Error).message}\n`);
  }
});

// Unified Funnel Prometheus scrape endpoint. Covers the B3/B7 control
// plane metrics:
//   funnel_workflow_terminate_on_save_total
//   funnel_workflow_cancel_attempted_total / cancelled_cleanly_total / cancel_timeout_total
//   funnel_signal_with_start_total / errors_total
//   funnel_stage_duration_seconds (histogram, per stage + per object type)
//   funnel_stage_errors_total
//   funnel_orphan_runs_swept_total
//   funnel_iceberg_metadata_emission_failures_total
router.get("/metrics", async (_req: Request, res: Response) => {
  try {
    const funnel = renderFunnelMetrics();
    const overlay = renderOverlaySliPrometheus();
    res
      .set("content-type", "text/plain; version=0.0.4")
      .send(funnel + overlay);
  } catch (err) {
    res.status(500).send(`# error: ${(err as Error).message}\n`);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/funnel/clickhouse/refresh — re-run the ClickHouse link
// table bootstrap. Useful after registering a new link_type so the
// traversal target table materializes without a server restart.
// ---------------------------------------------------------------------------

router.post("/clickhouse/refresh", async (_req: Request, res: Response) => {
  try {
    const result = await ensureLinkTablesForAllLinkTypes();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/funnel/clickhouse/link — ensure a single link-type table
// exists in ClickHouse. Body: {sourceObjectType, linkName, targetObjectType}.
// ---------------------------------------------------------------------------

router.post("/clickhouse/link", async (req: Request, res: Response) => {
  const { sourceObjectType, linkName, targetObjectType, withKafkaIngest, rebuild } = req.body as {
    sourceObjectType?: string;
    linkName?: string;
    targetObjectType?: string;
    withKafkaIngest?: boolean;
    rebuild?: boolean;
  };
  if (!sourceObjectType || !linkName || !targetObjectType) {
    res.status(400).json({
      error: "BAD_REQUEST",
      message: "sourceObjectType, linkName, targetObjectType are required",
    });
    return;
  }
  const link = { sourceObjectType, linkName, targetObjectType };
  try {
    const wantIngest = withKafkaIngest !== false && !!process.env.KAFKA_BROKERS;
    if (wantIngest) {
      try {
        if (rebuild) {
          await rebuildLinkIngestTopology(link);
        } else {
          await ensureLinkIngestTopology(link);
        }
        res.json({ table: linkTableName(link), kafkaIngest: true, rebuilt: !!rebuild });
        return;
      } catch (err) {
        console.warn(
          `[funnel] Kafka ingest DDL failed, falling back to bare table: ${(err as Error).message}`
        );
      }
    }
    const table = await ensureLinkTable(link);
    res.json({ table, kafkaIngest: false });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// B2 — Lakekeeper control plane.
//
// POST /lakekeeper/bootstrap — create warehouse + per-Object-Type namespaces.
// GET  /lakekeeper/info      — version / bootstrap state / warehouse id.
// GET  /lakekeeper/warehouses — list configured warehouses.
// ---------------------------------------------------------------------------

router.post("/lakekeeper/bootstrap", async (_req: Request, res: Response) => {
  try {
    const result = await bootstrapLakekeeper();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.get("/lakekeeper/info", async (_req: Request, res: Response) => {
  try {
    const client = getLakekeeperClient();
    if (!(await client.isReachable())) {
      res.status(503).json({ reachable: false });
      return;
    }
    res.json({ reachable: true, ...(await client.getInfo()) });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.get("/lakekeeper/warehouses", async (_req: Request, res: Response) => {
  try {
    const client = getLakekeeperClient();
    const warehouses = await client.listWarehouses();
    res.json({ warehouses });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// FNL-H6 — list namespaces under the Tellus warehouse so operators can
// verify the _funnel / _pipeline / _links roots are present after
// bootstrap.
router.get("/lakekeeper/namespaces", async (_req: Request, res: Response) => {
  try {
    const { listNamespaces, LINK_NAMESPACE_ROOT, PIPELINE_NAMESPACE_ROOT } = await import(
      "../services/funnel/lakekeeperBootstrap"
    );
    const summary = await listNamespaces();
    // Guarantee the three well-known roots appear even when Lakekeeper
    // is unreachable — the FE needs a stable contract.
    const roots = ["_funnel", PIPELINE_NAMESPACE_ROOT, LINK_NAMESPACE_ROOT];
    const union = Array.from(new Set([...roots, ...summary.namespaces]));
    res.json({
      reachable: summary.reachable,
      warehouseName: summary.warehouseName,
      namespaces: union,
      expectedRoots: roots,
    });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// B9 — Replacement pipeline control plane.
//
// POST /replacement/start — begin a dual-index cutover for an Object Type.
// POST /replacement/:objectType/backfill — drive the backfill activity (reader supplied via body).
// POST /replacement/:objectType/complete-backfill — transition to SOAK.
// POST /replacement/:objectType/approve-cutover — flip alias if diff gate passed.
// POST /replacement/:objectType/rollback — revert to previous version within 48h.
// POST /replacement/sweep — drop old indexes whose grace window elapsed.
// GET  /replacement/:objectType — inspect the active version & pending state.
// ---------------------------------------------------------------------------

router.post("/replacement/start", async (req: Request, res: Response) => {
  const {
    objectTypeApiName,
    primaryKeyApiName,
    previousProperties,
    nextProperties,
    soakDays,
    volumeTrigger,
    force,
  } = req.body as {
    objectTypeApiName?: string;
    primaryKeyApiName?: string;
    previousProperties?: unknown[];
    nextProperties?: unknown[];
    soakDays?: number;
    volumeTrigger?: { rowsChanged: number; totalRows: number };
    force?: boolean;
  };
  if (
    !objectTypeApiName ||
    !primaryKeyApiName ||
    !Array.isArray(previousProperties) ||
    !Array.isArray(nextProperties)
  ) {
    res.status(400).json({
      error: "BAD_REQUEST",
      message:
        "objectTypeApiName, primaryKeyApiName, previousProperties[], nextProperties[] are required",
    });
    return;
  }
  try {
    const out = await startReplacement({
      objectTypeApiName,
      primaryKeyApiName,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      previousProperties: previousProperties as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nextProperties: nextProperties as any,
      soakDays,
      volumeTrigger,
      force,
    });
    res.status(out.triggered ? 201 : 200).json(out);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.post("/replacement/:objectType/complete-backfill", async (req: Request, res: Response) => {
  try {
    await completeBackfill(req.params.objectType);
    res.json({ objectType: req.params.objectType, state: "REPLACEMENT_SOAK" });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.post("/replacement/:objectType/approve-cutover", async (req: Request, res: Response) => {
  try {
    const result = await approveCutover(req.params.objectType);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.post("/replacement/:objectType/rollback", async (req: Request, res: Response) => {
  try {
    await rollbackCutover(req.params.objectType);
    res.json({ objectType: req.params.objectType, state: "ROLLED_BACK" });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// Manually fire one scheduler tick — used by the e2e script and the
// on-call runbook when someone wants to bypass the 1-minute interval.
router.post("/replacement/scheduler-tick", async (_req: Request, res: Response) => {
  try {
    const result = await replacementTick();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// Preview the cutover gate verdict for an Object Type without firing.
router.get("/replacement/:objectType/preview-cutover", async (req: Request, res: Response) => {
  try {
    const result = await previewCutover(req.params.objectType);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.post("/replacement/sweep", async (_req: Request, res: Response) => {
  try {
    const dropped = await sweepRetainedIndexes();
    res.json({ dropped });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.get("/replacement/:objectType", async (req: Request, res: Response) => {
  try {
    const result = await query(
      `SELECT object_type_api_name, active_version, pending_version, state,
              soak_days, diff_rate_threshold, backfill_started_at, soak_started_at,
              last_cutover_at, last_rollback_at, old_index_retained_until, updated_at
         FROM object_type_active_index_version
        WHERE object_type_api_name = $1`,
      [req.params.objectType]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "NOT_FOUND", objectType: req.params.objectType });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/funnel/clickhouse/cdc-lag — rolling CDC lag per link type.
// Alert if any entry has alerting=true (>30s lag with rows present).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/v1/funnel/clickhouse/link-cdc — publish a link CDC event.
// Used by integration tests and by backfill jobs. In production the
// Action writeback path is the primary producer (editApplicator.ts).
// ---------------------------------------------------------------------------

router.post("/clickhouse/link-cdc", async (req: Request, res: Response) => {
  const { sourceObjectType, linkName, sourcePk, targetPk, linkProps, markings } = req.body as {
    sourceObjectType?: string;
    linkName?: string;
    sourcePk?: string;
    targetPk?: string;
    linkProps?: Record<string, unknown>;
    markings?: string[];
  };
  if (!sourceObjectType || !linkName || !sourcePk || !targetPk) {
    res.status(400).json({
      error: "BAD_REQUEST",
      message: "sourceObjectType, linkName, sourcePk, targetPk are required",
    });
    return;
  }
  try {
    const ok = await publishLinkCdc(sourceObjectType, linkName, {
      source_pk: sourcePk,
      target_pk: targetPk,
      link_props: linkProps ?? {},
      markings: markings ?? [],
    });
    res.json({
      published: ok,
      topic: linkCdcTopic(sourceObjectType, linkName),
    });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

router.get("/clickhouse/cdc-lag", async (_req: Request, res: Response) => {
  try {
    const links = await query(
      `SELECT lt.api_name AS link_name,
              src.api_name AS source_api,
              tgt.api_name AS target_api
         FROM link_type lt
         JOIN object_type src ON src.object_type_id = lt.source_object_type
         JOIN object_type tgt ON tgt.object_type_id = lt.target_object_type`
    );
    const descriptors = links.rows.map((r: { link_name: string; source_api: string; target_api: string }) => ({
      linkName: r.link_name,
      sourceObjectType: r.source_api,
      targetObjectType: r.target_api,
    }));
    const readings = await readAllCdcLag(descriptors);
    const alerting = readings.some((r) => r.alerting);
    res.json({ alerting, readings });
  } catch (err) {
    res.status(500).json({ error: "INTERNAL", message: (err as Error).message });
  }
});

export default router;
