// ---------------------------------------------------------------------------
// Function Registry Routes — Express Router
//
// CRUD for registered functions. Table auto-created on first use.
//
// Mounted at: /api/v2/ontologies/:ontologyId/functions
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendNoContent, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensureFunctionTable(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS function_type (
      function_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id        UUID NOT NULL,
      api_name           TEXT NOT NULL,
      display_name       TEXT NOT NULL,
      description        TEXT,
      version            INT DEFAULT 1,
      input_schema       JSONB,
      output_schema      JSONB,
      code_repository_url TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(ontology_id, api_name)
    )
  `);
  migrated = true;
}

function formatRow(row: any) {
  return {
    functionId: row.function_id,
    ontologyId: row.ontology_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description,
    version: row.version,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    codeRepositoryUrl: row.code_repository_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// GET / — List functions
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFunctionTable();
    const { ontologyId } = req.params;

    const result = await query(
      `SELECT * FROM function_type WHERE ontology_id = $1 ORDER BY created_at DESC`,
      [ontologyId]
    );

    return sendSuccess(res, { data: result.rows.map(formatRow) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create a function
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFunctionTable();
    const { ontologyId } = req.params;
    const { apiName, displayName, description, inputSchema, outputSchema, codeRepositoryUrl } = req.body || {};

    if (!apiName || !displayName) {
      return sendError(res, "VALIDATION_FAILED", "apiName and displayName are required.");
    }

    const result = await query(
      `INSERT INTO function_type (ontology_id, api_name, display_name, description, input_schema, output_schema, code_repository_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [ontologyId, apiName, displayName, description || null, inputSchema ? JSON.stringify(inputSchema) : null, outputSchema ? JSON.stringify(outputSchema) : null, codeRepositoryUrl || null]
    );

    return sendCreated(res, formatRow(result.rows[0]));
  } catch (err: any) {
    if (err.code === "23505") {
      return sendError(res, "ALREADY_EXISTS", "A function with that apiName already exists.");
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /:apiName — Get a single function
// ---------------------------------------------------------------------------

router.get("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFunctionTable();
    const { ontologyId, apiName } = req.params;

    const result = await query(
      `SELECT * FROM function_type WHERE ontology_id = $1 AND api_name = $2`,
      [ontologyId, apiName]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Function '${apiName}' not found.`);
    }

    return sendSuccess(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:apiName — Update a function
// ---------------------------------------------------------------------------

router.put("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFunctionTable();
    const { ontologyId, apiName } = req.params;
    const { displayName, description, inputSchema, outputSchema, codeRepositoryUrl } = req.body || {};

    const sets: string[] = ["updated_at = NOW()"];
    const values: unknown[] = [];
    let idx = 1;

    if (displayName !== undefined) { sets.push(`display_name = $${idx++}`); values.push(displayName); }
    if (description !== undefined) { sets.push(`description = $${idx++}`); values.push(description); }
    if (inputSchema !== undefined) { sets.push(`input_schema = $${idx++}`); values.push(JSON.stringify(inputSchema)); }
    if (outputSchema !== undefined) { sets.push(`output_schema = $${idx++}`); values.push(JSON.stringify(outputSchema)); }
    if (codeRepositoryUrl !== undefined) { sets.push(`code_repository_url = $${idx++}`); values.push(codeRepositoryUrl); }

    // Also bump version on update
    sets.push("version = version + 1");

    values.push(ontologyId, apiName);
    const result = await query(
      `UPDATE function_type SET ${sets.join(", ")} WHERE ontology_id = $${idx++} AND api_name = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Function '${apiName}' not found.`);
    }

    return sendSuccess(res, formatRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:apiName — Delete a function
// ---------------------------------------------------------------------------

router.delete("/:apiName", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureFunctionTable();
    const { ontologyId, apiName } = req.params;

    const result = await query(
      `DELETE FROM function_type WHERE ontology_id = $1 AND api_name = $2 RETURNING *`,
      [ontologyId, apiName]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Function '${apiName}' not found.`);
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
