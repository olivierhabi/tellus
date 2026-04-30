// ---------------------------------------------------------------------------
// Function Registry — Ontology Platform spec Task 18
// ---------------------------------------------------------------------------
// Mounted at /api/v1/ontology/:ontologyId/functions
//   POST   /                            — register a new function
//   GET    /                            — list registered functions
//   GET    /:apiName                    — function detail with versions
//   POST   /:apiName/versions           — publish a new version
//   POST   /:apiName/invoke             — execute the latest version
//
// Invocation honours a 5s timeout (spec §Task 6 + §Task 18 observability
// contract) and records every call in ontology_function_invocation for
// metrics aggregation.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  sendSuccess,
  sendCreated,
  sendError,
  sendNoContent,
} from "../utils/responseFormatter";
import { runSandboxed, FUNCTION_TIMEOUT_MS } from "../services/functionRuntime";

const router = Router({ mergeParams: true });

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { apiName, displayName, description, runtime, sourceCode, inputSchema, outputSchema } =
      req.body || {};
    if (!apiName || !displayName) {
      return sendError(res, "VALIDATION_FAILED", "apiName and displayName are required.");
    }
    if (!sourceCode) {
      return sendError(res, "VALIDATION_FAILED", "sourceCode is required for initial version.");
    }
    const fn = await query(
      `INSERT INTO ontology_function
         (ontology_id, api_name, display_name, description, runtime)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ontologyId, apiName, displayName, description || null, runtime || "typescript"]
    );
    await query(
      `INSERT INTO ontology_function_version
         (function_id, version_number, source_code, input_schema, output_schema, is_latest, published_by)
       VALUES ($1, 1, $2, $3::jsonb, $4::jsonb, true, $5)`,
      [
        fn.rows[0].function_id,
        sourceCode,
        JSON.stringify(inputSchema || {}),
        JSON.stringify(outputSchema || {}),
        (req as any).user?.id || "system",
      ]
    );
    sendCreated(res, { function: fn.rows[0], versions: [{ version: 1 }] });
  } catch (err: any) {
    if (err.code === "23505") {
      return sendError(res, "API_NAME_CONFLICT", "Function already exists.");
    }
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const result = await query(
      `SELECT f.*,
              (SELECT COUNT(*)::int FROM ontology_function_version v WHERE v.function_id = f.function_id) AS version_count,
              (SELECT COUNT(*)::int FROM ontology_function_invocation i WHERE i.function_id = f.function_id AND i.invoked_at > now() - interval '24 hours') AS invocations_24h
         FROM ontology_function f
        WHERE f.ontology_id = $1
        ORDER BY f.display_name`,
      [ontologyId]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId, apiName } = req.params;
    const fn = await query(
      "SELECT * FROM ontology_function WHERE ontology_id = $1 AND api_name = $2",
      [ontologyId, apiName]
    );
    if (fn.rowCount === 0) {
      return sendError(res, "NOT_FOUND", `Function ${apiName} not found.`);
    }
    const versions = await query(
      "SELECT * FROM ontology_function_version WHERE function_id = $1 ORDER BY version_number DESC",
      [fn.rows[0].function_id]
    );
    sendSuccess(res, { function: fn.rows[0], versions: versions.rows });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/:apiName/versions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const { sourceCode, inputSchema, outputSchema } = req.body || {};
      if (!sourceCode) {
        return sendError(res, "VALIDATION_FAILED", "sourceCode is required.");
      }
      const fn = await query(
        "SELECT function_id FROM ontology_function WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, apiName]
      );
      if (fn.rowCount === 0) {
        return sendError(res, "NOT_FOUND", `Function ${apiName} not found.`);
      }
      const functionId = fn.rows[0].function_id;
      // Atomic switch of is_latest
      await query("BEGIN");
      try {
        await query(
          "UPDATE ontology_function_version SET is_latest = false WHERE function_id = $1",
          [functionId]
        );
        const next = await query(
          "SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM ontology_function_version WHERE function_id = $1",
          [functionId]
        );
        const versionNumber = next.rows[0].n;
        const result = await query(
          `INSERT INTO ontology_function_version
             (function_id, version_number, source_code, input_schema, output_schema, is_latest, published_by)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, true, $6)
           RETURNING *`,
          [
            functionId,
            versionNumber,
            sourceCode,
            JSON.stringify(inputSchema || {}),
            JSON.stringify(outputSchema || {}),
            (req as any).user?.id || "system",
          ]
        );
        await query("COMMIT");
        sendCreated(res, result.rows[0]);
      } catch (e) {
        await query("ROLLBACK");
        throw e;
      }
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:apiName/invoke",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      const fn = await query(
        `SELECT f.function_id, f.runtime, v.version_id, v.source_code
           FROM ontology_function f
           JOIN ontology_function_version v ON v.function_id = f.function_id AND v.is_latest = true
          WHERE f.ontology_id = $1 AND f.api_name = $2`,
        [ontologyId, apiName]
      );
      if (fn.rowCount === 0) {
        return sendError(res, "NOT_FOUND", `Function ${apiName} not found.`);
      }
      const { function_id, version_id, source_code, runtime } = fn.rows[0];

      if (runtime !== "typescript" && runtime !== "javascript") {
        return sendError(
          res,
          "VALIDATION_FAILED",
          `Runtime '${runtime}' is not supported by the inline sandbox.`
        );
      }

      const sandboxResult = runSandboxed(source_code, req.body?.input ?? null);

      await query(
        `INSERT INTO ontology_function_invocation
           (function_id, version_id, duration_ms, status, error_message)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          function_id,
          version_id,
          sandboxResult.durationMs,
          sandboxResult.status,
          sandboxResult.errorMessage || null,
        ]
      );

      if (sandboxResult.status === "timeout") {
        return sendError(
          res,
          "FUNCTION_TIMEOUT",
          `Function exceeded ${FUNCTION_TIMEOUT_MS}ms timeout.`
        );
      }
      if (sandboxResult.status === "error") {
        return sendError(
          res,
          "RULE_EXECUTION_FAILED",
          sandboxResult.errorMessage || "Function execution failed."
        );
      }

      sendSuccess(res, {
        output: sandboxResult.output,
        durationMs: sandboxResult.durationMs,
        logs: sandboxResult.logs,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:apiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ontologyId, apiName } = req.params;
      await query(
        "DELETE FROM ontology_function WHERE ontology_id = $1 AND api_name = $2",
        [ontologyId, apiName]
      );
      sendNoContent(res);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
