// ---------------------------------------------------------------------------
// B8 — Virtual Table CRUD + refreshSchema handlers (spec §B8 line 401).
//
// Routes (mounted under /api/v2/connectivity by the connectivity router):
//   POST   /connections/:rid/virtual-tables           -> create
//   GET    /virtual-tables/:vrid                      -> read
//   PUT    /virtual-tables/:vrid                      -> update (If-Match)
//   DELETE /virtual-tables/:vrid                      -> soft-delete (If-Match)
//   POST   /virtual-tables/:vrid/refreshSchema       -> re-discover columns
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../../../db";
import { TellusError } from "../../../lib/errors/envelope";
import {
  ConnectionNotFound,
  IfMatchRequired,
  ResourceVersionMismatch,
  InvalidConfiguration,
} from "../../../lib/errors/connectivity.errors";
import { VirtualTableCreateRequest, type VirtualTableT } from "./contracts";
import { parseIfMatch } from "../../../middleware/connectivityEtag";

function ridV(): string {
  return `ri.magritte.main.virtual-table.${randomUUID()}`;
}

function actorOf(req: Request): string {
  return (req as any).user?.id ?? "00000000-0000-0000-0000-000000000000";
}

export async function postVirtualTable(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = VirtualTableCreateRequest.safeParse(req.body);
    if (!parsed.success) {
      new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      }).send(res);
      return;
    }
    const b = parsed.data;
    const conn = await pool.query(
      `SELECT 1 FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
      [b.connectionRid],
    );
    if (conn.rowCount === 0) {
      new TellusError(ConnectionNotFound, {
        connectionRid: b.connectionRid,
      }).send(res);
      return;
    }
    const vrid = ridV();
    const userId = actorOf(req);
    await pool.query(
      `INSERT INTO virtual_tables(rid, connection_rid, dataset_rid, display_name,
                                  source_schema, source_table, schema_json, schema_stale, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'[]'::jsonb,true,$7)`,
      [
        vrid,
        b.connectionRid,
        b.datasetRid,
        b.displayName,
        b.source.schema,
        b.source.table,
        userId,
      ],
    );
    res
      .status(201)
      .set("ETag", `W/"1"`)
      .set("Location", `/api/v2/connectivity/virtual-tables/${vrid}`)
      .json({ rid: vrid, version: 1 });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

export async function listVirtualTablesByConnection(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const connRid = req.params.rid;
    const r = await pool.query(
      `SELECT rid, connection_rid, dataset_rid, display_name,
              source_schema, source_table, schema_json, schema_stale,
              version, created_at, updated_at, created_by
         FROM virtual_tables
        WHERE connection_rid=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [connRid],
    );
    const virtualTables = r.rows.map((row) => ({
      rid: row.rid,
      connectionRid: row.connection_rid,
      datasetRid: row.dataset_rid,
      displayName: row.display_name,
      source: { schema: row.source_schema, table: row.source_table },
      schema: row.schema_json,
      schemaStale: row.schema_stale,
      version: row.version,
      createdAt: row.created_at.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at.toISOString?.() ?? row.updated_at,
      createdBy: row.created_by,
    }));
    res.json({ virtualTables });
  } catch (err) {
    next(err);
  }
}

export async function getVirtualTable(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const r = await pool.query<{
      rid: string;
      connection_rid: string;
      dataset_rid: string;
      display_name: string;
      source_schema: string;
      source_table: string;
      schema_json: unknown;
      schema_stale: boolean;
      version: number;
      created_at: Date;
      updated_at: Date;
      created_by: string;
    }>(
      `SELECT rid, connection_rid, dataset_rid, display_name,
              source_schema, source_table, schema_json, schema_stale,
              version, created_at, updated_at, created_by
         FROM virtual_tables
        WHERE rid=$1 AND deleted_at IS NULL`,
      [req.params.vrid],
    );
    if (r.rowCount === 0) {
      new TellusError(ConnectionNotFound, { rid: req.params.vrid }).send(res);
      return;
    }
    const row = r.rows[0];
    const out: VirtualTableT = {
      rid: row.rid as VirtualTableT["rid"],
      connectionRid: row.connection_rid as VirtualTableT["connectionRid"],
      datasetRid: row.dataset_rid as VirtualTableT["datasetRid"],
      displayName: row.display_name,
      source: { schema: row.source_schema, table: row.source_table },
      schema: row.schema_json as VirtualTableT["schema"],
      schemaStale: row.schema_stale,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      createdBy: row.created_by,
    };
    res.set("ETag", `W/"${row.version}"`).json(out);
  } catch (err) {
    next(err);
  }
}

export async function deleteVirtualTable(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ifMatch = parseIfMatch(req);
    if (ifMatch == null) {
      new TellusError(IfMatchRequired, {}).send(res);
      return;
    }
    const r = await pool.query(
      `UPDATE virtual_tables
          SET deleted_at = now()
        WHERE rid=$1 AND deleted_at IS NULL AND version=$2`,
      [req.params.vrid, ifMatch],
    );
    if (r.rowCount === 0) {
      new TellusError(ResourceVersionMismatch, { rid: req.params.vrid }).send(res);
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function refreshSchema(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const row = await pool.query<{
      connection_rid: string;
      source_schema: string;
      source_table: string;
      version: number;
    }>(
      `SELECT connection_rid, source_schema, source_table, version
         FROM virtual_tables
        WHERE rid=$1 AND deleted_at IS NULL`,
      [req.params.vrid],
    );
    if (row.rowCount === 0) {
      new TellusError(ConnectionNotFound, { rid: req.params.vrid }).send(res);
      return;
    }
    const discovery = await import(
      "../connectors/postgresql/discovery"
    );
    const cols = await discovery.discoverColumns(
      row.rows[0].connection_rid,
      row.rows[0].source_schema,
      row.rows[0].source_table,
    );
    const schemaJson = cols.map((c) => ({
      columnName: c.columnName,
      pgOid: c.pgOid,
      tellusType: c.tellusType,
    }));
    const upd = await pool.query<{ version: number }>(
      `UPDATE virtual_tables
          SET schema_json = $1::jsonb,
              schema_stale = false,
              version = version + 1,
              updated_at = now()
        WHERE rid=$2
        RETURNING version`,
      [JSON.stringify(schemaJson), req.params.vrid],
    );
    res
      .set("ETag", `W/"${upd.rows[0].version}"`)
      .status(200)
      .json({
        rid: req.params.vrid,
        version: upd.rows[0].version,
        columns: schemaJson,
      });
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}
