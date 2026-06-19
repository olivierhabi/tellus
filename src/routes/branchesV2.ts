// B7.09 — endpoint wiring for Compass branches/proposals/merge.
//
// Routes:
//   POST   /projects/:rid/branches           — create branch
//   GET    /projects/:rid/branches           — list branches
//   GET    /branches/:id                     — get branch
//   POST   /branches/:id/proposals           — open proposal
//   GET    /branches/:id/proposals           — list proposals
//   POST   /proposals/:id/approve            — approve / reject
//   GET    /branches/:id/conflicts           — detect merge conflicts
//   POST   /branches/:id/merge               — apply merge
import { Router, Request, Response, NextFunction } from "express";
import { branchService } from "../services/branchService";
import { proposalService } from "../services/proposalService";
import { mergeService } from "../services/mergeService";

const router = Router();

router.post("/projects/:rid/branches", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, parentBranchId } = req.body as { name?: string; parentBranchId?: string };
    if (!name) return res.status(400).json({ errorCode: "INVALID_ARGUMENT", message: "name required" });
    const actorId = (req as Request & { user?: { id: string } }).user?.id;
    const b = await branchService.create(req.params.rid, name, { actorId, parentBranchId });
    res.status(201).json(b);
  } catch (err) { next(err); }
});

router.get("/projects/:rid/branches", async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ branches: await branchService.listByProject(req.params.rid) }); }
  catch (err) { next(err); }
});

router.get("/branches/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = await branchService.getById(req.params.id);
    if (!b) return res.status(404).json({ errorCode: "RESOURCE_NOT_FOUND" });
    res.json(b);
  } catch (err) { next(err); }
});

router.post("/branches/:id/proposals", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, description } = req.body as { title?: string; description?: string };
    if (!title) return res.status(400).json({ errorCode: "INVALID_ARGUMENT", message: "title required" });
    const actorId = (req as Request & { user?: { id: string } }).user?.id;
    const p = await proposalService.open(req.params.id, title, { actorId, description });
    res.status(201).json(p);
  } catch (err) { next(err); }
});

router.get("/branches/:id/proposals", async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ proposals: await proposalService.listByBranch(req.params.id) }); }
  catch (err) { next(err); }
});

router.post("/proposals/:id/approve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { decision, comment } = req.body as { decision?: 'APPROVED' | 'REJECTED'; comment?: string };
    if (!decision || !['APPROVED','REJECTED'].includes(decision)) {
      return res.status(400).json({ errorCode: "INVALID_ARGUMENT", message: "decision must be APPROVED or REJECTED" });
    }
    const actorId = (req as Request & { user?: { id: string } }).user?.id;
    if (!actorId) return res.status(401).json({ errorCode: "UNAUTHENTICATED" });
    const p = await proposalService.approve(req.params.id, actorId, decision, { comment });
    if (!p) return res.status(404).json({ errorCode: "RESOURCE_NOT_FOUND" });
    res.json(p);
  } catch (err) { next(err); }
});

router.get("/branches/:id/conflicts", async (req: Request, res: Response, next: NextFunction) => {
  try { res.json({ conflicts: await mergeService.detectConflicts(req.params.id) }); }
  catch (err) { next(err); }
});

router.post("/branches/:id/merge", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actorId = (req as Request & { user?: { id: string } }).user?.id;
    if (!actorId) return res.status(401).json({ errorCode: "UNAUTHENTICATED" });
    const r = await mergeService.applyMerge(req.params.id, actorId);
    if (r.status === 'CONFLICT') return res.status(409).json(r);
    res.json(r);
  } catch (err) { next(err); }
});

export default router;
