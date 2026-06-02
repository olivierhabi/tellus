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
import { acquireOrJoin } from "../../orchestration/queue/single-active-build";
import { dispatchBuild } from "../../orchestration/queue/build-dispatcher";
import type { JobSpec } from "../../orchestration/runners/runtime-adapter";
import { issueWorkloadToken } from "../../multipass/tokens";

function buildRid(): string {
  return `ri.magritte.main.extract.${randomUUID()}`;
}

function actor(req: Request): string {
  // tellus auth middleware sets req.user.id
  return (req as any).user?.id ?? "00000000-0000-0000-0000-000000000000";
}

/**
 * Coerce a timestamp column to an ISO string. `pg` usually hydrates
 * `timestamptz` as a `Date`, but depending on the configured type parsers it
 * can arrive as an ISO string — calling `.toISOString()` blindly then throws
 * ("r.created_at.toISOString is not a function"). Handles Date, string, and
 * null uniformly so every handler serializes timestamps the same way.
 */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return v == null ? "" : String(v);
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
      .set("Location", `/api/v1/connectivity/imports/${rid}`)
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
      createdAt: toIso(r.created_at),
      updatedAt: toIso(r.updated_at),
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

    const conn = await pool.query<{ config: any; tenant: string }>(
      `SELECT config, tenant FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
      [row.rows[0].connection_rid],
    );
    if (conn.rowCount === 0) {
      new TellusError(ConnectionNotFound, {
        connectionRid: row.rows[0].connection_rid,
      }).send(res);
      return;
    }

    // Build the JobSpec inputs.
    const newBuildRid = `ri.orchestration.main.build.${randomUUID()}`;
    // Use the CONNECTION's tenant so the workload JWT and the server-side
    // vault.unwrap resolve the credential under the tenant it was stored with.
    const tenant =
      conn.rows[0].tenant ?? (req as any).user?.tenant ?? "default";
    const actorId = actor(req);
    const importConfig = row.rows[0].config;
    // The connection config nests the driver settings under `postgres`
    // (matching PostgresConfig); fall back to a flat shape defensively.
    const pgConfig = conn.rows[0].config?.postgres ?? conn.rows[0].config ?? {};
    const lastWm = await pool.query<{ value: string | null }>(
      `SELECT watermark_value AS value FROM table_import_watermarks WHERE import_rid=$1`,
      [importRid],
    );

    // Coalesce concurrent executes for the same import onto a single build.
    // The lock is released when the build reaches a terminal state (see the
    // build queue's finalize path), not after a fixed TTL on the happy path.
    const lock = await acquireOrJoin(importRid, newBuildRid);
    if (lock.coalesced) {
      res.status(202).json({ buildRid: lock.buildRid, coalesced: true });
      return;
    }

    const payload = {
      strategy: importConfig.mode,
      config: importConfig,
      pgHost: pgConfig.host,
      pgPort: pgConfig.port,
      pgDatabase: pgConfig.database,
      lastWatermark: lastWm.rows[0]?.value ?? null,
    };
    const egress = {
      allow: [{ host: pgConfig.host, port: pgConfig.port }],
      cidrs: [] as string[],
    };

    // Durable record of intent. Status defaults to 'queued'; the dispatcher's
    // event subscriber advances it to running → succeeded/failed/timeout.
    await pool.query(
      `INSERT INTO orchestration_builds(
         rid, import_rid, connection_rid, tenant, actor, kind, payload, egress
       ) VALUES ($1,$2,$3,$4,$5,'foundryWorker',$6::jsonb,$7::jsonb)
       ON CONFLICT (rid) DO NOTHING`,
      [
        newBuildRid,
        importRid,
        row.rows[0].connection_rid,
        tenant,
        actorId,
        JSON.stringify(payload),
        JSON.stringify(egress),
      ],
    );

    // Accept now — dispatch is decoupled from the request budget. The build is
    // durably recorded above; the response cannot be held hostage by worker
    // startup, a saturated concurrency cap, or a hung child.
    res.status(202).json({ buildRid: newBuildRid, coalesced: false });

    // The worker fetches its connection credentials from the internal unwrap
    // endpoint using a short-lived, connection-scoped workload JWT. Its egress
    // allowlist must therefore permit BOTH the source DB (persisted above for
    // audit) AND the internal endpoint — otherwise the worker's own egress
    // guard blocks the credential fetch. The internal target is infra, not
    // user-data egress, so it's added only to the worker's spec, not the
    // persisted build row.
    const internalUrl = process.env.TELLUS_INTERNAL_URL ?? "http://127.0.0.1:3000";
    let internalTarget: { host: string; port: number } | null = null;
    try {
      const u = new URL(internalUrl);
      internalTarget = {
        host: u.hostname,
        port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
      };
    } catch {
      internalTarget = { host: "127.0.0.1", port: 3000 };
    }
    const workerEgress = {
      allow: internalTarget ? [...egress.allow, internalTarget] : egress.allow,
      cidrs: egress.cidrs,
    };

    const workloadJwt = issueWorkloadToken({
      subject: "tellus-foundry-worker",
      connectionRid: row.rows[0].connection_rid,
      tenant,
      scopes: ["connectivity:credential-unwrap"],
      // Issued at dispatch; the worker fetches credentials at build start. Keep
      // it comfortably longer than queue wait so a backlogged build can still
      // unwrap when it finally runs.
      ttlSeconds: 1800,
    });

    const spec: JobSpec = {
      buildRid: newBuildRid,
      importRid,
      connectionRid: row.rows[0].connection_rid,
      tenant,
      actor: actorId,
      kind: "foundryWorker",
      egress: workerEgress,
      workloadJwt,
      payload,
      deadlineMs: 30 * 60_000,
    };
    // Fire-and-forget: dispatchBuild owns its own error handling (it releases
    // the lock and marks the build failed if admission throws).
    void dispatchBuild(spec);
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
