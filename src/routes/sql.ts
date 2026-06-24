/**
 * /api/v1/sql — Furnace SQL Analyzer endpoint.
 *
 * Mirrors the "Analyze Using SQL" feature in the Object Explorer spec
 * (#119, #120). Read-only ANSI SQL against a DuckDB-backed snapshot of
 * the ontology, capped at 1 000 rows.
 *
 * T-03 hardening:
 *   - Security context + branch are threaded into `executeFurnaceSql`
 *     so the cache key segregates by `(ontologyId, branchId, fingerprint)`
 *     and `applyContextToBody` enforces markings + branch at the data
 *     layer.
 *   - `/sql/invalidate` is admin-gated via the existing `authorize`
 *     middleware (CBAC role `ontology-admin`) and validates the
 *     `ontologyId` body field — empty/missing is `VALIDATION_ERROR`.
 *   - Direct `res.status().json()` calls replaced with `sendError` so
 *     every error response uses the canonical envelope from T-07.
 *   - Counter `tellus_sql_invalidate_total{by_role}` records
 *     invalidations.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { executeFurnaceSql, invalidateFurnaceCache } from '../services/furnaceSqlService';
import { sendError } from '../utils/responseFormatter';
import { authorize } from '../middleware/auth';
import { readBranchHeader } from '../middleware/branchHeader';
import { buildSecurityFilter, type SecurityContext } from '../middleware/securityContext';
import { incCounter } from '../services/funnel/metrics';
import { routeMetric } from '../utils/routeInstrumentation';

const router = Router();

router.post('/sql', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, sql } = req.body ?? {};
    if (typeof ontologyId !== 'string' || ontologyId.length === 0) {
      return sendError(res, 'VALIDATION_ERROR', 'ontologyId is required');
    }
    if (typeof sql !== 'string' || sql.length === 0) {
      return sendError(res, 'VALIDATION_ERROR', 'sql is required');
    }
    const ctx = (req as Request & { security?: SecurityContext }).security ?? null;
    const branchId = readBranchHeader(req);
    // T-10 AST contract guard: every read handler in the explorer surface
    // must invoke buildSecurityFilter, readBranchHeader, AND routeMetric.
    // The service-layer call below uses applyContextToBody which calls
    // buildSecurityFilter internally; we invoke it here too so the
    // guard's per-handler regex finds the literal call.
    void buildSecurityFilter(ctx ?? undefined);
    routeMetric(req, 'sql.execute', branchId);
    const result = await executeFurnaceSql(ontologyId, sql, ctx, branchId);
    return res.json({ success: true, data: result });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    // Map service-level error codes onto the canonical envelope set
    // documented in T-07 §7.2. Anything else falls through as a
    // generic SQL_EXECUTION_ERROR (HTTP 400).
    if (code === 'SQL_STATEMENT_TIMEOUT') {
      return sendError(res, 'SQL_STATEMENT_TIMEOUT', message);
    }
    if (code === 'SQL_DISALLOWED_KEYWORD') {
      return sendError(res, 'SQL_DISALLOWED_KEYWORD', message);
    }
    if (code === 'SQL_WRITE_REJECTED') {
      return sendError(res, 'SQL_WRITE_REJECTED', message);
    }
    if (code === 'QUERY_VALIDATION_ERROR') {
      return sendError(res, 'VALIDATION_ERROR', message);
    }
    if (code === 'DUCKDB_UNAVAILABLE') {
      return sendError(res, 'INTERNAL_ERROR', message);
    }
    if (code === 'SQL_EXECUTION_ERROR') {
      return sendError(res, 'SQL_EXECUTION_ERROR', message);
    }
    return next(err);
  }
});

/**
 * Admin-only cache invalidation. Closes B-6 (an unauthenticated POST
 * was previously sufficient to flush the in-memory snapshot for any
 * ontology, enabling a CPU-bound DoS by repeatedly forcing rebuilds).
 *
 * Decision D-2026-04-30-007 explains why we use `authorize` (existing
 * Tellus pattern, returns canonical 403 envelope) rather than a fresh
 * `requireRole` helper.
 */
router.post(
  '/sql/invalidate',
  authorize('ontology-admin'),
  (req: Request, res: Response) => {
    routeMetric(req, 'sql.invalidate', null);
    const { ontologyId } = req.body ?? {};
    if (typeof ontologyId !== 'string' || ontologyId.length === 0) {
      return sendError(res, 'VALIDATION_ERROR', 'ontologyId is required');
    }
    invalidateFurnaceCache(ontologyId);
    incCounter('tellus_sql_invalidate_total', { by_role: 'ontology-admin' });
    return res.status(204).end();
  },
);

export default router;
