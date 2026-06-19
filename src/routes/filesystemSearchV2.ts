// F5.04 — GET /api/v2/filesystem/search
// Lightweight search over resources by display_name. Not OSS-grade —
// this is the QuickOpen-friendly fallback that hits Postgres directly
// using ILIKE; the heavy-duty OSS endpoint is /api/v2/oss/search.
import { Router, Request, Response, NextFunction } from "express";
import { pool } from "../db";

const router = Router();

router.get("/search", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = (req.query.q as string | undefined) ?? "";
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 25)));
    const types = ((req.query.types as string | undefined) ?? "")
      .split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!q || q.length < 1) {
      return res.json({ results: [] });
    }
    const params: unknown[] = [`%${q}%`];
    let where = `display_name ILIKE $1 AND trash_status = 'NOT_TRASHED'`;
    if (types.length > 0) {
      params.push(types);
      where += ` AND type = ANY($${params.length}::text[])`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT rid, display_name, type, project_rid FROM resources WHERE ${where}
       ORDER BY display_name LIMIT $${params.length}`,
      params,
    );
    res.json({
      results: rows.map((r) => ({
        rid: r.rid as string,
        displayName: r.display_name as string,
        type: r.type as string,
        projectRid: r.project_rid as string | null,
      })),
    });
  } catch (err) { next(err); }
});

export default router;
