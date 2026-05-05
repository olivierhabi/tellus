// B10 — Templates (legacy). Kept for one release per spec; route layer
// stamps Deprecation: true and Sunset: 2026-11-04 on every response.

import { pool } from "../../../db";
import { newQuiverRid } from "../rids";
import { CreateTemplateRequest, Template } from "./types";
import { invalidAnalysisRequest, templateNotFound } from "../errors";
import type { ActorContext } from "./dashboardService";

export const TEMPLATE_DEPRECATION_HEADERS = {
  Deprecation: "true",
  Sunset: "2026-11-04",
};

export async function createTemplate(
  actor: ActorContext,
  raw: unknown,
): Promise<Template> {
  const parsed = CreateTemplateRequest.safeParse(raw);
  if (!parsed.success) {
    throw invalidAnalysisRequest({
      reason: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const req = parsed.data;
  const rid = newQuiverRid("template");
  await pool.query(
    `INSERT INTO quiver_template (rid, parent_folder_rid, display_name, snapshot, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [rid, req.parentFolderRid, req.displayName, JSON.stringify(req.snapshot), actor.userSubject],
  );
  const r = await pool.query(
    `SELECT * FROM quiver_template WHERE rid = $1`,
    [rid],
  );
  const row = r.rows[0];
  return {
    rid: row.rid,
    parentFolderRid: row.parent_folder_rid,
    displayName: row.display_name,
    snapshot: row.snapshot,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export async function getTemplate(rid: string): Promise<Template> {
  const r = await pool.query(
    `SELECT * FROM quiver_template WHERE rid = $1`,
    [rid],
  );
  if (r.rowCount === 0) throw templateNotFound({ rid });
  const row = r.rows[0];
  return {
    rid: row.rid,
    parentFolderRid: row.parent_folder_rid,
    displayName: row.display_name,
    snapshot: row.snapshot,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}
