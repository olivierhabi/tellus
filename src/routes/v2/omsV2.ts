// ---------------------------------------------------------------------------
// OMS v2 routes — thin adapters over existing metadata storage
//
//   GET /api/v2/ontologies/:ontology/objectTypes[/:apiName]
//   GET /api/v2/ontologies/:ontology/linkTypes[/:apiName]
//   GET /api/v2/ontologies/:ontology/actionTypes[/:apiName]
//   GET /api/v2/ontologies/:ontology/interfaceTypes[/:apiName]
// ---------------------------------------------------------------------------

import { Router, Request, Response } from "express";
import {
  listObjectTypesV2,
  getObjectTypeV2,
  listLinkTypesV2,
  getLinkTypeV2,
  listActionTypesV2,
  getActionTypeV2,
  listInterfacesV2,
  getInterfaceV2,
} from "../../services/oss/omsV2Mapper";
import { toV2Error } from "../../services/oss/v2Errors";
import { requireOntology } from "./ontologyParam";
import { resolveRequestTenant } from "../../utils/requestTenant";

const router = Router({ mergeParams: true });

function notFound(errorName: string, what: string, apiName: string) {
  throw Object.assign(new Error(`${what} not found: ${apiName}`), {
    errorName,
    parameters: { [what.toLowerCase()]: apiName },
  });
}

router.get("/objectTypes", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    res.json({ data: await listObjectTypesV2(ontologyId) });
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get("/objectTypes/:apiName", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    const r = await getObjectTypeV2(ontologyId, req.params.apiName);
    if (!r) notFound("ObjectTypeNotFound", "ObjectType", req.params.apiName);
    res.json(r);
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get("/linkTypes", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    res.json({ data: await listLinkTypesV2(ontologyId) });
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get("/linkTypes/:apiName", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    const r = await getLinkTypeV2(ontologyId, req.params.apiName);
    if (!r) notFound("LinkTypeNotFound", "LinkType", req.params.apiName);
    res.json(r);
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get("/actionTypes", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    res.json({ data: await listActionTypesV2(ontologyId) });
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get("/actionTypes/:apiName", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    const r = await getActionTypeV2(ontologyId, req.params.apiName);
    if (!r) notFound("ActionTypeNotFound", "ActionType", req.params.apiName);
    res.json(r);
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get("/interfaceTypes", async (req: Request, res: Response) => {
  try {
    const ontologyId = await requireOntology(
      req.params.ontology,
      resolveRequestTenant(req),
    );
    res.json({ data: await listInterfacesV2(ontologyId) });
  } catch (err) {
    const { status, body } = toV2Error(err);
    res.status(status).json(body);
  }
});

router.get(
  "/interfaceTypes/:apiName",
  async (req: Request, res: Response) => {
    try {
      const ontologyId = await requireOntology(
        req.params.ontology,
        resolveRequestTenant(req),
      );
      const r = await getInterfaceV2(ontologyId, req.params.apiName);
      if (!r)
        notFound("InterfaceTypeNotFound", "InterfaceType", req.params.apiName);
      res.json(r);
    } catch (err) {
      const { status, body } = toV2Error(err);
      res.status(status).json(body);
    }
  },
);

export default router;
