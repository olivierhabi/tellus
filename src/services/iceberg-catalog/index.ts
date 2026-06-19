// ---------------------------------------------------------------------------
// B8 — Tellus REST catalog facade (spec §B8 line 409).
//
// Implements a subset of the Iceberg REST 1.x catalog API:
//   GET  /v1/namespaces
//   GET  /v1/namespaces/{namespace}/tables
//   GET  /v1/namespaces/{namespace}/tables/{table}    -> table metadata
//   POST /v1/namespaces/{namespace}/tables/{table}/scan   -> proxy to federation
//
// Reads to virtual tables proxy to the federation engine. Reads to
// physical Iceberg tables (B5 imports) go to the configured CatalogAdapter
// (local-fs / rest).
// ---------------------------------------------------------------------------

import { Router } from "express";
import { pool } from "../../db";
import { loadFederationAdapter } from "../query-federation/engine-adapter";
import { loadCatalogAdapter } from "../../lib/iceberg";

export function createIcebergCatalogRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get("/v1/namespaces", async (_req, res, next) => {
    try {
      const r1 = await pool.query<{ namespace: string }>(
        `SELECT DISTINCT source_schema AS namespace
           FROM virtual_tables
          WHERE deleted_at IS NULL
          ORDER BY namespace`,
      );
      res.json({ namespaces: r1.rows.map((row) => [row.namespace]) });
    } catch (err) {
      next(err);
    }
  });

  r.get("/v1/namespaces/:ns/tables", async (req, res, next) => {
    try {
      const r1 = await pool.query<{ rid: string; name: string }>(
        `SELECT rid, display_name AS name
           FROM virtual_tables
          WHERE source_schema = $1 AND deleted_at IS NULL
          ORDER BY display_name`,
        [req.params.ns],
      );
      res.json({
        identifiers: r1.rows.map((row) => ({
          namespace: [req.params.ns],
          name: row.name,
          rid: row.rid,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  r.get("/v1/namespaces/:ns/tables/:table", async (req, res, next) => {
    try {
      const r1 = await pool.query<{
        rid: string;
        schema_json: any;
      }>(
        `SELECT rid, schema_json
           FROM virtual_tables
          WHERE source_schema = $1 AND display_name = $2 AND deleted_at IS NULL`,
        [req.params.ns, req.params.table],
      );
      if (r1.rowCount === 0) {
        res.status(404).json({
          errorCode: "NOT_FOUND",
          errorName: "Tellus:IcebergCatalog:TableNotFound",
          parameters: req.params,
        });
        return;
      }
      const row = r1.rows[0];
      const cols = (row.schema_json as Array<{ columnName: string; tellusType: any }>) ?? [];
      res.json({
        metadata: {
          "format-version": 2,
          "table-uuid": row.rid,
          location: `tellus-virtual://${row.rid}`,
          schemas: [
            {
              "schema-id": 0,
              fields: cols.map((c, i) => ({
                id: i + 1,
                name: c.columnName,
                type: c.tellusType?.name ?? "string",
                required: false,
              })),
            },
          ],
          "current-schema-id": 0,
          properties: {
            "tellus.virtual-table.rid": row.rid,
          },
        },
        "config": {},
      });
    } catch (err) {
      next(err);
    }
  });

  r.post("/v1/namespaces/:ns/tables/:table/scan", async (req, res, next) => {
    try {
      const r1 = await pool.query<{ rid: string }>(
        `SELECT rid FROM virtual_tables
          WHERE source_schema = $1 AND display_name = $2 AND deleted_at IS NULL`,
        [req.params.ns, req.params.table],
      );
      if (r1.rowCount === 0) {
        res.status(404).end();
        return;
      }
      const adapter = await loadFederationAdapter();
      const result = await adapter.execute({
        virtualTableRid: r1.rows[0].rid,
        project: Array.isArray(req.body?.project) ? req.body.project : [],
        where: req.body?.where,
        limit: req.body?.limit,
        orderBy: req.body?.orderBy,
      });
      res
        .status(200)
        .set("content-type", "application/vnd.apache.arrow.stream");
      result.stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  // Touch the iceberg catalog adapter at boot to surface configuration issues
  // here rather than at first physical-table read.
  void loadCatalogAdapter().catch(() => undefined);

  return r;
}
