/**
 * /api/v1/timeseries — time-series property I/O endpoints.
 * Implements feature #13 from the spec.
 */

import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

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
