// ---------------------------------------------------------------------------
// B2 — saga ledger store. Persists SagaContext + state in
// `code_repository_saga_ledger` (DDL: migration 053).
//
// Spec contracts proven:
//   B2-C-15  UNIQUE (idempotency_key, principal_sub) — enforces replay
//   B2-C-25  state advances are SERIALIZABLE within a single tx
//   G-C-22   POST replay: same (idem, sub) returns the existing saga row
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";
import type { SagaContext, SagaState } from "./types";

export interface SagaLedgerRow extends SagaContext {
  readonly state: SagaState;
  readonly lastErrorName: string | null;
  readonly lastErrorEnvelope: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Insert a new saga ledger row at INIT. Returns null on idempotent conflict. */
export async function insertNewSagaWithinTx(
  client: PoolClient,
  args: {
    sagaId: string;
    idempotencyKey: string;
    principalSub: string;
    displayName: string;
    parentFolderRid: string;
    templateId: string;
    templateVersion: string;
    defaultBranch: string;
  },
): Promise<{ inserted: boolean; row: SagaLedgerRow }> {
  // Idempotent insert: if (idempotency_key, principal_sub) already exists,
  // return the existing row.
  const ins = await client.query<SagaLedgerDbRow>(
    `INSERT INTO code_repository_saga_ledger (
       saga_id, idempotency_key, principal_sub,
       display_name, parent_folder_rid, template_id, template_version,
       default_branch, state
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'INIT')
     ON CONFLICT (idempotency_key, principal_sub) DO NOTHING
     RETURNING *`,
    [
      args.sagaId,
      args.idempotencyKey,
      args.principalSub,
      args.displayName,
      args.parentFolderRid,
      args.templateId,
      args.templateVersion,
      args.defaultBranch,
    ],
  );

  if (ins.rowCount === 1) {
    return { inserted: true, row: rowFromDb(ins.rows[0]) };
  }

  // Conflict — fetch existing.
  const ex = await client.query<SagaLedgerDbRow>(
    `SELECT * FROM code_repository_saga_ledger
       WHERE idempotency_key = $1 AND principal_sub = $2`,
    [args.idempotencyKey, args.principalSub],
  );
  if (ex.rowCount === 0) {
    throw new Error("ledger insert conflicted but no existing row found");
  }
  return { inserted: false, row: rowFromDb(ex.rows[0]) };
}

/** Load saga by saga_id (primary lookup during executor stepping). */
export async function loadSagaById(
  pool: Pool,
  sagaId: string,
): Promise<SagaLedgerRow | null> {
  const r = await pool.query<SagaLedgerDbRow>(
    `SELECT * FROM code_repository_saga_ledger WHERE saga_id = $1`,
    [sagaId],
  );
  return r.rowCount === 1 ? rowFromDb(r.rows[0]) : null;
}

export async function loadSagaByIdWithinTx(
  client: PoolClient,
  sagaId: string,
): Promise<SagaLedgerRow | null> {
  const r = await client.query<SagaLedgerDbRow>(
    `SELECT * FROM code_repository_saga_ledger WHERE saga_id = $1 FOR UPDATE`,
    [sagaId],
  );
  return r.rowCount === 1 ? rowFromDb(r.rows[0]) : null;
}

/** Update saga row — state + optional context fields. */
export async function updateSagaWithinTx(
  client: PoolClient,
  sagaId: string,
  patch: {
    state?: SagaState;
    compassResourceRid?: string | null;
    stemmaRepositoryRid?: string | null;
    initialCommitSha?: string | null;
    lastErrorName?: string | null;
    lastErrorEnvelope?: Record<string, unknown> | null;
  },
): Promise<SagaLedgerRow> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.state !== undefined) {
    sets.push(`state = $${i++}`);
    values.push(patch.state);
  }
  if (patch.compassResourceRid !== undefined) {
    sets.push(`compass_resource_rid = $${i++}`);
    values.push(patch.compassResourceRid);
  }
  if (patch.stemmaRepositoryRid !== undefined) {
    sets.push(`stemma_repository_rid = $${i++}`);
    values.push(patch.stemmaRepositoryRid);
  }
  if (patch.initialCommitSha !== undefined) {
    sets.push(`initial_commit_sha = $${i++}`);
    values.push(patch.initialCommitSha);
  }
  if (patch.lastErrorName !== undefined) {
    sets.push(`last_error_name = $${i++}`);
    values.push(patch.lastErrorName);
  }
  if (patch.lastErrorEnvelope !== undefined) {
    sets.push(`last_error_envelope = $${i++}::jsonb`);
    values.push(
      patch.lastErrorEnvelope === null
        ? null
        : JSON.stringify(patch.lastErrorEnvelope),
    );
  }
  sets.push(`updated_at = now()`);
  values.push(sagaId);

  const sql = `UPDATE code_repository_saga_ledger
                  SET ${sets.join(", ")}
                WHERE saga_id = $${i}
                RETURNING *`;
  const r = await client.query<SagaLedgerDbRow>(sql, values);
  if (r.rowCount === 0) {
    throw new Error(`saga ${sagaId} not found`);
  }
  return rowFromDb(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Internal — DB row → domain row mapping.
// ---------------------------------------------------------------------------

interface SagaLedgerDbRow {
  saga_id: string;
  idempotency_key: string;
  principal_sub: string;
  display_name: string;
  parent_folder_rid: string;
  template_id: string;
  template_version: string;
  default_branch: string;
  state: SagaState;
  compass_resource_rid: string | null;
  stemma_repository_rid: string | null;
  initial_commit_sha: string | null;
  last_error_name: string | null;
  last_error_envelope: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function rowFromDb(r: SagaLedgerDbRow): SagaLedgerRow {
  return {
    sagaId: r.saga_id,
    idempotencyKey: r.idempotency_key,
    principalSub: r.principal_sub,
    displayName: r.display_name,
    parentFolderRid: r.parent_folder_rid,
    templateId: r.template_id,
    templateVersion: r.template_version,
    defaultBranch: r.default_branch,
    compassResourceRid: r.compass_resource_rid,
    stemmaRepositoryRid: r.stemma_repository_rid,
    initialCommitSha: r.initial_commit_sha,
    state: r.state,
    lastErrorName: r.last_error_name,
    lastErrorEnvelope: r.last_error_envelope,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
