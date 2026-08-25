// ---------------------------------------------------------------------------
// Comparison Views — Ontology Platform spec Task 26
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/comparisons
//
// POST /aggregate — dual aggregation in a single round trip
//
// Request body:
//   {
//     objectTypeApiName,
//     sharedFilter,            // applied to both sets
//     setA: { filter, label, color },
//     setB: { filter, label, color },
//     aggregation: { type: "terms"|"histogram"|"date_histogram", field, … }
//   }
//
// Response:
//   { setA: { buckets }, setB: { buckets }, palette: {…} }
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { mapFilters } from "../services/opensearch/filterMapper";
import { client as osClient } from "../services/opensearch/client";
import { applyContextToQuery } from "../services/opensearch/applyContext";
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { routeMetric } from "../utils/routeInstrumentation";
import { objectTypeIndexName } from "../services/opensearch/objectIndexNames";

const router = Router({ mergeParams: true });

const PALETTE = {
  A: "#2563eb",
  B: "#ea580c",
};

router.post(
  "/aggregate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeApiName, sharedFilter, setA, setB, aggregation } =
        req.body || {};
      if (!objectTypeApiName) {
        return sendError(res, "VALIDATION_FAILED", "objectTypeApiName is required.");
      }
      if (!setA || !setB) {
        return sendError(res, "VALIDATION_FAILED", "setA and setB are required.");
      }
      if (!aggregation?.type || !aggregation?.field) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "aggregation.type and aggregation.field are required."
        );
      }

      const buildQuery = (extra: unknown): Record<string, unknown> => {
        const filters = [
          ...(Array.isArray(sharedFilter) ? sharedFilter : []),
          ...(Array.isArray(extra) ? extra : []),
        ];
        return filters.length
          ? (mapFilters(filters) as unknown as Record<string, unknown>)
          : { match_all: {} };
      };

      // Strip the `type` discriminator before passing to ES — the actual
      // `terms` / `histogram` / `date_histogram` clause expects
      // {field, size, interval, …}.
      const { type: aggType, ...aggParams } = aggregation as Record<string, unknown>;
      const buildAggBody = (q: Record<string, unknown>) => ({
        size: 0,
        query: q,
        aggs: {
          comparison: {
            [aggType as string]: aggType === "terms"
              ? { size: 100, ...aggParams }
              : aggParams,
          },
        },
      });

      // T-01: every read-path query runs through the canonical
      // applyContextToQuery helper. The local "wrap-with-security"
      // lambda that previously lived here is intentionally deleted —
      // we no longer have two definitions of "apply request context
      // to a query" in the codebase.
      const security = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req);
      const applyCtx = (q: Record<string, unknown>): Record<string, unknown> =>
        applyContextToQuery(q, security, branchId);

      // Cardinality-bounded route metric. The route enum lives in
      // src/utils/routeInstrumentation.ts so the AST contract guard can
      // validate every handler at PR time (see T-10).
      routeMetric(req, "comparisons.aggregate", branchId);

      const index = objectTypeIndexName(objectTypeApiName);
      const msearchBody: unknown[] = [
        { index },
        // The `aggs` block is NOT wrapped — only the per-sub-body
        // `query` field. Aggregations operate over the result set
        // produced by the wrapped query.
        buildAggBody(applyCtx(buildQuery(setA.filter))),
        { index },
        buildAggBody(applyCtx(buildQuery(setB.filter))),
      ];

      let bucketsA: unknown[] = [];
      let bucketsB: unknown[] = [];
      try {
        const result = await osClient.msearch({ body: msearchBody as any });
        const responses = (result.body as any)?.responses ?? [];
        bucketsA =
          responses[0]?.aggregations?.comparison?.buckets ??
          responses[0]?.aggregations?.comparison?.values ??
          [];
        bucketsB =
          responses[1]?.aggregations?.comparison?.buckets ??
          responses[1]?.aggregations?.comparison?.values ??
          [];
      } catch {
        // ES unavailable — fall through with empty buckets so UI still renders.
      }

      sendSuccess(res, {
        palette: {
          A: setA.color || PALETTE.A,
          B: setB.color || PALETTE.B,
        },
        setA: {
          label: setA.label || "Set A",
          buckets: bucketsA,
        },
        setB: {
          label: setB.label || "Set B",
          buckets: bucketsB,
        },
        aggregation,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
