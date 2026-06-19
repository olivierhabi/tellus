// B8.14 — POST/GET/PATCH endpoints for object_types and link_types.
import { Router, Request, Response, NextFunction } from "express";
import { omsService, ValidationError } from "../services/omsService";

const router = Router();

function handleErr(err: unknown, res: Response): boolean {
  if (err instanceof ValidationError) {
    const map: Record<string, number> = {
      INVALID_API_NAME: 400, MISSING_DISPLAY_NAME: 400, MISSING_DATA_TYPE: 400,
      PRIMARY_KEYS_REQUIRED: 400, PROPERTIES_REQUIRED: 400, PK_NOT_FOUND: 400,
      TITLE_PROPERTY_NOT_FOUND: 400, PK_LENGTH_MISMATCH: 400, PROPERTY_MAPPING_UNKNOWN: 400,
      INVALID_BACKING_TYPE: 400, INVALID_CARDINALITY: 400, INVALID_SELF_LINK: 400,
      OBJECT_TYPE_NOT_FOUND: 404, NOT_FOUND: 404,
      PRECONDITION_FAILED: 412, IMMUTABLE_API_NAME: 409,
    };
    res.status(map[err.code] ?? 400).json({ errorCode: err.code, message: err.message });
    return true;
  }
  return false;
}

router.post("/ontologies/:ontologyRid/object-types", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await omsService.createObjectType({ ...req.body, ontologyRid: req.params.ontologyRid, actorId: (req as any).user?.id });
    res.status(201).json(r);
  } catch (err) { if (!handleErr(err, res)) next(err); }
});

router.get("/ontologies/:ontologyRid/object-types", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchRid = (req.query.branchRid as string) || null;
    res.json({ objectTypes: await omsService.listObjectTypes(req.params.ontologyRid, branchRid) });
  } catch (err) { next(err); }
});

router.get("/ontologies/:ontologyRid/object-types/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const branchRid = (req.query.branchRid as string) || null;
    const ot = await omsService.getObjectType(req.params.ontologyRid, req.params.apiName, branchRid);
    if (!ot) return res.status(404).json({ errorCode: "NOT_FOUND", message: `object type ${req.params.apiName} not found` });
    res.json(ot);
  } catch (err) { next(err); }
});

router.patch("/object-types/:rid", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ifMatch = req.headers['if-match'] as string | undefined;
    if (!ifMatch) return res.status(428).json({ errorCode: "PRECONDITION_REQUIRED", message: "If-Match header required" });
    const m = ifMatch.match(/^"v(\d+)"$/);
    if (!m) return res.status(400).json({ errorCode: "INVALID_ARGUMENT", message: "If-Match must be 'vN' form" });
    const r = await omsService.updateObjectType(req.params.rid, Number(m[1]), req.body);
    res.json(r);
  } catch (err) { if (!handleErr(err, res)) next(err); }
});

router.post("/ontologies/:ontologyRid/link-types", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const r = await omsService.createLinkType({ ...req.body, ontologyRid: req.params.ontologyRid, actorId: (req as any).user?.id });
    res.status(201).json(r);
  } catch (err) { if (!handleErr(err, res)) next(err); }
});

router.get("/ontologies/:ontologyRid/link-types", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ linkTypes: await omsService.listLinkTypes(req.params.ontologyRid, (req.query.branchRid as string) || null) });
  } catch (err) { next(err); }
});

router.post("/ontologies/:ontologyRid/shared-property-types", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await omsService.createSharedPropertyType({ ...req.body, ontologyRid: req.params.ontologyRid }));
  } catch (err) { if (!handleErr(err, res)) next(err); }
});

router.post("/ontologies/:ontologyRid/interfaces", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(201).json(await omsService.createInterface({ ...req.body, ontologyRid: req.params.ontologyRid }));
  } catch (err) { if (!handleErr(err, res)) next(err); }
});

export default router;
