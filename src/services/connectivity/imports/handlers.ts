// ---------------------------------------------------------------------------
// B5 — TableImport handlers (spec §B5 line 252).
//
// Routes:
//   POST   /connections/:rid/imports               -> create
//   GET    /connections/:rid/imports               -> list by connection
//   GET    /imports/:importRid                     -> read
//   PUT    /imports/:importRid                     -> update (If-Match)
//   DELETE /imports/:importRid                     -> soft-delete (If-Match)
//   POST   /imports/:importRid/execute             -> enqueue build
//   GET    /imports/:importRid/builds              -> list builds
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../../../db";
import { TellusError } from "../../../lib/errors/envelope";
import {
  ConnectionNotFound,
  ResourceVersionMismatch,
  IfMatchRequired,
  InvalidConfiguration,
} from "../../../lib/errors/connectivity.errors";
import {
  TableImportCreateRequest,
  TableImportUpdateRequest,
  type TableImportT,
} from "./contracts";
import { parseIfMatch } from "../../../middleware/connectivityEtag";

function buildRid(): string {
  return `ri.magritte.main.extract.${randomUUID()}`;
}

function actor(req: Request): string {
  // tellus auth middleware sets req.user.id
  return (req as any).user?.id ?? "00000000-0000-0000-0000-000000000000";
}

// ---------------------------------------------------------------------------
// POST /connections/:rid/imports
// ---------------------------------------------------------------------------
export async function postImport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = TableImportCreateRequest.safeParse(req.body);
    if (!parsed.success) {
      new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      }).send(res);
      return;
    }
    const body = parsed.data;
    const conn = await pool.query(
      `SELECT 1 FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
      [body.connectionRid],
    );
    if (conn.rowCount === 0) {
      new TellusError(ConnectionNotFound, {
        connectionRid: body.connectionRid,
      }).send(res);
      return;
    }
    const rid = buildRid();
    const userId = actor(req);
    await pool.query(
      `INSERT INTO table_imports(rid, connection_rid, dataset_rid, display_name, config, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [
        rid,
        body.connectionRid,
        body.datasetRid,
        body.displayName,
        JSON.stringify(body.config),
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

// ---------------------------------------------------------------------------
// GET /connections/:rid/imports  (list by connection)
// ---------------------------------------------------------------------------
export async function listImportsByConnection(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const connRid = req.params.rid;
    const r = await pool.query(
      `SELECT rid, connection_rid, dataset_rid, display_name, config,
              version, status, created_at, updated_at, created_by
         FROM table_imports
        WHERE connection_rid=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [connRid],
    );
    const imports = r.rows.map((row) => ({
      rid: row.rid,
      connectionRid: row.connection_rid,
      datasetRid: row.dataset_rid,
      displayName: row.display_name,
      config: row.config,
      version: row.version,
      status: row.status,
      createdAt: row.created_at.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at.toISOString?.() ?? row.updated_at,
      createdBy: row.created_by,
    }));
    res.json({ imports });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /connections/:rid/snapshots  (build history for the history page)
// Returns all imports and their builds for a connection.
// ---------------------------------------------------------------------------
export async function listSnapshots(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const connRid = req.params.rid;
    // Fetch imports for this connection.
    const imports = await pool.query(
      `SELECT rid, display_name, status, created_at
         FROM table_imports
        WHERE connection_rid=$1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [connRid],
    );

    const snapshots: Array<{
      importRid: string;
      displayName: string;
      status: string;
      createdAt: string;
      builds: Array<{
        rid: string;
        status: string;
        startedAt: string;
        completedAt: string | null;
        rows: number;
        bytes: number;
      }>;
    }> = [];

    for (const imp of imports.rows) {
      const builds = await pool.query(
        `SELECT rid, status, started_at, ended_at AS completed_at, rows_written AS rows, bytes_read AS bytes
           FROM orchestration_builds
          WHERE import_rid=$1
          ORDER BY enqueued_at DESC
          LIMIT 20`,
        [imp.rid],
      );
      snapshots.push({
        importRid: imp.rid,
        displayName: imp.display_name,
        status: imp.status?.state ?? imp.status ?? "UNKNOWN",
        createdAt: imp.created_at.toISOString?.() ?? imp.created_at,
        builds: builds.rows.map((b) => ({
          rid: b.rid,
          status: b.status,
          startedAt: b.started_at?.toISOString?.() ?? b.started_at,
          completedAt: b.completed_at?.toISOString?.() ?? b.completed_at ?? null,
          rows: b.rows ?? 0,
          bytes: b.bytes ?? 0,
        })),
      });
    }

    res.json({ snapshots });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /imports/:importRid
// ---------------------------------------------------------------------------
export async function getImport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const row = await pool.query<{
      rid: string;
      connection_rid: string;
      dataset_rid: string;
      display_name: string;
      config: unknown;
      version: number;
      status: unknown;
      created_at: Date;
      updated_at: Date;
      created_by: string;
    }>(
      `SELECT rid, connection_rid, dataset_rid, display_name, config,
              version, status, created_at, updated_at, created_by
         FROM table_imports
        WHERE rid=$1 AND deleted_at IS NULL`,
      [req.params.importRid],
    );
    if (row.rowCount === 0) {
      new TellusError(ConnectionNotFound, {
        importRid: req.params.importRid,
      }).send(res);
      return;
    }
    const r = row.rows[0];
    const out: TableImportT = {
      rid: r.rid as TableImportT["rid"],
      connectionRid: r.connection_rid as TableImportT["connectionRid"],
      datasetRid: r.dataset_rid as TableImportT["datasetRid"],
      displayName: r.display_name,
      config: r.config as TableImportT["config"],
      version: r.version,
      status: r.status as TableImportT["status"],
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
      createdBy: r.created_by,
    };
    res.set("ETag", `W/"${r.version}"`).json(out);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// PUT /imports/:importRid  (requires If-Match)
// ---------------------------------------------------------------------------
export async function putImport(
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
    const parsed = TableImportUpdateRequest.safeParse(req.body);
    if (!parsed.success) {
      new TellusError(InvalidConfiguration, {
        issues: parsed.error.issues,
      }).send(res);
      return;
    }
    const body = parsed.data;
    const r = await pool.query<{ version: number }>(
      `UPDATE table_imports
          SET display_name = COALESCE($1, display_name),
              config = CASE
                WHEN $2::jsonb IS NOT NULL THEN config || $2::jsonb
                ELSE config
              END,
              version = version + 1,
              updated_at = now()
        WHERE rid=$3 AND deleted_at IS NULL AND version=$4
        RETURNING version`,
      [
        body.displayName ?? null,
        body.config ? JSON.stringify(body.config) : null,
        req.params.importRid,
        ifMatch,
      ],
    );
    if (r.rowCount === 0) {
      // Distinguish "not found" from "version mismatch".
      const exists = await pool.query(
        `SELECT version FROM table_imports WHERE rid=$1 AND deleted_at IS NULL`,
        [req.params.importRid],
      );
      if (exists.rowCount === 0) {
        new TellusError(ConnectionNotFound, {
          importRid: req.params.importRid,
        }).send(res);
        return;
      }
      new TellusError(ResourceVersionMismatch, {
        importRid: req.params.importRid,
        currentVersion: exists.rows[0].version,
      }).send(res);
      return;
    }
    res
      .set("ETag", `W/"${r.rows[0].version}"`)
      .status(200)
      .json({ rid: req.params.importRid, version: r.rows[0].version });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /imports/:importRid  (soft delete; If-Match)
// ---------------------------------------------------------------------------
export async function deleteImport(
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
      `UPDATE table_imports
          SET deleted_at = now()
        WHERE rid=$1 AND deleted_at IS NULL AND version=$2`,
      [req.params.importRid, ifMatch],
    );
    if (r.rowCount === 0) {
      new TellusError(ResourceVersionMismatch, {
        importRid: req.params.importRid,
      }).send(res);
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /imports/:importRid/execute  (enqueue a build via runtime adapter)
// ---------------------------------------------------------------------------
export async function executeImport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const importRid = req.params.importRid;
    const row = await pool.query<{
      connection_rid: string;
      config: any;
    }>(
      `SELECT connection_rid, config
         FROM table_imports
        WHERE rid=$1 AND deleted_at IS NULL`,
      [importRid],
    );
    if (row.rowCount === 0) {
      new TellusError(ConnectionNotFound, { importRid }).send(res);
      return;
    }

    const conn = await pool.query<{ config: any }>(
      `SELECT config FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
      [row.rows[0].connection_rid],
    );
    if (conn.rowCount === 0) {
      new TellusError(ConnectionNotFound, {
        connectionRid: row.rows[0].connection_rid,
      }).send(res);
      return;
    }

    // Build the JobSpec.
    const buildRid = `ri.orchestration.main.build.${randomUUID()}`;
    const tenant = (req as any).user?.tenant ?? "default";
    const importConfig = row.rows[0].config;
    const pgConfig = conn.rows[0].config;
    const lastWm = await pool.query<{ value: string | null }>(
      `SELECT watermark_value AS value FROM table_import_watermarks WHERE import_rid=$1`,
      [importRid],
    );

    const { loadRuntimeAdapter } = await import(
      "../../orchestration/runners/runtime-adapter"
    );
    const { makeBuildQueue } = await import(
      "../../orchestration/queue/build-queue"
    );
    const runtime = await loadRuntimeAdapter();
    const queue = makeBuildQueue(runtime);

    await pool.query(
      `INSERT INTO orchestration_builds(
         rid, import_rid, connection_rid, tenant, actor, kind, payload, egress
       ) VALUES ($1,$2,$3,$4,$5,'foundryWorker',$6::jsonb,$7::jsonb)
       ON CONFLICT (rid) DO NOTHING`,
      [
        buildRid,
        importRid,
        row.rows[0].connection_rid,
        tenant,
        actor(req),
        JSON.stringify({
          strategy: importConfig.mode,
          config: importConfig,
          pgHost: pgConfig.host,
          pgPort: pgConfig.port,
          pgDatabase: pgConfig.database,
          lastWatermark: lastWm.rows[0]?.value ?? null,
        }),
        JSON.stringify({
          allow: [{ host: pgConfig.host, port: pgConfig.port }],
          cidrs: [],
        }),
      ],
    );

    const lock = await queue.enqueue(
      {
        buildRid,
        importRid,
        connectionRid: row.rows[0].connection_rid,
        tenant,
        actor: actor(req),
        kind: "foundryWorker",
        egress: {
          allow: [{ host: pgConfig.host, port: pgConfig.port }],
          cidrs: [],
        },
        workloadJwt: "TODO-issue-via-multipass",
        payload: {
          strategy: importConfig.mode,
          config: importConfig,
          pgHost: pgConfig.host,
          pgPort: pgConfig.port,
          pgDatabase: pgConfig.database,
          lastWatermark: lastWm.rows[0]?.value ?? null,
        },
        deadlineMs: 30 * 60_000,
      },
      { weight: 1 },
    );
    res.status(202).json({
      buildRid: lock.buildRid,
      coalesced: lock.coalesced,
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /imports/:importRid/builds
// ---------------------------------------------------------------------------
export async function listBuilds(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const r = await pool.query(
      `SELECT rid, status, enqueued_at, started_at, ended_at,
              exit_code, reason, snapshot_rid, bytes_read, rows_written
         FROM orchestration_builds
        WHERE import_rid=$1
        ORDER BY enqueued_at DESC
        LIMIT 100`,
      [req.params.importRid],
    );
    res.json({ builds: r.rows });
  } catch (err) {
    next(err);
  }
}
