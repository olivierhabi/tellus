// ---------------------------------------------------------------------------
// tests/integration/code-repos/middleware/idempotency-integration.test.ts
//
// Spec contracts asserted (against real Postgres):
//   G-C-20  POST without Idempotency-Key → 400 Stemma:MissingIdempotencyKey
//   G-C-21  Idempotency keys are scoped per-principal — same key from a
//           different principal is a fresh request, not a replay
//   G-C-22  Same key + different request body → 409 IdempotencyConflict;
//           the response of the first call is NOT replayed
//   G-C-25  Replay (same key + same body) returns the captured response
//           verbatim with header X-Idempotent-Replay: true
//
// The idempotency table (`code_repos_idempotency`) has 24h TTL; we don't
// directly test the TTL purge here (that's a separate cron concern), but
// we assert that an expired row would not block a fresh write by manually
// expiring it and replaying.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import { createStemmaAdminApp } from "../../../../src/services/stemma/admin/app";
import { mintRepositoryRid } from "../../../../src/services/codeRepos/contracts/rid";
import { isExactEnvelope } from "../../../../src/services/codeRepos/contracts/errors";
import { randomUUID } from "crypto";

function postRepo(
  app: import("express").Express,
  principal: string,
  key: string,
  body: Record<string, unknown>,
) {
  return request(app)
    .post("/stemma/api/v1/repositories")
    .set("X-Tellus-Test-Principal", principal)
    .set("Idempotency-Key", key)
    .send(body);
}

describe("Code Repos idempotency middleware — replay + conflict + scope", () => {
  let ctx: SchemaContext;
  let app: ReturnType<typeof createStemmaAdminApp>;

  beforeAll(async () => {
    ctx = await openTestSchema("idempotency_mw");
    await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    await ctx.applyMigration("src/migrations/051_code_repos_audit.sql");
    app = createStemmaAdminApp({ pool: ctx.pool });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  // -------------------------------------------------------------------------
  // G-C-20 — required header
  // -------------------------------------------------------------------------
  it("G-C-20 missing Idempotency-Key → 400 Stemma:MissingIdempotencyKey", async () => {
    const r = await request(app)
      .post("/stemma/api/v1/repositories")
      .set("X-Tellus-Test-Principal", "user-a/OWNER")
      .send({ rid: mintRepositoryRid(), defaultBranchName: "main" });
    expect(r.status).toBe(400);
    expect(isExactEnvelope(r.body)).toBe(true);
    expect(r.body.errorName).toBe("Stemma:MissingIdempotencyKey");
    expect(r.body.errorCode).toBe("INVALID_ARGUMENT");
  });

  it("G-C-20 malformed Idempotency-Key → 400 Stemma:InvalidIdempotencyKey", async () => {
    const r = await request(app)
      .post("/stemma/api/v1/repositories")
      .set("X-Tellus-Test-Principal", "user-a/OWNER")
      .set("Idempotency-Key", "definitely-not-a-uuid")
      .send({ rid: mintRepositoryRid(), defaultBranchName: "main" });
    expect(r.status).toBe(400);
    expect(r.body.errorName).toBe("Stemma:InvalidIdempotencyKey");
  });

  // -------------------------------------------------------------------------
  // G-C-25 — same key + same body = replay
  // -------------------------------------------------------------------------
  it("G-C-25 same key + same body returns captured response with X-Idempotent-Replay header", async () => {
    const rid = mintRepositoryRid();
    const key = randomUUID();
    const body = { rid, defaultBranchName: "main" };

    const first = await postRepo(app, "user-a/OWNER", key, body);
    expect(first.status).toBe(201);
    expect(first.headers["x-idempotent-replay"]).toBeUndefined();

    const second = await postRepo(app, "user-a/OWNER", key, body);
    expect(second.status).toBe(201);
    expect(second.headers["x-idempotent-replay"]).toBe("true");
    // Body is byte-identical to the first response.
    expect(second.body).toEqual(first.body);
    // ETag is replayed too.
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it("G-C-25 only ONE audit row is written across replay (the first response is reused, not re-emitted)", async () => {
    const rid = mintRepositoryRid();
    const key = randomUUID();
    const body = { rid, defaultBranchName: "main" };

    const first = await postRepo(app, "user-b/OWNER", key, body);
    expect(first.status).toBe(201);
    const second = await postRepo(app, "user-b/OWNER", key, body);
    expect(second.status).toBe(201);

    const audit = await ctx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM code_repos_audit_events
        WHERE target_rid = $1 AND action = 'createRepository'`,
      [rid],
    );
    // Exactly one — the replay path short-circuits before the route
    // handler runs, so insertCodeReposAuditEvent is not called twice.
    expect(audit.rows[0].count).toBe("1");
  });

  // -------------------------------------------------------------------------
  // G-C-22 — same key + different body = 409 IdempotencyConflict
  // -------------------------------------------------------------------------
  it("G-C-22 same key + different body → 409 IdempotencyConflict; second body is NOT honoured", async () => {
    const ridFirst = mintRepositoryRid();
    const ridSecond = mintRepositoryRid();
    const key = randomUUID();

    const first = await postRepo(app, "user-c/OWNER", key, {
      rid: ridFirst,
      defaultBranchName: "main",
    });
    expect(first.status).toBe(201);

    const conflict = await postRepo(app, "user-c/OWNER", key, {
      // Different body — same key.
      rid: ridSecond,
      defaultBranchName: "trunk",
    });
    expect(conflict.status).toBe(409);
    expect(isExactEnvelope(conflict.body)).toBe(true);
    expect(conflict.body.errorName).toBe("Stemma:IdempotencyConflict");
    expect(conflict.body.errorCode).toBe("CONFLICT");

    // The "different" repo MUST NOT have been created.
    const repoCheck = await ctx.query<{ rid: string }>(
      `SELECT rid FROM stemma_repository WHERE rid = $1`,
      [ridSecond],
    );
    expect(repoCheck.rowCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // G-C-21 — per-principal scoping
  // -------------------------------------------------------------------------
  it("G-C-21 same key from a DIFFERENT principal is treated as a fresh request", async () => {
    const ridA = mintRepositoryRid();
    const ridB = mintRepositoryRid();
    const sharedKey = randomUUID();

    const userA = await postRepo(app, "alice/OWNER", sharedKey, {
      rid: ridA,
      defaultBranchName: "main",
    });
    expect(userA.status).toBe(201);

    // Bob uses the SAME key with a DIFFERENT body. Because the dedup
    // scope is per-principal, this must NOT 409 — it's a fresh write.
    const userB = await postRepo(app, "bob/OWNER", sharedKey, {
      rid: ridB,
      defaultBranchName: "trunk",
    });
    expect(userB.status).toBe(201);
    expect(userB.headers["x-idempotent-replay"]).toBeUndefined();

    // Both repos exist.
    const both = await ctx.query<{ rid: string }>(
      `SELECT rid FROM stemma_repository WHERE rid = ANY($1::text[])`,
      [[ridA, ridB]],
    );
    expect(both.rowCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // TTL — expired rows do not block a fresh write
  // -------------------------------------------------------------------------
  it("expired idempotency rows are ignored (TTL surface)", async () => {
    const rid = mintRepositoryRid();
    const key = randomUUID();
    const body = { rid, defaultBranchName: "main" };

    const first = await postRepo(app, "ttl-user/OWNER", key, body);
    expect(first.status).toBe(201);

    // The idempotency row is persisted by the middleware in a
    // `res.on("finish")` handler — fire-and-forget after the HTTP
    // response is flushed. On a slow runner, our manual UPDATE below
    // can race the async INSERT and lose, after which the middleware's
    // INSERT overwrites with a fresh expires_at=+24h row, breaking the
    // "expired" precondition. Poll the table until the row exists so
    // the UPDATE is deterministic.
    for (let i = 0; i < 50; i += 1) {
      const r = await ctx.query<{ idem_key: string }>(
        `SELECT idem_key FROM code_repos_idempotency
          WHERE principal_user_id = 'ttl-user' AND idem_key = $1`,
        [key],
      );
      if (r.rowCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Manually expire the row — production purge cron does this every
    // hour; we simulate by setting both created_at AND expires_at into
    // the past so the CHECK (expires_at > created_at) still holds.
    const upd = await ctx.query(
      `UPDATE code_repos_idempotency
          SET created_at = now() - interval '2 hour',
              expires_at = now() - interval '1 hour'
        WHERE principal_user_id = 'ttl-user' AND idem_key = $1`,
      [key],
    );
    // Sanity: precondition for this test only holds if the UPDATE
    // matched a row. Surfaces any future regression in the wait loop.
    expect(upd.rowCount).toBe(1);

    // Replay with same key + same body — but expired. Behaviour: the
    // middleware ignores the expired row and the route runs again,
    // which now sees the existing repo and returns 200 (not 201) via
    // the createRepositoryWithinTx idempotency path. The middleware
    // overwrites the now-stale idempotency row with a fresh one.
    const second = await postRepo(app, "ttl-user/OWNER", key, body);
    // Either 200 (DB-level idempotency saw existing repo) or 201
    // (depending on race) — both are acceptable. The contract is that
    // it succeeds; the middleware did NOT short-circuit with the
    // expired row.
    expect([200, 201]).toContain(second.status);
    expect(second.headers["x-idempotent-replay"]).toBeUndefined();
  });
});
