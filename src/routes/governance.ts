// ---------------------------------------------------------------------------
// Governance routes — Ontology Platform spec Task 30
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/governance
//   GET  /lineage/:objectTypeApiName       — lineage DAG up to depth 5  (legacy, by api_name)
//   GET  /lineage/by-id/:objectTypeId      — lineage DAG, keyed by UUID
//   POST /pii-scans/:objectTypeApiName     — trigger a PII scan
//   GET  /pii-scans/:objectTypeApiName     — list scan results
//   GET  /usage/:objectTypeApiName         — usage sparkline (legacy, by api_name)
//   GET  /usage/by-id/:objectTypeId        — usage sparkline, keyed by UUID
//
// Why the by-id variants exist: api_name is mutable. Routing/caching off
// api_name means a rename silently invalidates every downstream hook that
// asks "what's the lineage/usage of this object type?". UUID/RID is the
// stable identity, so production callers should use the by-id routes;
// the api_name routes are kept for backwards-compat with older clients.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { computeLineage, MAX_LINEAGE_DEPTH } from "../services/lineageService";
import ProvenanceService from "../services/security/provenanceService";
import CellMarkingService from "../services/security/cellMarkingService";
import { scanObjectType } from "../services/piiScanner";
import { searchObjects } from "../services/opensearch/client";
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { incCounter } from "../services/funnel/metrics";
import { dataPlaneGuard } from "../middleware/requireRole";
import { objectTypeIndexName } from "../services/opensearch/objectIndexNames";

const router = Router({ mergeParams: true });

// FOUNDRY-GAPS §8 — unified who-touched-this-data provenance. One service
// instance reused across requests (it holds no per-request state; the `query`
// pool is shared).
const provenanceService = new ProvenanceService();
const cellMarkingService = new CellMarkingService();

// Function-level authorization: triggering a PII scan / refreshing usage are
// privileged writes (ontology-editor). Lineage/usage GETs stay open and keep
// their own marking-aware security filter (PATs scope-gated upstream,
// superadmin passes).
router.use(dataPlaneGuard({ post: "write" }));

const PII_SCAN_BATCH_SIZE = 1000;

// Strict UUID v1-v5 matcher. Used by the by-id routes to reject malformed
// path params with a 400 instead of leaking a `null` row to the underlying
// SQL. Keep aligned with `objectTypeService.UUID_REGEX`.
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve `(ontologyId, objectTypeId UUID)` → `api_name`. Centralised so
 * both `/lineage/by-id/...` and `/usage/by-id/...` share one validation
 * path. Returns either the api_name or a typed error object the caller
 * forwards verbatim to `sendError`.
 */
async function resolveApiNameById(
  ontologyId: string,
  objectTypeId: string
): Promise<{ ok: true; apiName: string } | { ok: false; code: string; message: string }> {
  if (!UUID_REGEX.test(objectTypeId)) {
    return {
      ok: false,
      code: "INVALID_PARAMETER",
      message: `'${objectTypeId}' is not a valid object type UUID.`,
    };
  }
  const row = await query(
    "SELECT api_name FROM object_type WHERE ontology_id = $1 AND object_type_id = $2",
    [ontologyId, objectTypeId]
  );
  if (row.rowCount === 0) {
    return {
      ok: false,
      code: "OBJECT_TYPE_NOT_FOUND",
      message: `Object type '${objectTypeId}' not found in ontology '${ontologyId}'.`,
    };
  }
  return { ok: true, apiName: row.rows[0].api_name as string };
}

/**
 * Cached `to_regclass()` existence check for the usage_event_daily
 * matview. The matview is created in `migrate.ts` only when the
 * upstream `usage_event` table exists (Phase 2 telemetry feature).
 * In dev environments without that telemetry stack, the matview
 * never gets created — and every call to /usage/:apiName would
 * spam the global PG-error logger ("relation 'usage_event_daily'
 * does not exist") before our try/catch swallowed the throw.
 *
 * Caching the regclass result means we only emit one schema-probe
 * query at startup, instead of once per usage-sparkline request.
 * The cache is invalidated automatically on backend restart, which
 * is when migrations re-run anyway.
 */
let usageMatviewExists: boolean | null = null;
async function usageEventDailyExists(): Promise<boolean> {
  if (usageMatviewExists !== null) return usageMatviewExists;
  try {
    const r = await query(
      `SELECT to_regclass('public.usage_event_daily') IS NOT NULL AS present`
    );
    usageMatviewExists = Boolean(r.rows[0]?.present);
  } catch {
    usageMatviewExists = false;
  }
  return usageMatviewExists;
}

/**
 * Build the 30-day usage sparkline for an object type given its api_name.
 * The matview `usage_event_daily` is keyed on api_name today; switching
 * to UUID is a separate ticket. Both `/usage/:apiName` and
 * `/usage/by-id/:objectTypeId` share this helper so the wire shape stays
 * identical between the two routes.
 *
 * Behaviour when the matview is missing (telemetry stack not deployed):
 * we short-circuit to the zero-filled skeleton WITHOUT issuing the
 * doomed SELECT. This silences the spurious `relation … does not exist`
 * stderr noise that would otherwise fire on every page load and
 * pollute the logs.
 */
async function buildUsageSparkline(
  apiName: string
): Promise<{ series: Array<{ day: string; reads: number; writes: number }> }> {
  const days = 30;
  const today = Date.now();
  const skeleton: Record<string, { day: string; reads: number; writes: number }> = {};
  for (let i = 0; i < days; i++) {
    const iso = new Date(today - (days - 1 - i) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    skeleton[iso] = { day: iso, reads: 0, writes: 0 };
  }
  if (!(await usageEventDailyExists())) {
    return { series: Object.values(skeleton) };
  }
  try {
    const result = await query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, operation, n
         FROM usage_event_daily
        WHERE resource_type = 'objectType'
          AND resource_id = $1
          AND day > now() - interval '30 days'`,
      [apiName]
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
    /* matview was dropped between probe and query — fall through to zeros */
  }
  return { series: Object.values(skeleton) };
}

// UUID-keyed lineage. Declared BEFORE the api_name route so Express's
// first-match routing picks the more specific `/by-id/...` path before
// falling through to `/:objectTypeApiName`.
router.get(
  "/lineage/by-id/:objectTypeId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeId } = req.params;
      const resolved = await resolveApiNameById(ontologyId, objectTypeId);
      if (!resolved.ok) {
        return sendError(res, resolved.code, resolved.message);
      }
      const depth = Math.min(
        parseInt((req.query.depth as string) || String(MAX_LINEAGE_DEPTH), 10),
        MAX_LINEAGE_DEPTH
      );
      const graph = await computeLineage(ontologyId, resolved.apiName, depth);
      sendSuccess(res, graph);
    } catch (err) {
      next(err);
    }
  }
);

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

// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §8 — unified provenance ("who touched this data?").
//
// Joins the four separately-audited streams (dataset_lineage data-flow +
// read audit + action/write audit + CBAC decisions + purpose grants) into one
// record for a single object instance. Read-only; inherits the same auth chain
// and marking-aware posture as the lineage/usage GETs above.
//
//   GET /provenance/:objectTypeApiName/:primaryKey
//   GET /provenance/by-id/:objectTypeId/:primaryKey   (stable UUID key)
// ---------------------------------------------------------------------------
function parseProvenanceQuery(req: Request): { limit?: number; lineageDepth?: number } {
  const limit = parseInt((req.query.limit as string) ?? "", 10);
  const depth = parseInt((req.query.depth as string) ?? "", 10);
  return {
    limit: Number.isFinite(limit) ? limit : undefined,
    lineageDepth: Number.isFinite(depth) ? depth : undefined,
  };
}

router.get(
  "/provenance/by-id/:objectTypeId/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeId, primaryKey } = req.params;
      const resolved = await resolveApiNameById(ontologyId, objectTypeId);
      if (!resolved.ok) {
        return sendError(res, resolved.code, resolved.message);
      }
      const result = await provenanceService.getObjectProvenance({
        ontologyId,
        objectTypeApiName: resolved.apiName,
        primaryKey,
        ...parseProvenanceQuery(req),
      });
      sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/provenance/:objectTypeApiName/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName, primaryKey } = req.params;
      const result = await provenanceService.getObjectProvenance({
        ontologyId,
        objectTypeApiName,
        primaryKey,
        ...parseProvenanceQuery(req),
      });
      sendSuccess(res, result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §8 — cell-level security markings (migration 102).
//
//   GET  /cell-markings/:objectTypeApiName/:primaryKey            — list cells
//   PUT  /cell-markings/:objectTypeApiName/:primaryKey/:property  — set markings
//
// Setting a cell marking is a privileged governance write (the router-level
// dataPlaneGuard already gates POST→write; PUT is gated here explicitly). An
// empty markings array tombstones the cell (visible to all) without losing the
// "was once marked" history.
// ---------------------------------------------------------------------------
router.get(
  "/cell-markings/:objectTypeApiName/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeApiName, primaryKey } = req.params;
      const cells = await cellMarkingService.getForObject(objectTypeApiName, primaryKey);
      sendSuccess(res, { objectTypeApiName, primaryKey, cells });
    } catch (err) {
      next(err);
    }
  }
);

// The router-level dataPlaneGuard already routes PUT → requireOntologyWrite.
router.put(
  "/cell-markings/:objectTypeApiName/:primaryKey/:propertyApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeApiName, primaryKey, propertyApiName } = req.params;
      const markings = Array.isArray(req.body?.markings)
        ? (req.body.markings as unknown[]).filter((m): m is string => typeof m === "string")
        : null;
      if (markings === null) {
        return sendError(res, "INVALID_PARAMETER", "Body must include a `markings` string array.");
      }
      const setBy =
        ((req as unknown as { auth?: { preferred_username?: string; sub?: string } }).auth
          ?.preferred_username) ||
        ((req as unknown as { auth?: { sub?: string } }).auth?.sub) ||
        "system";
      await cellMarkingService.set({
        objectTypeApiName,
        primaryKey,
        propertyApiName,
        markings,
        ontologyId: ontologyId ?? null,
        setBy,
      });
      sendSuccess(res, { objectTypeApiName, primaryKey, propertyApiName, markings });
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
            objectTypeIndexName(objectTypeApiName),
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

// UUID-keyed usage sparkline. Declared BEFORE the api_name route so the
// `/by-id/...` path wins under Express's first-match routing.
router.get(
  "/usage/by-id/:objectTypeId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, objectTypeId } = req.params;
      const resolved = await resolveApiNameById(ontologyId, objectTypeId);
      if (!resolved.ok) {
        return sendError(res, resolved.code, resolved.message);
      }
      const data = await buildUsageSparkline(resolved.apiName);
      sendSuccess(res, data);
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
      const data = await buildUsageSparkline(objectTypeApiName);
      sendSuccess(res, data);
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
