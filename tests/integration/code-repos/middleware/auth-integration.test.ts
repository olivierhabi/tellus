// ---------------------------------------------------------------------------
// tests/integration/code-repos/middleware/auth-integration.test.ts
//
// Spec contracts asserted (against real Postgres + the Express app):
//   G-C-07   Authorization header must carry Bearer JWT or PAT (or, in
//            test mode, X-Tellus-Test-Principal)
//   G-C-08   Missing/invalid auth → 401 Stemma:Unauthenticated envelope
//   G-C-09   IDOR on a known principal but unknown resource → 404
//            (never 403). The Stemma admin routes always return
//            Stemma:RepositoryNotFound for unknown rids regardless of
//            whether they exist or not — verified here.
//   G-C-10   req.codeReposPrincipal carries userId + source + ip + ua
//
// The test mode opt-in (CODE_REPOS_TEST_AUTH=1) is set by the vitest
// config; we verify here that:
//   (a) no auth header at all → 401 with the contracted envelope
//   (b) X-Tellus-Test-Principal: "" → 401 (empty userId rejected)
//   (c) the legitimate test principal lets the request through
//   (d) IDOR (auth OK but unknown resource) → 404, not 403
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import { createStemmaAdminApp } from "../../../../src/services/stemma/admin/app";
import { mintRepositoryRid } from "../../../../src/services/codeRepos/contracts/rid";
import { isExactEnvelope } from "../../../../src/services/codeRepos/contracts/errors";
import { randomUUID } from "crypto";

describe("Code Repos auth middleware — Stemma:Unauthenticated + IDOR-as-404", () => {
  let ctx: SchemaContext;
  let app: ReturnType<typeof createStemmaAdminApp>;

  beforeAll(async () => {
    ctx = await openTestSchema("auth_mw");
    await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    await ctx.applyMigration("src/migrations/051_code_repos_audit.sql");
    app = createStemmaAdminApp({ pool: ctx.pool });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  // -------------------------------------------------------------------------
  // G-C-08 — missing auth → 401 Stemma:Unauthenticated
  // -------------------------------------------------------------------------
  describe("G-C-08 missing/invalid auth → 401 Stemma:Unauthenticated", () => {
    it("POST /repositories without auth → 401 with the §1.3 envelope", async () => {
      const r = await request(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", randomUUID())
        .send({ rid: mintRepositoryRid(), defaultBranchName: "main" });
      expect(r.status).toBe(401);
      expect(isExactEnvelope(r.body)).toBe(true);
      expect(r.body.errorName).toBe("Stemma:Unauthenticated");
      expect(r.body.errorCode).toBe("UNAUTHENTICATED");
    });

    it("GET /repositories/:rid/refs without auth → 401", async () => {
      const rid = mintRepositoryRid();
      const r = await request(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs`,
      );
      expect(r.status).toBe(401);
      expect(r.body.errorName).toBe("Stemma:Unauthenticated");
    });

    it("DELETE /repositories/:rid without auth → 401", async () => {
      const rid = mintRepositoryRid();
      const r = await request(app).delete(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}`,
      );
      expect(r.status).toBe(401);
      expect(r.body.errorName).toBe("Stemma:Unauthenticated");
    });

    it("X-Tellus-Test-Principal with empty userId → 401", async () => {
      const r = await request(app)
        .post("/stemma/api/v1/repositories")
        .set("X-Tellus-Test-Principal", "/OWNER") // empty userId before the slash
        .set("Idempotency-Key", randomUUID())
        .send({ rid: mintRepositoryRid(), defaultBranchName: "main" });
      expect(r.status).toBe(401);
      expect(r.body.errorName).toBe("Stemma:Unauthenticated");
    });
  });

  // -------------------------------------------------------------------------
  // G-C-07 — health and readiness are intentionally unauthenticated
  // -------------------------------------------------------------------------
  it("health endpoints are NOT gated by auth (kubelet probes)", async () => {
    const h = await request(app).get("/health");
    expect(h.status).toBe(200);
    const r = await request(app).get("/readiness");
    expect(r.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // G-C-09 — IDOR-as-404
  // -------------------------------------------------------------------------
  describe("G-C-09 IDOR-as-404", () => {
    it("authenticated GET on a never-created rid returns 404 (not 403)", async () => {
      const rid = mintRepositoryRid();
      const r = await request(app)
        .get(`/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs`)
        .set("X-Tellus-Test-Principal", "stranger/READER");
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
      // The contract is explicit: never 403. We assert this directly.
      expect(r.status).not.toBe(403);
    });

    it("authenticated DELETE on a never-created rid returns 404 (not 403)", async () => {
      const rid = mintRepositoryRid();
      const r = await request(app)
        .delete(`/stemma/api/v1/repositories/${encodeURIComponent(rid)}`)
        .set("X-Tellus-Test-Principal", "stranger/OWNER");
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
      expect(r.status).not.toBe(403);
    });

    it("authenticated GET on a TOMBSTONED rid returns 404 (B1-C-46 + G-C-09)", async () => {
      const rid = mintRepositoryRid();
      // Set up: create then tombstone.
      const create = await request(app)
        .post("/stemma/api/v1/repositories")
        .set("X-Tellus-Test-Principal", "owner-1/OWNER")
        .set("Idempotency-Key", randomUUID())
        .send({ rid, defaultBranchName: "main" });
      expect(create.status).toBe(201);

      const del = await request(app)
        .delete(`/stemma/api/v1/repositories/${encodeURIComponent(rid)}`)
        .set("X-Tellus-Test-Principal", "owner-1/OWNER");
      expect(del.status).toBe(200);

      // Now read it as another authenticated user — must be 404.
      const r = await request(app)
        .get(`/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs`)
        .set("X-Tellus-Test-Principal", "stranger/READER");
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
    });
  });

  // -------------------------------------------------------------------------
  // G-C-10 — principal carries identity into audit
  // -------------------------------------------------------------------------
  it("G-C-10 the audit row's principal_user_id matches the X-Tellus-Test-Principal userId", async () => {
    const rid = mintRepositoryRid();
    const r = await request(app)
      .post("/stemma/api/v1/repositories")
      .set("X-Tellus-Test-Principal", "alice-from-test/OWNER,EDITOR")
      .set("Idempotency-Key", randomUUID())
      .send({ rid, defaultBranchName: "main" });
    expect(r.status).toBe(201);

    const audit = await ctx.query<{
      principal_user_id: string;
      principal_source: string;
    }>(
      `SELECT principal_user_id, principal_source
         FROM code_repos_audit_events
        WHERE target_rid = $1 AND action = 'createRepository'`,
      [rid],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].principal_user_id).toBe("alice-from-test");
    // 'test' source maps to 'system' in the audit row per the
    // CHECK constraint on code_repos_audit_events.principal_source.
    expect(audit.rows[0].principal_source).toBe("system");
  });
});
