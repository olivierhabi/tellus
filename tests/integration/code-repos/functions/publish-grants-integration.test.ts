// ---------------------------------------------------------------------------
// Function publish authorization — admin API + real-schema integration tests.
//
// Exercises migration 164 end-to-end:
//   - superadmin-only grant management (create / revoke / list)
//   - audit trail for decisions AND grant lifecycle events
//   - revocation effective on the very next authorizePublish() (no restart)
//   - expiry handled by SQL-side classification against the real clock
//
// The code-repos lane sets FUNCTION_EXECUTION_TRUST_MODE=open-development so
// unrelated lanes can publish freely — this file overrides the trust-mode
// env back to trusted-authors-only to exercise the real gate.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg.js";
import { createFunctionPublishAdminRouter } from "../../../../src/services/functions/admin/routes.js";
import { authorizePublish } from "../../../../src/services/functions/executionPolicy.js";

const REPO_A = "ri.stemma.main.repository.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPO_B = "ri.stemma.main.repository.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "admin-user/tellus-superadmin";
const NON_ADMIN = "bob/READER";

const ENV_KEYS = [
  "FUNCTION_EXECUTION_TRUST_MODE",
  "FUNCTION_TRUSTED_AUTHOR_IDS",
  "FUNCTION_PUBLISH_ROLE",
] as const;
const savedEnv = new Map<string, string | undefined>();

let ctx: SchemaContext;
let app: Express;

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.FUNCTION_EXECUTION_TRUST_MODE = "trusted-authors-only";
  delete process.env.FUNCTION_TRUSTED_AUTHOR_IDS;
  delete process.env.FUNCTION_PUBLISH_ROLE;

  ctx = await openTestSchema("fn_publish_authz");
  await ctx.applyMigrationSql(
    readFileSync(resolve("src/migrations/164_function_publish_authz.sql"), "utf8"),
  );
  // Repo-scope validation target — only the (rid) lookup is exercised.
  await ctx.exec(
    `CREATE TABLE IF NOT EXISTS code_repository (rid TEXT PRIMARY KEY)`,
  );
  await ctx.query(`INSERT INTO code_repository (rid) VALUES ($1), ($2)`, [
    REPO_A,
    REPO_B,
  ]);

  app = express();
  app.use(
    "/api/v1/functions/admin",
    createFunctionPublishAdminRouter({ pool: ctx.pool }),
  );
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  await ctx.close();
});

describe("admin API authorization", () => {
  it("rejects non-admin callers on every endpoint", async () => {
    const base = "/api/v1/functions/admin";
    const create = await request(app)
      .post(`${base}/function-publish-grants`)
      .set("X-Tellus-Test-Principal", NON_ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({ subjectType: "local_user", subjectId: "x", scopeType: "global", reason: "r" });
    expect(create.status).toBe(403);
    expect(create.body.errorName).toBe("Functions:PermissionDenied");

    const list = await request(app)
      .get(`${base}/function-publish-grants`)
      .set("X-Tellus-Test-Principal", NON_ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(list.status).toBe(403);

    const revoke = await request(app)
      .delete(`${base}/function-publish-grants/00000000-0000-0000-0000-000000000000`)
      .set("X-Tellus-Test-Principal", NON_ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(revoke.status).toBe(403);

    const audit = await request(app)
      .get(`${base}/function-publish-audit-log`)
      .set("X-Tellus-Test-Principal", NON_ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(audit.status).toBe(403);
  });
});

describe("grant lifecycle", () => {
  let grantId: string;

  it("creates a global grant; audit records grant_created", async () => {
    const r = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "local_user",
        subjectId: "alice",
        scopeType: "global",
        reason: "test grant",
      });
    expect(r.status).toBe(201);
    expect(r.body.grant).toMatchObject({
      subjectType: "local_user",
      subjectId: "alice",
      scopeType: "global",
      status: "active",
    });
    grantId = r.body.grant.id;

    const { rows } = await ctx.query(
      `SELECT event_type, actor_id, grant_id FROM function_publish_audit_log
        WHERE event_type = 'grant_created'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: "admin-user", grant_id: grantId });
  });

  it("rejects a duplicate active grant (409)", async () => {
    const r = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "local_user",
        subjectId: "alice",
        scopeType: "global",
        reason: "duplicate",
      });
    expect(r.status).toBe(409);
    expect(r.body.errorName).toBe("Functions:GrantConflict");
  });

  it("the grant admits publication immediately (db_grant)", async () => {
    const d = await authorizePublish(ctx.pool, {
      localUserId: "alice",
      repositoryRid: REPO_A,
      releaseTag: "1.0.0",
    });
    expect(d).toMatchObject({ allowed: true, source: "db_grant", grantId });
  });

  it("revocation is effective on the very next request and audited", async () => {
    const r = await request(app)
      .delete(`/api/v1/functions/admin/function-publish-grants/${grantId}`)
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(r.status).toBe(200);
    expect(r.body.grant.status).toBe("revoked");
    expect(r.body.grant.revokedBy).toBe("admin-user");

    const d = await authorizePublish(ctx.pool, {
      localUserId: "alice",
      repositoryRid: REPO_A,
      releaseTag: "1.0.1",
    });
    expect(d.allowed).toBe(false);

    const { rows } = await ctx.query(
      `SELECT event_type FROM function_publish_audit_log
        WHERE event_type = 'grant_revoked' AND grant_id = $1`,
      [grantId],
    );
    expect(rows).toHaveLength(1);
  });

  it("double-revoke is a 404, unknown id is a 404", async () => {
    const again = await request(app)
      .delete(`/api/v1/functions/admin/function-publish-grants/${grantId}`)
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(again.status).toBe(404);
    const missing = await request(app)
      .delete(
        "/api/v1/functions/admin/function-publish-grants/00000000-0000-0000-0000-000000000000",
      )
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(missing.status).toBe(404);
  });
});

describe("grant validation", () => {
  it("repository scope requires an existing repository RID", async () => {
    const noRid = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "local_user",
        subjectId: "carol",
        scopeType: "repository",
        reason: "r",
      });
    expect(noRid.status).toBe(400);

    const unknownRid = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "local_user",
        subjectId: "carol",
        scopeType: "repository",
        scopeRid: "ri.stemma.main.repository.00000000-0000-4000-8000-000000000000",
        reason: "r",
      });
    expect(unknownRid.status).toBe(400);
    expect(unknownRid.body.parameters.reason).toBe("repository-not-found");
  });

  it("rejects missing reason, bad subjectType, and past expiry", async () => {
    const noReason = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({ subjectType: "local_user", subjectId: "carol", scopeType: "global" });
    expect(noReason.status).toBe(400);

    const badType = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "email",
        subjectId: "carol",
        scopeType: "global",
        reason: "r",
      });
    expect(badType.status).toBe(400);

    const pastExpiry = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "local_user",
        subjectId: "carol",
        scopeType: "global",
        reason: "r",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
    expect(pastExpiry.status).toBe(400);
  });
});

describe("scoped + expiring grants against the real clock", () => {
  it("repo-scoped grant admits only its RID; expiry flips the decision to deny", async () => {
    const r = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "local_user",
        subjectId: "carol",
        scopeType: "repository",
        scopeRid: REPO_A,
        reason: "release-window",
        expiresAt: futureIso(60_000),
      });
    expect(r.status).toBe(201);
    const grantId: string = r.body.grant.id;

    const ok = await authorizePublish(ctx.pool, {
      localUserId: "carol",
      repositoryRid: REPO_A,
    });
    expect(ok).toMatchObject({ allowed: true, source: "db_grant", grantId });

    const other = await authorizePublish(ctx.pool, {
      localUserId: "carol",
      repositoryRid: REPO_B,
    });
    expect(other.allowed).toBe(false);

    // Fast-forward: expire it in the database (the POST path refuses past dates).
    await ctx.query(
      `UPDATE function_publish_grants SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [grantId],
    );
    const expired = await authorizePublish(ctx.pool, {
      localUserId: "carol",
      repositoryRid: REPO_A,
    });
    expect(expired).toMatchObject({
      allowed: false,
      reason: "function-publish-grant-expired",
    });

    const { rows } = await ctx.query(
      `SELECT event_type FROM function_publish_audit_log
        WHERE event_type = 'grant_expired_denial' AND grant_id = $1`,
      [grantId],
    );
    expect(rows).toHaveLength(1);
  });

  it("keycloak_sub grants match the IdP identity", async () => {
    const r = await request(app)
      .post("/api/v1/functions/admin/function-publish-grants")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .send({
        subjectType: "keycloak_sub",
        subjectId: "kc-carol",
        scopeType: "global",
        reason: "idp identity",
      });
    expect(r.status).toBe(201);

    const d = await authorizePublish(ctx.pool, {
      localUserId: "someone-else",
      keycloakSub: "kc-carol",
      repositoryRid: REPO_A,
    });
    expect(d).toMatchObject({ allowed: true, source: "db_grant" });
  });
});

describe("list endpoints", () => {
  it("lists grants with status filter + keyset pagination", async () => {
    const active = await request(app)
      .get("/api/v1/functions/admin/function-publish-grants?status=active")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(active.status).toBe(200);
    // carol's (now expired) grant is excluded; the kc-carol grant remains.
    expect(active.body.items.map((g: { subjectId: string }) => g.subjectId)).toEqual([
      "kc-carol",
    ]);

    const page1 = await request(app)
      .get("/api/v1/functions/admin/function-publish-grants?limit=1")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(1);
    expect(page1.body.nextPageToken).toBeTruthy();
    const page2 = await request(app)
      .get(
        `/api/v1/functions/admin/function-publish-grants?limit=1&cursor=${encodeURIComponent(page1.body.nextPageToken)}`,
      )
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(page2.status).toBe(200);
    expect(page2.body.items).toHaveLength(1);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it("lists audit events with filters", async () => {
    const r = await request(app)
      .get(
        "/api/v1/functions/admin/function-publish-audit-log?eventType=grant_created",
      )
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(r.status).toBe(200);
    expect(r.body.totalCount).toBe(3); // alice global + carol repo + kc-carol global
    const subject = await request(app)
      .get("/api/v1/functions/admin/function-publish-audit-log?subject=alice")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(
      subject.body.items.every(
        (row: { subjectId: string }) => row.subjectId === "alice",
      ),
    ).toBe(true);
    const badFilter = await request(app)
      .get("/api/v1/functions/admin/function-publish-audit-log?eventType=nope")
      .set("X-Tellus-Test-Principal", ADMIN)
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "");
    expect(badFilter.status).toBe(400);
  });
});
