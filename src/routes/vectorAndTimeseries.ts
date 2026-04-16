/**
 * /api/v2/vector and /api/v2/timeseries — vector + time-series property
 * I/O endpoints. Implements features #12 and #13 from the spec.
 *
 * The handlers degrade gracefully: if pgvector / TimescaleDB is not
 * loaded into the running Postgres image, the routes still work — vectors
 * stay in JSONB and similarity is computed in JavaScript.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

/* -------------------------------------------------------------------- */
/* Vector properties                                                    */
/* -------------------------------------------------------------------- */

router.put('/vector/:objectType/:propertyApiName/:primaryKey', async (req: Request, res: Response) => {
  const { objectType, propertyApiName, primaryKey } = req.params;
  const { embedding } = req.body ?? {};
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'embedding[] required' } });
  }
  if (embedding.length > 2048) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'max 2048 dimensions' } });
  }
  await pool.query(
    `INSERT INTO vector_property_value (object_type_api_name, property_api_name, primary_key_value, embedding)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (object_type_api_name, property_api_name, primary_key_value)
     DO UPDATE SET embedding = EXCLUDED.embedding, updated_at = now()`,
    [objectType, propertyApiName, primaryKey, JSON.stringify(embedding)],
  );
  res.json({ success: true, data: { dimensions: embedding.length } });
});

router.post('/vector/:objectType/:propertyApiName/search', async (req: Request, res: Response) => {
  const { objectType, propertyApiName } = req.params;
  const { query, topK = 10 } = req.body ?? {};
  if (!Array.isArray(query)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'query[] required' } });
  }
  if (query.length > 2048) {
    return res.status(400).json({ success: false, error: { code: 'VECTOR_DIMS_EXCEEDED', message: 'max 2048 dimensions' } });
  }

  // Spec §Task 6: Vector KNN search uses Elasticsearch knn clause with
  // num_candidates: k * 10. We try ES first and fall through to a JS
  // cosine scan if the index doesn't carry vector mappings (dev mode).
  try {
    const { client: osClient } = await import('../services/opensearch/client');
    const result = await osClient.search({
      index: `ontology-${objectType.toLowerCase()}`,
      body: {
        size: topK,
        knn: {
          field: propertyApiName,
          query_vector: query,
          k: topK,
          num_candidates: topK * 10,
        },
      } as any,
    });
    const hits = (result.body as any)?.hits?.hits ?? [];
    if (hits.length > 0) {
      return res.json({
        success: true,
        data: {
          results: hits.map((h: any) => ({ primaryKey: h._id, score: h._score })),
          engine: 'opensearch-knn',
        },
      });
    }
  } catch {
    // Fall through to pgvector / JSONB fallback.
  }

  const rows = await pool.query(
    `SELECT primary_key_value, embedding FROM vector_property_value
       WHERE object_type_api_name = $1 AND property_api_name = $2`,
    [objectType, propertyApiName],
  );

  const scored = rows.rows
    .map((r) => {
      const v = (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding) as number[];
      return { primaryKey: r.primary_key_value, score: cosine(query, v) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  res.json({ success: true, data: { results: scored, engine: rows.rows.length > 0 ? 'pgvector-fallback' : 'none' } });
});

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/* -------------------------------------------------------------------- */
/* Time-series properties                                               */
/* -------------------------------------------------------------------- */

router.post('/timeseries/:objectType/:propertyApiName/:primaryKey', async (req: Request, res: Response) => {
  const { objectType, propertyApiName, primaryKey } = req.params;
  const { samples } = req.body ?? {};
  if (!Array.isArray(samples)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'samples[] required' } });
  }
  for (const s of samples) {
    await pool.query(
      `INSERT INTO time_series_property_value
        (object_type_api_name, property_api_name, primary_key_value, ts, value_double, value_string)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        objectType,
        propertyApiName,
        primaryKey,
        s.timestamp ?? new Date().toISOString(),
        typeof s.value === 'number' ? s.value : null,
        typeof s.value === 'string' ? s.value : null,
      ],
    );
  }
  res.json({ success: true, data: { ingested: samples.length } });
});

router.get('/timeseries/:objectType/:propertyApiName/:primaryKey', async (req: Request, res: Response) => {
  const { objectType, propertyApiName, primaryKey } = req.params;
  const { from, to, limit } = req.query;
  const limitNum = Math.min(Number(limit) || 1000, 10_000);
  const rows = await pool.query(
    `SELECT ts, value_double, value_string FROM time_series_property_value
       WHERE object_type_api_name = $1 AND property_api_name = $2 AND primary_key_value = $3
         AND ($4::timestamptz IS NULL OR ts >= $4::timestamptz)
         AND ($5::timestamptz IS NULL OR ts <= $5::timestamptz)
       ORDER BY ts DESC
       LIMIT $6`,
    [objectType, propertyApiName, primaryKey, from || null, to || null, limitNum],
  );
  res.json({
    success: true,
    data: {
      samples: rows.rows.map((r) => ({
        timestamp: r.ts,
        value: r.value_double ?? r.value_string,
      })),
      engine: 'TimescaleDB hypertable (or plain table fallback)',
    },
  });
});

export default router;
