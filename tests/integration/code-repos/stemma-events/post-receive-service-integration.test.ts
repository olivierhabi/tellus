// ---------------------------------------------------------------------------
// tests/integration/code-repos/stemma-events/post-receive-service-integration.test.ts
//
// Spec contracts:
//   B10-C-03  post-receive: write one stemma_event per ALLOWed update,
//             plus one audit row, in ONE Postgres transaction
//   B10-C-15  fan-out is async — the audit + event commit even if the
//             dispatcher fails to deliver a callback later
//   G-C-51    one audit row per mutating action
//   G-C-52    audit row durable BEFORE the call returns (event row
//             rolls back if audit row write fails)
// ---------------------------------------------------------------------------

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import { recordPostReceive } from "../../../../src/services/stemmaEvents/postReceiveService";
import { createSubscription } from "../../../../src/services/stemmaEvents/store/subscriptionStore";
import type {
  CallbackDelivery,
  DispatcherDeps,
} from "../../../../src/services/stemmaEvents/dispatcher/callbackDispatcher";

const REPO_RID =
  "ri.stemma.main.repository.99999999-9999-4999-a999-999999999999";

function freshInput() {
  return {
    repositoryRid: REPO_RID,
    eventType: "PUSH" as const,
    ref: "refs/heads/main",
    oldSha: "0000000000000000000000000000000000000000",
    newSha: "abcdef0123456789abcdef0123456789abcdef01",
    principalUserId: "11111111-1111-1111-1111-111111111111",
    principalSub: "11111111-1111-1111-1111-111111111111",
    principalSource: "bearer-jwt" as const,
    requestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    sourceIp: "127.0.0.1",
    userAgent: "vitest",
    payload: { author: "alice" },
  };
}

describe("B10 — recordPostReceive orchestrator (event + audit + fan-out)", () => {
  let ctx: SchemaContext;

  beforeAll(async () => {
    ctx = await openTestSchema("post_receive_svc");
    await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    await ctx.applyMigration("src/migrations/051_code_repos_audit.sql");
    await ctx.applyMigration("src/migrations/052_b10_stemma_events.sql");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  it("writes exactly one stemma_event AND exactly one audit row per call (G-C-51)", async () => {
    const before = await ctx.query(
      "SELECT (SELECT count(*)::int FROM stemma_event) AS e, (SELECT count(*)::int FROM code_repos_audit_events) AS a",
    );
    const beforeRow = before.rows[0] as { e: number; a: number };

    const result = await recordPostReceive({ pool: ctx.pool }, freshInput());
    expect(result.event.rid).toMatch(/^ri\.stemma\.main\.event\./);
    expect(result.auditRowId).toMatch(/^[0-9a-f-]{36}$/);

    const after = await ctx.query(
      "SELECT (SELECT count(*)::int FROM stemma_event) AS e, (SELECT count(*)::int FROM code_repos_audit_events) AS a",
    );
    const afterRow = after.rows[0] as { e: number; a: number };

    expect(afterRow.e - beforeRow.e).toBe(1);
    expect(afterRow.a - beforeRow.a).toBe(1);
  });

  it("audit row's parameters reference the event rid + ref + sha", async () => {
    const result = await recordPostReceive(
      { pool: ctx.pool },
      { ...freshInput(), ref: "refs/heads/feature/x" },
    );
    const r = await ctx.query<{ parameters: Record<string, unknown> }>(
      "SELECT parameters FROM code_repos_audit_events WHERE audit_id = $1",
      [result.auditRowId],
    );
    expect(r.rowCount).toBe(1);
    const p = r.rows[0].parameters;
    expect(p.eventRid).toBe(result.event.rid);
    expect(p.ref).toBe("refs/heads/feature/x");
    expect(p.eventType).toBe("PUSH");
  });

  it("event row + audit row are atomic — failing audit insert rolls back the event (G-C-52)", async () => {
    // Sabotage: drop the audit head pointer mid-flight. The event INSERT
    // runs first (fine), then the audit INSERT throws AUDIT_CHAIN_HEAD_MISSING,
    // and withTx rolls back BOTH.
    await ctx.exec("DELETE FROM code_repos_audit_hash_head WHERE id = 1");

    const beforeE = await ctx.query("SELECT count(*)::int AS n FROM stemma_event");
    const beforeECount = (beforeE.rows[0] as { n: number }).n;

    await expect(
      recordPostReceive({ pool: ctx.pool }, freshInput()),
    ).rejects.toThrow();

    const afterE = await ctx.query("SELECT count(*)::int AS n FROM stemma_event");
    expect((afterE.rows[0] as { n: number }).n - beforeECount).toBe(0);

    // Restore so subsequent tests in this file (none here, but defensive)
    // don't fail. Use the genesis hash.
    await ctx.exec(`
      INSERT INTO code_repos_audit_hash_head (id, head_hash, head_audit_id, head_seq)
      VALUES (1,
        'f5231d667c23085fdcfc58be156f84a21ef7de2cdeefc4e5f23011ad81a8efb8',
        '00000000-0000-0000-0000-000000000000', 0)
    `);
  });

  it("synchronousDispatch=true delivers to matching subscribers in the same call", async () => {
    // Fresh isolated schema for this test so prior subscriptions don't
    // leak in.
    const ctx2 = await openTestSchema("post_receive_dispatch");
    try {
      await ctx2.applyMigration("src/migrations/050_stemma_ddl.sql");
      await ctx2.applyMigration("src/migrations/051_code_repos_audit.sql");
      await ctx2.applyMigration("src/migrations/052_b10_stemma_events.sql");

      const subRid = `ri.stemma.main.subscription.subsubsu-bsub-4sub-bsub-subsubsubsub`;
      await createSubscription(ctx2.pool, {
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: REPO_RID,
        targetUri: "https://collected.test/hook",
        secretEncrypted: "shh",
      });

      const captured: { url: string }[] = [];
      const deliver: CallbackDelivery = async (req) => {
        captured.push({ url: req.url });
        return { status: 200 };
      };
      const dispatcher: DispatcherDeps = {
        pool: ctx2.pool,
        deliver,
        decryptSecret: (e) => e,
      };

      const result = await recordPostReceive(
        {
          pool: ctx2.pool,
          dispatcher,
          synchronousDispatch: true,
        },
        freshInput(),
      );

      expect(result.dispatch).toBeDefined();
      const r = result.dispatch?.find((x) => x.subscriptionRid === subRid);
      expect(r?.outcome).toBe("delivered");
      expect(captured).toEqual([{ url: "https://collected.test/hook" }]);
    } finally {
      await ctx2.close();
    }
  });

  it("a failing dispatcher does NOT roll back the audit + event (B10-C-15)", async () => {
    const ctx2 = await openTestSchema("post_receive_dispatch_fails");
    try {
      await ctx2.applyMigration("src/migrations/050_stemma_ddl.sql");
      await ctx2.applyMigration("src/migrations/051_code_repos_audit.sql");
      await ctx2.applyMigration("src/migrations/052_b10_stemma_events.sql");

      const subRid = `ri.stemma.main.subscription.failsubs-fail-4sub-fail-failfailfail`;
      await createSubscription(ctx2.pool, {
        rid: subRid,
        eventTypes: ["PUSH"],
        repositoryRid: REPO_RID,
        targetUri: "https://will-throw.test/hook",
        secretEncrypted: "shh",
      });

      const deliver: CallbackDelivery = async () => {
        throw new Error("network down");
      };
      const dispatcher: DispatcherDeps = {
        pool: ctx2.pool,
        deliver,
        decryptSecret: (e) => e,
      };

      // Snapshot counts BEFORE recordPostReceive — migration 051 seeds
      // a genesis row in code_repos_audit_events, so absolute counts
      // are not zero on a fresh schema. Delta semantics make this test
      // robust to seed-row changes.
      const before = await ctx2.query(
        "SELECT (SELECT count(*)::int FROM stemma_event) AS e, (SELECT count(*)::int FROM code_repos_audit_events) AS a",
      );
      const beforeRow = before.rows[0] as { e: number; a: number };

      const result = await recordPostReceive(
        {
          pool: ctx2.pool,
          dispatcher,
          synchronousDispatch: true,
        },
        freshInput(),
      );

      // Event + audit landed despite the dispatch failure.
      const after = await ctx2.query(
        "SELECT (SELECT count(*)::int FROM stemma_event) AS e, (SELECT count(*)::int FROM code_repos_audit_events) AS a",
      );
      const afterRow = after.rows[0] as { e: number; a: number };
      expect(afterRow.e - beforeRow.e).toBe(1);
      expect(afterRow.a - beforeRow.a).toBe(1);
      // Dispatch outcome surfaces the failure — but the call returned
      // normally (no throw).
      const r = result.dispatch?.find((x) => x.subscriptionRid === subRid);
      expect(r?.outcome).toBe("failed");
    } finally {
      await ctx2.close();
    }
  });
});
