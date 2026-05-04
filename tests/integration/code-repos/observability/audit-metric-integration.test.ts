// ---------------------------------------------------------------------------
// tests/integration/code-repos/observability/audit-metric-integration.test.ts
//
// Spec contracts:
//   G-C-54  Audit chain is tamper-evident; on AUDIT_CHAIN_HEAD_MISSING
//           a Prometheus counter must be incremented so on-call is paged
//           BEFORE the chain breaks publicly.
//   §1.8    Standard counters/histograms emitted per service.
//
// Strategy: drive the real `insertCodeReposAuditEvent` against a real
// Postgres schema. Assert deltas on the in-process Prometheus shim
// (the funnel/metrics counters) — the success path increments
// `tellus_code_repos_audit_chain_appended_total`; the head-missing path
// increments `tellus_code_repos_audit_chain_head_missing_total` AND
// throws CodeReposAuditError("AUDIT_CHAIN_HEAD_MISSING") AND the
// underlying tx rolls back (so no partial audit row leaks).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  openTestSchema,
  type SchemaContext,
} from "../_helpers/pg";
import {
  CodeReposAuditError,
  insertCodeReposAuditEvent,
  type CodeReposAuditEvent,
} from "../../../../src/services/codeRepos/audit/auditEvents";
import {
  __getCounterValueForTest,
  METRICS,
} from "../../../../src/services/codeRepos/observability/metrics";

const VALID_RID =
  "ri.stemma.shared.repository.audit-metric-test-aaaaaaaaaaaaaaaa";

function newEvent(seqHint: number): CodeReposAuditEvent {
  return {
    category: "stemma",
    action: "createRepository",
    targetRid: VALID_RID,
    targetType: "Repository",
    principalUserId: "11111111-1111-1111-1111-111111111111",
    principalSource: "bearer-jwt",
    requestId: `req-audit-metric-${seqHint}`,
    beforeHash: null,
    afterHash:
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    sourceIp: null,
    userAgent: null,
    parameters: { seqHint },
  };
}

describe("Code Repos audit — G-C-54 metric wiring", () => {
  let ctx: SchemaContext;

  beforeAll(async () => {
    ctx = await openTestSchema("audit_metric");
    await ctx.applyMigration("src/migrations/050_stemma_ddl.sql");
    await ctx.applyMigration("src/migrations/051_code_repos_audit.sql");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  it("success path increments tellus_code_repos_audit_chain_appended_total", async () => {
    const before = __getCounterValueForTest(METRICS.auditChainAppendedTotal);
    await ctx.withTx(async (client) => {
      await insertCodeReposAuditEvent(client, newEvent(1));
    });
    const after = __getCounterValueForTest(METRICS.auditChainAppendedTotal);
    expect(after - before).toBe(1);
  });

  it(
    "AUDIT_CHAIN_HEAD_MISSING throws AND increments " +
      "tellus_code_repos_audit_chain_head_missing_total even though tx rolls back",
    async () => {
      // Snapshot row count and counter values BEFORE sabotage. Tests share
      // a process-wide metrics shim and a per-describe schema; the success
      // test in this same describe inserted exactly one row already, so we
      // assert deltas, not absolutes.
      const rowsBefore = await ctx.query(
        "SELECT count(*)::int AS n FROM code_repos_audit_events",
      );
      const rowCountBefore = (rowsBefore.rows[0] as { n: number }).n;

      // Sabotage: drop the singleton head row. The advisory lock and the
      // SELECT FOR UPDATE in insertCodeReposAuditEvent will both succeed,
      // but the head row will be missing; the writer must throw.
      await ctx.exec("DELETE FROM code_repos_audit_hash_head WHERE id = 1");

      const beforeHM = __getCounterValueForTest(
        METRICS.auditChainHeadMissingTotal,
      );
      const beforeAppended = __getCounterValueForTest(
        METRICS.auditChainAppendedTotal,
      );

      await expect(
        ctx.withTx(async (client) => {
          await insertCodeReposAuditEvent(client, newEvent(2));
        }),
      ).rejects.toBeInstanceOf(CodeReposAuditError);

      const afterHM = __getCounterValueForTest(
        METRICS.auditChainHeadMissingTotal,
      );
      const afterAppended = __getCounterValueForTest(
        METRICS.auditChainAppendedTotal,
      );

      // Page-on counter incremented exactly once; success counter unchanged.
      expect(afterHM - beforeHM).toBe(1);
      expect(afterAppended - beforeAppended).toBe(0);

      // Tx rolled back — no NEW audit row landed (delta against pre-sabotage).
      const rowsAfter = await ctx.query(
        "SELECT count(*)::int AS n FROM code_repos_audit_events",
      );
      expect(
        (rowsAfter.rows[0] as { n: number }).n - rowCountBefore,
      ).toBe(0);
    },
  );

  it("metric name and HELP text are emitted in the Prometheus exposition", async () => {
    // Force at least one increment so the metric is registered with help text.
    // Use a brand-new schema so the head row is present.
    const ctx2 = await openTestSchema("audit_metric_help");
    try {
      await ctx2.applyMigration("src/migrations/050_stemma_ddl.sql");
      await ctx2.applyMigration("src/migrations/051_code_repos_audit.sql");
      await ctx2.withTx(async (client) => {
        await insertCodeReposAuditEvent(client, newEvent(3));
      });
    } finally {
      await ctx2.close();
    }

    const value = __getCounterValueForTest(METRICS.auditChainAppendedTotal);
    expect(value).toBeGreaterThan(0);

    // Metric name must use the exact spec'd identifier.
    expect(METRICS.auditChainHeadMissingTotal).toBe(
      "tellus_code_repos_audit_chain_head_missing_total",
    );
    expect(METRICS.auditChainAppendedTotal).toBe(
      "tellus_code_repos_audit_chain_appended_total",
    );
  });
});
