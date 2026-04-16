// ---------------------------------------------------------------------------
// Link Type Routes — Express Router (Thursday Enhanced)
//
// CRUD for link types plus resolution, counting, Search Around, multi-hop,
// analysis, export/import, and join table upload endpoints.
//
// Mounted at: /api/v1/ontology/:ontologyId/linkTypes
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import * as fs from "fs";
import * as path from "path";
import linkTypeModel from "../models/linkType";
import { resolveObjectTypeApiName, resolvePropertyApiName } from "../models/linkType";
import {
  resolveLinks,
  countLinks,
  bulkCountLinks,
  searchAround,
  resolveMultiHop,
  analyzeLinkType,
  validateCardinalityChange,
  validateForeignKeys,
  validateJoinTable,
} from "../services/linkResolverService";
import {
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
  encodePageToken,
  decodePageToken,
} from "../utils/responseFormatter";
import type { Cardinality, LinkTypeRow } from "../models/linkType";

const router = Router({ mergeParams: true });

// Multer setup for CSV upload
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(process.cwd(), "data", "join_tables");
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed."));
    }
  },
});

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
  "INVALID_PARAMETER",
  "MAX_LINK_DEPTH_EXCEEDED",
  "JOIN_TABLE_REQUIRED",
]);

// ---------------------------------------------------------------------------
// POST / — Create link type (Task 2)
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const {
      apiName, displayName, description, cardinality,
      sourceObjectTypeApiName, targetObjectTypeApiName,
      sourcePropertyApiName, targetPropertyApiName,
      joinTableFilePath, joinTableSourceColumn, joinTableTargetColumn,
      isBidirectional,
    } = req.body;

    if (!apiName || !displayName || !cardinality || !sourceObjectTypeApiName || !targetObjectTypeApiName) {
      return sendError(res, "VALIDATION_FAILED", "apiName, displayName, cardinality, sourceObjectTypeApiName, and targetObjectTypeApiName are required.");
    }

    if (!VALID_CARDINALITIES.includes(cardinality)) {
      return sendError(res, "VALIDATION_FAILED", `Invalid cardinality. Must be one of: ${VALID_CARDINALITIES.join(", ")}`);
    }

    const linkType = await linkTypeModel.create(ontologyId, {
      apiName, displayName, description, cardinality,
      sourceObjectTypeApiName, targetObjectTypeApiName,
      sourcePropertyApiName, targetPropertyApiName,
      joinTableFilePath, joinTableSourceColumn, joinTableTargetColumn,
      isBidirectional,
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
// GET / — List link types (Task 3)
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { sourceObjectType, targetObjectType, cardinality, pageSize, pageToken } = req.query;

    const linkTypes = await linkTypeModel.listByOntology(ontologyId, {
      sourceObjectType: sourceObjectType as string | undefined,
      targetObjectType: targetObjectType as string | undefined,
      cardinality: cardinality as string | undefined,
    });

    const size = Math.min(parseInt(pageSize as string, 10) || 100, 1000);
    const offset = pageToken ? decodePageToken(pageToken as string) : 0;
    const paged = linkTypes.slice(offset, offset + size);
    const nextPageToken = offset + size < linkTypes.length
      ? encodePageToken(offset + size) : undefined;

    return sendSuccess(res, {
      data: paged.map(formatLinkType),
      totalCount: linkTypes.length,
      nextPageToken: nextPageToken || null,
    });
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /export — Export all link types as JSON (Task 25)
// ---------------------------------------------------------------------------

router.get("/export", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const linkTypes = await linkTypeModel.listByOntology(ontologyId);

    const exportData = {
      ontologyId,
      exportedAt: new Date().toISOString(),
      count: linkTypes.length,
      version: "1.0",
      linkTypes: await Promise.all(linkTypes.map(async (lt) => {
        const sourceApiName = await resolveObjectTypeApiName(lt.source_object_type).catch(() => lt.source_object_type);
        const targetApiName = await resolveObjectTypeApiName(lt.target_object_type).catch(() => lt.target_object_type);
        const sourcePropName = lt.source_property_id ? await resolvePropertyApiName(lt.source_property_id).catch(() => lt.source_property_id) : null;
        const targetPropName = lt.target_property_id ? await resolvePropertyApiName(lt.target_property_id).catch(() => lt.target_property_id) : null;

        return {
          apiName: lt.api_name,
          displayName: lt.display_name,
          description: lt.description,
          cardinality: lt.cardinality,
          sourceObjectTypeApiName: sourceApiName,
          targetObjectTypeApiName: targetApiName,
          sourcePropertyApiName: sourcePropName,
          targetPropertyApiName: targetPropName,
          joinTableFilePath: lt.join_table_file_path,
          joinTableSourceColumn: lt.join_table_source_column,
          joinTableTargetColumn: lt.join_table_target_column,
          isBidirectional: lt.is_bidirectional,
        };
      })),
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="link-types-${ontologyId}.json"`);
    return res.status(200).json(exportData);
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /import — Import link types from JSON (Task 26)
// ---------------------------------------------------------------------------

router.post("/import", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { linkTypes } = req.body;

    if (!Array.isArray(linkTypes)) {
      return sendError(res, "VALIDATION_FAILED", "linkTypes array is required.");
    }

    const result = await linkTypeModel.bulkInsert(ontologyId, linkTypes);

    return sendSuccess(res, {
      created: result.created.map(formatLinkType),
      skipped: result.skipped,
      failed: result.failed,
      summary: {
        total: linkTypes.length,
        created: result.created.length,
        skipped: result.skipped.length,
        failed: result.failed.length,
      },
    });
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /bulkCount — Bulk count across multiple link types (Task 16)
// ---------------------------------------------------------------------------

router.post("/bulkCount", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { objectTypeApiName, objectPK, requests } = req.body;

    // If requests array is provided, use it directly
    if (Array.isArray(requests) && requests.length > 0) {
      const results: Array<{ linkTypeApiName: string; direction: string; objectPK: string; count: number | null; error?: string }> = [];

      const settled = await Promise.allSettled(
        requests.map(async (r: any) => {
          const linkType = await linkTypeModel.getByApiName(ontologyId, r.linkTypeApiName);
          if (!linkType) {
            return { linkTypeApiName: r.linkTypeApiName, direction: r.direction, objectPK: r.objectPK, count: null, error: "Link type not found" };
          }
          const count = await countLinks(linkType, r.objectPK, r.direction);
          return { linkTypeApiName: r.linkTypeApiName, direction: r.direction, objectPK: r.objectPK, count };
        })
      );

      for (const r of settled) {
        if (r.status === "fulfilled") {
          results.push(r.value);
        } else {
          results.push({ linkTypeApiName: "unknown", direction: "forward", objectPK: "", count: null, error: (r.reason as Error).message });
        }
      }

      return sendSuccess(res, { results });
    }

    // Alternative: provide objectTypeApiName + objectPK to get all link type counts
    if (!objectTypeApiName || !objectPK) {
      return sendError(res, "VALIDATION_FAILED", "Either 'requests' array or 'objectTypeApiName' + 'objectPK' are required.");
    }

    const { query: dbQuery } = await import("../db");
    const otResult = await dbQuery(
      "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, objectTypeApiName]
    );
    if (otResult.rows.length === 0) {
      return sendError(res, "OBJECT_TYPE_NOT_FOUND", `Object type '${objectTypeApiName}' not found.`);
    }

    const results = await bulkCountLinks(ontologyId, otResult.rows[0].object_type_id, objectPK);
    return sendSuccess(res, { results });
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /multiHop — Multi-hop link traversal (Task 22)
// ---------------------------------------------------------------------------

router.post("/multiHop", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { startingPKs, steps, pageSize, pageToken, targetFilter } = req.body;

    if (!Array.isArray(startingPKs) || startingPKs.length === 0) {
      return sendError(res, "VALIDATION_FAILED", "startingPKs array is required.");
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return sendError(res, "VALIDATION_FAILED", "steps array is required.");
    }

    const stepsWithOntology = steps.map((s: any) => ({
      ...s,
      ontologyId,
    }));

    const result = await resolveMultiHop(stepsWithOntology, startingPKs, {
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
// GET /:apiName — Get link type (Task 4)
// ---------------------------------------------------------------------------

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;

    // Don't match special paths
    if (apiName === "export" || apiName === "import" || apiName === "bulkCount" || apiName === "multiHop") {
      return next();
    }

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    // Enrich with metadata
    const sourceApiName = await resolveObjectTypeApiName(linkType.source_object_type).catch(() => null);
    const targetApiName = await resolveObjectTypeApiName(linkType.target_object_type).catch(() => null);

    const formatted = formatLinkType(linkType);
    (formatted as any).sourceObjectTypeApiName = sourceApiName;
    (formatted as any).targetObjectTypeApiName = targetApiName;

    return sendSuccess(res, formatted);
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:apiName — Update link type (Task 5)
// ---------------------------------------------------------------------------

router.put("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const {
      displayName, description, cardinality,
      sourcePropertyApiName, targetPropertyApiName,
      joinTableFilePath, joinTableSourceColumn, joinTableTargetColumn,
      isBidirectional,
    } = req.body;

    // Reject immutable field changes
    if (req.body.apiName && req.body.apiName !== apiName) {
      return sendError(res, "VALIDATION_FAILED", "apiName is immutable and cannot be changed.");
    }
    if (req.body.sourceObjectTypeApiName !== undefined) {
      return sendError(res, "VALIDATION_FAILED", "sourceObjectTypeApiName is immutable and cannot be changed.");
    }
    if (req.body.targetObjectTypeApiName !== undefined) {
      return sendError(res, "VALIDATION_FAILED", "targetObjectTypeApiName is immutable and cannot be changed.");
    }

    if (cardinality && !VALID_CARDINALITIES.includes(cardinality)) {
      return sendError(res, "VALIDATION_FAILED", `Invalid cardinality. Must be one of: ${VALID_CARDINALITIES.join(", ")}`);
    }

    const updated = await linkTypeModel.update(ontologyId, apiName, {
      displayName, description, cardinality,
      sourcePropertyApiName, targetPropertyApiName,
      joinTableFilePath, joinTableSourceColumn, joinTableTargetColumn,
      isBidirectional,
    });

    const result: any = formatLinkType(updated);
    const warnings = (updated as any)._warnings;
    if (warnings) {
      result.warnings = warnings;
    }

    return sendSuccess(res, result);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:apiName — Delete link type (Task 6)
// ---------------------------------------------------------------------------

router.delete("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const deleted = await linkTypeModel.remove(ontologyId, apiName);

    if (!deleted) {
      return sendNoContent(res);
    }

    const formatted = formatLinkType(deleted);
    (formatted as any).deletedAt = new Date().toISOString();

    if (deleted.join_table_file_path) {
      console.warn(`[ORPHANED_JOIN_TABLE] Link type '${apiName}' deleted but join table file remains: ${deleted.join_table_file_path}`);
      (formatted as any).warnings = [`Orphaned join table file: ${deleted.join_table_file_path}`];
    }

    return sendSuccess(res, formatted);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/resolve — Resolve linked objects (Task 12)
// ---------------------------------------------------------------------------

router.post("/:apiName/resolve", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const { objectPK, direction, pageSize, pageToken, targetFilter, select } = req.body;

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
      pageSize, pageToken, targetFilter, select,
    });

    // Format response based on cardinality
    const isSingle = (linkType.cardinality === "ONE_TO_ONE" || linkType.cardinality === "MANY_TO_ONE") && direction === "forward";
    if (isSingle) {
      return sendSuccess(res, {
        linkedObject: result.linkedObjects.length > 0 ? result.linkedObjects[0] : null,
      });
    }

    return sendSuccess(res, result);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/count — Count linked objects (Task 15)
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
// POST /:apiName/searchAround — Search Around (Tasks 13-14)
// ---------------------------------------------------------------------------

router.post("/:apiName/searchAround", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const { direction, sourceFilter, targetFilter, pageSize, pageToken, maxDepth } = req.body;

    if (!direction) {
      return sendError(res, "VALIDATION_FAILED", "direction is required.");
    }

    // Spec §Task 7 — maxDepth defaults to 1, caps at 3 (Palantir Search Around).
    if (maxDepth !== undefined) {
      if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1) {
        return sendError(res, "INVALID_PARAMETER", "maxDepth must be a positive integer.");
      }
      if (maxDepth > 3) {
        return sendError(
          res,
          "MAX_LINK_DEPTH_EXCEEDED",
          `maxDepth ${maxDepth} exceeds the Palantir Search Around limit of 3.`,
          { maxDepth, limit: 3 }
        );
      }
    }

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const result = await searchAround(linkType, direction, {
      sourceFilter, targetFilter, pageSize, pageToken,
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
// POST /:apiName/upload — Join table CSV upload (Task 17)
// ---------------------------------------------------------------------------

router.post("/:apiName/upload", upload.single("file"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    if (linkType.cardinality !== "MANY_TO_MANY") {
      return sendError(res, "VALIDATION_FAILED", "Join table upload is only supported for MANY_TO_MANY link types.");
    }

    if (!req.file) {
      return sendError(res, "VALIDATION_FAILED", "CSV file is required.");
    }

    // Parse and validate the CSV
    const content = fs.readFileSync(req.file.path, "utf-8");
    const lines = content.trim().split("\n");

    if (lines.length < 1) {
      fs.unlinkSync(req.file.path);
      return sendError(res, "VALIDATION_FAILED", "CSV file is empty.");
    }

    const header = lines[0].split(",").map((c) => c.trim());
    if (header.length < 2) {
      fs.unlinkSync(req.file.path);
      return sendError(res, "VALIDATION_FAILED", "CSV must have at least 2 columns.");
    }

    // Validate rows
    let validRows = 0;
    let invalidRows = 0;
    const sourcePKs = new Set<string>();
    const targetPKs = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      if (cols.length < 2 || !cols[0] || !cols[1]) {
        invalidRows++;
        continue;
      }
      validRows++;
      sourcePKs.add(cols[0]);
      targetPKs.add(cols[1]);
    }

    // Update the link type with the file path
    await linkTypeModel.update(ontologyId, apiName, {
      joinTableFilePath: req.file.path,
      joinTableSourceColumn: header[0],
      joinTableTargetColumn: header[1],
    });

    return sendSuccess(res, {
      message: "Join table uploaded successfully.",
      filePath: req.file.path,
      sourceColumn: header[0],
      targetColumn: header[1],
      totalRows: lines.length - 1,
      validRows,
      invalidRows,
      uniqueSourceKeys: sourcePKs.size,
      uniqueTargetKeys: targetPKs.size,
    });
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/validate — Validate join table (Task 18)
// ---------------------------------------------------------------------------

router.post("/:apiName/validate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const validation = await validateJoinTable(linkType);
    return sendSuccess(res, validation);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:apiName/analysis — Link type analysis (Task 23)
// ---------------------------------------------------------------------------

router.get("/:apiName/analysis", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const analysis = await analyzeLinkType(linkType);
    return sendSuccess(res, analysis);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:apiName/validateMigration — Cardinality migration validation (Task 24)
// ---------------------------------------------------------------------------

router.post("/:apiName/validateMigration", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const { targetCardinality } = req.body;

    if (!targetCardinality || !VALID_CARDINALITIES.includes(targetCardinality)) {
      return sendError(res, "VALIDATION_FAILED", `targetCardinality is required and must be one of: ${VALID_CARDINALITIES.join(", ")}`);
    }

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const validation = await validateCardinalityChange(linkType, targetCardinality);
    return sendSuccess(res, validation);
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
    joinTableFilePath: row.join_table_file_path || null,
    joinTableSourceColumn: row.join_table_source_column || null,
    joinTableTargetColumn: row.join_table_target_column || null,
    isBidirectional: row.is_bidirectional || false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default router;
