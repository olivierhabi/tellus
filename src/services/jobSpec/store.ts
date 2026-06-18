// B7 — JobSpec store.
//
// publishJobSpecs is the central operation: a batch of (outputDatasetRid, …)
// rows for a single (repository_rid, branch). Behaviour:
//
//  1. Inside one SERIALIZABLE tx:
//     a. INSERT each row with ON CONFLICT (output_dataset_rid, branch) DO UPDATE
//        WHERE job_spec.repository_rid = EXCLUDED.repository_rid (atomic upsert
//        only when the existing owner matches).
//     b. The conditional WHERE means: a different repo's row will hit conflict
//        but NOT update — the affected row count tells us collision happened.
//        We then translate that to JobSpec:OutputAlreadyOwned per output.
//     c. After successful upserts, DELETE all (repository_rid, branch) rows
//        whose output_dataset_rid is NOT in the published set ("orphan replacement").
//  2. resource_version is bumped on every write.
//
// Concurrency: SERIALIZABLE isolation; on 40001 the caller retries.

import type { Pool, PoolClient } from "pg";

export interface StoredJobSpec {
  readonly outputDatasetRid: string;
  readonly branch: string;
  readonly repositoryRid: string;
  readonly commitSha: string;
  readonly sourcePath: string;
  readonly entryPoint: string;
  readonly inputs: ReadonlyArray<unknown>;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly computeProfile: string;
  readonly publishedAt: Date;
  readonly resourceVersion: number;
}

export interface JobSpecRowToPublish {
  readonly outputDatasetRid: string;
  readonly sourcePath: string;
  readonly entryPoint: string;
  readonly inputs: ReadonlyArray<unknown>;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly computeProfile: string;
}

export interface PublishResult {
  readonly published: ReadonlyArray<{ outputDatasetRid: string; resourceVersion: number }>;
  readonly rejected: ReadonlyArray<{ outputDatasetRid: string; reason: "owned-by-other-repo"; ownedBy: string }>;
  readonly deletedOrphans: ReadonlyArray<string>;
}

interface DbJobSpecRow {
  output_dataset_rid: string;
  branch: string;
  repository_rid: string;
  commit_sha: string;
  source_path: string;
  entry_point: string;
  inputs: unknown;
  parameters: Record<string, unknown>;
  compute_profile: string;
  published_at: Date;
  resource_version: string | number;
}

function fromDb(r: DbJobSpecRow): StoredJobSpec {
  return {
    outputDatasetRid: r.output_dataset_rid,
    branch: r.branch,
    repositoryRid: r.repository_rid,
    commitSha: r.commit_sha,
    sourcePath: r.source_path,
    entryPoint: r.entry_point,
    inputs: Array.isArray(r.inputs) ? r.inputs : [],
    parameters: r.parameters ?? {},
    computeProfile: r.compute_profile,
    publishedAt: r.published_at,
    resourceVersion: typeof r.resource_version === "string" ? parseInt(r.resource_version, 10) : r.resource_version,
  };
}

export interface PublishArgs {
  readonly repositoryRid: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly specs: ReadonlyArray<JobSpecRowToPublish>;
}

export async function publishJobSpecs(pool: Pool, args: PublishArgs): Promise<PublishResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const result = await publishJobSpecsTx(client, args);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  } finally {
    client.release();
  }
}

export async function publishJobSpecsTx(
  client: PoolClient,
  args: PublishArgs,
): Promise<PublishResult> {
  const published: Array<{ outputDatasetRid: string; resourceVersion: number }> = [];
  const rejected: Array<{ outputDatasetRid: string; reason: "owned-by-other-repo"; ownedBy: string }> = [];
  // Process each spec atomically within the outer SERIALIZABLE tx.
  for (const spec of args.specs) {
    // Conditional upsert: only update if existing row's repository_rid matches.
    const upsertSql = `
      INSERT INTO job_spec
        (output_dataset_rid, branch, repository_rid, commit_sha, source_path, entry_point, inputs, parameters, compute_profile)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
      ON CONFLICT (output_dataset_rid, branch) DO UPDATE SET
        commit_sha       = EXCLUDED.commit_sha,
        source_path      = EXCLUDED.source_path,
        entry_point      = EXCLUDED.entry_point,
        inputs           = EXCLUDED.inputs,
        parameters       = EXCLUDED.parameters,
        compute_profile  = EXCLUDED.compute_profile,
        published_at     = NOW(),
        resource_version = job_spec.resource_version + 1
      WHERE job_spec.repository_rid = EXCLUDED.repository_rid
      RETURNING resource_version
    `;
    const r = await client.query<{ resource_version: string | number }>(upsertSql, [
      spec.outputDatasetRid,
      args.branch,
      args.repositoryRid,
      args.commitSha,
      spec.sourcePath,
      spec.entryPoint,
      JSON.stringify(spec.inputs),
      JSON.stringify(spec.parameters),
      spec.computeProfile,
    ]);
    if (r.rowCount === 1) {
      const rv = typeof r.rows[0].resource_version === "string"
        ? parseInt(r.rows[0].resource_version, 10)
        : r.rows[0].resource_version;
      published.push({ outputDatasetRid: spec.outputDatasetRid, resourceVersion: rv });
    } else {
      // Existing row exists but is owned by another repo: read owner and reject.
      const ownerR = await client.query<{ repository_rid: string }>(
        `SELECT repository_rid FROM job_spec WHERE output_dataset_rid = $1 AND branch = $2`,
        [spec.outputDatasetRid, args.branch],
      );
      const ownedBy = ownerR.rows[0]?.repository_rid ?? "unknown";
      rejected.push({ outputDatasetRid: spec.outputDatasetRid, reason: "owned-by-other-repo", ownedBy });
    }
  }
  // Orphan replacement: delete (repository_rid, branch) rows whose output is not in this batch.
  const publishedRids = published.map((p) => p.outputDatasetRid);
  const orphanSql = publishedRids.length === 0
    ? `DELETE FROM job_spec WHERE repository_rid = $1 AND branch = $2 RETURNING output_dataset_rid`
    : `DELETE FROM job_spec WHERE repository_rid = $1 AND branch = $2 AND NOT (output_dataset_rid = ANY($3::text[])) RETURNING output_dataset_rid`;
  const orphanArgs: unknown[] = publishedRids.length === 0
    ? [args.repositoryRid, args.branch]
    : [args.repositoryRid, args.branch, publishedRids];
  const orphanR = await client.query<{ output_dataset_rid: string }>(orphanSql, orphanArgs);
  const deletedOrphans = orphanR.rows.map((row) => row.output_dataset_rid);
  return { published, rejected, deletedOrphans };
}

export async function getJobSpec(
  pool: Pool,
  outputDatasetRid: string,
  branch: string,
): Promise<StoredJobSpec | null> {
  const r = await pool.query<DbJobSpecRow>(
    `SELECT * FROM job_spec WHERE output_dataset_rid = $1 AND branch = $2 LIMIT 1`,
    [outputDatasetRid, branch],
  );
  return r.rowCount === 0 ? null : fromDb(r.rows[0]);
}

export async function listForRepo(
  pool: Pool,
  repositoryRid: string,
  branch: string,
): Promise<ReadonlyArray<StoredJobSpec>> {
  const r = await pool.query<DbJobSpecRow>(
    `SELECT * FROM job_spec WHERE repository_rid = $1 AND branch = $2 ORDER BY output_dataset_rid`,
    [repositoryRid, branch],
  );
  return r.rows.map(fromDb);
}
