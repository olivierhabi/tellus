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
//   POST   /imports/execute-batch                  -> enqueue one multi-job build
//   GET    /imports/:importRid/builds              -> list builds
//   GET    /builds/:buildRid                       -> single build (job-tracker)
//   GET    /builds/:buildRid/events                -> live progress (SSE)
//   POST   /builds/:buildRid/cancel                -> cancel a build
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../../../db";
import { TellusError } from "../../../lib/errors/envelope";
import {
  ConnectionNotFound,
  BuildNotFound,
  ResourceVersionMismatch,
  IfMatchRequired,
  InvalidConfiguration,
  EgressPolicyNotFound,
  EgressPolicyNotApproved,
} from "../../../lib/errors/connectivity.errors";
import * as egressPoliciesRepo from "../store/egress-policies.repo";
import {
  assertEgressAllowed,
  assertEgressResolved,
} from "../connectors/postgresql/egress";
import {
  TableImportCreateRequest,
  TableImportUpdateRequest,
  type TableImportT,
} from "./contracts";
import { parseIfMatch } from "../../../middleware/connectivityEtag";
import { resolvePrincipalNames } from "../principalNames";
import { classifyTrigger } from "./triggers";
import { assertSelectOnly, UnsafeSqlError } from "./sql-renderer";
import {
  upsertImportSchedule,
  deleteImportSchedule,
} from "./temporal/schedule";
import { registerSyncedDataset } from "../../datasets/synced-dataset-registry";
import { acquireOrJoin, release } from "../../orchestration/queue/single-active-build";
import {
  dispatchBuild,
  cancelLocalBuild,
} from "../../orchestration/queue/build-dispatcher";
import {
  ensureBus,
  subscribeBuildEvents,
  publishBuildEvent,
  publishCancelRequest,
} from "../../orchestration/build-event-bus";
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

/**
 * SELECT-only gate at the API write boundary. When a `customQuery` is present,
 * reject anything that is not a single pure read-only SELECT *before* it is
 * persisted — so unsafe SQL never reaches storage, and the user gets immediate
 * 400 feedback instead of a build that fails later. Returns true when OK;
 * sends a 400 InvalidConfiguration and returns false otherwise.
 */
async function customQueryOk(
  res: Response,
  customQuery: string | undefined,
): Promise<boolean> {
  if (!customQuery) return true;
  try {
    await assertSelectOnly(customQuery);
    return true;
  } catch (err) {
    if (err instanceof UnsafeSqlError) {
      new TellusError(InvalidConfiguration, {
        field: "config.customQuery",
        reason: err.reason,
      }).send(res);
      return false;
    }
    throw err;
  }
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
    if (!(await customQueryOk(res, body.config.customQuery))) return;
    const conn = await pool.query<{ compass_folder_rid: string | null; tenant: string }>(
      `SELECT compass_folder_rid, tenant FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
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

    // Make the output Dataset visible in its Compass project/folder (Foundry
    // parity) so it appears in the project view and opens the Dataset Preview.
    // Best-effort: a registration failure never fails sync creation.
    void registerSyncedDataset({
      datasetRid: body.datasetRid,
      name: body.displayName,
      compassFolderRid: conn.rows[0].compass_folder_rid,
      schema: body.config.schema,
      table: body.config.targetTable ?? body.config.table,
      warehouse: body.config.warehouseRoot ?? conn.rows[0].tenant ?? "default",
      status: "draft", // not built yet → "ready" (viewable, not polled)
    }).catch(() => undefined);

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
              version, status, created_at, updated_at, created_by,
              schedule_enabled, schedule_interval_minutes, next_run_at, last_run_at,
              schedule_cron, schedule_timezone
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
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      createdBy: row.created_by,
      schedule: {
        enabled: row.schedule_enabled,
        intervalMinutes: row.schedule_interval_minutes,
        cron: row.schedule_cron,
        timezone: row.schedule_timezone,
        nextRunAt: row.next_run_at ? toIso(row.next_run_at) : null,
        lastRunAt: row.last_run_at ? toIso(row.last_run_at) : null,
      },
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
      schedule_enabled: boolean;
      schedule_interval_minutes: number | null;
      next_run_at: Date | string | null;
      last_run_at: Date | string | null;
      schedule_cron: string | null;
      schedule_timezone: string | null;
    }>(
      `SELECT rid, connection_rid, dataset_rid, display_name, config,
              version, status, created_at, updated_at, created_by,
              schedule_enabled, schedule_interval_minutes, next_run_at, last_run_at,
              schedule_cron, schedule_timezone
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
      schedule: {
        enabled: r.schedule_enabled,
        intervalMinutes: r.schedule_interval_minutes,
        cron: r.schedule_cron,
        timezone: r.schedule_timezone,
        nextRunAt: r.next_run_at ? toIso(r.next_run_at) : null,
        lastRunAt: r.last_run_at ? toIso(r.last_run_at) : null,
      },
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
    if (!(await customQueryOk(res, body.config?.customQuery))) return;

    // Schedule update (optional). A schedule is cron-based OR interval-based.
    //  - cron:     Temporal owns next-fire (DB next_run_at left NULL).
    //  - interval: next_run_at computed one interval out (also drives the
    //              DB-poll fallback when Temporal is unreachable).
    // `scheduleSet` tells the UPDATE whether to touch the schedule columns so a
    // config-only PUT leaves the schedule untouched.
    const scheduleSet = body.schedule !== undefined;
    const scheduleEnabled = body.schedule?.enabled ?? false;
    const scheduleCron =
      scheduleEnabled && body.schedule?.cron && body.schedule.cron.trim()
        ? body.schedule.cron.trim()
        : null;
    const scheduleInterval =
      scheduleEnabled && !scheduleCron
        ? body.schedule?.intervalMinutes ?? null
        : null;
    const scheduleTimezone = scheduleCron
      ? body.schedule?.timezone?.trim() || "UTC"
      : null;
    // Fast-fail on obviously malformed cron (Temporal is the authoritative
    // validator at schedule-create time).
    if (scheduleCron) {
      const fields = scheduleCron.split(/\s+/).length;
      if (fields < 5 || fields > 7) {
        new TellusError(InvalidConfiguration, {
          field: "schedule.cron",
          reason: "cron expression must have 5-7 fields",
        }).send(res);
        return;
      }
    }
    const nextRunAt =
      scheduleEnabled && !scheduleCron && scheduleInterval != null
        ? new Date(Date.now() + scheduleInterval * 60_000)
        : null;

    const r = await pool.query<{ version: number }>(
      `UPDATE table_imports
          SET display_name = COALESCE($1, display_name),
              config = CASE
                WHEN $2::jsonb IS NOT NULL THEN config || $2::jsonb
                ELSE config
              END,
              schedule_enabled = CASE WHEN $5 THEN $6 ELSE schedule_enabled END,
              schedule_interval_minutes =
                CASE WHEN $5 THEN $7 ELSE schedule_interval_minutes END,
              next_run_at = CASE WHEN $5 THEN $8 ELSE next_run_at END,
              schedule_cron = CASE WHEN $5 THEN $9 ELSE schedule_cron END,
              schedule_timezone = CASE WHEN $5 THEN $10 ELSE schedule_timezone END,
              version = version + 1,
              updated_at = now()
        WHERE rid=$3 AND deleted_at IS NULL AND version=$4
        RETURNING version`,
      [
        body.displayName ?? null,
        body.config ? JSON.stringify(body.config) : null,
        req.params.importRid,
        ifMatch,
        scheduleSet,
        scheduleEnabled,
        scheduleInterval,
        nextRunAt,
        scheduleCron,
        scheduleTimezone,
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

    // Scheduling engine partition (no double-firing):
    //   - CRON schedules run on the durable Temporal Schedule (cron + timezone
    //     + overlap=SKIP + catchupWindow). The DB poll ignores them
    //     (schedule_interval_minutes IS NULL).
    //   - INTERVAL schedules run on the proven DB-poll scheduler
    //     (FOR UPDATE SKIP LOCKED; next_run_at set above). No Temporal schedule.
    // So we create a Temporal Schedule only for cron, and delete any lingering
    // one whenever the import is interval-mode or disabled. Best-effort: never
    // fail the API on scheduler sync (boot resync reconciles drift).
    if (scheduleSet) {
      try {
        if (scheduleEnabled && scheduleCron) {
          await upsertImportSchedule(req.params.importRid, {
            cron: scheduleCron,
            timezone: scheduleTimezone,
          });
        } else {
          await deleteImportSchedule(req.params.importRid);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[imports.putImport] temporal schedule sync failed for ${req.params.importRid}: ${(e as Error).message}`,
        );
      }
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
/**
 * Build + dispatch a foundry-worker build for an import. This is the single
 * code path shared by the HTTP `execute` handler and the table-import
 * scheduler, so a scheduled run does EXACTLY what a manual "Run" does:
 *   - coalesce onto an in-flight build via the single-active lock,
 *   - persist a durable `orchestration_builds` row,
 *   - hand the worker a short-lived, connection-scoped workload JWT and an
 *     egress allowlist covering the source DB + the internal unwrap endpoint,
 *   - fire-and-forget `dispatchBuild` (its own error handling).
 *
 * Throws `Tellus:Connectivity:ConnectionNotFound` when the import or its
 * connection is missing/deleted. Returns the build rid and whether it
 * coalesced onto an already-running build.
 *
 * `groupRid` ties this build into a multi-table Build (Foundry's one-build-
 * many-jobs model): every member of a "Create sync for N tables" action shares
 * the lead member's rid as its `group_rid`. Omitted for a standalone build, in
 * which case the build is its own group of one (`group_rid = its own rid`).
 */
export async function enqueueBuildForImport(
  importRid: string,
  actorId: string,
  groupRid?: string,
): Promise<{ buildRid: string; coalesced: boolean }> {
  const row = await pool.query<{ connection_rid: string; config: any }>(
    `SELECT connection_rid, config
       FROM table_imports
      WHERE rid=$1 AND deleted_at IS NULL`,
    [importRid],
  );
  if (row.rowCount === 0) {
    throw new TellusError(ConnectionNotFound, { importRid });
  }

  const conn = await pool.query<{ config: any; tenant: string; egress_policy: any; egress_policy_rid: string | null }>(
    `SELECT config, tenant, egress_policy, egress_policy_rid FROM connectivity_connections WHERE rid=$1 AND deleted_at IS NULL`,
    [row.rows[0].connection_rid],
  );
  if (conn.rowCount === 0) {
    throw new TellusError(ConnectionNotFound, {
      connectionRid: row.rows[0].connection_rid,
    });
  }

  // Foundry-native build RID namespace (matches the platform resource model +
  // the job-tracker build URLs). Legacy `ri.orchestration.main.build.*` rows
  // remain valid; see migration 091.
  const newBuildRid = `ri.foundry.main.build.${randomUUID()}`;
  // Use the CONNECTION's tenant so the workload JWT and the server-side
  // vault.unwrap resolve the credential under the tenant it was stored with.
  const tenant = conn.rows[0].tenant ?? "default";
  const importConfig = row.rows[0].config;
  // The connection config nests the driver settings under `postgres`
  // (matching PostgresConfig); fall back to a flat shape defensively.
  const pgConfig = conn.rows[0].config?.postgres ?? conn.rows[0].config ?? {};

  // Zero-trust egress gate at build admission (Strix medium 6.5, Sept 2026):
  // the import worker child dials pgConfig.host:pgPort DIRECTLY with only
  // the connection's self-authored allowlist installed — it never passes
  // through pool.getPool. Enforce the same checks here as at dial time
  // (pool.ts getPool) BEFORE any child process spawns: a referenced named
  // egress policy must be APPROVED, the effective allowlist must cover
  // host:port, and reserved/internal targets are refused unless the
  // operator opted them in via CONNECTIVITY_EGRESS_ALLOW_RESERVED.
  // Without this, a connection to e.g. 169.254.169.254:80 is refused by
  // the guarded /test path but still dialed by the import worker.
  const connectionRid = row.rows[0].connection_rid;
  let effectivePolicy = conn.rows[0].egress_policy;
  if (conn.rows[0].egress_policy_rid) {
    const named = await egressPoliciesRepo.resolveForEnforcement(
      conn.rows[0].egress_policy_rid,
    );
    if (!named) {
      throw new TellusError(EgressPolicyNotFound, {
        connectionRid,
        egressPolicyRid: conn.rows[0].egress_policy_rid,
      });
    }
    if (named.status !== "APPROVED") {
      throw new TellusError(EgressPolicyNotApproved, {
        connectionRid,
        egressPolicyRid: conn.rows[0].egress_policy_rid,
        status: named.status,
      });
    }
    effectivePolicy = { allowlist: named.allowlist };
  }
  assertEgressAllowed(connectionRid, pgConfig.host, pgConfig.port, effectivePolicy);
  await assertEgressResolved(pgConfig.host, pgConfig.port);

  const lastWm = await pool.query<{ value: string | null }>(
    `SELECT watermark_value AS value FROM table_import_watermarks WHERE import_rid=$1`,
    [importRid],
  );

  // Coalesce concurrent runs (manual + scheduled) for the same import onto a
  // single build. The lock is released when the build reaches a terminal state.
  const lock = await acquireOrJoin(importRid, newBuildRid);
  if (lock.coalesced) {
    return { buildRid: lock.buildRid, coalesced: true };
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
       rid, import_rid, connection_rid, tenant, actor, kind, payload, egress, group_rid
     ) VALUES ($1,$2,$3,$4,$5,'foundryWorker',$6::jsonb,$7::jsonb,$8)
     ON CONFLICT (rid) DO NOTHING`,
    [
      newBuildRid,
      importRid,
      row.rows[0].connection_rid,
      tenant,
      actorId,
      JSON.stringify(payload),
      JSON.stringify(egress),
      groupRid ?? newBuildRid,
    ],
  );

  // The worker fetches its credentials from the internal unwrap endpoint using
  // a short-lived, connection-scoped workload JWT. Its egress allowlist must
  // permit BOTH the source DB (persisted above for audit) AND the internal
  // endpoint — the internal target is infra, so it's added only to the spec.
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
  // Fire-and-forget: dispatchBuild owns its own error handling (it releases the
  // lock and marks the build failed if admission throws).
  void dispatchBuild(spec);

  return { buildRid: newBuildRid, coalesced: false };
}

export async function executeImport(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await enqueueBuildForImport(req.params.importRid, actor(req));
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
    next(err);
  }
}

/**
 * Enqueue ONE Build that materialises several imports (tables) as jobs — the
 * Foundry one-build-many-jobs model. The first import's build is the lead; its
 * rid becomes the shared `group_rid` for the whole batch and the rid the
 * job-tracker is opened at. Each member is dispatched independently (the proven
 * per-import path), but the read/SSE/cancel surface aggregates them into a
 * single Build keyed on that group rid.
 *
 * Returns the group (lead) build rid plus each member's outcome.
 */
/** Upper bound on tables per Build. A batch dispatches sequentially, so this
 *  caps the request's work (and the resulting fan-out) to a sane size; larger
 *  imports should be split into multiple Builds. */
const MAX_BATCH_IMPORTS = 100;

export async function enqueueBuildBatch(
  importRids: string[],
  actorId: string,
): Promise<{
  buildRid: string;
  members: { importRid: string; buildRid: string; coalesced: boolean }[];
}> {
  // Dedupe so a repeated rid can't create two jobs for one import.
  const rids = Array.from(new Set(importRids));
  if (rids.length === 0) {
    throw new TellusError(InvalidConfiguration, {
      field: "importRids",
      reason: "at least one import rid is required",
    });
  }
  if (rids.length > MAX_BATCH_IMPORTS) {
    throw new TellusError(InvalidConfiguration, {
      field: "importRids",
      reason: `a Build may contain at most ${MAX_BATCH_IMPORTS} tables (got ${rids.length})`,
    });
  }

  // Pre-flight: every import must exist BEFORE we dispatch any, so one bad rid
  // can't leave a half-built Build (some jobs dispatched, the request 404'd).
  const existing = await pool.query<{ rid: string }>(
    `SELECT rid FROM table_imports WHERE rid = ANY($1) AND deleted_at IS NULL`,
    [rids],
  );
  const found = new Set(existing.rows.map((r) => r.rid));
  const missing = rids.filter((r) => !found.has(r));
  if (missing.length > 0) {
    throw new TellusError(ConnectionNotFound, { importRids: missing });
  }

  const members: { importRid: string; buildRid: string; coalesced: boolean }[] = [];
  let groupRid: string | undefined;
  for (const importRid of rids) {
    // The first member sets the group rid (its own build rid via the default);
    // the rest are stamped with it so they aggregate into one Build.
    const r = await enqueueBuildForImport(importRid, actorId, groupRid);
    if (!groupRid) groupRid = r.buildRid;
    members.push({ importRid, buildRid: r.buildRid, coalesced: r.coalesced });
  }
  return { buildRid: groupRid as string, members };
}

// ---------------------------------------------------------------------------
// POST /imports/execute-batch  (enqueue one multi-table Build)
//
// Body: { importRids: string[] }. Runs every import as a job under a single
// Build (shared group_rid) so "Create sync for N tables" produces ONE build
// the user can watch — matching Foundry's `Build.jobRids`.
// ---------------------------------------------------------------------------
export async function executeImportBatch(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const raw = (req.body ?? {}) as { importRids?: unknown };
    const importRids = Array.isArray(raw.importRids)
      ? raw.importRids.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (importRids.length === 0) {
      new TellusError(InvalidConfiguration, {
        field: "importRids",
        reason: "importRids must be a non-empty array of import rids",
      }).send(res);
      return;
    }
    const result = await enqueueBuildBatch(importRids, actor(req));
    res.status(202).json(result);
  } catch (err) {
    if (err instanceof TellusError) {
      err.send(res);
      return;
    }
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

// ---------------------------------------------------------------------------
// GET /builds/:buildRid  (single build — the job-tracker "build details" view)
//
// Read-side counterpart to `POST /imports/:rid/execute`. Returns the durable
// `orchestration_builds` row joined with the import it materialises (the
// "resource to sync" — display name + target dataset rid + table coordinates)
// and the owning connection, plus the append-only event log the progress
// timeline renders. Mirrors Foundry's Get Build (orchestration-v2): a build is
// the execution that produces a resource, so the response carries both the
// build's lifecycle (status/timings/counts) AND the resource it builds.
//
// The status enum is normalised to Foundry's vocabulary for the client
// (queued/running → RUNNING, succeeded → SUCCEEDED, failed/timeout → FAILED,
// cancelled → CANCELED) while the raw status is preserved so the FE can
// distinguish a timeout from a plain failure.
// ---------------------------------------------------------------------------

/**
 * Normalise a timestamp to canonical ISO 8601 (`...T...Z`). `pg` may hydrate a
 * `timestamptz` as a space-separated Postgres string (`2026-06-05 10:45:01+00`)
 * which is OUTSIDE the ECMAScript Date spec — Chrome parses it but Safari/
 * Firefox can return NaN. Emitting strict ISO guarantees the client's
 * `new Date(...)` works everywhere. Falls back to the raw string if unparseable.
 */
function toIsoStrict(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** Map the internal build status to Foundry's Build.status enum. */
function foundryBuildStatus(
  status: string,
): "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" {
  switch (status) {
    case "succeeded":
      return "SUCCEEDED";
    case "failed":
    case "timeout":
      return "FAILED";
    case "cancelled":
      return "CANCELED";
    default:
      // queued | running
      return "RUNNING";
  }
}

/** Raw internal statuses that are terminal (no further events will arrive). */
const RAW_TERMINAL: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
]);

/** A single orchestration_builds row joined with its import + connection — one
 *  member (job) of a Build group. */
interface BuildMemberRow {
  rid: string;
  group_rid: string | null;
  status: string;
  kind: string;
  actor: string;
  enqueued_at: Date | string;
  started_at: Date | string | null;
  ended_at: Date | string | null;
  exit_code: number | null;
  reason: string | null;
  snapshot_rid: string | null;
  rows_written: string | number | null;
  bytes_read: string | number | null;
  import_rid: string;
  display_name: string;
  dataset_rid: string;
  import_config: { schema?: string; table?: string; mode?: string } | null;
  connection_rid: string;
  connection_name: string | null;
}

const toNum = (v: string | number | null): number | null =>
  v == null ? null : typeof v === "number" ? v : Number(v);

/** All members (jobs) of the Build group that `buildRid` belongs to, oldest
 *  first. A standalone build is its own group of one. Empty when the rid is
 *  unknown. Grouping is by `COALESCE(group_rid, rid)` so pre-092 rows (where
 *  group_rid was backfilled to rid) and any null still resolve correctly. */
async function groupMemberRows(buildRid: string): Promise<BuildMemberRow[]> {
  const r = await pool.query<BuildMemberRow>(
    `SELECT b.rid, b.group_rid, b.status, b.kind, b.actor,
            b.enqueued_at, b.started_at, b.ended_at,
            b.exit_code, b.reason, b.snapshot_rid,
            b.rows_written, b.bytes_read,
            ti.rid           AS import_rid,
            ti.display_name  AS display_name,
            ti.dataset_rid   AS dataset_rid,
            ti.config        AS import_config,
            c.rid            AS connection_rid,
            c.name           AS connection_name
       FROM orchestration_builds b
       JOIN table_imports ti ON ti.rid = b.import_rid
       LEFT JOIN connectivity_connections c ON c.rid = b.connection_rid
      WHERE COALESCE(b.group_rid, b.rid) = (
              SELECT COALESCE(group_rid, rid)
                FROM orchestration_builds WHERE rid = $1
            )
      ORDER BY b.enqueued_at ASC, b.rid ASC`,
    [buildRid],
  );
  return r.rows;
}

/** Just the member rids of `buildRid`'s group (cheap; used by SSE + cancel). */
async function groupMemberRids(buildRid: string): Promise<string[]> {
  const r = await pool.query<{ rid: string }>(
    `SELECT rid FROM orchestration_builds
      WHERE COALESCE(group_rid, rid) = (
              SELECT COALESCE(group_rid, rid)
                FROM orchestration_builds WHERE rid = $1
            )
      ORDER BY enqueued_at ASC, rid ASC`,
    [buildRid],
  );
  return r.rows.map((x) => x.rid);
}

/** Collapse the member raw statuses into one Build status (Foundry enum + the
 *  representative raw label). A Build is RUNNING while any job is queued/running;
 *  FAILED if any job failed/timed out; CANCELED if any was cancelled; else
 *  SUCCEEDED. A group of one passes its raw status through verbatim (so a lone
 *  timeout still surfaces as "Timed out"). */
function aggregateStatus(raws: string[]): {
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";
  rawStatus: string;
} {
  if (raws.length === 1) {
    return { status: foundryBuildStatus(raws[0]), rawStatus: raws[0] };
  }
  const has = (s: string) => raws.includes(s);
  let rawStatus: string;
  if (raws.some((r) => r === "queued" || r === "running")) {
    rawStatus = has("running") ? "running" : "queued";
  } else if (raws.some((r) => r === "failed" || r === "timeout")) {
    rawStatus = has("failed") ? "failed" : "timeout";
  } else if (has("cancelled")) {
    rawStatus = "cancelled";
  } else {
    rawStatus = "succeeded";
  }
  return { status: foundryBuildStatus(rawStatus), rawStatus };
}

/** Earliest ('min') or latest ('max') non-null timestamp among `values`, as ISO. */
function pickIso(values: (Date | string | null)[], pick: "min" | "max"): string | null {
  let best: Date | string | null = null;
  let bestMs: number | null = null;
  for (const v of values) {
    if (v == null) continue;
    const ms = (v instanceof Date ? v : new Date(String(v))).getTime();
    if (Number.isNaN(ms)) continue;
    if (bestMs == null || (pick === "min" ? ms < bestMs : ms > bestMs)) {
      bestMs = ms;
      best = v;
    }
  }
  return best == null ? null : toIsoStrict(best);
}

/** Map one member row to a per-job view object. */
function toJob(b: BuildMemberRow): Record<string, unknown> {
  return {
    rid: b.rid,
    status: foundryBuildStatus(b.status),
    rawStatus: b.status,
    kind: b.kind,
    enqueuedAt: toIsoStrict(b.enqueued_at) ?? "",
    startedAt: toIsoStrict(b.started_at),
    endedAt: toIsoStrict(b.ended_at),
    exitCode: b.exit_code,
    reason: b.reason,
    snapshotRid: b.snapshot_rid,
    rowsWritten: toNum(b.rows_written),
    bytesRead: toNum(b.bytes_read),
    import: {
      rid: b.import_rid,
      displayName: b.display_name,
      datasetRid: b.dataset_rid,
      schema: b.import_config?.schema ?? null,
      table: b.import_config?.table ?? null,
      mode: b.import_config?.mode ?? null,
    },
    connection: { rid: b.connection_rid, name: b.connection_name },
  };
}

/** The Build envelope (identity + aggregate lifecycle + every job it
 *  materialises), shared by the JSON `getBuild` handler and the SSE
 *  `status`/`done` snapshots. The top-level fields describe the Build as a whole
 *  (aggregate status, earliest start, latest end, summed rows) while `jobs[]`
 *  carries each table's own row — Foundry's one-build-many-jobs shape. The
 *  top-level `import`/`connection` reflect the lead job so a single-table Build
 *  is byte-identical to the pre-group response. Returns null for an unknown rid.
 *  Events are fetched separately (`buildEventsAfter`/`groupEvents`). */
async function buildEnvelope(buildRid: string): Promise<Record<string, unknown> | null> {
  const rows = await groupMemberRows(buildRid);
  if (rows.length === 0) return null;

  const grp = rows[0].group_rid ?? rows[0].rid;
  const lead = rows.find((r) => r.rid === grp) ?? rows[0];
  const jobs = rows.map(toJob);
  const agg = aggregateStatus(rows.map((r) => r.status));

  const sum = (key: "rows_written" | "bytes_read"): number | null => {
    let any = false;
    let total = 0;
    for (const r of rows) {
      const v = toNum(r[key]);
      if (v != null) {
        any = true;
        total += v;
      }
    }
    return any ? total : null;
  };

  const allTerminal = rows.every((r) => RAW_TERMINAL.has(r.status));
  // Surface a failure/cancel reason from whichever job carries one (so the FE's
  // failure banner has something to show), else the lead's.
  const reason =
    rows.find((r) => r.reason && (r.status === "failed" || r.status === "timeout"))?.reason ??
    rows.find((r) => r.reason)?.reason ??
    lead.reason;
  const single = rows.length === 1;

  // "Started by" (Foundry parity): a build is started either by a USER or by a
  // SCHEDULE. The lead actor is the principal that enqueued the Build; classify
  // it, and for a user resolve the Keycloak subject id to a display name (the
  // FE shows the name or "Build schedule", never a raw id). Best-effort: an
  // unresolved/unreachable principal stays null and the FE shows "Unknown user".
  const trigger = classifyTrigger(lead.actor);
  let createdByName: string | null = null;
  if (trigger === "MANUAL" && lead.actor) {
    const names = await resolvePrincipalNames([lead.actor]);
    createdByName = names.get(lead.actor) ?? null;
  }

  return {
    // Echo the requested rid (REST-conventional). The whole group is still
    // returned via `jobs[]`; the create-sync flow opens the group's lead rid, so
    // the canonical Build id is shown there.
    rid: buildRid,
    status: agg.status,
    rawStatus: agg.rawStatus,
    kind: lead.kind,
    createdBy: lead.actor,
    // Resolved display name for a user actor (null for schedules / unresolved).
    createdByName,
    // How the build was started: a user ("MANUAL") or a timer ("SCHEDULE").
    trigger,
    enqueuedAt: pickIso(rows.map((r) => r.enqueued_at), "min") ?? "",
    startedAt: pickIso(rows.map((r) => r.started_at), "min"),
    // The Build ends only when every job has; until then it's still running.
    endedAt: allTerminal ? pickIso(rows.map((r) => r.ended_at), "max") : null,
    exitCode: single ? lead.exit_code : null,
    reason,
    snapshotRid: single ? lead.snapshot_rid : null,
    rowsWritten: sum("rows_written"),
    bytesRead: sum("bytes_read"),
    import: {
      rid: lead.import_rid,
      displayName: lead.display_name,
      datasetRid: lead.dataset_rid,
      schema: lead.import_config?.schema ?? null,
      table: lead.import_config?.table ?? null,
      mode: lead.import_config?.mode ?? null,
    },
    connection: { rid: lead.connection_rid, name: lead.connection_name },
    jobs,
  };
}

/** One member's append-only events with id > afterId (ascending), bounded.
 *  The SSE cursor is per member, so a group tails each member independently. */
async function buildEventsAfter(
  buildRid: string,
  afterId: number,
  limit: number,
): Promise<{ id: number; kind: string; ts: string; data: unknown }[]> {
  const r = await pool.query<{ id: string | number; kind: string; ts: Date | string; data: unknown }>(
    `SELECT id, kind, ts, data
       FROM orchestration_build_events
      WHERE build_rid = $1 AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [buildRid, afterId, limit],
  );
  return r.rows.map((e) => ({
    id: typeof e.id === "number" ? e.id : Number(e.id),
    kind: e.kind,
    ts: toIsoStrict(e.ts) ?? "",
    data: e.data ?? {},
  }));
}

/** The merged event timeline across every job in `memberRids`, ordered by ts
 *  (each job tagged with its build rid), bounded. Used by the one-shot JSON
 *  view. For a single-job Build this is exactly that job's log. */
async function groupEvents(
  memberRids: string[],
  perMemberLimit: number,
): Promise<{ buildRid: string; kind: string; ts: string; data: unknown }[]> {
  const all: { buildRid: string; kind: string; ts: string; data: unknown }[] = [];
  for (const rid of memberRids) {
    const evs = await buildEventsAfter(rid, 0, perMemberLimit);
    for (const e of evs) all.push({ buildRid: rid, kind: e.kind, ts: e.ts, data: e.data });
  }
  all.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return all;
}

export async function getBuild(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildRid = req.params.buildRid;
    const envelope = await buildEnvelope(buildRid);
    if (!envelope) {
      new TellusError(BuildNotFound, { buildRid }).send(res);
      return;
    }
    // Merge the event timeline across every job in the Build group.
    const memberRids = await groupMemberRids(buildRid);
    const events = await groupEvents(memberRids, 200);
    res.json({
      ...envelope,
      // The one-shot JSON view exposes events without the SSE cursor id.
      events: events.map((e) => ({ kind: e.kind, ts: e.ts, data: e.data })),
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /builds/:buildRid/events  (Server-Sent Events — live build progress)
//
// Streams the build's lifecycle to the client as it happens. Design notes:
//   - LOW LATENCY: events are pushed via Redis pub/sub (the build event bus) so
//     a client sees each event within milliseconds, regardless of which app
//     instance produced it.
//   - DURABLE + RESUMABLE: the DB (`orchestration_build_events`) is the source
//     of truth. On connect we backfill from the persisted log (resuming from
//     `Last-Event-ID`), and a slower DB reconciliation poll runs as a SAFETY
//     NET — Redis pub/sub is at-most-once, so the reconcile catches any event
//     the bus dropped and also detects terminal status. No event is lost across
//     a dropped connection.
//   - GRACEFUL DEGRADATION: if Redis is unavailable the bus is a no-op and the
//     reconcile poll runs at a faster cadence, so SSE still works (just with
//     poll latency) — nothing breaks.
//   - HORIZONTALLY SCALABLE: the handler is stateless (DB + a shared Redis
//     subscription); any instance can serve any client.
//   - The stream opens with a full `status` snapshot, emits each raw event
//     (`started`, `progress`, …) with its cursor id, refreshes the `status`
//     snapshot on change, and sends a terminal `done` snapshot when the build
//     finishes — then closes. A 15s heartbeat keeps proxies open; a hard
//     lifetime cap closes idle streams (the client reconnects + resumes).
// ---------------------------------------------------------------------------
const SSE_RECONCILE_BUS_MS = 5000; // safety-net poll when pub/sub is live
const SSE_RECONCILE_POLL_MS = 1000; // primary poll when pub/sub is unavailable
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_LIFETIME_MS = 10 * 60_000;
const SSE_EVENT_PAGE = 500;
// Coalesce bus-triggered aggregate re-reads for a multi-job Build: a burst of
// member events collapses to one group query instead of one query per event.
const SSE_BUS_DEBOUNCE_MS = 150;

export async function streamBuildEvents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const buildRid = req.params.buildRid;
  try {
    // 404 before upgrading to a stream, so an unknown rid is a normal error.
    const initial = await buildEnvelope(buildRid);
    if (!initial) {
      new TellusError(BuildNotFound, { buildRid }).send(res);
      return;
    }

    // A Build may have several jobs (member builds); tail each one. A single-job
    // Build keeps the original contract exactly: raw events are forwarded with
    // their cursor ids and `Last-Event-ID` resumes them. A multi-job Build emits
    // only aggregate `status`/`done` snapshots (each member has its own id
    // sequence, so per-event ids aren't globally meaningful) — and the client
    // only consumes snapshots anyway.
    const memberRids = await groupMemberRids(buildRid);
    const single = memberRids.length <= 1;

    // Resume point: the browser replays its last seen id on reconnect. Per-member
    // cursors; only the single-job case seeds from the header (its lone sequence).
    const lastEventIdHeader = req.headers["last-event-id"];
    const lastEventIdRaw = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : lastEventIdHeader ?? (req.query.lastEventId as string | undefined);
    let seed = Number(lastEventIdRaw ?? 0);
    if (!Number.isFinite(seed) || seed < 0) seed = 0;
    const cursors = new Map<string, number>();
    for (const rid of memberRids) cursors.set(rid, single ? seed : 0);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // defeat nginx buffering
    res.flushHeaders?.();

    let closed = false;
    let finished = false;
    let reconcileTimer: NodeJS.Timeout | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let lifetimeTimer: NodeJS.Timeout | undefined;
    let busReconcileTimer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;

    const flush = () => (res as unknown as { flush?: () => void }).flush?.();
    const writeFrame = (event: string, data: unknown, id?: number) => {
      if (closed) return;
      if (id != null) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      flush();
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (lifetimeTimer) clearTimeout(lifetimeTimer);
      if (busReconcileTimer) clearTimeout(busReconcileTimer);
    };
    req.on("close", cleanup);

    // Send a terminal `done` snapshot once, then close. Idempotent.
    const finish = async (): Promise<void> => {
      if (finished || closed) return;
      finished = true;
      const env = (await buildEnvelope(buildRid)) ?? initial;
      writeFrame("done", env);
      cleanup();
      try {
        res.end();
      } catch {
        /* already torn down */
      }
    };

    // Catch up from the durable log: drain each job's events past its cursor
    // (forwarding raw frames only for a single-job Build), then refresh the
    // aggregate status snapshot if anything changed, and finish on terminal.
    const reconcile = async (): Promise<void> => {
      if (closed || finished) return;
      try {
        let drained = false;
        for (const rid of memberRids) {
          const events = await buildEventsAfter(rid, cursors.get(rid) ?? 0, SSE_EVENT_PAGE);
          for (const e of events) {
            if (e.id <= (cursors.get(rid) ?? 0)) continue;
            if (single) writeFrame(e.kind, { kind: e.kind, ts: e.ts, data: e.data }, e.id);
            cursors.set(rid, e.id);
            drained = true;
          }
        }
        const env = await buildEnvelope(buildRid);
        if (!env) {
          await finish(); // build pruned — end gracefully
          return;
        }
        if (drained) writeFrame("status", env);
        if (RAW_TERMINAL.has(String(env.rawStatus))) await finish();
      } catch {
        // Transient DB hiccup: keep the stream open; next reconcile retries.
      }
    };

    // Coalesce bus-triggered reconciles for a multi-job Build: a burst of member
    // events within the debounce window collapses to ONE aggregate group read.
    const scheduleReconcile = () => {
      if (closed || finished || busReconcileTimer) return;
      busReconcileTimer = setTimeout(() => {
        busReconcileTimer = undefined;
        void reconcile();
      }, SSE_BUS_DEBOUNCE_MS);
    };

    res.write("retry: 3000\n\n"); // client reconnect backoff
    writeFrame("status", initial); // full snapshot first

    // Live push via Redis pub/sub. Subscribe to every job BEFORE the initial
    // backfill so no event slips through the gap; the id-cursor dedupe makes
    // overlap safe. Single-job: forward the raw frame for lowest latency.
    // Multi-job: re-derive the aggregate snapshot via reconcile.
    const busLive = await ensureBus();
    if (busLive) {
      const offs = memberRids.map((rid) =>
        subscribeBuildEvents(rid, (m) => {
          if (closed || finished) return;
          if (single && typeof m.id === "number" && m.id > (cursors.get(m.buildRid) ?? 0)) {
            writeFrame(m.kind, { kind: m.kind, ts: m.ts, data: m.data }, m.id);
            cursors.set(m.buildRid, m.id);
            if (RAW_TERMINAL.has(m.kind)) void finish();
          } else if (!single) {
            // Multi-job: re-derive the aggregate snapshot (debounced).
            scheduleReconcile();
          }
        }),
      );
      unsubscribe = () => offs.forEach((off) => off());
    }

    // Initial backfill (also finishes immediately if already terminal).
    await reconcile();

    if (!closed) {
      // Reconcile cadence: a slow safety net when pub/sub is live; the primary
      // poll when it isn't.
      reconcileTimer = setInterval(
        () => void reconcile(),
        busLive ? SSE_RECONCILE_BUS_MS : SSE_RECONCILE_POLL_MS,
      );
      heartbeatTimer = setInterval(() => {
        if (!closed) {
          res.write(": ping\n\n");
          flush();
        }
      }, SSE_HEARTBEAT_MS);
      lifetimeTimer = setTimeout(() => {
        if (!closed) {
          writeFrame("timeout", {});
          cleanup();
          res.end();
        }
      }, SSE_MAX_LIFETIME_MS);
    }
  } catch (err) {
    if (!res.headersSent) {
      next(err);
    } else {
      try {
        res.end();
      } catch {
        /* already torn down */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /builds/:buildRid/cancel  (cancel an in-flight or queued build)
//
// Authoritative + cross-instance:
//   - Transitions the build to `cancelled` in the DB (guarded on a non-terminal
//     status) — the source of truth, independent of which instance runs the
//     worker. Idempotent: cancelling an already-finished build returns its
//     terminal status without error.
//   - Appends + publishes a `cancelled` event so SSE clients update instantly.
//   - Releases the single-active coalescing lock so a fresh run can start.
//   - Aborts the actual worker: locally (fast path) and via a Redis cancel
//     request so the instance that owns the job stops it.
// ---------------------------------------------------------------------------
export async function cancelBuild(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const buildRid = req.params.buildRid;
    const actorId = actor(req);
    const reason = `cancelled by ${actorId}`;

    // Cancel EVERY job in the Build group (a multi-table Build cancels as a unit).
    const memberRids = await groupMemberRids(buildRid);
    if (memberRids.length === 0) {
      new TellusError(BuildNotFound, { buildRid }).send(res);
      return;
    }

    let cancelledAny = false;
    for (const rid of memberRids) {
      const upd = await pool.query<{ import_rid: string }>(
        `UPDATE orchestration_builds
            SET status = 'cancelled', ended_at = now(),
                reason = COALESCE(reason, $2)
          WHERE rid = $1 AND status IN ('queued', 'running')
          RETURNING import_rid`,
        [rid, reason],
      );
      if (upd.rowCount === 0) continue; // already terminal — leave it
      cancelledAny = true;
      const importRid = upd.rows[0].import_rid;

      // Mirror the cancel onto the sync so the source-detail health pill + the
      // Overview "Build status" reflect it (the dispatcher's terminal event
      // covers in-flight builds; this also covers a queued-build cancel).
      void pool
        .query(
          `UPDATE table_imports SET status = jsonb_build_object('state','cancelled'), updated_at = now() WHERE rid = $1`,
          [importRid],
        )
        .catch(() => undefined);

      // Append + publish the cancelled event (instant SSE). Best-effort.
      try {
        const ev = await pool.query<{ id: string | number; ts: Date | string }>(
          `INSERT INTO orchestration_build_events(build_rid, kind, data)
           VALUES ($1, 'cancelled', $2::jsonb)
           RETURNING id, ts`,
          [rid, JSON.stringify({ reason })],
        );
        const row = ev.rows[0];
        if (row) {
          void publishBuildEvent({
            buildRid: rid,
            id: typeof row.id === "number" ? row.id : Number(row.id),
            kind: "cancelled",
            ts: toIsoStrict(row.ts) ?? new Date().toISOString(),
            data: { reason },
          });
        }
      } catch {
        /* best-effort */
      }

      // Free the coalescing lock so a new run can be started immediately, then
      // abort the worker: local fast path + cross-instance request.
      void release(importRid);
      void cancelLocalBuild(rid);
      void publishCancelRequest(rid);
    }

    // Report the aggregate post-cancel state. `alreadyTerminal` is true only when
    // nothing was in-flight to cancel (the whole Build had already finished).
    const env = await buildEnvelope(buildRid);
    res.json({
      rid: (env?.rid as string) ?? buildRid,
      status: (env?.status as string) ?? "CANCELED",
      rawStatus: (env?.rawStatus as string) ?? "cancelled",
      alreadyTerminal: !cancelledAny,
    });
  } catch (err) {
    next(err);
  }
}
