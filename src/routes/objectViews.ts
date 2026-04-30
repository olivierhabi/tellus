// ---------------------------------------------------------------------------
// Object View Routes — Express Router (Tasks 11-13)
//
// Provides enriched "view" endpoints for objects that combine OpenSearch data
// with PostgreSQL metadata. These endpoints are distinct from the raw object
// query endpoints in objects.ts — views are designed for UI consumption with
// property metadata, interface implementations, and linked object summaries.
//
// Mounted at: /api/v1/ontology/:ontologyId/objectTypes/:objectTypeApiName
//
// Endpoints:
//   GET  .../objects/:primaryKey/view      — Single object view (Task 11)
//   GET  .../objects/:primaryKey/linked    — Linked objects (Task 12)
//   POST .../objects/batchView             — Batch object views (Task 13)
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { appError } from "../utils/appError";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import {
  enrichProperties,
  getPropertyMetadata,
} from "../services/propertyMetadataService";
import { executeGetObject } from "../services/queryExecutor";
import { countLinks, resolveLinks } from "../services/linkResolverService";
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { incCounter } from "../services/funnel/metrics";
import linkTypeModel from "../models/linkType";

const router = Router({ mergeParams: true });

// ---------------------------------------------------------------------------
// Known error codes
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "OBJECT_NOT_FOUND",
  "LINK_TYPE_NOT_FOUND",
  "VALIDATION_FAILED",
  "OPENSEARCH_ERROR",
  "INVALID_PAGE_TOKEN",
  "INVALID_PARAMETER",
]);

function handleError(err: any, res: Response, next: NextFunction): void {
  if (err.code && KNOWN_CODES.has(err.code)) {
    const status =
      err.code === "OBJECT_TYPE_NOT_FOUND" || err.code === "OBJECT_NOT_FOUND"
        ? 404
        : err.code === "OPENSEARCH_ERROR"
          ? 503
          : 400;
    res.status(status).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }
  next(err);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureObjectTypeExists(
  ontologyId: string,
  objectTypeApiName: string
): Promise<{ objectTypeId: string }> {
  const result = await query(
    `SELECT object_type_id
     FROM object_type
     WHERE ontology_id = $1 AND api_name = $2`,
    [ontologyId, objectTypeApiName]
  );
  if (result.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectTypeApiName}' not found in ontology '${ontologyId}'.`
    );
  }
  return { objectTypeId: result.rows[0].object_type_id };
}

/**
 * Get interface implementations for an object type.
 * Returns the interfaces this type implements with mapped property names.
 */
async function getInterfaceImplementations(
  objectTypeId: string
): Promise<Array<Record<string, unknown>>> {
  const result = await query(
    `SELECT
       i.api_name AS interface_api_name,
       i.display_name AS interface_display_name,
       oti.property_mapping
     FROM object_type_interface oti
     JOIN interface i ON i.interface_id = oti.interface_id
     WHERE oti.object_type_id = $1
     ORDER BY i.api_name`,
    [objectTypeId]
  );

  return result.rows.map((row: any) => ({
    interfaceApiName: row.interface_api_name,
    interfaceDisplayName: row.interface_display_name,
    propertyMapping: row.property_mapping || {},
  }));
}

/**
 * Get link count summary for all link types involving this object type.
 */
async function getLinkSummary(
  ontologyId: string,
  objectTypeId: string,
  primaryKey: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Array<Record<string, unknown>>> {
  // Get all link types where this object type is source or target
  const linkTypes = await linkTypeModel.listByOntology(ontologyId);
  const relevantLinks = linkTypes.filter(
    (lt) =>
      lt.source_object_type === objectTypeId ||
      lt.target_object_type === objectTypeId
  );

  const results: Array<Record<string, unknown>> = [];

  // Count links for each relevant link type
  const settled = await Promise.allSettled(
    relevantLinks.map(async (lt) => {
      const isSource = lt.source_object_type === objectTypeId;
      const direction: "forward" | "reverse" = isSource ? "forward" : "reverse";

      try {
        const count = await countLinks(lt, primaryKey, direction, securityFilter, branchId);
        return {
          linkTypeApiName: lt.api_name,
          linkTypeDisplayName: lt.display_name,
          direction,
          cardinality: lt.cardinality,
          count,
        };
      } catch {
        return {
          linkTypeApiName: lt.api_name,
          linkTypeDisplayName: lt.display_name,
          direction,
          cardinality: lt.cardinality,
          count: 0,
          error: "Failed to count links",
        };
      }
    })
  );

  for (const r of settled) {
    if (r.status === "fulfilled") {
      results.push(r.value);
    }
  }

  return results;
}

/**
 * Build a complete object view from raw OpenSearch data + PostgreSQL metadata.
 */
async function buildObjectView(
  ontologyId: string,
  objectTypeApiName: string,
  objectTypeId: string,
  primaryKey: string,
  include: string[] = ["properties", "links", "interfaces"],
  securityFilter?: Record<string, unknown> | null,
  branchId: string | null = null,
): Promise<Record<string, unknown>> {
  // Fetch the raw object from OpenSearch.
  // F-P3-13: branchId forwarded so reads respect branch isolation.
  const rawObject = await executeGetObject(objectTypeApiName, primaryKey, securityFilter, branchId);
  if (!rawObject) {
    throw appError(
      "OBJECT_NOT_FOUND",
      `Object with primary key '${primaryKey}' not found in object type '${objectTypeApiName}'.`
    );
  }

  // Start building the view
  const view: Record<string, unknown> = {
    __primaryKey: rawObject.__primaryKey,
    __objectType: rawObject.__objectType,
    __version: rawObject.__version ?? 0,
  };

  // Extract raw property values (exclude system fields)
  const rawProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawObject)) {
    if (!key.startsWith("__")) {
      rawProperties[key] = value;
    }
  }

  // Enrich properties with metadata if requested
  if (include.includes("properties")) {
    view.properties = await enrichProperties(objectTypeApiName, rawProperties);
  } else {
    view.properties = rawProperties;
  }

  // Get interface implementations if requested
  if (include.includes("interfaces")) {
    view.interfaces = await getInterfaceImplementations(objectTypeId);
  }

  // Get link summary if requested
  if (include.includes("links")) {
    view.linkedObjectsSummary = await getLinkSummary(
      ontologyId,
      objectTypeId,
      primaryKey,
      securityFilter,
      branchId,
    );
  }

  return view;
}

// ---------------------------------------------------------------------------
// Task 11: GET /objects/:primaryKey/view — Single Object View
// ---------------------------------------------------------------------------

router.get(
  "/objects/:primaryKey/view",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { ontologyId, objectTypeApiName, primaryKey } = req.params;

      const { objectTypeId } = await ensureObjectTypeExists(
        ontologyId,
        objectTypeApiName
      );

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      incCounter("tellus_read_branch_filtered_total", {
        route: "objectViews.single",
        scoped: String(branchId !== null),
      });
      const view = await buildObjectView(
        ontologyId,
        objectTypeApiName,
        objectTypeId,
        primaryKey,
        undefined,
        secFilter,
        branchId
      );

      const elapsed = Date.now() - start;
      console.log(
        `[OBJECT_VIEW] GET .../objects/${primaryKey}/view → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, view);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// Task 12: GET /objects/:primaryKey/linked — Linked Objects
// ---------------------------------------------------------------------------

router.get(
  "/objects/:primaryKey/linked",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { ontologyId, objectTypeApiName, primaryKey } = req.params;
      const {
        linkType: linkTypeFilter,
        pageSize: rawPageSize,
        pageToken,
      } = req.query;

      const { objectTypeId } = await ensureObjectTypeExists(
        ontologyId,
        objectTypeApiName
      );

      const pageSize = rawPageSize
        ? Math.min(Math.max(parseInt(String(rawPageSize), 10) || 100, 1), 1000)
        : 100;

      // Get all link types involving this object type
      const allLinkTypes = await linkTypeModel.listByOntology(ontologyId);
      let relevantLinks = allLinkTypes.filter(
        (lt) =>
          lt.source_object_type === objectTypeId ||
          lt.target_object_type === objectTypeId
      );

      // Apply linkType filter if provided
      if (linkTypeFilter) {
        relevantLinks = relevantLinks.filter(
          (lt) => lt.api_name === linkTypeFilter
        );
        if (relevantLinks.length === 0) {
          throw appError(
            "LINK_TYPE_NOT_FOUND",
            `Link type '${linkTypeFilter}' not found or does not involve object type '${objectTypeApiName}'.`
          );
        }
      }

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      incCounter("tellus_read_branch_filtered_total", {
        route: "objectViews.linked",
        scoped: String(branchId !== null),
      });

      // Resolve linked objects for each link type
      const linkGroups: Array<Record<string, unknown>> = [];

      for (const lt of relevantLinks) {
        const isSource = lt.source_object_type === objectTypeId;
        const direction: "forward" | "reverse" = isSource
          ? "forward"
          : "reverse";

        // Determine target object type api_name for context
        const targetOtId = isSource
          ? lt.target_object_type
          : lt.source_object_type;
        const targetOtResult = await query(
          "SELECT api_name FROM object_type WHERE object_type_id = $1",
          [targetOtId]
        );
        const targetOtApiName = targetOtResult.rows[0]?.api_name ?? "unknown";

        try {
          const result = await resolveLinks(lt, primaryKey, direction, {
            pageSize,
            pageToken: pageToken as string | undefined,
          }, secFilter, branchId);

          linkGroups.push({
            linkTypeApiName: lt.api_name,
            linkTypeDisplayName: lt.display_name,
            direction,
            cardinality: lt.cardinality,
            targetObjectType: targetOtApiName,
            objects: result.linkedObjects,
            totalCount: result.totalCount,
            nextPageToken: result.nextPageToken,
          });
        } catch {
          linkGroups.push({
            linkTypeApiName: lt.api_name,
            linkTypeDisplayName: lt.display_name,
            direction,
            cardinality: lt.cardinality,
            targetObjectType: targetOtApiName,
            objects: [],
            totalCount: 0,
            nextPageToken: null,
            error: "Failed to resolve linked objects",
          });
        }
      }

      const elapsed = Date.now() - start;
      console.log(
        `[LINKED_OBJECTS] GET .../objects/${primaryKey}/linked → 200 (${linkGroups.length} groups, ${elapsed}ms)`
      );

      return sendSuccess(res, {
        primaryKey,
        objectType: objectTypeApiName,
        linkGroups,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// Task 13: POST /objects/batchView — Batch Object Views
// ---------------------------------------------------------------------------

router.post(
  "/objects/batchView",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { ontologyId, objectTypeApiName } = req.params;
      const { primaryKeys, include } = req.body || {};

      // Validate input
      if (!Array.isArray(primaryKeys) || primaryKeys.length === 0) {
        throw appError(
          "VALIDATION_FAILED",
          "primaryKeys must be a non-empty array."
        );
      }

      if (primaryKeys.length > 100) {
        throw appError(
          "VALIDATION_FAILED",
          `Maximum 100 primary keys per batch. Received: ${primaryKeys.length}.`
        );
      }

      // Validate all primary keys are strings
      for (let i = 0; i < primaryKeys.length; i++) {
        if (typeof primaryKeys[i] !== "string" || primaryKeys[i].length === 0) {
          throw appError(
            "VALIDATION_FAILED",
            `primaryKeys[${i}] must be a non-empty string.`
          );
        }
      }

      // Validate include if provided
      const validIncludes = ["properties", "links", "interfaces"];
      const effectiveInclude: string[] = Array.isArray(include)
        ? include.filter((i: string) => validIncludes.includes(i))
        : validIncludes;

      const { objectTypeId } = await ensureObjectTypeExists(
        ontologyId,
        objectTypeApiName
      );

      const secFilter = buildSecurityFilter(req.security);

      // Build views for all primary keys in parallel
      const settled = await Promise.allSettled(
        primaryKeys.map(async (pk: string) => {
          try {
            return await buildObjectView(
              ontologyId,
              objectTypeApiName,
              objectTypeId,
              pk,
              effectiveInclude,
              secFilter
            );
          } catch (err: any) {
            // Return a partial result with error info
            return {
              __primaryKey: pk,
              __objectType: objectTypeApiName,
              __error: err.message || "Failed to build object view",
            };
          }
        })
      );

      const views: Array<Record<string, unknown>> = [];
      for (const r of settled) {
        if (r.status === "fulfilled") {
          views.push(r.value);
        } else {
          views.push({
            __error: (r.reason as Error).message || "Unexpected error",
          });
        }
      }

      const elapsed = Date.now() - start;
      console.log(
        `[BATCH_VIEW] POST .../objects/batchView → 200 (${views.length} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, {
        objectType: objectTypeApiName,
        views,
        totalRequested: primaryKeys.length,
        totalResolved: views.filter((v) => !v.__error).length,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// Spec-compliant routes without ontologyId in path (Tasks 11-13)
// Mounted at: /api/v1/objects/:objectType
// ontologyId is resolved by looking up the Object Type in PostgreSQL.
// ---------------------------------------------------------------------------

export const objectViewsByTypeRouter = Router({ mergeParams: true });

/**
 * Resolve ontologyId and objectTypeId from the objectType apiName.
 */
async function resolveObjectType(
  objectType: string
): Promise<{ ontologyId: string; objectTypeId: string }> {
  const result = await query(
    `SELECT ontology_id, object_type_id FROM object_type WHERE api_name = $1 LIMIT 1`,
    [objectType]
  );
  if (result.rows.length === 0) {
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${objectType}' not found.`
    );
  }
  return {
    ontologyId: result.rows[0].ontology_id,
    objectTypeId: result.rows[0].object_type_id,
  };
}

// GET /api/v1/objects/:objectType/:primaryKey/view
objectViewsByTypeRouter.get(
  "/:primaryKey/view",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      const { ontologyId, objectTypeId } = await resolveObjectType(objectType);

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      incCounter("tellus_read_branch_filtered_total", {
        route: "objectViews.byType.single",
        scoped: String(branchId !== null),
      });
      const view = await buildObjectView(
        ontologyId,
        objectType,
        objectTypeId,
        primaryKey,
        undefined,
        secFilter,
        branchId,
      );

      const elapsed = Date.now() - start;
      console.log(
        `[OBJECT_VIEW] GET /objects/${objectType}/${primaryKey}/view → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, view);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// GET /api/v1/objects/:objectType/:primaryKey/linked
objectViewsByTypeRouter.get(
  "/:primaryKey/linked",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      const {
        linkType: linkTypeFilter,
        pageSize: rawPageSize,
        pageToken,
      } = req.query;

      const { ontologyId, objectTypeId } = await resolveObjectType(objectType);

      const pageSize = rawPageSize
        ? Math.min(Math.max(parseInt(String(rawPageSize), 10) || 100, 1), 1000)
        : 100;

      const allLinkTypes = await linkTypeModel.listByOntology(ontologyId);
      let relevantLinks = allLinkTypes.filter(
        (lt) =>
          lt.source_object_type === objectTypeId ||
          lt.target_object_type === objectTypeId
      );

      if (linkTypeFilter) {
        relevantLinks = relevantLinks.filter(
          (lt) => lt.api_name === linkTypeFilter
        );
        if (relevantLinks.length === 0) {
          throw appError(
            "LINK_TYPE_NOT_FOUND",
            `Link type '${linkTypeFilter}' not found or does not involve object type '${objectType}'.`
          );
        }
      }

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      incCounter("tellus_read_branch_filtered_total", {
        route: "objectViews.byType.linked",
        scoped: String(branchId !== null),
      });
      const linkGroups: Array<Record<string, unknown>> = [];

      for (const lt of relevantLinks) {
        const isSource = lt.source_object_type === objectTypeId;
        const direction: "forward" | "reverse" = isSource ? "forward" : "reverse";

        const targetOtId = isSource ? lt.target_object_type : lt.source_object_type;
        const targetOtResult = await query(
          "SELECT api_name FROM object_type WHERE object_type_id = $1",
          [targetOtId]
        );
        const targetOtApiName = targetOtResult.rows[0]?.api_name ?? "unknown";

        try {
          const result = await resolveLinks(lt, primaryKey, direction, {
            pageSize,
            pageToken: pageToken as string | undefined,
          }, secFilter, branchId);

          linkGroups.push({
            linkTypeApiName: lt.api_name,
            linkTypeDisplayName: lt.display_name,
            direction,
            cardinality: lt.cardinality,
            targetObjectType: targetOtApiName,
            objects: result.linkedObjects,
            totalCount: result.totalCount,
            nextPageToken: result.nextPageToken,
          });
        } catch {
          linkGroups.push({
            linkTypeApiName: lt.api_name,
            linkTypeDisplayName: lt.display_name,
            direction,
            cardinality: lt.cardinality,
            targetObjectType: targetOtApiName,
            objects: [],
            totalCount: 0,
            nextPageToken: null,
            error: "Failed to resolve linked objects",
          });
        }
      }

      const elapsed = Date.now() - start;
      console.log(
        `[LINKED_OBJECTS] GET /objects/${objectType}/${primaryKey}/linked → 200 (${linkGroups.length} groups, ${elapsed}ms)`
      );

      return sendSuccess(res, {
        primaryKey,
        objectType,
        linkGroups,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// POST /api/v1/objects/:objectType/batchView
objectViewsByTypeRouter.post(
  "/batchView",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      const { primaryKeys, include } = req.body || {};

      if (!Array.isArray(primaryKeys) || primaryKeys.length === 0) {
        throw appError(
          "VALIDATION_FAILED",
          "primaryKeys must be a non-empty array."
        );
      }
      if (primaryKeys.length > 100) {
        throw appError(
          "VALIDATION_FAILED",
          `Maximum 100 primary keys per batch. Received: ${primaryKeys.length}.`
        );
      }
      for (let i = 0; i < primaryKeys.length; i++) {
        if (typeof primaryKeys[i] !== "string" || primaryKeys[i].length === 0) {
          throw appError(
            "VALIDATION_FAILED",
            `primaryKeys[${i}] must be a non-empty string.`
          );
        }
      }

      const validIncludes = ["properties", "links", "interfaces"];
      const effectiveInclude: string[] = Array.isArray(include)
        ? include.filter((i: string) => validIncludes.includes(i))
        : validIncludes;

      const { ontologyId, objectTypeId } = await resolveObjectType(objectType);
      const secFilter = buildSecurityFilter(req.security);

      const settled = await Promise.allSettled(
        primaryKeys.map(async (pk: string) => {
          try {
            return await buildObjectView(
              ontologyId,
              objectType,
              objectTypeId,
              pk,
              effectiveInclude,
              secFilter
            );
          } catch (err: any) {
            return {
              __primaryKey: pk,
              __objectType: objectType,
              __error: err.message || "Failed to build object view",
            };
          }
        })
      );

      const views: Array<Record<string, unknown>> = [];
      for (const r of settled) {
        if (r.status === "fulfilled") {
          views.push(r.value);
        } else {
          views.push({
            __error: (r.reason as Error).message || "Unexpected error",
          });
        }
      }

      const elapsed = Date.now() - start;
      console.log(
        `[BATCH_VIEW] POST /objects/${objectType}/batchView → 200 (${views.length} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, {
        objectType,
        views,
        totalRequested: primaryKeys.length,
        totalResolved: views.filter((v) => !v.__error).length,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

export default router;
