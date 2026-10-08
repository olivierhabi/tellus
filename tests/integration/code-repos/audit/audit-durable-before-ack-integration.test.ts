// ---------------------------------------------------------------------------
// tests/integration/code-repos/audit/audit-durable-before-ack-integration.test.ts
//
// Spec contracts asserted (against real Postgres):
//   G-C-52   The audit row MUST be durable BEFORE the HTTP response is
//            acknowledged. Equivalently: if the audit insert fails, the
//            data edit MUST roll back with it. There is no scenario in
//            which a 2xx response describes data that was committed but
//            an audit row that was NOT.
//
// Why a separate file?
//   The sabotage scenario corrupts the singleton hash-head pointer; if
//   it ran in the same schema as the verifyChainSegment tests, the
//   verifier would fail on subsequent tests because the chain links are
//   broken after the sabotage. Each test file gets its own schema, so
//   the sabotage's blast radius is bounded to this file.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import { createStemmaAdminApp } from "../../../../src/services/stemma/admin/app";
import { mintRepositoryRid } from "../../../../src/services/codeRepos/contracts/rid";
import { randomUUID } from "crypto";

describe("Code Repos audit — G-C-52 durable-before-ack", () => {
  let ctx: SchemaContext;
  let app: ReturnType<typeof createStemmaAdminApp>;

  beforeAll(async () => {
    ctx = await openTestSchema("audit_durable");
    await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    await ctx.applyMigration("src/migrations/051_code_repos_audit.sql");
    app = createStemmaAdminApp({ pool: ctx.pool });
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  it("when the audit head pointer is missing, response is 4xx/5xx and the data edit is rolled back", async () => {
    const rid = mintRepositoryRid();

    // Sabotage: delete the singleton head row. The next call to
    // insertCodeReposAuditEvent will throw AUDIT_CHAIN_HEAD_MISSING
    // inside the route handler's SERIALIZABLE tx, and the data edit
    // (the stemma_repository row + the HEAD ref) MUST roll back with
    // the audit failure. This is the durable-before-ack invariant.
    await ctx.exec("DELETE FROM code_repos_audit_hash_head WHERE id = 1");

    const r = await request(app)
      .post("/stemma/api/v1/repositories")
      .set("X-Tellus-Test-Principal", "sabotage-test/OWNER")
      .set("X-Tellus-Test-Auth-Token", process.env.CODE_REPOS_TEST_AUTH_TOKEN ?? "")
      .set("Idempotency-Key", randomUUID())
      .send({ rid, defaultBranchName: "main" });

    // Whatever the exact status (the catch in routes.ts maps unknown
    // errors to 400 INVALID_ARGUMENT), it MUST NOT be 2xx.
    expect(r.status).toBeGreaterThanOrEqual(400);

    // The data edit MUST have rolled back. If the repo row exists, the
    // durable-before-ack invariant is broken.
    const repoCheck = await ctx.query<{ rid: string }>(
      `SELECT rid FROM stemma_repository WHERE rid = $1`,
      [rid],
    );
    expect(repoCheck.rowCount).toBe(0);

    // And the HEAD ref also must NOT exist (it's part of the same tx).
    const refCheck = await ctx.query<{ name: string }>(
      `SELECT name FROM stemma_ref WHERE repository_rid = $1`,
      [rid],
    );
    expect(refCheck.rowCount).toBe(0);
  });
});
