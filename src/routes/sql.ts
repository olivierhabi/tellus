/**
 * /api/v2/sql — Furnace SQL Analyzer endpoint.
 *
 * Mirrors the "Analyze Using SQL" feature in the Object Explorer spec
 * (#119, #120). Read-only ANSI SQL against a DuckDB-backed snapshot of
 * the ontology, capped at 1 000 rows.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { executeFurnaceSql, invalidateFurnaceCache } from '../services/furnaceSqlService';

const router = Router();

router.post('/sql', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, sql } = req.body ?? {};
    if (!ontologyId || typeof ontologyId !== 'string') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'ontologyId is required' },
      });
    }
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'sql is required' },
      });
    }
    const result = await executeFurnaceSql(ontologyId, sql);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'SQL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
});

router.post('/sql/invalidate', (req: Request, res: Response) => {
  const { ontologyId } = req.body ?? {};
  invalidateFurnaceCache(ontologyId);
  res.json({ success: true, data: { invalidated: ontologyId ?? 'all' } });
});

export default router;
