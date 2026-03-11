// ---------------------------------------------------------------------------
// Link Type Routes — Express Router
//
// CRUD for link types plus resolution and counting endpoints.
// Mounted at: /api/v2/ontologies/:ontologyId/linkTypes
//
// Endpoints:
//   POST   /                          — Create a link type
//   GET    /                          — List link types
//   GET    /:apiName                  — Get link type
//   DELETE /:apiName                  — Delete link type
//   POST   /:apiName/resolve          — Resolve linked objects
//   POST   /:apiName/count            — Count linked objects
//   POST   /bulkCount                 — Bulk count across multiple link types
//   POST   /:apiName/searchAround     — Search Around
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import linkTypeModel from "../models/linkType";
import { resolveLinks, countLinks, searchAround } from "../services/linkResolverService";
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import type { Cardinality } from "../models/linkType";

const router = Router({ mergeParams: true });

const VALID_CARDINALITIES: Cardinality[] = [
  "ONE_TO_ONE",
  "ONE_TO_MANY",
  "MANY_TO_ONE",
  "MANY_TO_MANY",
];

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "PROPERTY_NOT_FOUND",
  "INVALID_API_NAME",
  "ALREADY_EXISTS",
  "LINK_TYPE_NOT_FOUND",
  "VALIDATION_FAILED",
]);

// ---------------------------------------------------------------------------
// POST / — Create link type
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const {
      apiName,
      displayName,
      description,
      cardinality,
      sourceObjectTypeApiName,
      targetObjectTypeApiName,
      sourcePropertyApiName,
      targetPropertyApiName,
    } = req.body;

    if (!apiName || !displayName || !cardinality || !sourceObjectTypeApiName || !targetObjectTypeApiName) {
      return sendError(res, "VALIDATION_FAILED", "apiName, displayName, cardinality, sourceObjectTypeApiName, and targetObjectTypeApiName are required.");
    }

    if (!VALID_CARDINALITIES.includes(cardinality)) {
      return sendError(res, "VALIDATION_FAILED", `Invalid cardinality. Must be one of: ${VALID_CARDINALITIES.join(", ")}`);
    }

    const linkType = await linkTypeModel.create(ontologyId, {
      apiName,
      displayName,
      description,
      cardinality,
      sourceObjectTypeApiName,
      targetObjectTypeApiName,
      sourcePropertyApiName,
      targetPropertyApiName,
    });

    return sendCreated(res, formatLinkType(linkType));
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET / — List link types
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const linkTypes = await linkTypeModel.listByOntology(ontologyId);
    return sendSuccess(res, { data: linkTypes.map(formatLinkType) });
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:apiName — Get link type
// ---------------------------------------------------------------------------

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }
    return sendSuccess(res, formatLinkType(linkType));
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:apiName — Delete link type
// ---------------------------------------------------------------------------

router.delete("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    await linkTypeModel.remove(ontologyId, apiName);
    return sendNoContent(res);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/resolve — Resolve linked objects
// ---------------------------------------------------------------------------

router.post("/:apiName/resolve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const { objectPK, direction, pageSize, pageToken, targetFilter } = req.body;

    if (!objectPK || !direction) {
      return sendError(res, "VALIDATION_FAILED", "objectPK and direction are required.");
    }
    if (direction !== "forward" && direction !== "reverse") {
      return sendError(res, "VALIDATION_FAILED", "direction must be 'forward' or 'reverse'.");
    }

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const result = await resolveLinks(linkType, objectPK, direction, {
      pageSize,
      pageToken,
      targetFilter,
    });

    return sendSuccess(res, result);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/count — Count linked objects
// ---------------------------------------------------------------------------

router.post("/:apiName/count", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const { objectPK, direction } = req.body;

    if (!objectPK || !direction) {
      return sendError(res, "VALIDATION_FAILED", "objectPK and direction are required.");
    }

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const count = await countLinks(linkType, objectPK, direction);
    return sendSuccess(res, { linkTypeApiName: apiName, direction, count });
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /bulkCount — Bulk count across multiple link types
// ---------------------------------------------------------------------------

router.post("/bulkCount", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { requests } = req.body;

    if (!Array.isArray(requests) || requests.length === 0) {
      return sendError(res, "VALIDATION_FAILED", "requests array is required and must be non-empty.");
    }

    const results: Array<{ linkTypeApiName: string; direction: string; objectPK: string; count: number; error?: string }> = [];

    for (const req of requests) {
      try {
        const linkType = await linkTypeModel.getByApiName(ontologyId, req.linkTypeApiName);
        if (!linkType) {
          results.push({ linkTypeApiName: req.linkTypeApiName, direction: req.direction, objectPK: req.objectPK, count: 0, error: "Link type not found" });
          continue;
        }
        const count = await countLinks(linkType, req.objectPK, req.direction);
        results.push({ linkTypeApiName: req.linkTypeApiName, direction: req.direction, objectPK: req.objectPK, count });
      } catch (err: any) {
        results.push({ linkTypeApiName: req.linkTypeApiName, direction: req.direction, objectPK: req.objectPK, count: 0, error: err.message });
      }
    }

    return sendSuccess(res, { results });
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/searchAround — Search Around
// ---------------------------------------------------------------------------

router.post("/:apiName/searchAround", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const { direction, sourceFilter, targetFilter, pageSize, pageToken } = req.body;

    if (!direction) {
      return sendError(res, "VALIDATION_FAILED", "direction is required.");
    }

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const result = await searchAround(linkType, direction, {
      sourceFilter,
      targetFilter,
      pageSize,
      pageToken,
    });

    return sendSuccess(res, result);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Format helper
// ---------------------------------------------------------------------------

function formatLinkType(row: any): Record<string, unknown> {
  return {
    linkTypeId: row.link_type_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    cardinality: row.cardinality,
    sourceObjectType: row.source_object_type,
    targetObjectType: row.target_object_type,
    sourcePropertyId: row.source_property_id,
    targetPropertyId: row.target_property_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default router;
