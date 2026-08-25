// ---------------------------------------------------------------------------
// PostgresStemma — a DURABLE StemmaAdapter.
//
// Mirrors InMemoryStemma's semantics byte-for-byte (same sha1-shaped HEADs,
// same tree-synthesis + treeSha, same CAS-on-parentSha contract) but persists
// branches and blobs to Postgres (migration 086: coderepo_stemma_repo / coderepo_stemma_branch /
// coderepo_stemma_blob). This is what makes committed functions survive a backend
// restart — previously all git content lived in process memory and was lost on
// every reload, which left repositories showing only the template scaffold and
// drifted the durable branch_cache out of sync (→ 412 StaleRefHead on commit).
//
// The SHA formulas are intentionally identical to inMemory.ts so that ETags,
// tree hashes, and the parent-SHA optimistic-concurrency fence behave the same
// whichever adapter is mounted.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  StemmaAdapter,
  StemmaCreateArgs,
  StemmaCreateOutcome,
  StemmaCommitFilesArgs,
  StemmaCommitFilesOutcome,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
  StemmaTreeEntry,
  StemmaCreateBranchArgs,
  StemmaCreateBranchOutcome,
  StemmaDeleteBranchArgs,
  StemmaDeleteBranchOutcome,
} from "./types";
import { projectTree, synthesizeTree } from "../stemma/treeFilter";

// --- hash helpers (identical to inMemory.ts) -------------------------------
function blobSha(buf: Uint8Array): string {
  return createHash("sha1").update(buf).digest("hex");
}
function deterministicSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}
function treeProjectionSha(
  entries: ReadonlyArray<{ path: string; type: string; mode: string; sha: string; size?: number }>,
): string {
  const h = createHash("sha1");
  for (const e of entries) {
    h.update(`${e.path}\0${e.type}\0${e.mode}\0${e.sha}\0${e.size ?? ""}\n`);
  }
  return h.digest("hex");
}

export interface PostgresStemmaDeps {
  readonly pool: Pool;
}

export class PostgresStemma implements StemmaAdapter {
  constructor(private readonly deps: PostgresStemmaDeps) {}

  async createRepository(args: StemmaCreateArgs): Promise<StemmaCreateOutcome> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO coderepo_stemma_repo (repository_rid, tombstoned)
           VALUES ($1, false)
         ON CONFLICT (repository_rid) DO UPDATE SET tombstoned = false`,
        [args.proposedRid],
      );
      await client.query(
        `INSERT INTO coderepo_stemma_branch (repository_rid, branch, head_sha)
           VALUES ($1, $2, $3)
         ON CONFLICT (repository_rid, branch) DO NOTHING`,
        [args.proposedRid, args.defaultBranchName,
         deterministicSha(`${args.proposedRid}:${args.defaultBranchName}:initial`)],
      );
      await client.query("COMMIT");
      return { kind: "ok", repositoryRid: args.proposedRid };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { kind: "transient", reason: (err as Error).message };
    } finally {
      client.release();
    }
  }

  async commitFiles(args: StemmaCommitFilesArgs): Promise<StemmaCommitFilesOutcome> {
    // Adapter contract guard: a path cannot be both upserted and deleted.
    const upsertPaths = new Set(args.files.map((f) => f.path));
    const deletes = args.deletePaths ?? [];
    for (const d of deletes) {
      if (upsertPaths.has(d)) return { kind: "transient", reason: `delete-overlaps-upsert:${d}` };
    }

    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      if (await this.isTombstonedTx(client, args.repositoryRid)) {
        await client.query("ROLLBACK");
        return { kind: "branch-not-found" };
      }
      // Lock the branch head row for the CAS window.
      const head = await client.query<{ head_sha: string }>(
        `SELECT head_sha FROM coderepo_stemma_branch
          WHERE repository_rid = $1 AND branch = $2 FOR UPDATE`,
        [args.repositoryRid, args.branch],
      );
      if (head.rowCount === 0) {
        await client.query("ROLLBACK");
        return { kind: "branch-not-found" };
      }
      const currentHead = head.rows[0].head_sha;
      // F4: parentSha must equal current HEAD (optimistic concurrency fence).
      if (args.parentSha !== undefined && args.parentSha !== currentHead) {
        await client.query("ROLLBACK");
        return { kind: "stale-ref", expectedSha: args.parentSha, currentHead };
      }

      let totalBytes = 0;
      for (const f of args.files) {
        const buf = Buffer.from(f.content);
        totalBytes += buf.byteLength;
        await client.query(
          `INSERT INTO coderepo_stemma_blob (repository_rid, branch, path, content, sha, mode, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (repository_rid, branch, path)
           DO UPDATE SET content = EXCLUDED.content, sha = EXCLUDED.sha,
                         mode = EXCLUDED.mode, updated_at = now()`,
          [args.repositoryRid, args.branch, f.path, buf, blobSha(buf), f.mode],
        );
      }
      for (const d of deletes) {
        await client.query(
          `DELETE FROM coderepo_stemma_blob WHERE repository_rid = $1 AND branch = $2 AND path = $3`,
          [args.repositoryRid, args.branch, d],
        );
      }

      // New HEAD is derived from the full post-mutation path set (sorted) —
      // identical formula to InMemoryStemma so the SHA is stable/portable.
      const paths = await client.query<{ path: string }>(
        `SELECT path FROM coderepo_stemma_blob WHERE repository_rid = $1 AND branch = $2 ORDER BY path`,
        [args.repositoryRid, args.branch],
      );
      const newHead = deterministicSha(
        `${args.repositoryRid}:${args.branch}:${args.message}:${paths.rows.map((r) => r.path).join(":")}`,
      );
      await client.query(
        `UPDATE coderepo_stemma_branch SET head_sha = $3 WHERE repository_rid = $1 AND branch = $2`,
        [args.repositoryRid, args.branch, newHead],
      );
      await client.query("COMMIT");
      return { kind: "ok", commitSha: newHead, fileCount: args.files.length + deletes.length, totalBytes };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { kind: "transient", reason: (err as Error).message };
    } finally {
      client.release();
    }
  }

  async createBranch(args: StemmaCreateBranchArgs): Promise<StemmaCreateBranchOutcome> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      if (await this.isTombstonedTx(client, args.repositoryRid)) {
        await client.query("ROLLBACK");
        return { kind: "source-not-found" };
      }
      const src = await client.query<{ head_sha: string }>(
        `SELECT head_sha FROM coderepo_stemma_branch
          WHERE repository_rid = $1 AND branch = $2`,
        [args.repositoryRid, args.fromBranch],
      );
      if (src.rowCount === 0) {
        await client.query("ROLLBACK");
        return { kind: "source-not-found" };
      }
      const head = src.rows[0].head_sha;
      const ins = await client.query(
        `INSERT INTO coderepo_stemma_branch (repository_rid, branch, head_sha)
           VALUES ($1, $2, $3)
         ON CONFLICT (repository_rid, branch) DO NOTHING`,
        [args.repositoryRid, args.newBranch, head],
      );
      if (ins.rowCount === 0) {
        await client.query("ROLLBACK");
        return { kind: "branch-exists" };
      }
      // Fork the full file set into the new branch.
      await client.query(
        `INSERT INTO coderepo_stemma_blob (repository_rid, branch, path, content, sha, mode, updated_at)
         SELECT repository_rid, $3, path, content, sha, mode, now()
           FROM coderepo_stemma_blob
          WHERE repository_rid = $1 AND branch = $2`,
        [args.repositoryRid, args.fromBranch, args.newBranch],
      );
      await client.query("COMMIT");
      return { kind: "ok", head };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return { kind: "transient", reason: (err as Error).message };
    } finally {
      client.release();
    }
  }

  async deleteBranch(args: StemmaDeleteBranchArgs): Promise<StemmaDeleteBranchOutcome> {
    try {
      // ON DELETE CASCADE on coderepo_stemma_blob removes the branch's blobs.
      const r = await this.deps.pool.query(
        `DELETE FROM coderepo_stemma_branch WHERE repository_rid = $1 AND branch = $2`,
        [args.repositoryRid, args.branch],
      );
      return (r.rowCount ?? 0) > 0 ? { kind: "ok" } : { kind: "not-found" };
    } catch (err) {
      return { kind: "transient", reason: (err as Error).message };
    }
  }

  async listBranches(args: { repositoryRid: string }): Promise<import("./types").StemmaListBranchesOutcome> {
    try {
      if (await this.isTombstoned(args.repositoryRid)) return { kind: "not-found" };
      const r = await this.deps.pool.query<{ branch: string; head_sha: string }>(
        `SELECT branch, head_sha FROM coderepo_stemma_branch
          WHERE repository_rid = $1 ORDER BY branch`,
        [args.repositoryRid],
      );
      return { kind: "ok", branches: r.rows.map((x) => ({ name: x.branch, head: x.head_sha })) };
    } catch (err) {
      return { kind: "transient", reason: (err as Error).message };
    }
  }

  async tombstone(args: { repositoryRid: string }): Promise<void> {
    // Idempotent soft-delete; cascade removes branches + blobs.
    await this.deps.pool.query(
      `UPDATE coderepo_stemma_repo SET tombstoned = true WHERE repository_rid = $1`,
      [args.repositoryRid],
    );
    await this.deps.pool.query(
      `DELETE FROM coderepo_stemma_branch WHERE repository_rid = $1`,
      [args.repositoryRid],
    );
  }

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    if (await this.isTombstoned(args.repositoryRid)) return { kind: "branch-not-found" };
    const branch = await this.deps.pool.query<{ head_sha: string }>(
      `SELECT head_sha FROM coderepo_stemma_branch WHERE repository_rid = $1 AND branch = $2`,
      [args.repositoryRid, args.branch],
    );
    if (branch.rowCount === 0) return { kind: "branch-not-found" };

    const rows = await this.deps.pool.query<{ path: string; mode: string; sha: string; size: number }>(
      `SELECT path, mode, sha, octet_length(content) AS size
         FROM coderepo_stemma_blob WHERE repository_rid = $1 AND branch = $2`,
      [args.repositoryRid, args.branch],
    );
    const blobs = rows.rows.map((b) => ({ path: b.path, mode: b.mode, sha: b.sha, size: Number(b.size) }));
    const all = synthesizeTree(blobs, (dir) =>
      deterministicSha(`tree:${args.repositoryRid}:${args.branch}:${dir}`),
    );
    if (args.path !== "") {
      const exists = all.some((e) => e.path === args.path && e.type === "tree");
      if (!exists) return { kind: "path-not-found" };
    }
    const projected = projectTree(all, args.path, args.depth);
    return {
      kind: "ok",
      entries: projected as readonly StemmaTreeEntry[],
      truncated: false,
      branchHead: branch.rows[0].head_sha,
      treeSha: treeProjectionSha(projected),
    };
  }

  async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    if (await this.isTombstoned(args.repositoryRid)) return { kind: "branch-not-found" };
    const branch = await this.deps.pool.query(
      `SELECT 1 FROM coderepo_stemma_branch WHERE repository_rid = $1 AND branch = $2`,
      [args.repositoryRid, args.branch],
    );
    if (branch.rowCount === 0) return { kind: "branch-not-found" };

    const row = await this.deps.pool.query<{ content: Buffer; sha: string }>(
      `SELECT content, sha FROM coderepo_stemma_blob
        WHERE repository_rid = $1 AND branch = $2 AND path = $3`,
      [args.repositoryRid, args.branch, args.path],
    );
    if (row.rowCount === 0) {
      // Distinguish "path is a directory" from "not found" (mirrors InMemory).
      const dir = await this.deps.pool.query(
        `SELECT 1 FROM coderepo_stemma_blob
          WHERE repository_rid = $1 AND branch = $2 AND path LIKE $3 LIMIT 1`,
        [args.repositoryRid, args.branch, `${args.path}/%`],
      );
      return dir.rowCount && dir.rowCount > 0 ? { kind: "path-is-tree" } : { kind: "path-not-found" };
    }
    const content = new Uint8Array(row.rows[0].content);
    return { kind: "ok", content, sha: row.rows[0].sha, size: content.byteLength };
  }

  // --- rehydrate support (not part of StemmaAdapter; duck-typed) -----------
  /** True once a repository has been provisioned durably (scaffolded). */
  async exists(rid: string): Promise<boolean> {
    const r = await this.deps.pool.query(
      `SELECT 1 FROM coderepo_stemma_repo WHERE repository_rid = $1 AND tombstoned = false`,
      [rid],
    );
    return (r.rowCount ?? 0) > 0;
  }
  async isTombstoned(rid: string): Promise<boolean> {
    const r = await this.deps.pool.query<{ tombstoned: boolean }>(
      `SELECT tombstoned FROM coderepo_stemma_repo WHERE repository_rid = $1`,
      [rid],
    );
    return r.rowCount === 0 ? false : r.rows[0].tombstoned === true;
  }
  private async isTombstonedTx(client: PoolClient, rid: string): Promise<boolean> {
    const r = await client.query<{ tombstoned: boolean }>(
      `SELECT tombstoned FROM coderepo_stemma_repo WHERE repository_rid = $1`,
      [rid],
    );
    return r.rowCount === 0 ? false : r.rows[0].tombstoned === true;
  }
}
