// ---------------------------------------------------------------------------
// tests/integration/code-repos/stemma/admin-routes-integration.test.ts
//
// Conjure-style contract tests for B1 admin routes (B1-C-09..13) at the wire
// level. Hits a real Express app talking to a real Postgres in an isolated
// schema. Uses supertest for HTTP.
//
// Spec contracts asserted:
//   B1-C-09  POST /repositories returns 201 + Repository
//   B1-C-10  DELETE /repositories/{rid} → soft-delete tombstone
//   B1-C-12  GET /repositories/{rid}/refs returns HEAD ref on empty repo
//   B1-C-13  GET /repositories/{rid}/refs/{name} returns the ref or 404
//   B1-C-21  ref CAS — write/delete loop (via storage layer, also exercised here)
//   B1-C-26  Stemma:RepositoryNotFound (404) — including for tombstoned
//   B1-C-27  Stemma:RefNotFound (404)
//   B1-C-46  tombstoned → 404
//   B1-C-47  empty repo has symbolic HEAD → refs/heads/main
//   G-C-12   error envelope shape
//   G-C-15   HTTP status mapping
//   G-C-17   ETag W/"<n>" format
//   G-C-20   POST requires Idempotency-Key
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import { createStemmaAdminApp } from "../../../../src/services/stemma/admin/app";
import { mintRepositoryRid } from "../../../../src/services/codeRepos/contracts/rid";
import { isExactEnvelope } from "../../../../src/services/codeRepos/contracts/errors";
import { applyRefUpdates } from "../../../../src/services/stemma/storage/refStore";
import { randomUUID } from "crypto";

const VALID_KEY = () => randomUUID();
const SHA = (h: string) => h.padStart(40, "0").slice(-40);

// Test-mode principal — `requireCodeReposAuth` reads this header only when
// CODE_REPOS_TEST_AUTH=1 is set in the environment (set by
// vitest.codeRepos.config.ts). Production code paths never consult it.
const TEST_PRINCIPAL_HEADER = "test-user-1/OWNER";

/**
 * supertest wrapper that automatically attaches the test-mode principal
 * header on every request. Returns the same supertest agent so chaining
 * (.set, .send) keeps working.
 */
function authed(app: import("express").Express) {
  // Wrap each verb so callers can write `authed(app).post("...")` exactly
  // like they would with bare supertest, and the principal header is
  // applied transparently. We retain the ability to override the header
  // by chaining .set("X-Tellus-Test-Principal", ...).
  const agent = request(app);
  return {
    get: (url: string) => agent.get(url).set("X-Tellus-Test-Principal", TEST_PRINCIPAL_HEADER),
    post: (url: string) => agent.post(url).set("X-Tellus-Test-Principal", TEST_PRINCIPAL_HEADER),
    delete: (url: string) => agent.delete(url).set("X-Tellus-Test-Principal", TEST_PRINCIPAL_HEADER),
    put: (url: string) => agent.put(url).set("X-Tellus-Test-Principal", TEST_PRINCIPAL_HEADER),
    patch: (url: string) => agent.patch(url).set("X-Tellus-Test-Principal", TEST_PRINCIPAL_HEADER),
  };
}

describe("B1 admin routes — Conjure contract surface", () => {
  let ctx: SchemaContext;
  let app: ReturnType<typeof createStemmaAdminApp>;

  beforeAll(async () => {
    ctx = await openTestSchema("stemma_admin_routes");
    await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    // Migration 032 stands up code_repos_audit_events + the hash chain
    // head + the idempotency table. Without it the routes' SERIALIZABLE
    // tx fails on the audit insert.
    await ctx.applyMigration("src/migrations/051_code_repos_audit.sql");
    app = createStemmaAdminApp({ pool: ctx.pool });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  // -------------------------------------------------------------------------
  // Health endpoints
  // -------------------------------------------------------------------------
  describe("G-C-41 health/readiness", () => {
    it("GET /health returns 200", async () => {
      // Health endpoints are intentionally unauthenticated (kubelet probes).
      const r = await request(app).get("/health");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: "ok" });
    });

    it("GET /readiness returns 200 when Postgres is reachable", async () => {
      const r = await request(app).get("/readiness");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ status: "ready" });
    });
  });

  // -------------------------------------------------------------------------
  // POST /repositories — B1-C-09
  // -------------------------------------------------------------------------
  describe("B1-C-09 POST /stemma/api/v1/repositories", () => {
    it("creates a fresh repository and returns 201 with ETag", async () => {
      const rid = mintRepositoryRid();
      const r = await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        rid,
        defaultBranch: "main",
        state: "ACTIVE",
      });
      // G-C-17 weak ETag.
      expect(r.headers.etag).toMatch(/^W\/"\d+"$/);
      expect(r.body.etag).toBe(r.headers.etag);
    });

    it("G-C-20 rejects missing Idempotency-Key with INVALID_ARGUMENT envelope", async () => {
      const r = await authed(app)
        .post("/stemma/api/v1/repositories")
        .send({ rid: mintRepositoryRid(), defaultBranchName: "main" });
      expect(r.status).toBe(400);
      expect(isExactEnvelope(r.body)).toBe(true);
      expect(r.body.errorName).toBe("Stemma:MissingIdempotencyKey");
      expect(r.body.errorCode).toBe("INVALID_ARGUMENT");
    });

    it("G-C-20 rejects malformed Idempotency-Key", async () => {
      const r = await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", "not-a-uuid")
        .send({ rid: mintRepositoryRid(), defaultBranchName: "main" });
      expect(r.status).toBe(400);
      // The middleware emits a more specific error name than the legacy
      // route handler did; both are acceptable per the spec since both are
      // INVALID_ARGUMENT and namespaced under Stemma:.
      expect(r.body.errorName).toBe("Stemma:InvalidIdempotencyKey");
    });

    it("rejects non-RID rid field", async () => {
      const r = await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid: "not-a-rid", defaultBranchName: "main" });
      expect(r.status).toBe(400);
      expect(r.body.errorName).toBe("Stemma:InvalidArgument");
      expect(r.body.parameters.field).toBe("rid");
    });

    it("rejects branch names that violate G-C-29", async () => {
      const rid = mintRepositoryRid();
      const r = await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "..bad" });
      expect(r.status).toBe(400);
      expect(r.body.errorName).toMatch(/^Stemma:/);
    });
  });

  // -------------------------------------------------------------------------
  // GET /repositories/:rid/refs — B1-C-12 + B1-C-47
  // -------------------------------------------------------------------------
  describe("B1-C-12 listRefs and B1-C-47 empty-repo HEAD", () => {
    it("returns the symbolic HEAD ref on an empty freshly-created repo", async () => {
      const rid = mintRepositoryRid();
      await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });

      const r = await authed(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs`
      );
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([
        expect.objectContaining({
          name: "HEAD",
          isSymbolic: true,
          symbolicTarget: "refs/heads/main",
          targetSha: "0000000000000000000000000000000000000000",
        }),
      ]);
      expect(r.body.nextPageToken).toBeNull();
    });

    it("returns 404 RepositoryNotFound for unknown rid", async () => {
      const rid = mintRepositoryRid(); // valid format but never created
      const r = await authed(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs`
      );
      expect(r.status).toBe(404);
      expect(isExactEnvelope(r.body)).toBe(true);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
    });

    it("returns 404 RepositoryNotFound for malformed rid (no information leak)", async () => {
      const r = await authed(app).get(`/stemma/api/v1/repositories/not-a-rid/refs`);
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
    });
  });

  // -------------------------------------------------------------------------
  // GET /repositories/:rid/refs/* — B1-C-13
  // -------------------------------------------------------------------------
  describe("B1-C-13 getRef", () => {
    it("returns 404 RefNotFound for an unknown ref on a known repo", async () => {
      const rid = mintRepositoryRid();
      await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });

      const r = await authed(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs/refs/heads/missing`
      );
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RefNotFound");
      expect(r.body.parameters.name).toBe("refs/heads/missing");
    });

    it("returns the ref with ETag for a created branch", async () => {
      const rid = mintRepositoryRid();
      await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });

      // Use the storage helper to create a real branch ref.
      const out = await applyRefUpdates(ctx.pool, rid, [
        { kind: "create", name: "refs/heads/feature", newSha: SHA("a1") },
      ]);
      expect(out.kind).toBe("ok");

      const r = await authed(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs/refs/heads/feature`
      );
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        name: "refs/heads/feature",
        targetSha: SHA("a1"),
        isSymbolic: false,
      });
      expect(r.headers.etag).toMatch(/^W\/"\d+"$/);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /repositories/:rid — B1-C-10 tombstone + B1-C-46 404 after tombstone
  // -------------------------------------------------------------------------
  describe("B1-C-10 + B1-C-46 tombstone semantics", () => {
    it("DELETE tombstones an active repo; subsequent GET refs returns 404", async () => {
      const rid = mintRepositoryRid();
      await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });

      const del = await authed(app).delete(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}`
      );
      expect(del.status).toBe(200);
      expect(del.body.state).toBe("TOMBSTONED");

      const r = await authed(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs`
      );
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
    });

    it("DELETE on missing repo returns 404 RepositoryNotFound", async () => {
      const rid = mintRepositoryRid();
      const r = await authed(app).delete(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}`
      );
      expect(r.status).toBe(404);
      expect(r.body.errorName).toBe("Stemma:RepositoryNotFound");
    });
  });

  // -------------------------------------------------------------------------
  // B1-C-21 — ref CAS at the storage layer (already DDL-tested; verifies the
  // higher-level applyRefUpdates returns the rejection envelope shape).
  // -------------------------------------------------------------------------
  describe("B1-C-21 + B1-C-22 ref CAS via applyRefUpdates", () => {
    it("returns 'ok' on a successful create; 'rejected' on stale-old-sha", async () => {
      const rid = mintRepositoryRid();
      await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });

      const created = await applyRefUpdates(ctx.pool, rid, [
        { kind: "create", name: "refs/heads/race", newSha: SHA("a1") },
      ]);
      expect(created.kind).toBe("ok");

      // Two concurrent CAS attempts: only one should win.
      const [a, b] = await Promise.all([
        applyRefUpdates(ctx.pool, rid, [
          { kind: "update", name: "refs/heads/race", oldSha: SHA("a1"), newSha: SHA("b2") },
        ]),
        applyRefUpdates(ctx.pool, rid, [
          { kind: "update", name: "refs/heads/race", oldSha: SHA("a1"), newSha: SHA("c3") },
        ]),
      ]);

      const winners = [a, b].filter((x) => x.kind === "ok");
      const losers = [a, b].filter((x) => x.kind === "rejected");
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);

      const loser = losers[0];
      if (loser.kind !== "rejected") throw new Error("type narrowing");
      expect(loser.rejection.reason).toBe("stale-old-sha");
      expect(loser.rejection.currentTip).toMatch(/^[0-9a-f]{40}$/);
      // The current tip must be one of the two attempted newShas (whichever won).
      expect([SHA("b2"), SHA("c3")]).toContain(loser.rejection.currentTip);
    });

    it("multi-ref atomicity: a rejection on ref #2 rolls back ref #1 (B1-C-22)", async () => {
      const rid = mintRepositoryRid();
      await authed(app)
        .post("/stemma/api/v1/repositories")
        .set("Idempotency-Key", VALID_KEY())
        .send({ rid, defaultBranchName: "main" });

      // Pre-create a ref to make the second update fail with stale-old-sha.
      await applyRefUpdates(ctx.pool, rid, [
        { kind: "create", name: "refs/heads/exists", newSha: SHA("99") },
      ]);

      const out = await applyRefUpdates(ctx.pool, rid, [
        { kind: "create", name: "refs/heads/should-rollback", newSha: SHA("aa") },
        { kind: "update", name: "refs/heads/exists", oldSha: SHA("00"), newSha: SHA("bb") }, // wrong oldSha
      ]);
      expect(out.kind).toBe("rejected");
      if (out.kind !== "rejected") throw new Error("narrowing");
      expect(out.rejection.name).toBe("refs/heads/exists");
      expect(out.rejection.reason).toBe("stale-old-sha");

      // Confirm ref #1 was NOT created (atomic rollback).
      const refsRes = await authed(app).get(
        `/stemma/api/v1/repositories/${encodeURIComponent(rid)}/refs/refs/heads/should-rollback`
      );
      expect(refsRes.status).toBe(404);
      expect(refsRes.body.errorName).toBe("Stemma:RefNotFound");
    });
  });
});
