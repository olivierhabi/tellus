// B10 — Visual Function publishing service.

import { pool, withTransaction } from "../../../db";
import {
  ParameterSchema,
  PublishVisualFunctionRequest,
  VisualFunction,
} from "./types";
import { newQuiverRid } from "../rids";
import {
  analysisNotFound,
  compassRegistrationFailed,
  exposedParameterNotFound,
  invalidAnalysisRequest,
  versionMismatch,
  visualFunctionNotFound,
  visualFunctionRootNotFound,
} from "../errors";
import { canonicalizeJson } from "../etag";
import { createHash } from "node:crypto";
import { emitQuiverAudit } from "../audit";
import {
  publishingDurationSeconds,
  visualFunctionInlineTotal,
  visualFunctionPublishTotal,
} from "../metrics";
import { getCardType } from "../dag/cardTypeRegistry";
import type { CardType } from "../types";
import type { ActorContext, DashboardCompassPort } from "./dashboardService";

let compassPort: DashboardCompassPort | null = null;
export function setVisualFunctionCompassPort(port: DashboardCompassPort): void {
  compassPort = port;
}

export function resetVisualFunctionCompassPort(): void {
  compassPort = null;
}

function computeEtag(snapshot: unknown): string {
  return createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex").slice(0, 32);
}

interface VfRow {
  rid: string;
  parent_folder_rid: string;
  analysis_rid: string;
  display_name: string;
  branch: string;
  exposed_parameter_card_ids: string[];
  root_card_id: string;
  input_schema: unknown;
  output_type: string;
  current_version: number | string;
  etag: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

function rowToVisualFunction(row: VfRow): VisualFunction {
  return VisualFunction.parse({
    rid: row.rid,
    parentFolderRid: row.parent_folder_rid,
    analysisRid: row.analysis_rid,
    displayName: row.display_name,
    branch: row.branch,
    exposedParameterCardIds: row.exposed_parameter_card_ids,
    rootCardId: row.root_card_id,
    inputSchema: ParameterSchema.parse(row.input_schema),
    outputType: row.output_type,
    currentVersion:
      typeof row.current_version === "string"
        ? Number(row.current_version)
        : row.current_version,
    etag: row.etag,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  });
}

interface AnalysisCard {
  id: string;
  type: string;
  config?: { paramType?: string };
}

function deriveInputSchema(
  cards: Record<string, AnalysisCard>,
  exposedIds: string[],
): { schema: ReturnType<typeof ParameterSchema.parse>; missing: string | null } {
  const props: Record<string, { type: "string" | "number" | "boolean" | "array" }> = {};
  for (const id of exposedIds) {
    const c = cards[id];
    if (!c) return { schema: { type: "object", properties: {}, required: [] }, missing: id };
    // Derive parameter card type
    const paramType =
      c.type === "PARAMETER_NUMBER"
        ? "number"
        : c.type === "PARAMETER_BOOLEAN"
          ? "boolean"
          : c.type === "PARAMETER_ARRAY"
            ? "array"
            : "string";
    props[id] = { type: paramType };
  }
  return {
    schema: { type: "object", properties: props, required: exposedIds },
    missing: null,
  };
}

function deriveOutputType(
  cards: Record<string, AnalysisCard>,
  rootCardId: string,
): string | null {
  const root = cards[rootCardId];
  if (!root) return null;
  const entry = getCardType(root.type as CardType);
  return entry?.output ?? root.type;
}

// =================== publishVisualFunction ===============================

export async function publishVisualFunction(
  actor: ActorContext,
  raw: unknown,
): Promise<VisualFunction> {
  const start = Date.now();
  const parsed = PublishVisualFunctionRequest.safeParse(raw);
  if (!parsed.success) {
    throw invalidAnalysisRequest({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const req = parsed.data;

  const ar = await pool.query(
    `SELECT cards, parent_folder_rid FROM quiver_analysis WHERE rid = $1 AND is_deleted = false`,
    [req.analysisRid],
  );
  if (ar.rowCount === 0) {
    visualFunctionPublishTotal.labels({ result: "analysis_missing" }).inc();
    throw analysisNotFound({ rid: req.analysisRid });
  }
  const cards = (ar.rows[0].cards ?? {}) as Record<string, AnalysisCard>;

  const { schema, missing } = deriveInputSchema(cards, req.exposedParameterCardIds);
  if (missing) {
    visualFunctionPublishTotal.labels({ result: "invalid_param" }).inc();
    throw exposedParameterNotFound({ cardId: missing });
  }
  const outputType = deriveOutputType(cards, req.rootCardId);
  if (!outputType) {
    visualFunctionPublishTotal.labels({ result: "invalid_root" }).inc();
    throw visualFunctionRootNotFound({ cardId: req.rootCardId });
  }

  const rid = newQuiverRid("visual-function");
  const parentFolderRid = ar.rows[0].parent_folder_rid as string;
  const subDag = { rootCardId: req.rootCardId, cards, exposedParameterCardIds: req.exposedParameterCardIds };
  const etag = computeEtag({ rid, ...subDag, version: 1 });

  let result: VisualFunction;
  try {
    result = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO quiver_visual_function
            (rid, parent_folder_rid, analysis_rid, display_name, branch,
             exposed_parameter_card_ids, root_card_id, input_schema, output_type,
             current_version, etag, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, 1, $10, $11)`,
        [
          rid,
          parentFolderRid,
          req.analysisRid,
          req.displayName,
          actor.branch,
          JSON.stringify(req.exposedParameterCardIds),
          req.rootCardId,
          JSON.stringify(schema),
          outputType,
          etag,
          actor.userSubject,
        ],
      );
      await client.query(
        `INSERT INTO quiver_visual_function_version
            (rid, version, sub_dag, input_schema, output_type, branch, published_by)
         VALUES ($1, 1, $2::jsonb, $3::jsonb, $4, $5, $6)`,
        [
          rid,
          JSON.stringify(subDag),
          JSON.stringify(schema),
          outputType,
          actor.branch,
          actor.userSubject,
        ],
      );
      if (compassPort) {
        try {
          await compassPort.registerDashboard({
            rid,
            parentFolderRid,
            displayName: req.displayName,
            branch: actor.branch,
          });
        } catch (e) {
          visualFunctionPublishTotal.labels({ result: "compass_failed" }).inc();
          throw compassRegistrationFailed({ rid });
        }
      }
      const r = await client.query<VfRow>(
        `SELECT * FROM quiver_visual_function WHERE rid = $1`,
        [rid],
      );
      return rowToVisualFunction(r.rows[0]);
    });
  } finally {
    publishingDurationSeconds
      .labels({ surface: "visual_function" })
      .observe((Date.now() - start) / 1000);
  }

  visualFunctionPublishTotal.labels({ result: "ok" }).inc();
  await emitQuiverAudit({
    actorSubject: actor.userSubject,
    action: "QUIVER_VISUAL_FUNCTION_PUBLISHED",
    rid,
    result: "SUCCESS",
    branch: actor.branch,
    afterEtag: result.etag,
    details: {
      analysisRid: req.analysisRid,
      version: 1,
      rootCardId: req.rootCardId,
      outputType,
    },
  });
  return result;
}

// =================== getVisualFunction ====================================

export async function getVisualFunction(
  _actor: ActorContext,
  rid: string,
): Promise<VisualFunction> {
  const r = await pool.query<VfRow>(
    `SELECT * FROM quiver_visual_function WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) throw visualFunctionNotFound({ rid });
  return rowToVisualFunction(r.rows[0]);
}

// =================== updateVisualFunction =================================

export async function updateVisualFunction(
  _actor: ActorContext,
  rid: string,
  ifMatch: string,
  raw: unknown,
): Promise<VisualFunction> {
  const updates = (raw as { displayName?: string }) ?? {};
  if (!updates.displayName) {
    throw invalidAnalysisRequest({
      reason: [{ path: "displayName", message: "required for PATCH" }],
    });
  }
  const r = await pool.query<VfRow>(
    `SELECT * FROM quiver_visual_function WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) throw visualFunctionNotFound({ rid });
  if (r.rows[0].etag !== ifMatch) throw versionMismatch({ rid });

  const newEtag = computeEtag({
    ...r.rows[0],
    display_name: updates.displayName,
  });
  await pool.query(
    `UPDATE quiver_visual_function
        SET display_name = $2, etag = $3, updated_at = now()
      WHERE rid = $1 AND etag = $4`,
    [rid, updates.displayName, newEtag, ifMatch],
  );
  const r2 = await pool.query<VfRow>(
    `SELECT * FROM quiver_visual_function WHERE rid = $1`,
    [rid],
  );
  return rowToVisualFunction(r2.rows[0]);
}

// =================== inlineVisualFunction =================================
// Returns the persisted sub-DAG so a consumer's coordinator can inline it.

export async function inlineVisualFunction(
  rid: string,
): Promise<{ rootCardId: string; cards: Record<string, AnalysisCard> }> {
  const r = await pool.query(
    `SELECT v.sub_dag
       FROM quiver_visual_function vf
       JOIN quiver_visual_function_version v
         ON v.rid = vf.rid AND v.version = vf.current_version
      WHERE vf.rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) throw visualFunctionNotFound({ rid });
  visualFunctionInlineTotal.inc();
  return r.rows[0].sub_dag as { rootCardId: string; cards: Record<string, AnalysisCard> };
}
