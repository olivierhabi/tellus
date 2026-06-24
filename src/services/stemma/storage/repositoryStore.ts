// ---------------------------------------------------------------------------
// B1 — Stemma repositoryStore: typed CRUD over stemma_repository + HEAD ref.
//
// Spec contracts:
//   B1-C-09  createRepository POST /repositories
//   B1-C-10  deleteRepository = tombstone
//   B1-C-20  state ∈ {ACTIVE, TOMBSTONED, PURGED}
//   B1-C-46  soft-deleted repos return 404 to non-admin
//   B1-C-47  empty repo created with HEAD → refs/heads/main (symbolic), 0 commits
//   G-C-19   resource_version monotonically increasing per row
//
// Storage uses any pg-compatible Pool (caller injects). Schema-isolation is
// the caller's job (search_path or qualified table names).
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";
import { assertRepositoryRid } from "../../codeRepos/contracts/rid";
import { validateBranchName } from "../../codeRepos/contracts/regex";

/** Standard Git "zero" SHA — used as target_sha for the symbolic HEAD on an empty repo. */
export const ZERO_SHA_40 = "0000000000000000000000000000000000000000";

export type RepositoryState = "ACTIVE" | "TOMBSTONED" | "PURGED";

export interface RepositoryRow {
  readonly rid: string;
  readonly defaultBranch: string;
  readonly state: RepositoryState;
  readonly createdAt: string;
  readonly resourceVersion: number;
}

export interface CreateRepositoryArgs {
  readonly rid: string;
  readonly defaultBranchName: string;
}

export interface CreateRepositoryResult {
  readonly created: boolean;            // true on first insert; false on duplicate (RID already exists)
  readonly repository: RepositoryRow;
  readonly headRefName: string;         // always "HEAD"
}

/** Caller-injectable pg client. */
export interface PgRunner {
  query: Pool["query"];
}

/**
 * B1-C-09 + B1-C-47: create a new active repository AND its symbolic HEAD ref
 * atomically. If a row with the same RID already exists in ACTIVE state with
 * the same defaultBranchName, returns `{created: false}` and the existing row
 * — this makes `createRepository` idempotent for retries.
 *
 * Throws Error on validation failure (caller maps to envelope).
 */
export async function createRepository(
  pool: Pool,
  args: CreateRepositoryArgs
): Promise<CreateRepositoryResult> {
  // Validate inputs (G-C-29 + G-C-01).
  assertRepositoryRid(args.rid);
  const branchOk = validateBranchName(args.defaultBranchName);
  if (!branchOk.ok) {
    throw new Error(`Invalid defaultBranchName: ${branchOk.reason}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    // Try to insert; on duplicate primary key, fetch the existing row.
    const insertRes = await client.query<{
      rid: string;
      default_branch: string;
      state: RepositoryState;
      created_at: string;
      resource_version: number;
    }>(
      `INSERT INTO stemma_repository(rid, default_branch, state)
            VALUES ($1, $2, 'ACTIVE')
       ON CONFLICT (rid) DO NOTHING
       RETURNING rid, default_branch, state, created_at::text, resource_version`,
      [args.rid, args.defaultBranchName]
    );

    let row: RepositoryRow;
    let created: boolean;

    if (insertRes.rowCount === 1) {
      created = true;
      const r = insertRes.rows[0];
      row = {
        rid: r.rid,
        defaultBranch: r.default_branch,
        state: r.state,
        createdAt: r.created_at,
        resourceVersion: Number(r.resource_version),
      };

      // Insert the symbolic HEAD ref pointing at refs/heads/<defaultBranch>.
      await client.query(
        `INSERT INTO stemma_ref
            (repository_rid, name, target_sha, is_symbolic, symbolic_target)
          VALUES ($1, 'HEAD', $2, TRUE, $3)`,
        [args.rid, ZERO_SHA_40, `refs/heads/${args.defaultBranchName}`]
      );
    } else {
      created = false;
      const existing = await client.query<{
        rid: string;
        default_branch: string;
        state: RepositoryState;
        created_at: string;
        resource_version: number;
      }>(
        `SELECT rid, default_branch, state, created_at::text, resource_version
           FROM stemma_repository WHERE rid = $1`,
        [args.rid]
      );
      const r = existing.rows[0];
      row = {
        rid: r.rid,
        defaultBranch: r.default_branch,
        state: r.state,
        createdAt: r.created_at,
        resourceVersion: Number(r.resource_version),
      };
    }
    await client.query("COMMIT");
    return { created, repository: row, headRefName: "HEAD" };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow — we're surfacing original */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Fetch a repository by RID. Returns null if not found OR if the repository
 * is TOMBSTONED/PURGED (per B1-C-46 the non-admin surface treats tombstoned
 * as not-found). Pass `includeTombstoned: true` for admin queries.
 */
export async function getRepository(
  runner: PgRunner,
  rid: string,
  options: { includeTombstoned?: boolean } = {}
): Promise<RepositoryRow | null> {
  assertRepositoryRid(rid);
  const r = await runner.query<{
    rid: string;
    default_branch: string;
    state: RepositoryState;
    created_at: string;
    resource_version: number;
  }>(
    `SELECT rid, default_branch, state, created_at::text, resource_version
       FROM stemma_repository WHERE rid = $1`,
    [rid]
  );
  const row = r.rows[0];
  if (!row) return null;
  if (!options.includeTombstoned && row.state !== "ACTIVE") return null;
  return {
    rid: row.rid,
    defaultBranch: row.default_branch,
    state: row.state,
    createdAt: row.created_at,
    resourceVersion: Number(row.resource_version),
  };
}

/**
 * B1-C-10: tombstone (soft-delete) a repository. Idempotent — calling on an
 * already-tombstoned repo is a no-op that returns the current row. Returns
 * null if the repository does not exist.
 */
export async function tombstoneRepository(
  pool: Pool,
  rid: string
): Promise<RepositoryRow | null> {
  assertRepositoryRid(rid);
  const r = await pool.query<{
    rid: string;
    default_branch: string;
    state: RepositoryState;
    created_at: string;
    resource_version: number;
  }>(
    `UPDATE stemma_repository
        SET state = 'TOMBSTONED',
            resource_version = resource_version + 1
      WHERE rid = $1 AND state = 'ACTIVE'
      RETURNING rid, default_branch, state, created_at::text, resource_version`,
    [rid]
  );
  if (r.rowCount === 1) {
    const row = r.rows[0];
    return {
      rid: row.rid,
      defaultBranch: row.default_branch,
      state: row.state,
      createdAt: row.created_at,
      resourceVersion: Number(row.resource_version),
    };
  }
  // Either it was already TOMBSTONED/PURGED, or missing.
  return getRepository(pool, rid, { includeTombstoned: true });
}

// ---------------------------------------------------------------------------
// Tx-aware variants — let the caller wrap the data edit + audit insert in a
// single SERIALIZABLE transaction, satisfying §1.10 durable-before-ack.
//
// The non-tx-aware variants above remain for callers that don't yet wire
// audit; new callers should prefer the *WithinTx forms.
// ---------------------------------------------------------------------------

/**
 * Same as createRepository but runs inside the caller's open transaction.
 * The caller is responsible for BEGIN / COMMIT / ROLLBACK; this function
 * never starts or ends a tx of its own. Use this when you need to emit
 * an audit row in the same transaction as the data edit.
 */
export async function createRepositoryWithinTx(
  client: PoolClient,
  args: CreateRepositoryArgs,
): Promise<CreateRepositoryResult> {
  assertRepositoryRid(args.rid);
  const branchOk = validateBranchName(args.defaultBranchName);
  if (!branchOk.ok) {
    throw new Error(`Invalid defaultBranchName: ${branchOk.reason}`);
  }
  const insertRes = await client.query<{
    rid: string;
    default_branch: string;
    state: RepositoryState;
    created_at: string;
    resource_version: number;
  }>(
    `INSERT INTO stemma_repository(rid, default_branch, state)
          VALUES ($1, $2, 'ACTIVE')
     ON CONFLICT (rid) DO NOTHING
     RETURNING rid, default_branch, state, created_at::text, resource_version`,
    [args.rid, args.defaultBranchName],
  );

  if (insertRes.rowCount === 1) {
    const r = insertRes.rows[0];
    await client.query(
      `INSERT INTO stemma_ref
          (repository_rid, name, target_sha, is_symbolic, symbolic_target)
        VALUES ($1, 'HEAD', $2, TRUE, $3)`,
      [args.rid, ZERO_SHA_40, `refs/heads/${args.defaultBranchName}`],
    );
    return {
      created: true,
      repository: {
        rid: r.rid,
        defaultBranch: r.default_branch,
        state: r.state,
        createdAt: r.created_at,
        resourceVersion: Number(r.resource_version),
      },
      headRefName: "HEAD",
    };
  }
  const existing = await client.query<{
    rid: string;
    default_branch: string;
    state: RepositoryState;
    created_at: string;
    resource_version: number;
  }>(
    `SELECT rid, default_branch, state, created_at::text, resource_version
       FROM stemma_repository WHERE rid = $1`,
    [args.rid],
  );
  const r = existing.rows[0];
  return {
    created: false,
    repository: {
      rid: r.rid,
      defaultBranch: r.default_branch,
      state: r.state,
      createdAt: r.created_at,
      resourceVersion: Number(r.resource_version),
    },
    headRefName: "HEAD",
  };
}

/**
 * Same as tombstoneRepository but runs inside the caller's open
 * transaction. Returns null if repo doesn't exist; returns the row in
 * its current state otherwise (idempotent on already-tombstoned).
 */
export async function tombstoneRepositoryWithinTx(
  client: PoolClient,
  rid: string,
): Promise<RepositoryRow | null> {
  assertRepositoryRid(rid);
  const r = await client.query<{
    rid: string;
    default_branch: string;
    state: RepositoryState;
    created_at: string;
    resource_version: number;
  }>(
    `UPDATE stemma_repository
        SET state = 'TOMBSTONED',
            resource_version = resource_version + 1
      WHERE rid = $1 AND state = 'ACTIVE'
      RETURNING rid, default_branch, state, created_at::text, resource_version`,
    [rid],
  );
  if (r.rowCount === 1) {
    const row = r.rows[0];
    return {
      rid: row.rid,
      defaultBranch: row.default_branch,
      state: row.state,
      createdAt: row.created_at,
      resourceVersion: Number(row.resource_version),
    };
  }
  // Already TOMBSTONED/PURGED or missing — read current state.
  const existing = await client.query<{
    rid: string;
    default_branch: string;
    state: RepositoryState;
    created_at: string;
    resource_version: number;
  }>(
    `SELECT rid, default_branch, state, created_at::text, resource_version
       FROM stemma_repository WHERE rid = $1`,
    [rid],
  );
  if (existing.rowCount !== 1) return null;
  const row = existing.rows[0];
  return {
    rid: row.rid,
    defaultBranch: row.default_branch,
    state: row.state,
    createdAt: row.created_at,
    resourceVersion: Number(row.resource_version),
  };
}

/** Hard purge (admin-only; called by the 30-day GC). */
export async function purgeRepository(client: PoolClient, rid: string): Promise<boolean> {
  assertRepositoryRid(rid);
  // Need to drop child rows first (refs, packfiles, …) — they FK to stemma_repository.
  // The migration uses ON DELETE RESTRICT for stemma_ref and CASCADE for
  // stemma_quarantine, so we delete refs explicitly here.
  await client.query(`DELETE FROM stemma_ref WHERE repository_rid = $1`, [rid]);
  await client.query(`DELETE FROM stemma_packfile WHERE repository_rid = $1`, [rid]);
  await client.query(`DELETE FROM stemma_loose_object WHERE repository_rid = $1`, [rid]);
  // Mark PURGED before delete so an audit reader sees the transition; the
  // row itself goes via DELETE so the rid never resurrects.
  await client.query(
    `UPDATE stemma_repository SET state = 'PURGED' WHERE rid = $1`,
    [rid]
  );
  const res = await client.query(`DELETE FROM stemma_repository WHERE rid = $1`, [rid]);
  return res.rowCount === 1;
}
