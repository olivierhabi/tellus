// ---------------------------------------------------------------------------
// connectivity_egress_policies repository (B1 — named egress policy resource).
//
// A named egress policy is a reusable, approvable allowlist that connections
// may reference by RID. Mutating methods accept a PoolClient so callers can
// compose them in a transaction. OCC mirrors connections.repo: update/delete
// gate on `version = $expected`, and a miss triggers a second SELECT to tell
// 404 (absent) from 409 (version mismatch).
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { pool } from "../../../db";
import {
  EgressPolicyNotFound,
  ResourceVersionMismatch,
} from "../../../lib/errors/connectivity.errors";
import { TellusError } from "../../../lib/errors/envelope";
import type {
  EgressEntry,
  EgressPolicyRid,
  EgressPolicyStatus,
  NamedEgressPolicy,
} from "../contracts";

interface PolicyRow {
  rid: string;
  tenant: string;
  name: string;
  description: string | null;
  status: string;
  allowlist: EgressEntry[];
  version: string; // bigint as string
  created_at: Date | string;
  created_by: string;
  updated_at: Date | string;
  updated_by: string;
  approved_at: Date | string | null;
  approved_by: string | null;
}

function toISO(v: Date | string): string {
  return typeof v === "string" ? v : v.toISOString();
}

function toContract(row: PolicyRow): NamedEgressPolicy {
  return {
    rid: row.rid as EgressPolicyRid,
    tenant: row.tenant,
    name: row.name,
    description: row.description ?? "",
    status: row.status as EgressPolicyStatus,
    allowlist: row.allowlist,
    version: Number(row.version),
    createdAt: toISO(row.created_at),
    createdBy: row.created_by,
    updatedAt: toISO(row.updated_at),
    updatedBy: row.updated_by,
    approvedAt: row.approved_at === null ? null : toISO(row.approved_at),
    approvedBy: row.approved_by,
  };
}

export async function insert(
  client: PoolClient,
  params: {
    rid: string;
    tenant: string;
    name: string;
    description: string;
    allowlist: EgressEntry[];
    actor: string;
  },
): Promise<NamedEgressPolicy> {
  const result = await client.query<PolicyRow>(
    `INSERT INTO connectivity_egress_policies (
       rid, tenant, name, description, status, allowlist,
       version, created_by, updated_by
     )
     VALUES ($1, $2, $3, $4, 'PENDING', $5::jsonb, 1, $6, $6)
     RETURNING *`,
    [
      params.rid,
      params.tenant,
      params.name,
      params.description,
      JSON.stringify(params.allowlist),
      params.actor,
    ],
  );
  return toContract(result.rows[0]);
}

export async function findByRid(
  rid: string,
  tenant: string,
): Promise<NamedEgressPolicy> {
  const result = await pool.query<PolicyRow>(
    `SELECT * FROM connectivity_egress_policies
      WHERE rid = $1 AND tenant = $2 AND deleted_at IS NULL`,
    [rid, tenant],
  );
  if (result.rows.length === 0) {
    throw new TellusError(EgressPolicyNotFound, { rid });
  }
  return toContract(result.rows[0]);
}

/**
 * Cross-tenant resolve for the enforcement path (pool layer has no tenant
 * context). Returns null when absent/deleted so the caller can decide.
 */
export async function resolveForEnforcement(
  rid: string,
): Promise<{ status: EgressPolicyStatus; allowlist: EgressEntry[] } | null> {
  const result = await pool.query<PolicyRow>(
    `SELECT * FROM connectivity_egress_policies
      WHERE rid = $1 AND deleted_at IS NULL`,
    [rid],
  );
  if (result.rows.length === 0) return null;
  const p = toContract(result.rows[0]);
  return { status: p.status, allowlist: p.allowlist };
}

export interface ListFilters {
  tenant: string;
  status?: string;
  pageSize?: number;
  pageToken?: string | null;
}

export async function list(
  filters: ListFilters,
): Promise<{ data: NamedEgressPolicy[]; nextPageToken: string | null }> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 200);
  const cursorAfter = filters.pageToken
    ? new Date(Buffer.from(filters.pageToken, "base64url").toString("utf8"))
    : null;
  const params: unknown[] = [filters.tenant];
  let where = `tenant = $1 AND deleted_at IS NULL`;
  if (filters.status) {
    params.push(filters.status);
    where += ` AND status = $${params.length}`;
  }
  if (cursorAfter) {
    params.push(cursorAfter);
    where += ` AND created_at < $${params.length}`;
  }
  params.push(pageSize + 1);
  const result = await pool.query<PolicyRow>(
    `SELECT * FROM connectivity_egress_policies
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = result.rows.length > pageSize;
  const data = result.rows.slice(0, pageSize).map(toContract);
  const nextPageToken =
    hasMore && data.length > 0
      ? Buffer.from(data[data.length - 1].createdAt).toString("base64url")
      : null;
  return { data, nextPageToken };
}

export async function update(
  client: PoolClient,
  rid: string,
  tenant: string,
  expectedVersion: number,
  patch: {
    name?: string;
    description?: string;
    allowlist?: EgressEntry[];
  },
  actor: string,
): Promise<NamedEgressPolicy> {
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
  if (patch.allowlist !== undefined) {
    values.push(JSON.stringify(patch.allowlist));
    setClauses.push(`allowlist = $${values.length}::jsonb`);
    // Any allowlist change re-opens approval: an edited policy returns to
    // PENDING so a reviewer must re-approve the new destinations.
    setClauses.push(`status = 'PENDING'`);
    setClauses.push(`approved_at = NULL`);
    setClauses.push(`approved_by = NULL`);
  }
  const result = await client.query<PolicyRow>(
    `UPDATE connectivity_egress_policies
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

/** Approve or reject a PENDING policy. Bumps version (ETag changes). */
export async function decide(
  client: PoolClient,
  rid: string,
  tenant: string,
  expectedVersion: number,
  decision: "APPROVED" | "REJECTED",
  actor: string,
): Promise<NamedEgressPolicy> {
  const result = await client.query<PolicyRow>(
    `UPDATE connectivity_egress_policies
        SET status = $5,
            approved_at = CASE WHEN $5 = 'APPROVED' THEN now() ELSE NULL END,
            approved_by = CASE WHEN $5 = 'APPROVED' THEN $4 ELSE NULL END,
            updated_at = now(),
            updated_by = $4,
            version = version + 1
      WHERE rid = $1 AND tenant = $2 AND version = $3 AND deleted_at IS NULL
      RETURNING *`,
    [rid, tenant, expectedVersion, actor, decision],
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
    `UPDATE connectivity_egress_policies
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

/** True when a live connection references this policy (blocks delete). */
export async function isReferenced(rid: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM connectivity_connections
        WHERE egress_policy_rid = $1 AND deleted_at IS NULL
     )::boolean AS exists`,
    [rid],
  );
  return result.rows[0]?.exists ?? false;
}

async function throwOccMiss(
  rid: string,
  tenant: string,
  expectedVersion: number,
): Promise<never> {
  const exists = await pool.query<{ version: string }>(
    `SELECT version FROM connectivity_egress_policies
      WHERE rid = $1 AND tenant = $2 AND deleted_at IS NULL`,
    [rid, tenant],
  );
  if (exists.rows.length === 0) {
    throw new TellusError(EgressPolicyNotFound, { rid });
  }
  throw new TellusError(ResourceVersionMismatch, {
    provided: expectedVersion,
    current: Number(exists.rows[0].version),
  });
}
