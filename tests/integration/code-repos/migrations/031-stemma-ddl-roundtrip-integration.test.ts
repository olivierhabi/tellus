// ---------------------------------------------------------------------------
// tests/integration/code-repos/migrations/031-stemma-ddl-roundtrip-integration.test.ts
//
// Spec contracts:
//   B1-C-20  stemma_repository.state CHECK constraint
//   B1-C-21  stemma_ref.target_sha CAS column (PRIMARY KEY guarantees row lock)
//   B1-C-23  stemma_packfile inserts (CHECK on size_bytes > 0)
//   B1-C-24  stemma_quarantine state CHECK
//   G-C-21   code_repos_idempotency 24h replay window
//   DoD      reversibility — down-migration drops cleanly
//
// Strategy: apply 031_stemma_ddl.sql in an isolated schema, assert every
// table/column/CHECK exists, apply 031_stemma_ddl.down.sql, assert clean.
//
// Requires: Postgres on localhost:5432 (existing tellus dev compose).
// Run via: npx vitest run --config vitest.codeRepos.config.ts tests/integration/code-repos/migrations
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";

describe("B1 — 031_stemma_ddl up/down round-trip", () => {
  let ctx: SchemaContext;

  beforeAll(async () => {
    ctx = await openTestSchema("stemma_ddl_roundtrip");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  // -------------------------------------------------------------------------
  // After UP migration
  // -------------------------------------------------------------------------

  describe("after applying 031_stemma_ddl.sql", () => {
    beforeAll(async () => {
      await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    });

    const expectedTables = [
      "stemma_repository",
      "stemma_ref",
      "stemma_packfile",
      "stemma_loose_object",
      "stemma_blob",
      "stemma_quarantine",
      "code_repos_idempotency",
    ];

    for (const t of expectedTables) {
      it(`table ${t} exists in the test schema`, async () => {
        const r = await ctx.query(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2`,
          [ctx.schema, t]
        );
        expect(r.rowCount).toBe(1);
      });
    }

    it("B1-C-20: stemma_repository.state CHECK accepts ACTIVE/TOMBSTONED/PURGED, rejects others", async () => {
      // Insert one row of each valid state — should succeed.
      for (const state of ["ACTIVE", "TOMBSTONED", "PURGED"]) {
        await ctx.query(
          `INSERT INTO stemma_repository(rid, state) VALUES ($1, $2)`,
          [`ri.stemma.main.repository.${state.toLowerCase()}-uuid`, state]
        );
      }
      // Bad state should violate the CHECK and raise SQLSTATE 23514.
      await expect(
        ctx.query(
          `INSERT INTO stemma_repository(rid, state) VALUES ('ri.stemma.main.repository.bad', 'BANANA')`
        )
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("B1-C-21: stemma_ref.(repository_rid, name) is the primary key (CAS row lock)", async () => {
      // Pick an existing repo from the previous step.
      const repoRid = "ri.stemma.main.repository.active-uuid";
      await ctx.query(
        `INSERT INTO stemma_ref(repository_rid, name, target_sha) VALUES ($1, 'refs/heads/main', 'aaaa')`,
        [repoRid]
      );
      await expect(
        ctx.query(
          `INSERT INTO stemma_ref(repository_rid, name, target_sha) VALUES ($1, 'refs/heads/main', 'bbbb')`,
          [repoRid]
        )
      ).rejects.toMatchObject({ code: "23505" }); // unique_violation
    });

    it("B1-C-21: ref CAS update flow — `WHERE target_sha = $expected_old` semantics", async () => {
      const repoRid = "ri.stemma.main.repository.active-uuid";
      // Set up a feature ref.
      await ctx.query(
        `INSERT INTO stemma_ref(repository_rid, name, target_sha)
            VALUES ($1, 'refs/heads/feature', 'old-sha')`,
        [repoRid]
      );
      // CAS hit: matching expected_old advances target_sha.
      const ok = await ctx.query(
        `UPDATE stemma_ref
            SET target_sha = $1, resource_version = resource_version + 1, updated_at = now()
          WHERE repository_rid = $2 AND name = $3 AND target_sha = $4`,
        ["new-sha", repoRid, "refs/heads/feature", "old-sha"]
      );
      expect(ok.rowCount).toBe(1);
      // CAS miss: stale expected_old leaves the row untouched and returns 0 rows.
      const stale = await ctx.query(
        `UPDATE stemma_ref
            SET target_sha = $1
          WHERE repository_rid = $2 AND name = $3 AND target_sha = $4`,
        ["another-sha", repoRid, "refs/heads/feature", "old-sha"]
      );
      expect(stale.rowCount).toBe(0);
      // Inspect: target_sha is the post-first-CAS value.
      const row = await ctx.query(
        `SELECT target_sha, resource_version FROM stemma_ref
          WHERE repository_rid = $1 AND name = $2`,
        [repoRid, "refs/heads/feature"]
      );
      expect(row.rows[0].target_sha).toBe("new-sha");
      expect(Number(row.rows[0].resource_version)).toBe(2);
    });

    it("B1-C-23: stemma_packfile.size CHECKs reject non-positive sizes", async () => {
      await expect(
        ctx.query(
          `INSERT INTO stemma_packfile(repository_rid, pack_id, pack_size_bytes,
                                       index_size_bytes, pack_blob_id, index_blob_id)
              VALUES ('ri.stemma.main.repository.active-uuid', 'p1', 0, 1, 'b', 'i')`
        )
      ).rejects.toMatchObject({ code: "23514" });

      await expect(
        ctx.query(
          `INSERT INTO stemma_packfile(repository_rid, pack_id, pack_size_bytes,
                                       index_size_bytes, pack_blob_id, index_blob_id)
              VALUES ('ri.stemma.main.repository.active-uuid', 'p2', 1, 0, 'b', 'i')`
        )
      ).rejects.toMatchObject({ code: "23514" });

      // Positive sizes succeed.
      const ok = await ctx.query(
        `INSERT INTO stemma_packfile(repository_rid, pack_id, pack_size_bytes,
                                     index_size_bytes, pack_blob_id, index_blob_id)
            VALUES ('ri.stemma.main.repository.active-uuid', 'p3', 100, 50, 'b', 'i')`
      );
      expect(ok.rowCount).toBe(1);
    });

    it("B1-C-24: stemma_quarantine.state CHECK accepts only OPEN/PROMOTED/REJECTED/EXPIRED", async () => {
      const repoRid = "ri.stemma.main.repository.active-uuid";
      const principal = "00000000-0000-4000-8000-000000000001";
      for (const state of ["OPEN", "PROMOTED", "REJECTED", "EXPIRED"]) {
        await ctx.query(
          `INSERT INTO stemma_quarantine(quarantine_id, repository_rid, principal_sub, expires_at, state)
              VALUES ($1, $2, $3, now() + interval '5 minutes', $4)`,
          [`q-${state}`, repoRid, principal, state]
        );
      }
      await expect(
        ctx.query(
          `INSERT INTO stemma_quarantine(quarantine_id, repository_rid, principal_sub, expires_at, state)
              VALUES ($1, $2, $3, now() + interval '5 minutes', 'GARBAGE')`,
          ["q-bad", repoRid, principal]
        )
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("stemma_blob.sha256 CHECK enforces 64-char hex length", async () => {
      // 63 chars: rejected.
      await expect(
        ctx.query(
          `INSERT INTO stemma_blob(blob_id, storage_uri, size_bytes, sha256) VALUES ('b1','s3://x',1,$1)`,
          ["a".repeat(63)]
        )
      ).rejects.toMatchObject({ code: "23514" });
      // 64 chars: accepted.
      const ok = await ctx.query(
        `INSERT INTO stemma_blob(blob_id, storage_uri, size_bytes, sha256) VALUES ('b2','s3://x',1,$1)`,
        ["a".repeat(64)]
      );
      expect(ok.rowCount).toBe(1);
    });

    it("G-C-21: code_repos_idempotency primary key is (key, service, endpoint)", async () => {
      const key = "00000000-0000-4000-8000-000000000abc";
      await ctx.query(
        `INSERT INTO code_repos_idempotency
            (idempotency_key, service, endpoint, request_hash, response_id, status_code, response_body, expires_at)
          VALUES ($1, 'stemma', 'POST /repositories', 'h1', 'r1', 201, '{}', now() + interval '24 hours')`,
        [key]
      );
      // Same (key, service, endpoint) — duplicate.
      await expect(
        ctx.query(
          `INSERT INTO code_repos_idempotency
              (idempotency_key, service, endpoint, request_hash, response_id, status_code, response_body, expires_at)
            VALUES ($1, 'stemma', 'POST /repositories', 'h1', 'r1', 201, '{}', now() + interval '24 hours')`,
          [key]
        )
      ).rejects.toMatchObject({ code: "23505" });
      // Same key, different service — separate row, allowed.
      const ok = await ctx.query(
        `INSERT INTO code_repos_idempotency
            (idempotency_key, service, endpoint, request_hash, response_id, status_code, response_body, expires_at)
          VALUES ($1, 'code-repos', 'POST /repositories', 'h1', 'r1', 201, '{}', now() + interval '24 hours')`,
        [key]
      );
      expect(ok.rowCount).toBe(1);
    });

    it("indexes from migration are present", async () => {
      const expectedIndexes = [
        "stemma_ref_repo_idx",
        "stemma_packfile_repo_idx",
        "stemma_quarantine_expires_idx",
        "code_repos_idempotency_expires_idx",
      ];
      for (const idx of expectedIndexes) {
        const r = await ctx.query(
          `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
          [ctx.schema, idx]
        );
        expect({ idx, found: r.rowCount }).toEqual({ idx, found: 1 });
      }
    });
  });

  // -------------------------------------------------------------------------
  // After DOWN migration
  // -------------------------------------------------------------------------

  describe("after applying 031_stemma_ddl.down.sql", () => {
    beforeAll(async () => {
      await ctx.applyMigration("src/migrations/050_stemma_ddl.down.sql");
    });

    const expectedDropped = [
      "stemma_repository",
      "stemma_ref",
      "stemma_packfile",
      "stemma_loose_object",
      "stemma_blob",
      "stemma_quarantine",
      "code_repos_idempotency",
    ];

    for (const t of expectedDropped) {
      it(`table ${t} no longer exists`, async () => {
        const r = await ctx.query(
          `SELECT 1 FROM information_schema.tables
            WHERE table_schema = $1 AND table_name = $2`,
          [ctx.schema, t]
        );
        expect(r.rowCount).toBe(0);
      });
    }

    it("indexes are gone", async () => {
      const r = await ctx.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = $1 AND indexname LIKE 'stemma_%'`,
        [ctx.schema]
      );
      expect(r.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip determinism: re-applying UP after DOWN works (no leftover state)
  // -------------------------------------------------------------------------

  describe("UP after DOWN succeeds (idempotent reversibility)", () => {
    it("re-applies the UP migration cleanly", async () => {
      await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
      const r = await ctx.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
        [ctx.schema, ["stemma_repository", "stemma_ref", "code_repos_idempotency"]]
      );
      expect(r.rows[0].n).toBe(3);
    });
  });
});
