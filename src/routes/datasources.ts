// ---------------------------------------------------------------------------
// Datasource Routes — Express Router
//
// Routes for backing datasource management, nested under object types.
// Mounted at:
//   /api/v1/ontology/:ontologyId/objectTypes/:apiName/datasource
//
// Provides 4 endpoints:
//   POST   /          — Register a backing datasource
//   GET    /          — Get the registered datasource
//   DELETE /          — Unregister the datasource
//   POST   /scan      — Re-scan the file and update metadata
//
// Uses mergeParams: true to access :ontologyId and :apiName from parent.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import datasourceService from "../services/datasourceService";
import {
  registerWithDataset,
  registerWithFoundryDataset,
} from "../services/datasetDatasourceService";
import {
  formatDatasource,
  sendSuccess,
  sendCreated,
  sendNoContent,
  sendError,
} from "../utils/responseFormatter";
import {
  validateBody,
  REGISTER_DATASOURCE_SCHEMA,
} from "../middleware/validateBody";
import { dataPlaneGuard } from "../middleware/requireRole";

const router = Router({ mergeParams: true });

// Function-level authorization: registering / re-scanning a backing
// datasource require ontology-editor; unregister (DELETE) requires
// ontology-admin (PATs scope-gated upstream, superadmin passes, reads open).
router.use(dataPlaneGuard({ post: "write" }));

// ---------------------------------------------------------------------------
// Known error codes handled in catch blocks
// ---------------------------------------------------------------------------

const KNOWN_CODES = new Set([
  "OBJECT_TYPE_NOT_FOUND",
  "DATASOURCE_NOT_FOUND",
  "DATASOURCE_ALREADY_REGISTERED",
  "DATASOURCE_FILE_NOT_FOUND",
  "COLUMN_MAPPING_INVALID",
  "PRIMARY_KEY_NOT_SET",
  "VALIDATION_FAILED",
  "AMBIGUOUS_DATASOURCE",
  "DATASET_NOT_FOUND",
  "DATASET_EMPTY",
  "COLUMN_NOT_FOUND",
  "PRIMARY_KEY_MISMATCH",
  "DATASET_ALREADY_BACKING",
]);

// ---------------------------------------------------------------------------
// Helper: resolve objectTypeId from route params
// ---------------------------------------------------------------------------

async function resolveObjectTypeId(
  req: Request,
  res: Response
): Promise<string | null> {
  const { ontologyId, apiName } = req.params;
  const result = await query(
    "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
    [ontologyId, apiName]
  );
  if (result.rows.length === 0) {
    sendError(
      res,
      "OBJECT_TYPE_NOT_FOUND",
      `Object type '${apiName}' not found in ontology '${ontologyId}'.`
    );
    return null;
  }
  return result.rows[0].object_type_id;
}

// ---------------------------------------------------------------------------
// Route 1: POST / — Register a backing datasource
// ---------------------------------------------------------------------------

router.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { datasetId, foundryDatasetId, datasetName, filePath, fileFormat, columnMapping, primaryKeyColumn } = req.body;

      // Foundry-dataset bridge: registers a `foundry_datasets` row (the
      // table tellus-fe's upload pipeline writes to) as a backing
      // datasource, reading columns from `dataset_columns` without any
      // filesystem round-trip. Used by the "Create a new object type"
      // wizard whose Step 1 picker is backed by foundry_datasets.
      if (foundryDatasetId) {
        if (!columnMapping) {
          return sendError(res, "VALIDATION_FAILED", "columnMapping is required.");
        }
        if (!primaryKeyColumn) {
          return sendError(res, "VALIDATION_FAILED", "primaryKeyColumn is required.");
        }
        const result = await registerWithFoundryDataset(objectTypeId, {
          foundryDatasetId,
          columnMapping,
          primaryKeyColumn,
        });
        return sendCreated(res, {
          backingDatasource: result,
          message: `Backing datasource registered from foundry dataset ${foundryDatasetId}.`,
        });
      }

      // If datasetId is provided, use the Ontology-dataset-aware path
      if (datasetId) {
        const result = await registerWithDataset(objectTypeId, {
          datasetId,
          filePath,
          columnMapping,
          primaryKeyColumn,
        });

        return sendCreated(res, {
          backingDatasource: result,
          message: `Backing datasource registered. Call POST /api/v1/ontology/:id/objectTypes/${result.objectType}/reindex to index the data into the Ontology.`,
        });
      }

      // Legacy path: use original datasourceService.register
      if (!columnMapping) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "columnMapping is required."
        );
      }

      const row = await datasourceService.register(objectTypeId, {
        datasetName,
        filePath,
        fileFormat,
        columnMapping,
      });

      const formatted = formatDatasource(row);
      sendCreated(res, formatted);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 2: GET / — Get the registered datasource
// ---------------------------------------------------------------------------

router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const row = await datasourceService.getByObjectType(objectTypeId);
      if (!row) {
        return sendError(
          res,
          "DATASOURCE_NOT_FOUND",
          "No datasource registered for this object type."
        );
      }

      const formatted = formatDatasource(row);
      sendSuccess(res, formatted);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 3: DELETE / — Unregister the datasource
// ---------------------------------------------------------------------------

router.delete(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      await datasourceService.unregister(objectTypeId);
      sendNoContent(res);
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 4: POST /scan — Re-scan the file
// ---------------------------------------------------------------------------

router.post(
  "/scan",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const objectTypeId = await resolveObjectTypeId(req, res);
      if (!objectTypeId) return;

      const { datasource, schemaChanged } =
        await datasourceService.scan(objectTypeId);

      const formatted = formatDatasource(datasource);
      sendSuccess(res, {
        datasource: formatted,
        schemaChanged,
      });
    } catch (err: any) {
      if (KNOWN_CODES.has(err.code)) {
        return sendError(res, err.code, err.message);
      }
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Route 5: POST /suggestMapping — Suggest column-to-property mapping
//
// Uses the MappingSuggestionService to analyze a dataset's columns and
// an object type's properties, returning a suggested mapping with
// confidence levels and a readyToRegister flag.
//
// This route is exported separately and mounted at:
//   /api/v1/ontology/:ontologyId/objectTypes/:apiName/suggestMapping
// ---------------------------------------------------------------------------

import { suggestMapping } from "../services/mappingSuggestionService";

export const suggestMappingRouter = Router({ mergeParams: true });

suggestMappingRouter.post(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const { datasetId } = req.body;

      if (!datasetId) {
        return sendError(
          res,
          "VALIDATION_FAILED",
          "datasetId is required in the request body."
        );
      }

      // Check if dataset has a schema
      const dsResult = await query(
        "SELECT schema_definition FROM dataset WHERE dataset_id = $1",
        [datasetId]
      );

      if (dsResult.rows.length === 0) {
        return sendError(
          res,
          "DATASET_NOT_FOUND",
          `Dataset '${datasetId}' was not found.`
        );
      }

      const schema = dsResult.rows[0].schema_definition;
      let hasSchema = false;
      if (schema) {
        if (Array.isArray(schema) && schema.length > 0) {
          hasSchema = true;
        } else if (schema.columns && Array.isArray(schema.columns) && schema.columns.length > 0) {
          hasSchema = true;
        }
      }

      if (!hasSchema) {
        return sendError(
          res,
          "DATASET_NO_SCHEMA",
          "Dataset has no schema definition. Upload data to the dataset first."
        );
      }

      const result = await suggestMapping(ontologyId, apiName, datasetId);

      // Add confidence levels to each suggestion
      const suggestedMapping: Record<string, unknown> = {};
      for (const s of result.suggestions) {
        let confidence: string;
        if (s.score >= 90) confidence = "exact";
        else if (s.score >= 70) confidence = "high";
        else if (s.score >= 40) confidence = "medium";
        else confidence = "low";

        let nameMatch: string;
        if (s.nameScore >= 55) nameMatch = "exact";
        else if (s.nameScore >= 35) nameMatch = "substring";
        else nameMatch = "partial";

        let typeMatch: string;
        if (s.typeScore >= 35) typeMatch = "compatible";
        else if (s.typeScore >= 15) typeMatch = "coercible";
        else typeMatch = "incompatible";

        suggestedMapping[s.propertyApiName] = {
          column: s.columnName,
          score: s.score,
          confidence,
          typeMatch,
          nameMatch,
        };
      }

      // Determine primary key column suggestion
      const otResult = await query(
        `SELECT ot.primary_key_property_id, p.api_name AS pk_api_name
         FROM object_type ot
         LEFT JOIN property p ON p.property_id = ot.primary_key_property_id
         WHERE ot.ontology_id = $1 AND ot.api_name = $2`,
        [ontologyId, apiName]
      );

      let suggestedPrimaryKeyColumn: string | null = null;
      let pkPropertyMapped = true;

      if (otResult.rows.length > 0 && otResult.rows[0].pk_api_name) {
        const pkApiName = otResult.rows[0].pk_api_name;
        const pkSuggestion = result.suggestions.find(
          (s) => s.propertyApiName === pkApiName
        );
        if (pkSuggestion) {
          suggestedPrimaryKeyColumn = pkSuggestion.columnName;
        } else {
          pkPropertyMapped = false;
        }
      }

      // Check required properties
      const requiredPropsResult = await query(
        `SELECT api_name FROM property
         WHERE object_type_id = (
           SELECT object_type_id FROM object_type
           WHERE ontology_id = $1 AND api_name = $2
         ) AND is_required = true`,
        [ontologyId, apiName]
      );
      const requiredProps = requiredPropsResult.rows.map((r: any) => r.api_name);
      const mappedProps = new Set(result.suggestions.map((s) => s.propertyApiName));
      const allRequiredMapped = requiredProps.every((p: string) => mappedProps.has(p));

      // Check for type incompatibilities
      const hasIncompatible = result.suggestions.some((s) => s.typeScore === 0);

      const readyToRegister = allRequiredMapped && pkPropertyMapped && !hasIncompatible;

      return sendSuccess(res, {
        suggestedMapping,
        unmappedProperties: result.unmappedProperties.map((p: string) => ({
          apiName: p,
          reason: "No matching column found with sufficient confidence",
        })),
        unmappedColumns: result.unmappedColumns.map((c: string) => ({
          columnName: c,
          reason: "No matching property found",
        })),
        suggestedPrimaryKeyColumn,
        readyToRegister,
        columnMapping: result.columnMapping,
      });
    } catch (err: any) {
      if (err.message?.includes("not found")) {
        return sendError(
          res,
          "OBJECT_TYPE_NOT_FOUND",
          err.message
        );
      }
      next(err);
    }
  }
);

export default router;
