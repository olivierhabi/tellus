// ---------------------------------------------------------------------------
// Geo endpoints — Ontology Platform spec Task 22
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/geo
//   POST /:objectTypeApiName/geohash    — geohash bucket aggregation
//   POST /:objectTypeApiName/choropleth — country/state aggregation
//
// Note: these routes delegate to OpenSearch via the existing searchService
// when available; otherwise they return an empty-bucket response so the UI
// can render a "no geo data" state deterministically.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { searchObjects } from "../services/opensearch/client";
import { mapFilters } from "../services/opensearch/filterMapper";
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { incCounter } from "../services/funnel/metrics";
import { objectTypeIndexName } from "../services/opensearch/objectIndexNames";

const router = Router({ mergeParams: true });

// GeoHash precision mapping by zoom level. Level 0 = world, 18 = building.
function precisionForZoom(zoom: number): number {
  if (zoom <= 2) return 3;
  if (zoom <= 5) return 4;
  if (zoom <= 9) return 5;
  if (zoom <= 13) return 6;
  return 7;
}

router.post(
  "/:objectTypeApiName/geohash",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeApiName } = req.params;
      const { geopointProperty, zoom = 4, filter = [] } = req.body || {};
      if (!geopointProperty) {
        return sendError(res, "VALIDATION_FAILED", "geopointProperty is required.");
      }
      const precision = precisionForZoom(Number(zoom));
      const filterClause = Array.isArray(filter) && filter.length
        ? mapFilters(filter)
        : { match_all: {} };
      const body = {
        size: 0,
        query: filterClause,
        aggs: {
          geo: {
            geohash_grid: { field: geopointProperty, precision },
          },
        },
      };
      try {
        // F-P3-13: thread branch filter to isolate per-branch geo aggregations.
        const branchId = readBranchHeader(req);
        incCounter("tellus_read_branch_filtered_total", {
          route: "geo.geohash",
          scoped: String(branchId !== null),
        });
        const result = await searchObjects(
          objectTypeIndexName(objectTypeApiName),
          body,
          buildSecurityFilter(req.security),
          branchId
        );
        const buckets = result.body?.aggregations?.geo?.buckets ?? [];
        sendSuccess(res, { precision, buckets, geopointProperty });
      } catch {
        // Index missing or ES unavailable — fall through with empty buckets.
        sendSuccess(res, {
          precision,
          buckets: [],
          geopointProperty,
          warning: "search_index_unavailable",
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:objectTypeApiName/choropleth",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectTypeApiName } = req.params;
      const { regionProperty, level = "country", filter = [] } = req.body || {};
      if (!regionProperty) {
        return sendError(res, "VALIDATION_FAILED", "regionProperty is required.");
      }
      if (!["country", "state"].includes(level)) {
        return sendError(res, "VALIDATION_FAILED", "level must be country or state.");
      }
      const filterClause = Array.isArray(filter) && filter.length
        ? mapFilters(filter)
        : { match_all: {} };
      const body = {
        size: 0,
        query: filterClause,
        aggs: {
          regions: {
            terms: { field: regionProperty, size: 1000 },
          },
        },
      };
      try {
        // F-P3-13: thread branch filter to isolate per-branch choropleth aggregations.
        const branchId = readBranchHeader(req);
        incCounter("tellus_read_branch_filtered_total", {
          route: "geo.choropleth",
          scoped: String(branchId !== null),
        });
        const result = await searchObjects(
          objectTypeIndexName(objectTypeApiName),
          body,
          buildSecurityFilter(req.security),
          branchId
        );
        const regions = result.body?.aggregations?.regions?.buckets ?? [];
        sendSuccess(res, { level, regions, regionProperty });
      } catch {
        sendSuccess(res, {
          level,
          regions: [],
          regionProperty,
          warning: "search_index_unavailable",
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

export default router;
