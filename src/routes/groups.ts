// ---------------------------------------------------------------------------
// Object Type Group Routes — Express Router
//
// CRUD for grouping object types. Tables auto-created on first use.
//
// Mounted at: /api/v2/ontologies/:ontologyId/groups
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import { sendSuccess, sendCreated, sendNoContent, sendError } from "../utils/responseFormatter";

const router = Router({ mergeParams: true });

let migrated = false;

async function ensureGroupTables(): Promise<void> {
  if (migrated) return;
  await query(`
    CREATE TABLE IF NOT EXISTS object_type_group (
      group_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ontology_id UUID NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      icon        TEXT DEFAULT 'th',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS object_type_group_member (
      group_id       UUID NOT NULL REFERENCES object_type_group(group_id) ON DELETE CASCADE,
      object_type_id UUID NOT NULL,
      PRIMARY KEY (group_id, object_type_id)
    )
  `);
  migrated = true;
}

// ---------------------------------------------------------------------------
// GET / — List groups
// ---------------------------------------------------------------------------

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureGroupTables();
    const { ontologyId } = req.params;

    const result = await query(
      `SELECT g.*, COALESCE(json_agg(m.object_type_id) FILTER (WHERE m.object_type_id IS NOT NULL), '[]') AS members
       FROM object_type_group g
       LEFT JOIN object_type_group_member m ON m.group_id = g.group_id
       WHERE g.ontology_id = $1
       GROUP BY g.group_id
       ORDER BY g.created_at DESC`,
      [ontologyId]
    );

    const data = result.rows.map((row: any) => ({
      groupId: row.group_id,
      ontologyId: row.ontology_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      createdAt: row.created_at,
      members: row.members,
    }));

    return sendSuccess(res, { data });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — Create a group
// ---------------------------------------------------------------------------

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureGroupTables();
    const { ontologyId } = req.params;
    const { name, description, icon } = req.body || {};

    if (!name) {
      return sendError(res, "VALIDATION_FAILED", "name is required.");
    }

    const result = await query(
      `INSERT INTO object_type_group (ontology_id, name, description, icon)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [ontologyId, name, description || null, icon || "th"]
    );

    const row = result.rows[0];
    return sendCreated(res, {
      groupId: row.group_id,
      ontologyId: row.ontology_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      createdAt: row.created_at,
      members: [],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /:groupId — Update a group
// ---------------------------------------------------------------------------

router.put("/:groupId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureGroupTables();
    const { ontologyId, groupId } = req.params;
    const { name, description, icon } = req.body || {};

    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { sets.push(`description = $${idx++}`); values.push(description); }
    if (icon !== undefined) { sets.push(`icon = $${idx++}`); values.push(icon); }

    if (sets.length === 0) {
      return sendError(res, "VALIDATION_FAILED", "At least one field must be provided.");
    }

    values.push(groupId, ontologyId);
    const result = await query(
      `UPDATE object_type_group SET ${sets.join(", ")} WHERE group_id = $${idx++} AND ontology_id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Group '${groupId}' not found.`);
    }

    const row = result.rows[0];
    return sendSuccess(res, {
      groupId: row.group_id,
      ontologyId: row.ontology_id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      createdAt: row.created_at,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:groupId — Delete a group
// ---------------------------------------------------------------------------

router.delete("/:groupId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureGroupTables();
    const { ontologyId, groupId } = req.params;

    const result = await query(
      `DELETE FROM object_type_group WHERE group_id = $1 AND ontology_id = $2 RETURNING *`,
      [groupId, ontologyId]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", `Group '${groupId}' not found.`);
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /:groupId/members — Add member to group
// ---------------------------------------------------------------------------

router.post("/:groupId/members", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureGroupTables();
    const { groupId } = req.params;
    const { objectTypeId } = req.body || {};

    if (!objectTypeId) {
      return sendError(res, "VALIDATION_FAILED", "objectTypeId is required.");
    }

    await query(
      `INSERT INTO object_type_group_member (group_id, object_type_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [groupId, objectTypeId]
    );

    return sendCreated(res, { groupId, objectTypeId });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /:groupId/members — Remove member from group
// ---------------------------------------------------------------------------

router.delete("/:groupId/members", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureGroupTables();
    const { groupId } = req.params;
    const { objectTypeId } = req.body || {};

    if (!objectTypeId) {
      return sendError(res, "VALIDATION_FAILED", "objectTypeId is required.");
    }

    const result = await query(
      `DELETE FROM object_type_group_member WHERE group_id = $1 AND object_type_id = $2 RETURNING *`,
      [groupId, objectTypeId]
    );

    if (result.rows.length === 0) {
      return sendError(res, "NOT_FOUND", "Member not found in group.");
    }

    return sendNoContent(res);
  } catch (err) {
    next(err);
  }
});

export default router;
