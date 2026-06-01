// ---------------------------------------------------------------------------
// connectivity_credentials repo (B2).
// All bytes are returned as Uint8Array; the BYTEA round-trip preserves length.
// ---------------------------------------------------------------------------

import { pool } from "../../../db";

export type CredentialField =
  | "password"
  | "client_key"
  | "service_account_json"
  | "token"
  | "other";

export interface CredentialHead {
  id: number;
  connectionRid: string;
  tenant: string;
  field: CredentialField;
  version: number;
  ciphertext: Uint8Array;
  wrappedDek: Uint8Array;
  kmsAdapter: string;
  kmsKeyId: string;
  createdAt: Date;
  createdBy: string;
}

interface Row {
  id: number;
  connection_rid: string;
  tenant: string;
  field: CredentialField;
  version: number;
  ciphertext: Buffer;
  wrapped_dek: Buffer;
  kms_adapter: string;
  kms_key_id: string;
  created_at: Date;
  created_by: string;
}

function rowToHead(r: Row): CredentialHead {
  return {
    id: r.id,
    connectionRid: r.connection_rid,
    tenant: r.tenant,
    field: r.field,
    version: r.version,
    ciphertext: new Uint8Array(r.ciphertext),
    wrappedDek: new Uint8Array(r.wrapped_dek),
    kmsAdapter: r.kms_adapter,
    kmsKeyId: r.kms_key_id,
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

export async function headVersion(
  connectionRid: string,
  tenant: string,
  field: CredentialField,
): Promise<CredentialHead | null> {
  const result = await pool.query<Row>(
    `SELECT * FROM connectivity_credentials
      WHERE connection_rid = $1 AND tenant = $2 AND field = $3
        AND superseded_at IS NULL
      ORDER BY version DESC
      LIMIT 1`,
    [connectionRid, tenant, field],
  );
  return result.rows[0] ? rowToHead(result.rows[0]) : null;
}

export async function insertNewVersion(params: {
  connectionRid: string;
  tenant: string;
  field: CredentialField;
  ciphertext: Uint8Array;
  wrappedDek: Uint8Array;
  kmsAdapter: string;
  kmsKeyId: string;
  createdBy: string;
}): Promise<{ version: number }> {
  // Next version under (rid, field). Concurrent insertions are serialized
  // by the UNIQUE (connection_rid, field, version) constraint; loser
  // retries.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await pool.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next
         FROM connectivity_credentials
        WHERE connection_rid = $1 AND tenant = $2 AND field = $3`,
      [params.connectionRid, params.tenant, params.field],
    );
    const nextVersion = current.rows[0].next;
    try {
      const inserted = await pool.query<{ version: number }>(
        `INSERT INTO connectivity_credentials
           (connection_rid, tenant, version, ciphertext, wrapped_dek,
            kms_adapter, kms_key_id, field, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING version`,
        [
          params.connectionRid,
          params.tenant,
          nextVersion,
          Buffer.from(params.ciphertext),
          Buffer.from(params.wrappedDek),
          params.kmsAdapter,
          params.kmsKeyId,
          params.field,
          params.createdBy,
        ],
      );
      return { version: inserted.rows[0].version };
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === "23505") {
        // Unique violation — race, retry with a fresh next.
        continue;
      }
      throw e;
    }
  }
  throw new Error("connectivity_credentials.insertNewVersion: exhausted retries");
}

export async function supersedeAll(
  connectionRid: string,
  tenant: string,
  field: CredentialField,
): Promise<number> {
  const result = await pool.query(
    `UPDATE connectivity_credentials
        SET superseded_at = now()
      WHERE connection_rid = $1 AND tenant = $2 AND field = $3
        AND superseded_at IS NULL`,
    [connectionRid, tenant, field],
  );
  return result.rowCount ?? 0;
}

export async function listVersions(
  connectionRid: string,
  tenant: string,
  field: CredentialField,
): Promise<Array<{ version: number; createdAt: Date; createdBy: string; superseded: boolean; kmsAdapter: string }>> {
  const result = await pool.query<{
    version: number;
    created_at: Date;
    created_by: string;
    superseded_at: Date | null;
    kms_adapter: string;
  }>(
    `SELECT version, created_at, created_by, superseded_at, kms_adapter
       FROM connectivity_credentials
      WHERE connection_rid = $1 AND tenant = $2 AND field = $3
      ORDER BY version DESC`,
    [connectionRid, tenant, field],
  );
  return result.rows.map((r) => ({
    version: r.version,
    createdAt: r.created_at,
    createdBy: r.created_by,
    superseded: r.superseded_at !== null,
    kmsAdapter: r.kms_adapter,
  }));
}
