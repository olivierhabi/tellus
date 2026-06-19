// ---------------------------------------------------------------------------
// B8 — Federation HTTP handlers (spec §B8 line 407).
//
// POST /api/v2/federation/query
//   Body: { virtualTableRid, project, where?, aggregate?, limit?, orderBy? }
//   Response: application/vnd.apache.arrow.stream (or application/json
//     fallback when apache-arrow isn't installed; documented in DEVIATIONS)
//
// Authorization: caller's Multipass token must hold connectivity:read on
// the underlying connection. Check enforced before dispatch.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { pool } from "../../db";
import { loadFederationAdapter } from "./engine-adapter";

export async function postQuery(
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
    // Authorization: ensure vt exists and the caller has read on its connection.
    const meta = await pool.query<{ connection_rid: string }>(
      `SELECT connection_rid FROM virtual_tables WHERE rid=$1 AND deleted_at IS NULL`,
      [body.virtualTableRid],
    );
    if (meta.rowCount === 0) {
      res.status(404).json({
        errorCode: "NOT_FOUND",
        errorName: "Tellus:Federation:VirtualTableNotFound",
        parameters: { rid: body.virtualTableRid },
      });
      return;
    }
    const scopes: string[] = (req as any).user?.scopes ?? [];
    if (!scopes.includes("connectivity:read")) {
      res.status(403).json({
        errorCode: "PERMISSION_DENIED",
        errorName: "Tellus:Federation:ScopeMissing",
        parameters: { required: "connectivity:read" },
      });
      return;
    }

    const adapter = await loadFederationAdapter();
    const result = await adapter.execute(body as any);
    res
      .status(200)
      .set("content-type", "application/vnd.apache.arrow.stream")
      .set("x-tellus-pushdown", JSON.stringify(result.pushdownPlan.pushed));
    result.stream.on("error", (e) => {
      // eslint-disable-next-line no-console
      console.error("[federation.query] stream error", e.message);
      try {
        res.destroy(e);
      } catch {
        /* */
      }
    });
    result.stream.pipe(res);
  } catch (err) {
    next(err);
  }
}
