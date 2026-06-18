// ---------------------------------------------------------------------------
// B8 — Functions Registry DDL roundtrip integration tests.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openTestSchema } from "../_helpers/pg";

const ROOT = process.cwd();
const UP = readFileSync(
  path.join(ROOT, "src/migrations/055_b8_functions_registry.sql"),
  "utf-8",
);
const DOWN = readFileSync(
  path.join(ROOT, "src/migrations/055_b8_functions_registry.down.sql"),
  "utf-8",
);

const REPO_RID = "ri.stemma.main.repository." + randomUUID();
const SHA64 = "a".repeat(64);

function insertSql(args: {
  rid?: string;
  branch?: string;
  semver?: string;
  isPreview?: boolean;
  runtime?: string;
  state?: string;
  commit?: string;
  artifactSha?: string;
  yankedAt?: string | null;
  yankReason?: string | null;
}): { sql: string; params: unknown[] } {
  const rid = args.rid ?? "ri.functions.main.function-version." + randomUUID();
  const branch = args.branch ?? "main";
  const semver = args.semver ?? "1.0.0";
  const isPreview = args.isPreview ?? false;
  const runtime = args.runtime ?? "NODE_20";
  const state = args.state ?? "AVAILABLE";
  const commit = args.commit ?? "abc1234";
  const artifactSha = args.artifactSha ?? SHA64;
  return {
    sql: `INSERT INTO function_version (
      rid, repository_rid, branch, is_preview, semver, commit_sha, runtime,
      artifact_blob_id, artifact_sha256, artifact_bytes, manifest_json, state,
      yanked_at, yank_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
    params: [
      rid,
      REPO_RID,
      branch,
      isPreview,
      semver,
      commit,
      runtime,
      "blob-" + randomUUID(),
      artifactSha,
      1024,
      JSON.stringify({ entryPoints: [] }),
      state,
      args.yankedAt ?? null,
      args.yankReason ?? null,
    ],
  };
}

describe("Migration 055 — B8 Functions Registry DDL roundtrip", () => {
  let openSchema: Awaited<ReturnType<typeof openTestSchema>>;

  beforeAll(async () => {
    openSchema = await openTestSchema("functions_ddl");
    await openSchema.applyMigrationSql(UP);
  });
  afterAll(async () => {
    if (openSchema) await openSchema.close();
  });

  it("creates function_version table", async () => {
    const r = await openSchema.query(
      `SELECT relname FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND relkind='r' AND relname='function_version'`,
      [openSchema.schema],
    );
    expect(r.rowCount).toBe(1);
  });

  it("inserts a valid AVAILABLE row", async () => {
    const ins = insertSql({ semver: "1.0.0" });
    await openSchema.query(ins.sql, ins.params);
  });

  it("rejects runtime not in ('NODE_20','PY_311')", async () => {
    const ins = insertSql({ runtime: "BOGUS" });
    await expect(openSchema.query(ins.sql, ins.params)).rejects.toThrow(
      /function_version_runtime_chk|check constraint/i,
    );
  });

  it("rejects state not in ('AVAILABLE','YANKED')", async () => {
    const ins = insertSql({ state: "BOGUS" });
    await expect(openSchema.query(ins.sql, ins.params)).rejects.toThrow(
      /function_version_state_chk|check constraint/i,
    );
  });

  it("rejects commit_sha not matching hex regex", async () => {
    const ins = insertSql({ commit: "ZZZ" });
    await expect(openSchema.query(ins.sql, ins.params)).rejects.toThrow(
      /function_version_commit_sha_chk|check constraint/i,
    );
  });

  it("rejects artifact_sha256 not matching 64-hex regex", async () => {
    const ins = insertSql({ artifactSha: "abc" });
    await expect(openSchema.query(ins.sql, ins.params)).rejects.toThrow(
      /function_version_artifact_sha256_chk|check constraint/i,
    );
  });

  it("yank lifecycle CHECK: AVAILABLE forbids yanked_at", async () => {
    const ins = insertSql({ state: "AVAILABLE", yankedAt: "2026-05-01T00:00:00Z" });
    await expect(openSchema.query(ins.sql, ins.params)).rejects.toThrow(
      /function_version_yank_lifecycle_chk|check constraint/i,
    );
  });

  it("yank lifecycle CHECK: YANKED requires yanked_at", async () => {
    const ins = insertSql({ state: "YANKED", yankedAt: null });
    await expect(openSchema.query(ins.sql, ins.params)).rejects.toThrow(
      /function_version_yank_lifecycle_chk|check constraint/i,
    );
  });

  it("UNIQUE (repository_rid, branch, semver) — rejects duplicates", async () => {
    const semver = "2.0.0";
    const a = insertSql({ semver });
    const b = insertSql({ semver });
    await openSchema.query(a.sql, a.params);
    await expect(openSchema.query(b.sql, b.params)).rejects.toThrow(
      /function_version_repo_semver_branch|duplicate|unique/i,
    );
  });

  it("UNIQUE allows same (repo, semver) on different branches", async () => {
    const semver = "3.0.0";
    const a = insertSql({ semver, branch: "main" });
    const b = insertSql({ semver, branch: "feature/foo", isPreview: true });
    await openSchema.query(a.sql, a.params);
    await openSchema.query(b.sql, b.params); // should not throw
  });

  it("DOWN drops function_version; UP recreates idempotently", async () => {
    await openSchema.query(DOWN);
    const r1 = await openSchema.query(
      `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND relname='function_version'`,
      [openSchema.schema],
    );
    expect(r1.rows[0].n).toBe(0);
    await openSchema.applyMigrationSql(UP);
    const r2 = await openSchema.query(
      `SELECT count(*)::int AS n FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND relname='function_version'`,
      [openSchema.schema],
    );
    expect(r2.rows[0].n).toBe(1);
  });
});
