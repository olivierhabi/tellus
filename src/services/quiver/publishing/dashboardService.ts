// B10 — Dashboard publishing service.
//
// Endpoints (mounted by routes/quiver/publishing.ts):
//   POST   /quiver/api/v1/dashboards               — publishDashboard
//   GET    /quiver/api/v1/dashboards/:rid          — getDashboard
//   PATCH  /quiver/api/v1/dashboards/:rid          — updateDashboard
//   DELETE /quiver/api/v1/dashboards/:rid          — deleteDashboard
//   POST   /quiver/api/v1/dashboards/:rid:embedInObjectView
//   POST   /quiver/api/v1/dashboards/:rid:embedInWorkshop
//
// Compass registration: tellus-quiver-dashboard under parent folder; failure
// rolls back the publish (B10 C-03).

import { pool, withTransaction } from "../../../db";
import {
  Dashboard,
  Embed,
  EmbedRequest,
  EmbedSurface,
  ParameterSchema,
  PublishDashboardRequest,
} from "./types";
import { newQuiverRid } from "../rids";
import {
  analysisNotFound,
  compassRegistrationFailed,
  dashboardNotFound,
  exposedCanvasNotFound,
  invalidAnalysisRequest,
  versionMismatch,
} from "../errors";
import { canonicalizeJson } from "../etag";
import { createHash, randomUUID } from "node:crypto";
import { emitQuiverAudit } from "../audit";
import {
  dashboardEmbedTotal,
  dashboardPublishTotal,
  publishingDurationSeconds,
} from "../metrics";
import { assertAnalysisEditable } from "../analysisService";

export interface ActorContext {
  userSubject: string;
  orgRid: string;
  branch: string;
}

export interface DashboardCompassPort {
  /** Returns the parent folder of the analysis (where the dashboard lands). */
  resolveAnalysisParentFolder(opts: {
    analysisRid: string;
    userSubject: string;
    branch: string;
  }): Promise<string>;
  /** Registers `tellus-quiver-dashboard` resource under parent folder. */
  registerDashboard(opts: {
    rid: string;
    parentFolderRid: string;
    displayName: string;
    branch: string;
  }): Promise<void>;
  /** Asserts the actor can read dashboard. */
  assertDashboardReadable(opts: {
    rid: string;
    userSubject: string;
    branch: string;
  }): Promise<void>;
  /** Asserts the actor can write to a target surface (Workshop / Object View). */
  assertEmbedTargetWritable(opts: {
    surface: EmbedSurface;
    targetRid: string;
    userSubject: string;
    branch: string;
  }): Promise<void>;
}

const noopCompass: DashboardCompassPort = {
  async resolveAnalysisParentFolder() {
    return "ri.compass.main.folder.default";
  },
  async registerDashboard() {},
  async assertDashboardReadable() {},
  async assertEmbedTargetWritable() {},
};

let compass: DashboardCompassPort = noopCompass;
export function setDashboardCompassPort(port: DashboardCompassPort): void {
  compass = port;
}

export function resetDashboardCompassPort(): void {
  compass = noopCompass;
}

function computeEtag(snapshot: unknown): string {
  return createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex").slice(0, 32);
}

interface DashboardRow {
  rid: string;
  parent_folder_rid: string;
  analysis_rid: string;
  display_name: string;
  branch: string;
  exposed_canvases: string[];
  parameter_schema: unknown;
  current_version: number | string;
  etag: string;
  created_at: string;
  updated_at: string;
  created_by: string;
}

function rowToDashboard(row: DashboardRow): Dashboard {
  return Dashboard.parse({
    rid: row.rid,
    parentFolderRid: row.parent_folder_rid,
    analysisRid: row.analysis_rid,
    displayName: row.display_name,
    branch: row.branch,
    exposedCanvases: row.exposed_canvases,
    parameterSchema: ParameterSchema.parse(row.parameter_schema),
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

// =================== publishDashboard =====================================

export async function publishDashboard(
  actor: ActorContext,
  raw: unknown,
): Promise<Dashboard> {
  const start = Date.now();
  const parsed = PublishDashboardRequest.safeParse(raw);
  if (!parsed.success) {
    throw invalidAnalysisRequest({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const req = parsed.data;

  // Folder authorization — publishing exposes the analysis's canvases, so
  // the actor must be an editor on the analysis's parent folder (same
  // membership model as every other analysis-mutating surface).
  await assertAnalysisEditable(actor, req.analysisRid);

  // Validate that exposedCanvases reference real canvases on the source analysis.
  const analysis = await pool.query(
    `SELECT canvases FROM quiver_analysis WHERE rid = $1 AND is_deleted = false`,
    [req.analysisRid],
  );
  if (analysis.rowCount === 0) {
    dashboardPublishTotal.labels({ result: "analysis_missing" }).inc();
    throw analysisNotFound({ rid: req.analysisRid });
  }
  const canvasIds = new Set(
    Array.isArray(analysis.rows[0].canvases)
      ? (analysis.rows[0].canvases as Array<{ id: string }>).map((c) => c.id)
      : [],
  );
  for (const cid of req.exposedCanvases) {
    if (!canvasIds.has(cid)) {
      dashboardPublishTotal.labels({ result: "invalid_canvas" }).inc();
      throw exposedCanvasNotFound({ canvasId: cid });
    }
  }

  const rid = newQuiverRid("dashboard");
  const parentFolderRid = await compass.resolveAnalysisParentFolder({
    analysisRid: req.analysisRid,
    userSubject: actor.userSubject,
    branch: actor.branch,
  });

  const snapshot = {
    analysisRid: req.analysisRid,
    exposedCanvases: req.exposedCanvases,
    parameterSchema: req.parameterSchema,
  };
  const etag = computeEtag({ rid, ...snapshot, version: 1 });

  let dashboard: Dashboard;
  try {
    dashboard = await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO quiver_dashboard
            (rid, parent_folder_rid, analysis_rid, display_name, branch,
             exposed_canvases, parameter_schema, current_version, etag, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 1, $8, $9)`,
        [
          rid,
          parentFolderRid,
          req.analysisRid,
          req.displayName,
          actor.branch,
          JSON.stringify(req.exposedCanvases),
          JSON.stringify(req.parameterSchema),
          etag,
          actor.userSubject,
        ],
      );
      await client.query(
        `INSERT INTO quiver_dashboard_version
            (rid, version, snapshot, parameter_schema, branch, published_by)
         VALUES ($1, 1, $2::jsonb, $3::jsonb, $4, $5)`,
        [
          rid,
          JSON.stringify(snapshot),
          JSON.stringify(req.parameterSchema),
          actor.branch,
          actor.userSubject,
        ],
      );
      // Compass registration — failure rolls back this transaction.
      try {
        await compass.registerDashboard({
          rid,
          parentFolderRid,
          displayName: req.displayName,
          branch: actor.branch,
        });
      } catch (e) {
        dashboardPublishTotal.labels({ result: "compass_failed" }).inc();
        throw compassRegistrationFailed({ rid });
      }
      const r = await client.query<DashboardRow>(
        `SELECT * FROM quiver_dashboard WHERE rid = $1`,
        [rid],
      );
      return rowToDashboard(r.rows[0]);
    });
  } finally {
    publishingDurationSeconds
      .labels({ surface: "dashboard" })
      .observe((Date.now() - start) / 1000);
  }

  dashboardPublishTotal.labels({ result: "ok" }).inc();
  await emitQuiverAudit({
    actorSubject: actor.userSubject,
    action: "QUIVER_DASHBOARD_PUBLISHED",
    rid,
    result: "SUCCESS",
    branch: actor.branch,
    afterEtag: dashboard.etag,
    details: {
      analysisRid: req.analysisRid,
      version: 1,
      exposedCanvases: req.exposedCanvases.length,
    },
  });
  return dashboard;
}

// =================== getDashboard =========================================

export async function getDashboard(
  actor: ActorContext,
  rid: string,
  versionPin?: number,
): Promise<Dashboard> {
  await compass.assertDashboardReadable({
    rid,
    userSubject: actor.userSubject,
    branch: actor.branch,
  });
  const r = await pool.query<DashboardRow>(
    `SELECT * FROM quiver_dashboard WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) {
    throw dashboardNotFound({ rid });
  }
  const dash = rowToDashboard(r.rows[0]);
  if (versionPin && versionPin !== dash.currentVersion) {
    const v = await pool.query(
      `SELECT snapshot, parameter_schema FROM quiver_dashboard_version
        WHERE rid = $1 AND version = $2`,
      [rid, versionPin],
    );
    if (v.rowCount === 0) {
      throw dashboardNotFound({ rid, version: versionPin });
    }
    return Dashboard.parse({
      ...dash,
      currentVersion: versionPin,
      exposedCanvases: (v.rows[0].snapshot as { exposedCanvases: string[] }).exposedCanvases,
      parameterSchema: ParameterSchema.parse(v.rows[0].parameter_schema),
    });
  }
  return dash;
}

// =================== embedInSurface ========================================

export async function embedDashboard(
  actor: ActorContext,
  rid: string,
  surface: EmbedSurface,
  raw: unknown,
): Promise<Embed> {
  const parsed = EmbedRequest.safeParse(raw);
  if (!parsed.success) {
    throw invalidAnalysisRequest({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const req = parsed.data;
  const dashRow = await pool.query<DashboardRow>(
    `SELECT * FROM quiver_dashboard WHERE rid = $1`,
    [rid],
  );
  if (dashRow.rowCount === 0) {
    throw dashboardNotFound({ rid });
  }
  await compass.assertEmbedTargetWritable({
    surface,
    targetRid: req.targetRid,
    userSubject: actor.userSubject,
    branch: actor.branch,
  });
  // Embed records are not first-class RIDs (no Compass row); use a UUID7-prefixed
  // local id to match audit + idempotency conventions.
  const embedId = `embed_${randomUUID()}`;
  await pool.query(
    `INSERT INTO quiver_dashboard_embed
        (embed_id, dashboard_rid, surface, target_rid, param_bindings, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      embedId,
      rid,
      surface,
      req.targetRid,
      JSON.stringify(req.paramBindings),
      actor.userSubject,
    ],
  );
  const r = await pool.query(
    `SELECT * FROM quiver_dashboard_embed WHERE embed_id = $1`,
    [embedId],
  );
  dashboardEmbedTotal.labels({ surface }).inc();
  await emitQuiverAudit({
    actorSubject: actor.userSubject,
    action: "QUIVER_DASHBOARD_EMBED_REGISTERED",
    rid,
    result: "SUCCESS",
    branch: actor.branch,
    details: { surface, targetRid: req.targetRid, embedId },
  });
  return {
    embedId,
    dashboardRid: rid,
    surface,
    targetRid: req.targetRid,
    paramBindings: req.paramBindings,
    createdAt: r.rows[0].created_at,
    createdBy: actor.userSubject,
  };
}

// =================== updateDashboard (etag-CAS) ===========================

export async function updateDashboard(
  actor: ActorContext,
  rid: string,
  ifMatch: string,
  raw: unknown,
): Promise<Dashboard> {
  const updates = (raw as { displayName?: string }) ?? {};
  if (!updates.displayName) {
    throw invalidAnalysisRequest({
      reason: [{ path: "displayName", message: "required for PATCH" }],
    });
  }
  const r = await pool.query<DashboardRow>(
    `SELECT * FROM quiver_dashboard WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) throw dashboardNotFound({ rid });
  if (r.rows[0].etag !== ifMatch) throw versionMismatch({ rid });

  const newEtag = computeEtag({
    ...r.rows[0],
    display_name: updates.displayName,
    updated_at: new Date().toISOString(),
  });
  await pool.query(
    `UPDATE quiver_dashboard
        SET display_name = $2, etag = $3, updated_at = now()
      WHERE rid = $1 AND etag = $4`,
    [rid, updates.displayName, newEtag, ifMatch],
  );
  const r2 = await pool.query<DashboardRow>(
    `SELECT * FROM quiver_dashboard WHERE rid = $1`,
    [rid],
  );
  return rowToDashboard(r2.rows[0]);
}
