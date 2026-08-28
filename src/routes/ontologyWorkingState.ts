import { Router, type NextFunction, type Request, type Response } from "express";
import { currentUser } from "../middleware/currentUser";
import { dataPlaneGuard, requireOntologyWrite } from "../middleware/requireRole";
import {
  acknowledgeChange,
  commitWorkingState,
  discardAll,
  discardChange,
  discardResource,
  getWorkingState,
  getSavedBranchChanges,
  stageChange,
  updateWorkingState,
  type OntologyResourceKind,
  type WorkingChangeInput,
} from "../services/ontologyWorkingStateService";
import { sendNoContent, sendSuccess } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });
router.use((req, res, next) => {
  // Discard only ever removes the caller's private working state, so it has
  // the same ontology-write authority as staging. The generic data-plane
  // guard treats every DELETE as an admin operation, which is appropriate for
  // published resources but would prevent normal editors from undoing drafts.
  if (req.method === "DELETE") return requireOntologyWrite(req, res, next);
  return dataPlaneGuard({ post: "write" })(req, res, next);
});

function branch(req: Request): string | null {
  const value = req.query.branch ?? req.headers["x-ontology-branch"];
  return typeof value === "string" && value.trim() ? value.trim() : "main";
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try { sendSuccess(res, await getWorkingState(req.params.ontologyId, currentUser(req), branch(req))); }
  catch (error) { next(error); }
});

router.get("/saved-changes", async (req: Request, res: Response, next: NextFunction) => {
  try { sendSuccess(res, await getSavedBranchChanges(req.params.ontologyId, currentUser(req), branch(req))); }
  catch (error) { next(error); }
});

router.put("/changes/:changeId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = { ...(req.body ?? {}), changeId: req.params.changeId } as WorkingChangeInput;
    sendSuccess(res, await stageChange(req.params.ontologyId, currentUser(req), branch(req), input));
  } catch (error) { next(error); }
});

// Validation is deliberately non-mutating. Staging already stores canonical
// validation issues, so this endpoint refreshes/reviews without publishing.
router.post("/validate", async (req: Request, res: Response, next: NextFunction) => {
  try { sendSuccess(res, await getWorkingState(req.params.ontologyId, currentUser(req), branch(req))); }
  catch (error) { next(error); }
});

router.post("/update", async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await updateWorkingState(
      req.params.ontologyId,
      currentUser(req),
      branch(req),
      req.body?.resolutions ?? {},
    ));
  } catch (error) { next(error); }
});

router.post("/changes/:changeId/acknowledge", async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await acknowledgeChange(req.params.ontologyId, currentUser(req), branch(req),
      req.params.changeId, req.body?.acknowledged !== false));
  } catch (error) { next(error); }
});

router.delete("/resources/:resourceKind/:resourceId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    sendSuccess(res, await discardResource(req.params.ontologyId, currentUser(req), branch(req),
      req.params.resourceKind as OntologyResourceKind, req.params.resourceId));
  } catch (error) { next(error); }
});

router.delete("/changes/:changeId", async (req: Request, res: Response, next: NextFunction) => {
  try { sendSuccess(res, await discardChange(req.params.ontologyId, currentUser(req), branch(req), req.params.changeId)); }
  catch (error) { next(error); }
});

router.delete("/", async (req: Request, res: Response, next: NextFunction) => {
  try { await discardAll(req.params.ontologyId, currentUser(req), branch(req)); sendNoContent(res); }
  catch (error) { next(error); }
});

router.post("/commit", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const idempotencyKey = req.header("Idempotency-Key") ?? "";
    sendSuccess(res, await commitWorkingState(req.params.ontologyId, currentUser(req), branch(req), {
      target: req.body?.target ?? "main",
      branchName: req.body?.branchName,
      branchDescription: req.body?.branchDescription,
    }, idempotencyKey));
  } catch (error) { next(error); }
});

export default router;
