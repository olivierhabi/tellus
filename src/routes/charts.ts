/**
 * /api/v1/charts — OpenSearch-backed batch chart aggregations.
 *
 * T-02: The four legacy PG-direct chart endpoints
 * (`/charts/{listogram,histogram,dateHistogram,auto}`) and the
 * `loadObjectRows` 5000-row PG sample helper they shared have been
 * deleted. The PG-direct read path bypassed `injectSecurityFilter`
 * (markings + branch context); fixing it in place would have required
 * re-implementing the OpenSearch security filter against PG, which
 * duplicates the read-path semantics. Delete is the cheaper and safer
 * fix. All chart UI traffic flows through `/charts/batch` below.
 *
 * Frontend coordination is an operational concern (see
 * decisions/object-explorer/D-2026-04-30-006-fe-coordination-deferred.md):
 * a Phase-A FE migration must precede production deploy of this PR. The
 * backend is engineering-complete; release gating is documented in
 * tasks/object-explorer/PROGRESS.md.
 */

import { Router, Request, Response } from 'express';
import { client as osClient } from '../services/opensearch/client';
import { applyContextToQuery } from '../services/opensearch/applyContext';
import { buildSecurityFilter } from '../middleware/securityContext';
import { readBranchHeader } from '../middleware/branchHeader';
import { sendError } from '../utils/responseFormatter';
import { routeMetric } from '../utils/routeInstrumentation';
import { objectTypeIndexName } from "../services/opensearch/objectIndexNames";

const router = Router();

// Spec §Task 21 constants
const TERMS_AGG_SIZE = 100;
/** Histogram auto-bucketing: 1.5 * sqrt(doc_count), capped at 50 buckets. */
function autoBucketCount(docCount: number): number {
  if (docCount <= 1) return 1;
  return Math.min(Math.max(Math.round(1.5 * Math.sqrt(docCount)), 5), 50);
}

/**
 * Batch chart endpoint — Spec §Task 21:
 *   "One Elasticsearch multi-search `_msearch` call for ALL charts
 *    (not N separate calls). Terms agg `size: 100`. Histogram
 *    auto-bucketing: `1.5 * sqrt(doc_count)` buckets."
 *
 * Request body:
 *   {
 *     objectType: "flight",
 *     specs: [
 *       { type: "terms",          field: "status" },
 *       { type: "histogram",      field: "ticketPrice" },
 *       { type: "date_histogram", field: "departureTime", interval: "1d" }
 *     ]
 *   }
 */
router.post('/charts/batch', async (req: Request, res: Response) => {
  try {
    const { objectType, specs = [] } = req.body ?? {};
    if (!objectType || !Array.isArray(specs) || specs.length === 0) {
      return sendError(res, 'VALIDATION_ERROR', 'objectType and specs[] required');
    }

    const index = objectTypeIndexName(String(objectType));
    // T-01: every read-path query runs through the canonical
    // `applyContextToQuery` helper. The local `withSecurity` lambda
    // that previously lived here is intentionally deleted.
    const security = buildSecurityFilter((req as any).security);
    const branchId = readBranchHeader(req);
    const applyCtx = (q: Record<string, unknown>): Record<string, unknown> =>
      applyContextToQuery(q, security, branchId);

    // Cardinality-bounded route metric. The route enum lives in
    // src/utils/routeInstrumentation.ts so the AST contract guard can
    // validate every handler at PR time (see T-10).
    routeMetric(req, 'charts.batch', branchId);

    // First pass: get a single doc count so we can auto-bucket histograms.
    let docCount = 0;
    try {
      const countRes = await osClient.count({
        index,
        body: { query: applyCtx({ match_all: {} }) as any },
      });
      docCount = Number((countRes.body as any)?.count ?? 0);
    } catch {
      docCount = 0;
    }

    const buckets = autoBucketCount(docCount);

    const msearchBody: unknown[] = [];
    for (const spec of specs) {
      msearchBody.push({ index });
      // The `aggs` block is NOT wrapped — only the per-sub-body
      // `query` field.
      if (spec.type === 'terms') {
        msearchBody.push({
          size: 0,
          query: applyCtx({ match_all: {} }),
          aggs: {
            chart: {
              terms: { field: spec.field, size: TERMS_AGG_SIZE },
            },
          },
        });
      } else if (spec.type === 'histogram') {
        msearchBody.push({
          size: 0,
          query: applyCtx({ match_all: {} }),
          aggs: {
            chart: {
              histogram: {
                field: spec.field,
                interval: spec.interval ?? Math.max(1, Math.floor(100 / buckets)),
              },
            },
          },
        });
      } else if (spec.type === 'date_histogram') {
        msearchBody.push({
          size: 0,
          query: applyCtx({ match_all: {} }),
          aggs: {
            chart: {
              date_histogram: {
                field: spec.field,
                calendar_interval: spec.interval || '1d',
              },
            },
          },
        });
      } else {
        msearchBody.push({ size: 0, query: applyCtx({ match_all: {} }) });
      }
    }

    let charts: Array<{ spec: unknown; buckets: unknown[] }> = specs.map(
      (s: unknown) => ({ spec: s, buckets: [] }),
    );
    try {
      const result = await osClient.msearch({ body: msearchBody as any });
      const responses = (result.body as any)?.responses ?? [];
      charts = specs.map((s: unknown, i: number) => ({
        spec: s,
        buckets: responses[i]?.aggregations?.chart?.buckets ?? [],
      }));
    } catch {
      // Index missing — leave empty buckets.
    }

    res.json({
      success: true,
      data: {
        charts,
        docCount,
        autoBuckets: buckets,
        engine: 'opensearch-msearch',
      },
    });
  } catch (err) {
    sendError(res, 'CHART_ERROR', (err as Error).message);
  }
});

export default router;
