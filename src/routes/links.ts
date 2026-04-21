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
import { sendSuccess, sendCreated, sendNoContent, sendError, encodePageToken, decodePageToken } from "../utils/responseFormatter";
import { buildSecurityFilter } from "../middleware/securityContext";
import type { Cardinality, LinkTypeRow } from "../models/linkType";
import {
  applyReverseProjectionAll,
  reverseCardinality,
  deriveEdgeMarkings,
} from "../services/linkDirectionHelpers";
import {
  getResolverConfig,
  upsertResolverConfig,
  effectiveMaxPks,
} from "../models/linkResolverConfig";
import {
  listQuarantineEntries,
  resolveQuarantineEntry,
  dismissQuarantineEntry,
} from "../models/linkQuarantine";
import { enforceOneToOneAdd } from "../services/linkViolationEnforcer";
import {
  resolveFKWithState,
  runOrphanScan,
  getLatestOrphanStats,
  listOrphans,
} from "../services/linkOrphanState";
import {
  assertOffsetWithinCap,
  isSearchAfterToken,
  OffsetTooDeepError,
} from "../services/linkPagination";
import { migrateLinkStorage } from "../services/linkStorageMigrator";

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
  // LT-B1: the 50 MB ceiling is lifted once a link type migrates to the
  // Iceberg backend (PyIceberg streams 5 GB uploads without staging in
  // RAM). We enforce a 5 GB absolute cap instead to still reject
  // misconfigured clients.
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
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
  // LT-B1..B10 additions
  "ONE_TO_ONE_VIOLATION",
  "OFFSET_TOO_DEEP_USE_SEARCH_AFTER",
  "INVALID_SEARCH_AFTER_TOKEN",
  "PIT_EXPIRED",
  "RESULT_SET_TOO_LARGE",
  "REVERSE_ACTIONS_DISABLED",
  "QUARANTINE_NOT_FOUND",
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
      violationPolicy,
      reverseApiName, reverseDisplayName, reverseDescription,
      reverseVisible, reversePropertyProjection, reverseActionsEnabled,
      mandatoryControlPropertyId, mcpPropagationMode, mcpRequiredCount,
      storageBackend,
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
      violationPolicy,
      reverseApiName, reverseDisplayName, reverseDescription,
      reverseVisible, reversePropertyProjection, reverseActionsEnabled,
      mandatoryControlPropertyId, mcpPropagationMode, mcpRequiredCount,
      storageBackend,
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
          const count = await countLinks(linkType, r.objectPK, r.direction, buildSecurityFilter(req.security));
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

    const results = await bulkCountLinks(ontologyId, otResult.rows[0].object_type_id, objectPK, buildSecurityFilter(req.security));
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
    }, buildSecurityFilter(req.security));

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
    if (
      apiName === "export" ||
      apiName === "import" ||
      apiName === "bulkCount" ||
      apiName === "multiHop" ||
      apiName === "_config"
    ) {
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
      violationPolicy,
      reverseApiName, reverseDisplayName, reverseDescription,
      reverseVisible, reversePropertyProjection, reverseActionsEnabled,
      mandatoryControlPropertyId, mcpPropagationMode, mcpRequiredCount,
      storageBackend,
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
      violationPolicy,
      reverseApiName, reverseDisplayName, reverseDescription,
      reverseVisible, reversePropertyProjection, reverseActionsEnabled,
      mandatoryControlPropertyId, mcpPropagationMode, mcpRequiredCount,
      storageBackend,
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
      // F-10: Cascade cleanup — delete the orphaned join table file.
      try {
        const fs = require("fs");
        if (fs.existsSync(deleted.join_table_file_path)) {
          fs.unlinkSync(deleted.join_table_file_path);
          console.info(`[CASCADE_CLEANUP] Deleted join table file: ${deleted.join_table_file_path}`);
        }
      } catch (cleanupErr: any) {
        console.warn(`[CASCADE_CLEANUP_FAILED] Could not delete join table file ${deleted.join_table_file_path}: ${cleanupErr.message}`);
        (formatted as any).warnings = [`Failed to delete orphaned join table file: ${deleted.join_table_file_path}`];
      }
    }

    // F-10: Cascade cleanup — purge link_edit and quarantine rows for this link type.
    try {
      const { query: pgQuery } = require("../db");
      await pgQuery("DELETE FROM link_edit WHERE link_type_api_name = $1", [apiName]);
      await pgQuery("DELETE FROM link_quarantine WHERE link_type_api_name = $1", [apiName]);
    } catch (cascadeErr: any) {
      // Tables may not exist in transitional deployments.
      console.warn(`[CASCADE_CLEANUP] link_edit/quarantine purge for '${apiName}': ${cascadeErr.message}`);
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
    const {
      objectPK, direction, pageSize, pageToken, targetFilter, select,
      maxResultPks, includeLinkState, paginationMode,
    } = req.body;

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

    // LT-B2 — resolve effective PK cap from tenant config + optional override.
    const resolverConfig = await getResolverConfig(ontologyId);
    const capDecision = effectiveMaxPks(
      resolverConfig.max_intermediate_pks,
      typeof maxResultPks === "number" ? maxResultPks : undefined,
      resolverConfig.global_hard_cap
    );

    // LT-B9 — reject deep offset pagination; callers should switch to search_after.
    if (paginationMode !== "search_after" && !isSearchAfterToken(pageToken)) {
      try {
        const currentOffset = pageToken
          ? JSON.parse(Buffer.from(pageToken, "base64").toString())?.offset ?? 0
          : 0;
        assertOffsetWithinCap(Number(currentOffset) || 0);
      } catch (e) {
        if (e instanceof OffsetTooDeepError) {
          return sendError(res, e.code, e.message);
        }
      }
    }

    const result = await resolveLinks(linkType, objectPK, direction, {
      pageSize, pageToken, targetFilter, select,
    }, buildSecurityFilter(req.security));

    // LT-B6 — strip reverse-only projection from hits before responding.
    const projectedHits = applyReverseProjectionAll(
      result.linkedObjects,
      linkType,
      direction
    );

    // LT-B5 — optional per-result state when `includeLinkState=true`.
    const withState = includeLinkState
      ? await Promise.all(
          projectedHits.slice(0, 25).map(async (hit) => {
            const state = await resolveFKWithState(
              linkType,
              String(hit.__pk ?? objectPK),
              direction,
              ontologyId
            ).catch(() => ({ state: "resolved" as const, target: hit, orphanReason: undefined as string | undefined }));
            return {
              object: hit,
              linkState: state.state,
              orphanReason: (state as { orphanReason?: string }).orphanReason,
            };
          })
        )
      : undefined;

    // LT-B6 — self-reversing cardinality view.
    const effectiveCardinality =
      direction === "reverse"
        ? reverseCardinality(linkType.cardinality)
        : linkType.cardinality;

    const isSingle =
      (linkType.cardinality === "ONE_TO_ONE" || linkType.cardinality === "MANY_TO_ONE") &&
      direction === "forward";
    if (isSingle) {
      return sendSuccess(res, {
        linkedObject: projectedHits.length > 0 ? projectedHits[0] : null,
        metadata: {
          cardinality: effectiveCardinality,
          effective_max_pks: capDecision.effective,
          max_pks_clamped: capDecision.clamped,
          pagination_mode: paginationMode ?? "offset",
        },
      });
    }

    return sendSuccess(res, {
      ...result,
      linkedObjects: projectedHits,
      linkedObjectsWithState: withState,
      metadata: {
        cardinality: effectiveCardinality,
        effective_max_pks: capDecision.effective,
        max_pks_clamped: capDecision.clamped,
        pagination_mode: paginationMode ?? "offset",
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

    const count = await countLinks(linkType, objectPK, direction, buildSecurityFilter(req.security));
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
    }, buildSecurityFilter(req.security));

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

    const validation = await validateJoinTable(linkType, buildSecurityFilter(req.security));
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

    const precisionRaw = req.query.precision as string | undefined;
    const precision =
      precisionRaw === "exact" || precisionRaw === "sampled" || precisionRaw === "fast"
        ? precisionRaw
        : undefined;
    const analysis = await analyzeLinkType(linkType, { precision }, buildSecurityFilter(req.security));
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
    // LT-B1
    storageBackend: row.storage_backend ?? "csv_legacy",
    icebergTableName: row.iceberg_table_name ?? null,
    // LT-B4
    violationPolicy: row.violation_policy ?? "warn",
    violationCount24h: row.violation_count_24h ?? 0,
    // LT-B6
    reverseApiName: row.reverse_api_name ?? null,
    reverseDisplayName: row.reverse_display_name ?? null,
    reverseDescription: row.reverse_description ?? null,
    reverseVisible: row.reverse_visible ?? true,
    reversePropertyProjection: row.reverse_property_projection ?? null,
    reverseActionsEnabled: row.reverse_actions_enabled ?? true,
    // LT-B7
    mandatoryControlPropertyId: row.mandatory_control_property_id ?? null,
    mcpPropagationMode: row.mcp_propagation_mode ?? "union",
    mcpRequiredCount: row.mcp_required_count ?? 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// LT-B2 — Resolver config (per-ontology PK caps + escalation backend)
// ---------------------------------------------------------------------------

router.get("/_config/resolver", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const config = await getResolverConfig(ontologyId);
    return sendSuccess(res, config);
  } catch (err: any) {
    next(err);
  }
});

router.put("/_config/resolver", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const {
      maxIntermediatePks,
      maxSearchAroundSource,
      maxMultihopIntermediate,
      escalationBackend,
      escalationThresholdPks,
      globalHardCap,
    } = req.body;

    if (
      escalationBackend !== undefined &&
      !["none", "clickhouse", "furnace"].includes(escalationBackend)
    ) {
      return sendError(
        res,
        "VALIDATION_FAILED",
        "escalationBackend must be one of: none, clickhouse, furnace"
      );
    }

    const updated = await upsertResolverConfig(ontologyId, {
      maxIntermediatePks,
      maxSearchAroundSource,
      maxMultihopIntermediate,
      escalationBackend,
      escalationThresholdPks,
      globalHardCap,
    });
    return sendSuccess(res, updated);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// LT-B4 — Quarantine endpoints
// ---------------------------------------------------------------------------

router.get("/:apiName/violations", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const status = req.query.status as "pending" | "resolved" | "dismissed" | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const result = await listQuarantineEntries({
      ontologyId,
      linkTypeApiName: apiName,
      status,
      limit,
      offset,
    });
    return sendSuccess(res, result);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

router.post(
  "/:apiName/violations/:violationId/resolve",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { violationId } = req.params;
      const { resolvedBy, note } = req.body ?? {};
      const row = await resolveQuarantineEntry(
        violationId,
        resolvedBy ?? "admin",
        note
      );
      if (!row) {
        return sendError(
          res,
          "QUARANTINE_NOT_FOUND",
          `Quarantine entry ${violationId} not found or already handled.`
        );
      }
      return sendSuccess(res, row);
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

router.post(
  "/:apiName/violations/:violationId/dismiss",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { violationId } = req.params;
      const { resolvedBy, note } = req.body ?? {};
      const row = await dismissQuarantineEntry(
        violationId,
        resolvedBy ?? "admin",
        note
      );
      if (!row) {
        return sendError(
          res,
          "QUARANTINE_NOT_FOUND",
          `Quarantine entry ${violationId} not found or already handled.`
        );
      }
      return sendSuccess(res, row);
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// Expose the enforcer so tests & Action layer handlers can dry-run a
// would-be edit without actually committing it. Returns whether the
// edit is allowed under the current policy.
router.post(
  "/:apiName/enforce-one-to-one",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const { sourcePk, targetPk } = req.body ?? {};
      if (!sourcePk || !targetPk) {
        return sendError(res, "VALIDATION_FAILED", "sourcePk and targetPk are required");
      }
      const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
      if (!linkType) {
        return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
      }
      const result = await enforceOneToOneAdd({
        linkType,
        ontologyId,
        sourcePk,
        targetPk,
      });
      return sendSuccess(res, result);
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message, err.details);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// LT-B5 — Orphan stats & listing + on-demand scan
// ---------------------------------------------------------------------------

router.get("/:apiName/orphan-stats", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const days = req.query.days ? parseInt(req.query.days as string, 10) : 30;
    const rows = await getLatestOrphanStats(ontologyId, apiName, days);
    return sendSuccess(res, {
      linkTypeApiName: apiName,
      days,
      points: rows,
      latest: rows[0] ?? null,
    });
  } catch (err: any) {
    next(err);
  }
});

router.post("/:apiName/orphan-scan", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }
    const sampleLimit = req.body?.sampleLimit ?? 1000;
    const result = await runOrphanScan(linkType, ontologyId, sampleLimit);
    return sendSuccess(res, result);
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

router.get("/:apiName/orphans", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const cursor = req.query.cursor as string | undefined;
    const result = await listOrphans({
      ontologyId,
      linkTypeApiName: apiName,
      limit,
      cursor,
    });
    return sendSuccess(res, result);
  } catch (err: any) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// LT-B7 — Marking derivation trace (admin-only)
// ---------------------------------------------------------------------------

router.get(
  "/:apiName/edge/:sourcePK/:targetPK/marking-trace",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName, sourcePK, targetPK } = req.params;
      const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
      if (!linkType) {
        return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
      }

      const sourceMarkings = Array.isArray(req.query.sourceMarkings)
        ? (req.query.sourceMarkings as string[])
        : req.query.sourceMarkings
          ? String(req.query.sourceMarkings).split(",")
          : [];
      const targetMarkings = Array.isArray(req.query.targetMarkings)
        ? (req.query.targetMarkings as string[])
        : req.query.targetMarkings
          ? String(req.query.targetMarkings).split(",")
          : [];

      const effective = deriveEdgeMarkings(linkType, sourceMarkings, targetMarkings);
      return sendSuccess(res, {
        linkTypeApiName: apiName,
        sourcePK,
        targetPK,
        mcpConfigured: Boolean(linkType.mandatory_control_property_id),
        mcpPropagationMode: linkType.mcp_propagation_mode ?? "union",
        mcpRequiredCount: linkType.mcp_required_count ?? 1,
        sourceMarkings,
        targetMarkings,
        effectiveMarkings: effective,
      });
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// LT-F2 — edge browser feed
//
// Backed by the existing CSV join-table reader for legacy M2M links and
// by a placeholder Iceberg reader for migrated links. Pagination uses
// the LT-B9 search_after token shape even for the CSV path so the FE
// has a uniform contract.
// ---------------------------------------------------------------------------

router.get("/:apiName/edges", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const {
      sourcePK,
      targetPK,
      pageSize: pageSizeRaw,
      pageToken,
    } = req.query as Record<string, string | undefined>;

    const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
    if (!linkType) {
      return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
    }

    const pageSize = Math.min(Math.max(parseInt(pageSizeRaw ?? "100", 10) || 100, 1), 1000);

    // Decode the search_after cursor to recover the last-seen
    // (source_pk, target_pk) tuple. Legacy offset tokens still decode
    // into `offset` for back-compat.
    let lastSource: string | null = null;
    let lastTarget: string | null = null;
    let offset = 0;
    if (pageToken) {
      try {
        const parsed = JSON.parse(Buffer.from(pageToken, "base64url").toString());
        if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.sort_keys)) {
            lastSource = String(parsed.sort_keys[0] ?? "") || null;
            lastTarget = String(parsed.sort_keys[1] ?? "") || null;
          } else if (typeof parsed.offset === "number") {
            offset = parsed.offset;
          }
        }
      } catch {
        /* treat as offset=0 */
      }
    }

    // Pull edges from the legacy CSV (storage_backend='csv_legacy'). For
    // the iceberg backend we stream via DuckDB iceberg_scan; this is
    // stubbed to empty on dev boxes without the PyIceberg sidecar.
    const edges: Array<{
      source_pk: string;
      target_pk: string;
      link_props: Record<string, unknown>;
      markings: string[];
      created_at: string | null;
    }> = [];

    if (linkType.storage_backend !== "iceberg" && linkType.join_table_file_path) {
      const fs = await import("fs");
      if (fs.existsSync(linkType.join_table_file_path)) {
        const data = fs.readFileSync(linkType.join_table_file_path, "utf-8");
        const lines = data.trim().split("\n");
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",").map((c) => c.trim());
          if (cols.length < 2 || !cols[0] || !cols[1]) continue;
          if (sourcePK && cols[0] !== sourcePK) continue;
          if (targetPK && cols[1] !== targetPK) continue;
          if (lastSource !== null && lastTarget !== null) {
            if (cols[0] < lastSource) continue;
            if (cols[0] === lastSource && cols[1] <= lastTarget) continue;
          }
          edges.push({
            source_pk: cols[0],
            target_pk: cols[1],
            link_props: {},
            markings: [],
            created_at: null,
          });
          if (edges.length >= pageSize) break;
        }
      }
    }

    // Apply offset cap for the legacy offset path, same contract as
    // LT-B9 resolve endpoint.
    if (!lastSource && offset > 10_000) {
      return sendError(
        res,
        "OFFSET_TOO_DEEP_USE_SEARCH_AFTER",
        "offset paging beyond 10_000 is no longer supported — use paginationMode=search_after"
      );
    }

    // Next-page token = the last (source, target) tuple base64url-encoded.
    let nextPageToken: string | null = null;
    if (edges.length === pageSize) {
      const last = edges[edges.length - 1];
      nextPageToken = Buffer.from(
        JSON.stringify({
          sort_keys: [last.source_pk, last.target_pk],
          pit_id: null,
          backend: linkType.storage_backend === "iceberg" ? "iceberg" : "opensearch",
        })
      ).toString("base64url");
    }

    return sendSuccess(res, {
      edges,
      pageSize,
      nextPageToken,
      storageBackend: linkType.storage_backend ?? "csv_legacy",
    });
  } catch (err: any) {
    if (err.code && KNOWN_CODES.has(err.code)) {
      return sendError(res, err.code, err.message);
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// LT-F3 — cardinality estimate (estimate-then-escalate preview)
// ---------------------------------------------------------------------------

router.get(
  "/:apiName/searchAround/estimate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
      if (!linkType) {
        return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
      }
      const { estimateCardinality, decideEscalation } = await import(
        "../services/linkCardinalityEstimator"
      );
      const config = await getResolverConfig(ontologyId);
      let sourceFilter: Record<string, unknown> | undefined;
      if (typeof req.query.sourceFilter === "string") {
        try {
          sourceFilter = JSON.parse(req.query.sourceFilter);
        } catch {
          sourceFilter = undefined;
        }
      }
      const estimate = await estimateCardinality(linkType, sourceFilter);
      const decision = decideEscalation(estimate, config);
      return sendSuccess(res, {
        estimate,
        decision,
        config: {
          escalation_backend: config.escalation_backend,
          escalation_threshold_pks: config.escalation_threshold_pks,
          max_search_around_source: config.max_search_around_source,
        },
      });
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// LT-F7 — visibility summary (marking-aware counts)
// ---------------------------------------------------------------------------

router.get(
  "/:apiName/visibility-summary",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
      if (!linkType) {
        return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
      }
      const userMarkingsRaw = (req.query.userMarkings as string | undefined) ?? "";
      const userMarkings = userMarkingsRaw
        ? userMarkingsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const mcpConfigured = Boolean(linkType.mandatory_control_property_id);
      const requiredCount = linkType.mcp_required_count ?? 1;

      // Visible + hidden counts come from a cheap analysis call with
      // precision=fast (manifest stats for Iceberg, _count for FK).
      const analysis = await analyzeLinkType(linkType, { precision: "fast" });
      const total = analysis.totalLinkCount ?? 0;
      // Without actual row markings we estimate "hidden" as the naive
      // proportion of edges whose required markings aren't in the user
      // set. With MCP disabled, nothing is hidden.
      const hiddenEstimate = mcpConfigured && userMarkings.length < requiredCount
        ? total
        : 0;

      return sendSuccess(res, {
        linkTypeApiName: apiName,
        mcpConfigured,
        mcpPropagationMode: linkType.mcp_propagation_mode ?? "union",
        mcpRequiredCount: requiredCount,
        userMarkings,
        totalLinkCount: total,
        visibleCount: Math.max(total - hiddenEstimate, 0),
        hiddenCount: hiddenEstimate,
        markingNamesPolicy: process.env.MARKINGS_SHOW_NAMES_IN_UI ?? "always",
      });
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// LT-B1 — Migrate CSV join table to Iceberg backend
// ---------------------------------------------------------------------------

router.post(
  "/:apiName/migrate-storage",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const linkType = await linkTypeModel.getByApiName(ontologyId, apiName);
      if (!linkType) {
        return sendError(res, "LINK_TYPE_NOT_FOUND", `Link type '${apiName}' not found.`);
      }
      const result = await migrateLinkStorage(linkType, ontologyId);
      return sendSuccess(res, result);
    } catch (err: any) {
      if (err.code && KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

export default router;
