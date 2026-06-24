// B8 — Functions Registry store.
//
// publishVersion semantics (spec line 696):
//   - Same (repository_rid, branch, semver) + same artifact_sha256 → 200 with
//     the existing row (idempotency dedups CI pod races).
//   - Same key + different artifact_sha256 → 409 Functions:VersionImmutable.
//   - New key → 201 with the inserted row.
//
// resolveTarget delegates to the pure-logic semver.resolveTarget(); the store
// only fetches the candidate set (AVAILABLE rows on requested branch + default
// branch's stable rows).

import type { Pool, PoolClient } from "pg";
import { resolveTarget as semverResolveTarget, type Candidate, type ParsedRange } from "./semver.js";

export interface FunctionVersionRow {
  readonly rid: string;
  readonly repositoryRid: string;
  readonly branch: string;
  readonly isPreview: boolean;
  readonly semver: string;
  readonly commitSha: string;
  readonly runtime: "NODE_20" | "PY_311";
  readonly artifactBlobId: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly manifest: Record<string, unknown>;
  readonly publishedAt: Date;
  readonly state: "AVAILABLE" | "YANKED";
}

interface DbRow {
  rid: string;
  repository_rid: string;
  branch: string;
  is_preview: boolean;
  semver: string;
  commit_sha: string;
  runtime: "NODE_20" | "PY_311";
  artifact_blob_id: string;
  artifact_sha256: string;
  artifact_bytes: string | number;
  manifest_json: Record<string, unknown>;
  published_at: Date;
  state: "AVAILABLE" | "YANKED";
}

function fromDb(r: DbRow): FunctionVersionRow {
  return {
    rid: r.rid,
    repositoryRid: r.repository_rid,
    branch: r.branch,
    isPreview: r.is_preview,
    semver: r.semver,
    commitSha: r.commit_sha,
    runtime: r.runtime,
    artifactBlobId: r.artifact_blob_id,
    artifactSha256: r.artifact_sha256,
    artifactBytes: typeof r.artifact_bytes === "string" ? parseInt(r.artifact_bytes, 10) : r.artifact_bytes,
    manifest: r.manifest_json ?? {},
    publishedAt: r.published_at,
    state: r.state,
  };
}

export interface PublishVersionArgs {
  readonly rid: string;                 // pre-minted RID for new inserts; ignored on dedupe
  readonly repositoryRid: string;
  readonly branch: string;
  readonly isPreview: boolean;
  readonly semver: string;
  readonly commitSha: string;
  readonly runtime: "NODE_20" | "PY_311";
  readonly artifactBlobId: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly manifest: Record<string, unknown>;
}

export type PublishVersionResult =
  | { readonly outcome: "inserted"; readonly row: FunctionVersionRow }
  | { readonly outcome: "deduplicated"; readonly row: FunctionVersionRow }
  | { readonly outcome: "immutable-conflict"; readonly existingArtifactSha256: string };

export async function publishVersion(
  pool: Pool,
  args: PublishVersionArgs,
): Promise<PublishVersionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    try {
      const result = await publishVersionTx(client, args);
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

export async function publishVersionTx(
  client: PoolClient,
  args: PublishVersionArgs,
): Promise<PublishVersionResult> {
  // Lock-then-check pattern. UQ index makes this atomic across processes.
  const existing = await client.query<DbRow>(
    `SELECT * FROM function_version
     WHERE repository_rid = $1 AND branch = $2 AND semver = $3
     LIMIT 1
     FOR UPDATE`,
    [args.repositoryRid, args.branch, args.semver],
  );
  if (existing.rowCount === 1) {
    const row = existing.rows[0];
    if (row.artifact_sha256 === args.artifactSha256) {
      return { outcome: "deduplicated", row: fromDb(row) };
    }
    return { outcome: "immutable-conflict", existingArtifactSha256: row.artifact_sha256 };
  }
  const inserted = await client.query<DbRow>(
    `INSERT INTO function_version
       (rid, repository_rid, branch, is_preview, semver, commit_sha, runtime,
        artifact_blob_id, artifact_sha256, artifact_bytes, manifest_json, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, 'AVAILABLE')
     RETURNING *`,
    [
      args.rid,
      args.repositoryRid,
      args.branch,
      args.isPreview,
      args.semver,
      args.commitSha,
      args.runtime,
      args.artifactBlobId,
      args.artifactSha256,
      args.artifactBytes,
      JSON.stringify(args.manifest),
    ],
  );
  return { outcome: "inserted", row: fromDb(inserted.rows[0]) };
}

export async function getVersion(
  pool: Pool,
  repositoryRid: string,
  semver: string,
  branch?: string,
): Promise<FunctionVersionRow | null> {
  const where = branch === undefined
    ? "WHERE repository_rid = $1 AND semver = $2"
    : "WHERE repository_rid = $1 AND semver = $2 AND branch = $3";
  const params = branch === undefined ? [repositoryRid, semver] : [repositoryRid, semver, branch];
  const r = await pool.query<DbRow>(`SELECT * FROM function_version ${where} LIMIT 1`, params);
  return r.rowCount === 0 ? null : fromDb(r.rows[0]);
}

export async function listVersions(
  pool: Pool,
  repositoryRid: string,
  opts?: { branch?: string; includeYanked?: boolean; limit?: number },
): Promise<ReadonlyArray<FunctionVersionRow>> {
  const where: string[] = [`repository_rid = $1`];
  const params: unknown[] = [repositoryRid];
  if (opts?.branch !== undefined) {
    params.push(opts.branch);
    where.push(`branch = $${params.length}`);
  }
  if (!opts?.includeYanked) where.push(`state = 'AVAILABLE'`);
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const r = await pool.query<DbRow>(
    `SELECT * FROM function_version WHERE ${where.join(" AND ")} ORDER BY published_at DESC LIMIT ${limit}`,
    params,
  );
  return r.rows.map(fromDb);
}

export interface ResolveTargetArgs {
  readonly repositoryRid: string;
  readonly versionRange: ParsedRange;
  readonly requestedBranch: string;
  readonly defaultBranch: string;
}

export async function resolveTarget(
  pool: Pool,
  args: ResolveTargetArgs,
): Promise<FunctionVersionRow | null> {
  // Fetch both candidate sets with a single query (requested OR default branch, AVAILABLE only).
  const sql = `SELECT * FROM function_version
               WHERE repository_rid = $1
                 AND state = 'AVAILABLE'
                 AND (branch = $2 OR branch = $3)`;
  const r = await pool.query<DbRow>(sql, [args.repositoryRid, args.requestedBranch, args.defaultBranch]);
  if (r.rowCount === 0) return null;
  const cands: Candidate[] = r.rows.map((row) => ({
    semver: row.semver,
    branch: row.branch,
    isPreview: row.is_preview,
  }));
  const winner = semverResolveTarget(cands, args.versionRange, args.requestedBranch, args.defaultBranch);
  if (winner === null) return null;
  // Find the matching row (semver + branch).
  const match = r.rows.find((row) => row.semver === winner.semver && row.branch === winner.branch);
  return match === undefined ? null : fromDb(match);
}

export async function yankVersion(
  pool: Pool,
  rid: string,
  reason?: string,
): Promise<FunctionVersionRow | null> {
  const r = await pool.query<DbRow>(
    `UPDATE function_version
       SET state = 'YANKED',
           yanked_at = now(),
           yank_reason = COALESCE($2, 'unspecified')
     WHERE rid = $1 AND state = 'AVAILABLE'
     RETURNING *`,
    [rid, reason ?? null],
  );
  return r.rowCount === 0 ? null : fromDb(r.rows[0]);
}
