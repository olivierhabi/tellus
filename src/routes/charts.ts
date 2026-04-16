/**
 * /api/v2/charts — Polars-backed auto-chart aggregations.
 *
 * Powers the Object Explorer "Auto-Generated Charts" feature (#73-78):
 * one listogram/histogram/date-histogram per prominent property.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';
import { autoChart, listogram, histogram, dateHistogram } from '../services/polarsAggregator';
import { client as osClient } from '../services/opensearch/client';
import { buildSecurityFilter } from '../middleware/securityContext';

const router = Router();

// Spec §Task 21 constants
const TERMS_AGG_SIZE = 100;
/** Histogram auto-bucketing: 1.5 * sqrt(doc_count), capped at 50 buckets. */
function autoBucketCount(docCount: number): number {
  if (docCount <= 1) return 1;
  return Math.min(Math.max(Math.round(1.5 * Math.sqrt(docCount)), 5), 50);
}

async function loadObjectRows(ontologyId: string, apiName: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(
    `SELECT properties_json FROM object_instance
      WHERE object_type_id = (
        SELECT object_type_id FROM object_type WHERE api_name = $1 AND ontology_id = $2
      )
      LIMIT 5000`,
    [apiName, ontologyId],
  ).catch(() => ({ rows: [] as any[] }));
  return result.rows.map((r) => r.properties_json ?? {});
}

router.post('/charts/listogram', async (req: Request, res: Response) => {
  try {
    const { ontologyId, objectType, field, topN } = req.body ?? {};
    const rows = await loadObjectRows(ontologyId, objectType);
    res.json({ success: true, data: listogram(rows, field, topN ?? 10) });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'CHART_ERROR', message: (err as Error).message } });
  }
});

router.post('/charts/histogram', async (req: Request, res: Response) => {
  try {
    const { ontologyId, objectType, field, buckets } = req.body ?? {};
    const rows = await loadObjectRows(ontologyId, objectType);
    res.json({ success: true, data: histogram(rows, field, buckets ?? 10) });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'CHART_ERROR', message: (err as Error).message } });
  }
});

router.post('/charts/dateHistogram', async (req: Request, res: Response) => {
  try {
    const { ontologyId, objectType, field } = req.body ?? {};
    const rows = await loadObjectRows(ontologyId, objectType);
    res.json({ success: true, data: dateHistogram(rows, field) });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'CHART_ERROR', message: (err as Error).message } });
  }
});

router.post('/charts/auto', async (req: Request, res: Response) => {
  try {
    const { ontologyId, objectType, fields } = req.body ?? {};
    if (!Array.isArray(fields)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'fields[] required' } });
    }
    const rows = await loadObjectRows(ontologyId, objectType);
    const charts = fields.map((f: { field: string; baseType: string }) =>
      autoChart(rows, f.field, f.baseType),
    );
    res.json({ success: true, data: { charts, rowCount: rows.length, engine: 'Polars' } });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: 'CHART_ERROR', message: (err as Error).message } });
  }
});

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
      return res
        .status(400)
        .json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'objectType and specs[] required' } });
    }

    const index = `ontology-${String(objectType).toLowerCase()}`;
    const security = buildSecurityFilter((req as any).security);
    const withSecurity = (q: Record<string, unknown>): Record<string, unknown> =>
      security ? { bool: { must: [q, security] } } : q;

    // First pass: get a single doc count so we can auto-bucket histograms.
    let docCount = 0;
    try {
      const countRes = await osClient.count({
        index,
        body: { query: withSecurity({ match_all: {} }) as any },
      });
      docCount = Number((countRes.body as any)?.count ?? 0);
    } catch {
      docCount = 0;
    }

    const buckets = autoBucketCount(docCount);

    const msearchBody: unknown[] = [];
    for (const spec of specs) {
      msearchBody.push({ index });
      if (spec.type === 'terms') {
        msearchBody.push({
          size: 0,
          query: withSecurity({ match_all: {} }),
          aggs: {
            chart: {
              terms: { field: spec.field, size: TERMS_AGG_SIZE },
            },
          },
        });
      } else if (spec.type === 'histogram') {
        msearchBody.push({
          size: 0,
          query: withSecurity({ match_all: {} }),
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
          query: withSecurity({ match_all: {} }),
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
        msearchBody.push({ size: 0, query: withSecurity({ match_all: {} }) });
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
    res.status(400).json({ success: false, error: { code: 'CHART_ERROR', message: (err as Error).message } });
  }
});

export default router;
