// ---------------------------------------------------------------------------
// connectivity_connections repository.
//
// All mutating methods accept a PoolClient so the caller can compose them in
// the same transaction as the outbox enqueue (Compass two-phase commit).
//
// OCC: update/softDelete use `WHERE rid=$ AND version=$expected`. A miss
// triggers a second SELECT to distinguish 404 (row absent) from 409
// (version mismatch). The second SELECT is one round-trip overhead per
// failed mutation, which is acceptable; the common-case happy path is one
// query.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { pool } from "../../../db";
import {
  ConnectionNotFound,
  ResourceVersionMismatch,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import { DEFAULT_CONNECTION_SETTINGS } from "../contracts";
import type {
  CompassFolderRid,
  Connection,
  ConnectionCreateRequest,
  ConnectionRid,
} from "../contracts";

interface ConnectionRow {
  rid: string;
  tenant: string;
  name: string;
  description: string | null;
  connector_type: string;
  worker_type: string;
  agent_group_rid: string | null;
  config: Connection["config"];
  egress_policy: Connection["egressPolicy"];
  compass_folder_rid: string;
  status: Connection["status"];
  settings: Connection["settings"] | null;
  version: string; // pg returns bigint as string
  created_at: Date | string; // TIMESTAMPTZ — string when setTypeParser(1184) is active
  created_by: string;
  updated_at: Date | string;
  updated_by: string;
  deleted_at: Date | string | null;
  deleted_by: string | null;
}

function toContract(row: ConnectionRow): Connection {
  // pg TIMESTAMPTZ columns return ISO strings (the main pool overrides
  // types.setTypeParser(1184) in src/db.ts). Coerce defensively so both
  // Date objects and raw strings work — the connectivity pool may be
  // configured differently.
  const toISO = (v: Date | string): string =>
    typeof v === "string" ? v : v.toISOString();
  return {
    rid: row.rid as ConnectionRid,
    tenant: row.tenant,
    name: row.name,
    description: row.description ?? "",
    connectorType: row.connector_type as Connection["connectorType"],
    workerType: row.worker_type as Connection["workerType"],
    agentGroupRid: (row.agent_group_rid ?? undefined) as Connection["agentGroupRid"],
    config: row.config,
    egressPolicy: row.egress_policy,
    compassFolderRid: row.compass_folder_rid as CompassFolderRid,
    status: row.status,
    settings: row.settings ?? DEFAULT_CONNECTION_SETTINGS,
    version: Number(row.version),
    createdAt: toISO(row.created_at),
    createdBy: row.created_by,
    updatedAt: toISO(row.updated_at),
    updatedBy: row.updated_by,
  };
}

export async function insert(
  client: PoolClient,
  params: {
    rid: string;
    tenant: string;
    request: ConnectionCreateRequest;
    actor: string;
  },
): Promise<Connection> {
  const result = await client.query<ConnectionRow>(
    `INSERT INTO connectivity_connections (
       rid, tenant, name, description, connector_type, worker_type,
       agent_group_rid, config, egress_policy, compass_folder_rid,
       status, version, created_by, updated_by, settings
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8::jsonb, $9::jsonb, $10,
       '{"state":"UNKNOWN","lastCheckedAt":null,"details":{}}'::jsonb,
       1, $11, $11, $12::jsonb
     )
     RETURNING *`,
    [
      params.rid,
      params.tenant,
      params.request.name,
      params.request.description ?? "",
      params.request.connectorType,
      params.request.workerType,
      params.request.agentGroupRid ?? null,
      JSON.stringify(params.request.config),
      JSON.stringify(params.request.egressPolicy),
      params.request.compassFolderRid,
      params.actor,
      JSON.stringify(params.request.settings ?? DEFAULT_CONNECTION_SETTINGS),
    ],
  );
  return toContract(result.rows[0]);
}

export async function findByRid(
  rid: string,
  tenant: string,
): Promise<Connection> {
  const result = await pool.query<ConnectionRow>(
    `SELECT * FROM connectivity_connections
      WHERE rid = $1 AND tenant = $2 AND deleted_at IS NULL`,
    [rid, tenant],
  );
  if (result.rows.length === 0) {
    throw new TellusError(ConnectionNotFound, { rid });
  }
  return toContract(result.rows[0]);
}

export interface ListFilters {
  tenant: string;
  folderRid?: string;
  connectorType?: string;
  pageSize?: number;
  pageToken?: string | null;
}

export async function list(
  filters: ListFilters,
): Promise<{ data: Connection[]; nextPageToken: string | null }> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 200);
  const cursorAfter = filters.pageToken
    ? new Date(Buffer.from(filters.pageToken, "base64url").toString("utf8"))
    : null;

  const params: unknown[] = [filters.tenant];
  let where = `tenant = $1 AND deleted_at IS NULL`;
  if (filters.folderRid) {
    params.push(filters.folderRid);
    where += ` AND compass_folder_rid = $${params.length}`;
  }
  if (filters.connectorType) {
    params.push(filters.connectorType);
    where += ` AND connector_type = $${params.length}`;
  }
  if (cursorAfter) {
    params.push(cursorAfter);
    where += ` AND created_at < $${params.length}`;
  }
  params.push(pageSize + 1);
  const sql = `SELECT * FROM connectivity_connections
                WHERE ${where}
                ORDER BY created_at DESC
                LIMIT $${params.length}`;
  const result = await pool.query<ConnectionRow>(sql, params);
  const hasMore = result.rows.length > pageSize;
  const data = result.rows.slice(0, pageSize).map(toContract);
  const nextPageToken =
    hasMore && data.length > 0
      ? Buffer.from(data[data.length - 1].createdAt).toString("base64url")
      : null;
  return { data, nextPageToken };
}

export interface ProbeTarget {
  rid: string;
  tenant: string;
  connectorType: string;
}

/**
 * Connections eligible for a background health probe: non-deleted, and either
 * never checked or last checked longer ago than `staleMs`. Ordered
 * least-recently-checked first (NULLs first) so a bounded batch makes steady
 * progress across the whole population. Cross-tenant by design — the prober
 * runs as a system task with no per-request tenant context.
 */
export async function listProbeTargets(
  staleMs: number,
  limit: number,
): Promise<ProbeTarget[]> {
  const result = await pool.query<{
    rid: string;
    tenant: string;
    connector_type: string;
  }>(
    `SELECT rid, tenant, connector_type
       FROM connectivity_connections
      WHERE deleted_at IS NULL
        AND (
          status->>'lastCheckedAt' IS NULL
          OR (status->>'lastCheckedAt')::timestamptz
               < now() - ($1::int || ' milliseconds')::interval
        )
      ORDER BY (status->>'lastCheckedAt') ASC NULLS FIRST
      LIMIT $2`,
    [staleMs, limit],
  );
  return result.rows.map((r) => ({
    rid: r.rid,
    tenant: r.tenant,
    connectorType: r.connector_type,
  }));
}

export async function update(
  client: PoolClient,
  rid: string,
  tenant: string,
  expectedVersion: number,
  patch: {
    name?: string;
    description?: string;
    config?: unknown;
    egressPolicy?: unknown;
    agentGroupRid?: string | null;
    settings?: unknown;
  },
  actor: string,
): Promise<Connection> {
  const setClauses: string[] = [
    "updated_at = now()",
    "updated_by = $4",
    "version = version + 1",
  ];
  const values: unknown[] = [rid, tenant, expectedVersion, actor];
  if (patch.name !== undefined) {
    values.push(patch.name);
    setClauses.push(`name = $${values.length}`);
  }
  if (patch.description !== undefined) {
    values.push(patch.description);
    setClauses.push(`description = $${values.length}`);
  }
  if (patch.config !== undefined) {
    values.push(JSON.stringify(patch.config));
    setClauses.push(`config = $${values.length}::jsonb`);
  }
  if (patch.egressPolicy !== undefined) {
    values.push(JSON.stringify(patch.egressPolicy));
    setClauses.push(`egress_policy = $${values.length}::jsonb`);
  }
  if (patch.agentGroupRid !== undefined) {
    values.push(patch.agentGroupRid);
    setClauses.push(`agent_group_rid = $${values.length}`);
  }
  if (patch.settings !== undefined) {
    values.push(JSON.stringify(patch.settings));
    setClauses.push(`settings = $${values.length}::jsonb`);
  }
  const result = await client.query<ConnectionRow>(
    `UPDATE connectivity_connections
        SET ${setClauses.join(", ")}
      WHERE rid = $1 AND tenant = $2 AND version = $3 AND deleted_at IS NULL
      RETURNING *`,
    values,
  );
  if (result.rows.length === 0) {
    await throwOccMiss(rid, tenant, expectedVersion);
  }
  return toContract(result.rows[0]);
}

export async function softDelete(
  client: PoolClient,
  rid: string,
  tenant: string,
  expectedVersion: number,
  actor: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE connectivity_connections
        SET deleted_at = now(),
            deleted_by = $4,
            updated_at = now(),
            updated_by = $4,
            version = version + 1
      WHERE rid = $1 AND tenant = $2 AND version = $3 AND deleted_at IS NULL`,
    [rid, tenant, expectedVersion, actor],
  );
  if (result.rowCount === 0) {
    await throwOccMiss(rid, tenant, expectedVersion);
  }
}

async function throwOccMiss(
  rid: string,
  tenant: string,
  expectedVersion: number,
): Promise<never> {
  const exists = await pool.query<{ version: string }>(
    `SELECT version FROM connectivity_connections
      WHERE rid = $1 AND tenant = $2 AND deleted_at IS NULL`,
    [rid, tenant],
  );
  if (exists.rows.length === 0) {
    throw new TellusError(ConnectionNotFound, { rid });
  }
  throw new TellusError(ResourceVersionMismatch, {
    provided: expectedVersion,
    current: Number(exists.rows[0].version),
  });
}

/**
 * Tolerates absence of downstream tables (B5 table_imports, B8 virtual_tables)
 * via to_regclass guard. Returns false until those migrations exist.
 */
export async function hasActiveDependencies(rid: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT (
       (to_regclass('public.connectivity_table_imports') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM connectivity_table_imports
          WHERE connection_rid = $1
        ))
       OR
       (to_regclass('public.connectivity_virtual_tables') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM connectivity_virtual_tables
          WHERE connection_rid = $1
        ))
     )::boolean AS exists`,
    [rid],
  );
  return result.rows[0]?.exists ?? false;
}

export async function findByNameInFolder(
  tenant: string,
  folderRid: string,
  name: string,
): Promise<Connection | null> {
  const result = await pool.query<ConnectionRow>(
    `SELECT * FROM connectivity_connections
      WHERE tenant = $1 AND compass_folder_rid = $2
        AND name = $3 AND deleted_at IS NULL`,
    [tenant, folderRid, name],
  );
  return result.rows[0] ? toContract(result.rows[0]) : null;
}

/** Append a status-log row for the /status endpoint history. */
export async function appendStatusLog(
  rid: string,
  state: string,
  details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO connectivity_connection_status_log
       (connection_rid, state, details)
     VALUES ($1, $2, $3::jsonb)`,
    [rid, state, JSON.stringify(details)],
  );
  await pool.query(
    `UPDATE connectivity_connections
        SET status = jsonb_build_object(
              'state', $2::text,
              'lastCheckedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'details', $3::jsonb
            )
      WHERE rid = $1 AND deleted_at IS NULL`,
    [rid, state, JSON.stringify(details)],
  );
}
