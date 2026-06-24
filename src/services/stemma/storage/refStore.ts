// ---------------------------------------------------------------------------
// B1 — Stemma refStore: ref CAS + atomic multi-ref transactions.
//
// Spec contracts:
//   B1-C-12  listRefs GET /repositories/{rid}/refs
//   B1-C-13  getRef GET /repositories/{rid}/refs/{name}
//   B1-C-21  Ref CAS via (repository_rid, name, expected_old_sha)
//   B1-C-22  Multiple refs in single push commit atomically (SERIALIZABLE)
//   B1-C-27  Stemma:RefNotFound (404)
//   B1-C-28  Stemma:RefUpdateRejected (409) on CAS mismatch — newTip carries current
//   B1-C-47  HEAD is symbolic on empty repo
//
// All public functions return discriminated unions instead of throwing for
// expected non-error outcomes (CAS miss, ref-not-found). Caller maps to the
// HTTP error envelope.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";

const SHA_REGEX = /^[0-9a-f]{40}$/;

export interface RefRow {
  readonly name: string;
  readonly targetSha: string;
  readonly peeledSha: string | null;
  readonly isSymbolic: boolean;
  readonly symbolicTarget: string | null;
  readonly resourceVersion: number;
  readonly updatedAt: string;
}

export type RefUpdate =
  | { readonly kind: "create"; readonly name: string; readonly newSha: string }
  | { readonly kind: "update"; readonly name: string; readonly oldSha: string; readonly newSha: string }
  | { readonly kind: "delete"; readonly name: string; readonly oldSha: string };

export type RefUpdateOutcome =
  | { readonly kind: "ok"; readonly newRefs: readonly RefRow[] }
  | { readonly kind: "rejected"; readonly rejection: RefUpdateRejection };

export interface RefUpdateRejection {
  readonly name: string;
  /** What the current row holds NOW (regardless of what we tried). */
  readonly currentTip: string | null;
  readonly reason: "stale-old-sha" | "ref-already-exists" | "ref-not-found";
}

/** B1-C-12 list. */
export async function listRefs(pool: Pool, repositoryRid: string): Promise<readonly RefRow[]> {
  const r = await pool.query<RefDbRow>(
    `SELECT name, target_sha, peeled_sha, is_symbolic, symbolic_target,
            resource_version, updated_at::text
       FROM stemma_ref
      WHERE repository_rid = $1
      ORDER BY name ASC`,
    [repositoryRid]
  );
  return r.rows.map(toRefRow);
}

/** B1-C-13 get one. Returns null on not-found. */
export async function getRef(
  pool: Pool,
  repositoryRid: string,
  name: string
): Promise<RefRow | null> {
  const r = await pool.query<RefDbRow>(
    `SELECT name, target_sha, peeled_sha, is_symbolic, symbolic_target,
            resource_version, updated_at::text
       FROM stemma_ref
      WHERE repository_rid = $1 AND name = $2`,
    [repositoryRid, name]
  );
  const row = r.rows[0];
  return row ? toRefRow(row) : null;
}

/**
 * B1-C-22: apply N ref updates atomically inside a SERIALIZABLE transaction.
 * On any rejection, the whole transaction rolls back and the rejection is
 * returned (never thrown). The caller maps a rejection → 409 RefUpdateRejected
 * with `parameters.newTip = rejection.currentTip` (B1-C-28).
 *
 * Each update is one of:
 *   - create: name MUST NOT exist; insert with newSha.
 *   - update: WHERE target_sha = oldSha (CAS); fail if no row updated.
 *   - delete: WHERE target_sha = oldSha (CAS); fail if no row deleted.
 */
export async function applyRefUpdates(
  pool: Pool,
  repositoryRid: string,
  updates: readonly RefUpdate[]
): Promise<RefUpdateOutcome> {
  if (updates.length === 0) {
    return { kind: "ok", newRefs: [] };
  }
  // Validate all newSha values are 40-char hex (or zero-sha for delete).
  for (const u of updates) {
    if (u.kind !== "delete") {
      if (!SHA_REGEX.test(u.newSha)) {
        throw new Error(`Invalid newSha for ${u.name}: ${u.newSha}`);
      }
    }
    if (u.kind !== "create") {
      if (!SHA_REGEX.test(u.oldSha)) {
        throw new Error(`Invalid oldSha for ${u.name}: ${u.oldSha}`);
      }
    }
  }

  const client = await pool.connect();
  // Track the in-flight update so a SERIALIZABLE conflict (Postgres SQLSTATE
  // 40001) can be translated into a "stale-old-sha" rejection that names
  // the conflicting ref. Without this, callers race-losing under SERIALIZABLE
  // would surface a raw Postgres error instead of the contracted rejection
  // envelope (B1-C-28). See tests/integration/code-repos/stemma/admin-routes
  // "ref CAS via applyRefUpdates".
  let inflight: RefUpdate | null = null;
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

    const updatedNames: string[] = [];
    let rejection: RefUpdateRejection | null = null;

    for (const u of updates) {
      inflight = u;
      if (u.kind === "create") {
        const r = await client.query(
          `INSERT INTO stemma_ref(repository_rid, name, target_sha)
                 VALUES ($1, $2, $3)
            ON CONFLICT (repository_rid, name) DO NOTHING`,
          [repositoryRid, u.name, u.newSha]
        );
        if (r.rowCount === 0) {
          // Already exists.
          const cur = await client.query<{ target_sha: string }>(
            `SELECT target_sha FROM stemma_ref
              WHERE repository_rid = $1 AND name = $2`,
            [repositoryRid, u.name]
          );
          rejection = {
            name: u.name,
            currentTip: cur.rows[0]?.target_sha ?? null,
            reason: "ref-already-exists",
          };
          break;
        }
        updatedNames.push(u.name);
      } else if (u.kind === "update") {
        const r = await client.query(
          `UPDATE stemma_ref
              SET target_sha = $1,
                  resource_version = resource_version + 1,
                  updated_at = now()
            WHERE repository_rid = $2 AND name = $3 AND target_sha = $4`,
          [u.newSha, repositoryRid, u.name, u.oldSha]
        );
        if (r.rowCount === 0) {
          // Either ref doesn't exist OR oldSha doesn't match (stale).
          const cur = await client.query<{ target_sha: string }>(
            `SELECT target_sha FROM stemma_ref
              WHERE repository_rid = $1 AND name = $2`,
            [repositoryRid, u.name]
          );
          rejection = {
            name: u.name,
            currentTip: cur.rows[0]?.target_sha ?? null,
            reason: cur.rows[0] ? "stale-old-sha" : "ref-not-found",
          };
          break;
        }
        updatedNames.push(u.name);
      } else {
        // delete
        const r = await client.query(
          `DELETE FROM stemma_ref
            WHERE repository_rid = $1 AND name = $2 AND target_sha = $3`,
          [repositoryRid, u.name, u.oldSha]
        );
        if (r.rowCount === 0) {
          const cur = await client.query<{ target_sha: string }>(
            `SELECT target_sha FROM stemma_ref
              WHERE repository_rid = $1 AND name = $2`,
            [repositoryRid, u.name]
          );
          rejection = {
            name: u.name,
            currentTip: cur.rows[0]?.target_sha ?? null,
            reason: cur.rows[0] ? "stale-old-sha" : "ref-not-found",
          };
          break;
        }
        updatedNames.push(u.name);
      }
    }

    if (rejection) {
      await client.query("ROLLBACK");
      return { kind: "rejected", rejection };
    }

    // Commit; then read back the final state of the just-touched non-deleted refs.
    await client.query("COMMIT");
    if (updatedNames.length === 0) {
      return { kind: "ok", newRefs: [] };
    }
    const r = await client.query<RefDbRow>(
      `SELECT name, target_sha, peeled_sha, is_symbolic, symbolic_target,
              resource_version, updated_at::text
         FROM stemma_ref
        WHERE repository_rid = $1 AND name = ANY($2::text[])`,
      [repositoryRid, updatedNames]
    );
    return { kind: "ok", newRefs: r.rows.map(toRefRow) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow */
    }
    // Translate Postgres serialization failure (40001) into the contracted
    // rejection envelope. Under SERIALIZABLE, two concurrent CAS attempts
    // on the same ref will surface 40001 on the loser; semantically this
    // is identical to a stale-old-sha CAS miss and B1-C-28 requires the
    // rejection carry the new tip. We re-read the tip on a fresh
    // connection (the original is in an aborted-tx state) so the response
    // can populate currentTip.
    const code = (err as { code?: string } | null)?.code;
    if (code === "40001" && inflight && inflight.kind !== "create") {
      const fresh = await pool.connect();
      try {
        const cur = await fresh.query<{ target_sha: string }>(
          `SELECT target_sha FROM stemma_ref WHERE repository_rid = $1 AND name = $2`,
          [repositoryRid, inflight.name],
        );
        return {
          kind: "rejected",
          rejection: {
            name: inflight.name,
            currentTip: cur.rows[0]?.target_sha ?? null,
            reason: cur.rows[0] ? "stale-old-sha" : "ref-not-found",
          },
        };
      } finally {
        fresh.release();
      }
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface RefDbRow {
  name: string;
  target_sha: string;
  peeled_sha: string | null;
  is_symbolic: boolean;
  symbolic_target: string | null;
  resource_version: number;
  updated_at: string;
}

function toRefRow(r: RefDbRow): RefRow {
  return {
    name: r.name,
    targetSha: r.target_sha,
    peeledSha: r.peeled_sha,
    isSymbolic: r.is_symbolic,
    symbolicTarget: r.symbolic_target,
    resourceVersion: Number(r.resource_version),
    updatedAt: r.updated_at,
  };
}
