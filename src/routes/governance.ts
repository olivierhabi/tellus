// ---------------------------------------------------------------------------
// Governance routes — Ontology Platform spec Task 30
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/governance
//   GET  /lineage/:objectTypeApiName     — lineage DAG up to depth 5
//   POST /pii-scans/:objectTypeApiName   — trigger a PII scan
//   GET  /pii-scans/:objectTypeApiName   — list scan results
//   GET  /usage/:objectTypeApiName       — usage sparkline from the last 30d
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { computeLineage, MAX_LINEAGE_DEPTH } from "../services/lineageService";
import { scanObjectType } from "../services/piiScanner";
import { searchObjects } from "../services/opensearch/client";
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { incCounter } from "../services/funnel/metrics";

const router = Router({ mergeParams: true });

const PII_SCAN_BATCH_SIZE = 1000;

router.get(
  "/lineage/:objectTypeApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName } = req.params;
      const depth = Math.min(
        parseInt((req.query.depth as string) || String(MAX_LINEAGE_DEPTH), 10),
        MAX_LINEAGE_DEPTH
      );
      const graph = await computeLineage(ontologyId, objectTypeApiName, depth);
      sendSuccess(res, graph);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/pii-scans/:objectTypeApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName } = req.params;
      const row = await query(
        "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, objectTypeApiName]
      );
      if (row.rowCount === 0) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          `Object type ${objectTypeApiName} not found.`
        );
      }

      // If the caller supplied samples, scan them directly. Otherwise pull
      // the first PII_SCAN_BATCH_SIZE docs out of the live index.
      let samples: Array<Record<string, unknown>> =
        Array.isArray(req.body?.samples) ? req.body.samples : [];
      let scannedFromIndex = false;

      if (samples.length === 0) {
        try {
          // F-P3-13: thread branch filter so PII-scan samples respect branch isolation.
          const branchId = readBranchHeader(req);
          incCounter("tellus_read_branch_filtered_total", {
            route: "governance.piiScan",
            scoped: String(branchId !== null),
          });
          const result = await searchObjects(
            `ontology-${objectTypeApiName.toLowerCase()}`,
            { size: PII_SCAN_BATCH_SIZE, query: { match_all: {} } },
            buildSecurityFilter(req.security),
            branchId
          );
          const hits = result.body?.hits?.hits ?? [];
          samples = hits.map((h: { _source: Record<string, unknown> }) => h._source || {});
          scannedFromIndex = true;
        } catch {
          // Index missing or ES unavailable — return an empty scan rather
          // than 500ing, so admins get a deterministic "no data" answer.
          samples = [];
        }
      }

      const matches = await scanObjectType(row.rows[0].object_type_id, samples);
      sendSuccess(res, {
        matches,
        suggestionCount: matches.length,
        sampleSize: samples.length,
        scannedFromIndex,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/pii-scans/:objectTypeApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName } = req.params;
      const result = await query(
        `SELECT p.* FROM pii_scan_result p
           JOIN object_type ot ON ot.object_type_id = p.object_type_id
          WHERE ot.ontology_id = $1 AND ot.api_name = $2
          ORDER BY p.scanned_at DESC`,
        [ontologyId, objectTypeApiName]
      );
      sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/usage/:objectTypeApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeApiName } = req.params;
      const days = 30;
      const today = Date.now();

      // Build the zero-filled skeleton so the sparkline always has 30
      // points — even on quiet days.
      const skeleton: Record<string, { day: string; reads: number; writes: number }> = {};
      for (let i = 0; i < days; i++) {
        const iso = new Date(today - (days - 1 - i) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        skeleton[iso] = { day: iso, reads: 0, writes: 0 };
      }

      // Pull real aggregated counts from the `usage_event_daily`
      // materialized view. If the view hasn't been created yet we fall
      // back to the zero sparkline so the UI still renders.
      try {
        const result = await query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, operation, n
             FROM usage_event_daily
            WHERE resource_type = 'objectType'
              AND resource_id = $1
              AND day > now() - interval '30 days'`,
          [objectTypeApiName]
        );
        for (const row of result.rows) {
          const bucket = skeleton[row.day as string];
          if (!bucket) continue;
          if ((row.operation as string) === "read") {
            bucket.reads += Number(row.n);
          } else {
            bucket.writes += Number(row.n);
          }
        }
      } catch {
        /* matview missing — skeleton already zero-filled */
      }

      sendSuccess(res, { series: Object.values(skeleton) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Refresh the usage_event_daily matview. Should be called from a
 * background scheduler every 60s per spec §Task 30. Exposed as an admin
 * endpoint so operators can also trigger it manually.
 */
router.post(
  "/usage/refresh",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await query("REFRESH MATERIALIZED VIEW CONCURRENTLY usage_event_daily");
      sendSuccess(res, { refreshedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
