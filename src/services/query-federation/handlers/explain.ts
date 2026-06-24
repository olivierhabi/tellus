// ---------------------------------------------------------------------------
// B8 — POST /api/v2/federation/explain (spec §B8 line 408).
//
// Returns the pushdown plan tree without executing the query. Useful for
// query-optimizer UI + tooling.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { loadFederationAdapter } from "../engine-adapter";

export async function postExplain(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body as { virtualTableRid?: string } & Record<string, unknown>;
    if (!body || typeof body.virtualTableRid !== "string") {
      res.status(400).json({
        errorCode: "INVALID_ARGUMENT",
        errorName: "Tellus:Federation:InvalidPlan",
        parameters: { reason: "virtualTableRid required" },
      });
      return;
    }
    const adapter = await loadFederationAdapter();
    const pd = await adapter.explain(body as any);
    res.json({ plan: pd });
  } catch (err) {
    next(err);
  }
}
