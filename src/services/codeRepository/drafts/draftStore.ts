// ---------------------------------------------------------------------------
// Uncommitted-drafts store (migration 104).
//
// Per-user, per-branch, PRE-COMMIT file drafts — the durable backend analogue
// of the repo browser's in-memory dirty buffer. Drafts survive across
// browsers/sessions (so "close the browser, reopen, your edits are still
// there") WITHOUT being a git commit: the frontend deletes them the moment
// the user commits via Source Control.
//
// Mirrors coderepo_stemma_blob (086) for content/path/mode, but keyed by
// `principal_sub` so each user's uncommitted work is private. Replace
// semantics: a PUT carries the FULL desired set for (principal, repo,
// branch); rows not in the set are deleted, the rest upserted (version
// bumps on update for an opt-in ETag). Last-write-wins per user (same
// semantics the in-memory buffer had across tabs).
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";
import { validateRelativePath } from "../stemma/path";

const MAX_DRAFTS = 500;
const MAX_DRAFT_BYTES = 5 * 1024 * 1024; // 5 MiB per draft (matches the file cap)

export interface DraftRow {
  readonly path: string;
  readonly content: string; // utf-8
  readonly baseSha: string | null;
  readonly baseContent: string | null; // utf-8 snapshot for the post-reload diff
  readonly mode: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface StoredDraftInput {
  readonly path: string;
  readonly content: string;
  readonly baseSha: string | null;
  readonly baseContent: string | null;
  readonly mode: string;
}

export type DraftValidation =
  | { kind: "ok"; drafts: StoredDraftInput[] }
  | {
      kind: "invalid";
      errorName:
        | "CodeRepos:InvalidSettings"
        | "CodeRepos:InvalidPath"
        | "CodeRepos:DraftTooLarge"
        | "CodeRepos:DraftLimitExceeded";
      parameters: Record<string, unknown>;
    };

interface DraftRowDb {
  path: string;
  content: Buffer;
  base_sha: string | null;
  base_content: Buffer | null;
  mode: string;
  version: string | number;
  updated_at: string | Date;
}

function toRow(r: DraftRowDb): DraftRow {
  return {
    path: r.path,
    content: r.content.toString("utf-8"),
    baseSha: r.base_sha,
    baseContent: r.base_content ? r.base_content.toString("utf-8") : null,
    mode: r.mode,
    version: typeof r.version === "string" ? Number(r.version) : r.version,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

const SELECT_COLS =
  "path, content, base_sha, base_content, mode, version, updated_at";

/**
 * Validate a PUT /drafts body. Pure — no I/O. Mirrors validateCommitBody:
 * hand-rolled, returns a discriminated outcome the route maps 1:1 to a §1.3
 * error envelope. Per-entry: non-empty repo-relative path, string content ≤
 * 5 MiB, baseSha is 40-hex or null, baseContent is string-or-null ≤ 5 MiB,
 * mode ∈ {100644,100755}; no duplicate paths; ≤ 500 entries.
 */
export function validateDraftsBody(body: unknown): DraftValidation {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "body", reason: "expected an object" },
    };
  }
  const drafts = (body as { drafts?: unknown }).drafts;
  if (!Array.isArray(drafts)) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:InvalidSettings",
      parameters: { field: "drafts", reason: "expected an array" },
    };
  }
  if (drafts.length > MAX_DRAFTS) {
    return {
      kind: "invalid",
      errorName: "CodeRepos:DraftLimitExceeded",
      parameters: { limit: MAX_DRAFTS, count: drafts.length },
    };
  }

  const seen = new Set<string>();
  const out: StoredDraftInput[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const entry = drafts[i];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: { field: `drafts[${i}]`, reason: "expected an object" },
      };
    }
    const e = entry as {
      path?: unknown;
      content?: unknown;
      baseSha?: unknown;
      baseContent?: unknown;
      mode?: unknown;
    };

    if (typeof e.path !== "string" || e.path.length === 0) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { field: `drafts[${i}].path`, reason: "must be a non-empty string" },
      };
    }
    const pv = validateRelativePath(e.path);
    if (!pv.ok) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { field: `drafts[${i}].path`, reason: pv.reason },
      };
    }
    if (pv.value.normalized.length === 0) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidPath",
        parameters: { field: `drafts[${i}].path`, reason: "must not be empty" },
      };
    }
    if (seen.has(pv.value.normalized)) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: { field: `drafts[${i}].path`, reason: "duplicate path" },
      };
    }
    seen.add(pv.value.normalized);

    if (typeof e.content !== "string") {
      return {
        kind: "invalid",
        errorName: "CodeRepos:InvalidSettings",
        parameters: { field: `drafts[${i}].content`, reason: "must be a string" },
      };
    }
    if (Buffer.byteLength(e.content, "utf8") > MAX_DRAFT_BYTES) {
      return {
        kind: "invalid",
        errorName: "CodeRepos:DraftTooLarge",
        parameters: { field: `drafts[${i}].content`, limit: MAX_DRAFT_BYTES },
      };
    }

    let baseSha: string | null = null;
    if (e.baseSha !== undefined && e.baseSha !== null) {
      if (typeof e.baseSha !== "string" || !/^[0-9a-f]{40}$/i.test(e.baseSha)) {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: { field: `drafts[${i}].baseSha`, reason: "must be a 40-hex sha or null" },
        };
      }
      baseSha = e.baseSha.toLowerCase();
    }

    let baseContent: string | null = null;
    if (e.baseContent !== undefined && e.baseContent !== null) {
      if (typeof e.baseContent !== "string") {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: { field: `drafts[${i}].baseContent`, reason: "must be a string or null" },
        };
      }
      if (Buffer.byteLength(e.baseContent, "utf8") > MAX_DRAFT_BYTES) {
        return {
          kind: "invalid",
          errorName: "CodeRepos:DraftTooLarge",
          parameters: { field: `drafts[${i}].baseContent`, limit: MAX_DRAFT_BYTES },
        };
      }
      baseContent = e.baseContent;
    }

    let mode = "100644";
    if (e.mode !== undefined) {
      if (e.mode !== "100644" && e.mode !== "100755") {
        return {
          kind: "invalid",
          errorName: "CodeRepos:InvalidSettings",
          parameters: { field: `drafts[${i}].mode`, reason: "must be 100644 or 100755" },
        };
      }
      mode = e.mode;
    }

    out.push({ path: pv.value.normalized, content: e.content, baseSha, baseContent, mode });
  }
  return { kind: "ok", drafts: out };
}

export interface DraftStoreArgs {
  readonly principalSub: string;
  readonly repositoryRid: string;
  readonly branch: string;
}

/** Return the user's draft set for (repo, branch), ordered by path. */
export async function listDrafts(pool: Pool, args: DraftStoreArgs): Promise<DraftRow[]> {
  const res = await pool.query<DraftRowDb>(
    `SELECT ${SELECT_COLS} FROM code_repository_draft
      WHERE principal_sub = $1 AND repository_rid = $2 AND branch = $3
      ORDER BY path`,
    [args.principalSub, args.repositoryRid, args.branch],
  );
  return res.rows.map(toRow);
}

/**
 * Replace the user's draft set for (repo, branch) with `drafts`. Anything not
 * in the new set is deleted; the rest are upserted (version bumps on update).
 * Atomic — the whole replace runs in one tx. Uses the passed `pool` directly
 * (manual BEGIN/COMMIT, mirroring PostgresStemma.commitFiles) so the route's
 * injected pool is honoured and the store is unit-testable with a mock pool.
 */
export async function replaceDrafts(
  pool: Pool,
  args: DraftStoreArgs & { drafts: StoredDraftInput[] },
): Promise<DraftRow[]> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const keepPaths = args.drafts.map((d) => d.path);
    if (keepPaths.length === 0) {
      await client.query(
        `DELETE FROM code_repository_draft
          WHERE principal_sub = $1 AND repository_rid = $2 AND branch = $3`,
        [args.principalSub, args.repositoryRid, args.branch],
      );
    } else {
      await client.query(
        `DELETE FROM code_repository_draft
          WHERE principal_sub = $1 AND repository_rid = $2 AND branch = $3
            AND NOT (path = ANY($4::text[]))`,
        [args.principalSub, args.repositoryRid, args.branch, keepPaths],
      );
    }
    for (const d of args.drafts) {
      await client.query(
        `INSERT INTO code_repository_draft
           (principal_sub, repository_rid, branch, path, content, base_sha, base_content, mode, version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now())
         ON CONFLICT (principal_sub, repository_rid, branch, path)
         DO UPDATE SET content = EXCLUDED.content,
                       base_sha = EXCLUDED.base_sha,
                       base_content = EXCLUDED.base_content,
                       mode = EXCLUDED.mode,
                       version = code_repository_draft.version + 1,
                       updated_at = now()`,
        [
          args.principalSub,
          args.repositoryRid,
          args.branch,
          d.path,
          Buffer.from(d.content, "utf-8"),
          d.baseSha,
          d.baseContent ? Buffer.from(d.baseContent, "utf-8") : null,
          d.mode,
        ],
      );
    }
    const res = await client.query<DraftRowDb>(
      `SELECT ${SELECT_COLS} FROM code_repository_draft
        WHERE principal_sub = $1 AND repository_rid = $2 AND branch = $3
        ORDER BY path`,
      [args.principalSub, args.repositoryRid, args.branch],
    );
    await client.query("COMMIT");
    return res.rows.map(toRow);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* swallow rollback errors — the original error is the real failure */
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Delete every draft for (principal, repo, branch) — called after a commit. */
export async function clearDrafts(pool: Pool, args: DraftStoreArgs): Promise<void> {
  await pool.query(
    `DELETE FROM code_repository_draft
      WHERE principal_sub = $1 AND repository_rid = $2 AND branch = $3`,
    [args.principalSub, args.repositoryRid, args.branch],
  );
}
