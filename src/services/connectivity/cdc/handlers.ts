// ---------------------------------------------------------------------------
// B7 — CDC stream creation handler.
//
// Creates a CDC import (table_imports row with mode='cdc') and
// returns the import RID + version.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../../../db";
import { TellusError } from "../../../lib/errors/envelope";
import {
  ConnectionNotFound,
  InvalidConfiguration,
} from "../../../lib/errors/connectivity.errors";
import { CdcImportCreateRequest } from "./contracts";
import {
  extractUser,
  requireScope,
} from "../handlers/connections.handler";

function buildRid(): string {
  return `ri.magritte.main.extract.${randomUUID()}`;
}

function actor(req: Request): string {
  return (req as any).user?.id ?? "00000000-0000-0000-0000-000000000000";
}

// ---------------------------------------------------------------------------
// POST /connections/:rid/cdc/streams
// ---------------------------------------------------------------------------
export async function postCdcStream(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Extract user and require write scope
    const user = extractUser(req);
    requireScope(user, "connectivity:write");

    const parsed = CdcImportCreateRequest.safeParse(req.body);
    if (!parsed.success) {
      new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      }).send(res);
      return;
    }
    const body = parsed.data;

    // Verify the connection exists and belongs to the user's tenant.
    const conn = await pool.query(
      `SELECT 1 FROM connectivity_connections WHERE rid=$1 AND tenant=$2 AND deleted_at IS NULL`,
      [body.connectionRid, user.tenant],
    );
    if (conn.rowCount === 0) {
      new TellusError(ConnectionNotFound, {
        connectionRid: body.connectionRid,
      }).send(res);
      return;
    }

    const rid = buildRid();
    const userId = actor(req);

    // Store as a table_imports row with mode=cdc in the config.
    const importConfig = {
      mode: "cdc",
      ...body.config,
    };

    await pool.query(
      `INSERT INTO table_imports(rid, connection_rid, dataset_rid, display_name, config, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        rid,
        body.connectionRid,
        body.datasetRid,
        body.displayName,
        JSON.stringify(importConfig),
        userId,
      ],
    );

    res
      .status(201)
      .set("ETag", `W/"1"`)
      .set("Location", `/api/v2/connectivity/imports/${rid}`)
      .json({ rid, version: 1 });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}
