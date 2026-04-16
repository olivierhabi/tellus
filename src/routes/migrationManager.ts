// ---------------------------------------------------------------------------
// Schema Migration Manager — Ontology Platform spec Task 13
// ---------------------------------------------------------------------------
// Mounted at /api/v2/ontologies/:ontologyId/migrations
//   POST /plan  — classify a proposed change as breaking vs non-breaking
//   POST /execute — run a migration (reindex alias swap)
//   GET  /      — list recent migrations
//
// Breaking changes per spec: PK change, property type change, property
// deletion, datasource removal. Non-breaking: add property, change
// display_name, change description.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { client as osClient } from "../services/opensearch/client";

const router = Router({ mergeParams: true });

const BREAKING_OPS = new Set([
  "primary_key_change",
  "property_type_change",
  "property_deletion",
  "datasource_removal",
]);

const NON_BREAKING_OPS = new Set([
  "add_property",
  "change_display_name",
  "change_description",
  "change_icon",
]);

router.post("/plan", (req: Request, res: Response) => {
  const { operations = [] } = req.body || {};
  const breaking: string[] = [];
  const nonBreaking: string[] = [];
  const unknown: string[] = [];
  for (const op of operations) {
    if (BREAKING_OPS.has(op)) breaking.push(op);
    else if (NON_BREAKING_OPS.has(op)) nonBreaking.push(op);
    else unknown.push(op);
  }
  sendSuccess(res, {
    breaking,
    nonBreaking,
    unknown,
    requiresMigration: breaking.length > 0,
  });
});

router.post("/execute", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const { objectTypeApiName, operations = [] } = req.body || {};
    if (!objectTypeApiName) {
      return sendError(
        res,
        "VALIDATION_FAILED",
        "objectTypeApiName is required for execute."
      );
    }

    const aliasName = `ontology-${objectTypeApiName.toLowerCase()}`;

    // Determine the next version number by inspecting any existing
    // aliased indices. New indices are versioned: objects-flight-v1, -v2, …
    let nextVersion = 1;
    try {
      const aliasInfo = await osClient.indices.getAlias({ name: aliasName });
      const indices = Object.keys(aliasInfo.body || {});
      const versions = indices
        .map((name) => {
          const m = name.match(/-v(\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        })
        .filter((v) => v > 0);
      if (versions.length > 0) nextVersion = Math.max(...versions) + 1;
    } catch {
      // Alias doesn't exist yet — bootstrap as v1.
    }

    const newIndex = `${aliasName}-v${nextVersion}`;
    const previousIndex =
      nextVersion > 1 ? `${aliasName}-v${nextVersion - 1}` : null;

    // 1. Create the new index. Mappings should come from the type's
    //    schema; for now we copy the existing index's mapping if there
    //    is one, otherwise create empty.
    try {
      let mapping: Record<string, unknown> | undefined;
      if (previousIndex) {
        const prev = await osClient.indices.getMapping({ index: previousIndex });
        mapping = (prev.body?.[previousIndex]?.mappings ?? undefined) as
          | Record<string, unknown>
          | undefined;
      }
      await osClient.indices.create({
        index: newIndex,
        body: mapping ? { mappings: mapping } : {},
      });

      // 2. Reindex from the previous version (if any).
      if (previousIndex) {
        await osClient.reindex({
          body: {
            source: { index: previousIndex },
            dest: { index: newIndex },
          },
          wait_for_completion: true,
        });
      }

      // 3. Atomic alias swap.
      const actions: Array<Record<string, unknown>> = [
        { add: { index: newIndex, alias: aliasName } },
      ];
      if (previousIndex) {
        actions.unshift({ remove: { index: previousIndex, alias: aliasName } });
      }
      await osClient.indices.updateAliases({ body: { actions } });
    } catch (err: any) {
      return sendError(
        res,
        "MIGRATION_REQUIRED",
        `Reindex failed: ${err?.message || String(err)}`
      );
    }

    // 4. Record the migration job for audit / 24h retention sweep.
    const jobId = `mig_${Date.now()}`;
    await query(
      `INSERT INTO export_job
         (ontology_id, requested_by, object_type_api_name, format, query_json, status)
       VALUES ($1, $2, $3, 'jsonl', $4::jsonb, 'COMPLETED')`,
      [
        ontologyId,
        (req as any).user?.id || "system",
        objectTypeApiName,
        JSON.stringify({
          migration: true,
          operations,
          newIndex,
          previousIndex,
          retainPreviousUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }),
      ]
    );

    sendSuccess(res, {
      jobId,
      status: "COMPLETED",
      newIndex,
      previousIndex,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ontologyId } = req.params;
    const result = await query(
      `SELECT job_id, object_type_api_name, status, created_at, updated_at
         FROM export_job
        WHERE ontology_id = $1
          AND (query_json->>'migration')::boolean = true
        ORDER BY created_at DESC
        LIMIT 100`,
      [ontologyId]
    );
    sendSuccess(res, { data: result.rows, totalCount: result.rowCount });
  } catch (err) {
    next(err);
  }
});

export default router;
