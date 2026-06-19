// ---------------------------------------------------------------------------
// /api/v1/compass/folders/:folderRid/children
//
// Production unified Compass Gateway endpoint. Replaces the 5 fan-out
// /v1/projects/<id>/{folders,datasets,pipelines} + /v1/workshop/modules
// + /v1/code-repositories calls the project workspace used to make.
// ---------------------------------------------------------------------------
import { Router, Request, Response, NextFunction } from "express";
import { getChildren } from "../services/compassChildrenService";
import { ChildrenQuery, ChildrenResponse } from "../types/compassChildren";

const router = Router();

router.get("/folders/:folderRid/children", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Validate query at the trust boundary — fail-loud on bad input.
    const parsed = ChildrenQuery.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        errorName: "INVALID_ARGUMENT",
        message: "Invalid query parameters",
        issues: parsed.error.issues,
      });
    }
    const folderRid = decodeURIComponent(req.params.folderRid);
    const start = Date.now();
    const result = await getChildren({
      folderRid,
      pageSize: parsed.data.pageSize,
      pageToken: parsed.data.pageToken,
      kinds: parsed.data.kinds,
      search: parsed.data.search,
      includeArchived: parsed.data.includeArchived,
    });

    // Validate at the trust boundary on the way OUT — guarantees the
    // response shape never drifts from the contract clients depend on.
    const out = ChildrenResponse.safeParse(result);
    if (!out.success) {
       
      console.error("[compassChildrenV2] response shape drift:", out.error.issues);
      return res.status(500).json({
        errorName: "INTERNAL",
        message: "Response failed schema validation",
      });
    }

    res.setHeader("X-Compass-Children-Latency-Ms", String(Date.now() - start));
    res.setHeader("X-Compass-Children-Source-Count", String(out.data.items.length));
    res.json(out.data);
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    if (e.status === 400 || e.code === "INVALID_FOLDER_RID") {
      return res.status(400).json({ errorName: "INVALID_ARGUMENT", message: e.message });
    }
    if (e.status === 404 || e.code === "FOLDER_NOT_FOUND") {
      return res.status(404).json({ errorName: "FOLDER_NOT_FOUND", message: e.message });
    }
    next(err);
  }
});

export default router;
