// B6.07 — POST/DELETE/GET endpoints for resource_dependencies + project_references.
import { Router, Request, Response, NextFunction } from "express";
import { resourceGraphService } from "../services/resourceGraphService";
import { projectReferenceService } from "../services/projectReferenceService";

const router = Router();

router.post("/resources/:rid/dependencies", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { downstreamRid, edgeType } = req.body as { downstreamRid?: string; edgeType?: string };
    if (!downstreamRid) return res.status(400).json({ errorCode: "INVALID_ARGUMENT", message: "downstreamRid required" });
    await resourceGraphService.addEdge(req.params.rid, downstreamRid, edgeType ?? "DEPENDS_ON", (req as Request & { user?: { id: string } }).user?.id);
    res.status(204).end();
  } catch (err: unknown) {
    const e = err as Error;
    if (/^CYCLE/.test(e.message)) {
      return res.status(409).json({ errorCode: "CYCLE_DETECTED", message: e.message });
    }
    next(err);
  }
});

router.delete("/resources/:rid/dependencies/:downstream", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await resourceGraphService.removeEdge(req.params.rid, req.params.downstream, (req.query.edgeType as string) || "DEPENDS_ON");
    res.json(r);
  } catch (err) { next(err); }
});

router.get("/resources/:rid/lineage", async (req: Request, res: Response, next: NextFunction) => {
  try { res.json(await resourceGraphService.getLineage(req.params.rid)); }
  catch (err) { next(err); }
});

router.post("/projects/:rid/references", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { referencedRid, referenceType } = req.body as { referencedRid?: string; referenceType?: string };
    if (!referencedRid) return res.status(400).json({ errorCode: "INVALID_ARGUMENT", message: "referencedRid required" });
    await projectReferenceService.addReference(req.params.rid, referencedRid, referenceType ?? "IMPORT", (req as Request & { user?: { id: string } }).user?.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get("/projects/:rid/references", async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ references: await projectReferenceService.listReferences(req.params.rid) }); }
  catch (err) { next(err); }
});

export default router;
