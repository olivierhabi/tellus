// ---------------------------------------------------------------------------
// Comparison Views — Ontology Platform spec Task 26
// ---------------------------------------------------------------------------
// Mounted at /api/v2/ontologies/:ontologyId/comparisons
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
import { buildSecurityFilter } from "../middleware/securityContext";

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

      const security = buildSecurityFilter(req.security);
      const wrapWithSecurity = (q: Record<string, unknown>): Record<string, unknown> =>
        security ? { bool: { must: [q, security] } } : q;

      const index = `ontology-${objectTypeApiName.toLowerCase()}`;
      const msearchBody: unknown[] = [
        { index },
        buildAggBody(wrapWithSecurity(buildQuery(setA.filter))),
        { index },
        buildAggBody(wrapWithSecurity(buildQuery(setB.filter))),
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
