// ---------------------------------------------------------------------------
// Transactional link-CDC outbox: in-txn staging, idempotent+retryable drain
// with bounded backoff, and dead-letter terminal state. Persistent table:
// migrations/153_link_cdc_outbox.sql.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  stageLinkCdcEvent,
  drainLinkOutboxOnce,
} from "../../../src/services/searchAround/linkCdcOutbox";
import type { PoolClient } from "pg";

describe("stageLinkCdcEvent", () => {
  it("inserts the outbox row atomically on the caller's transaction", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as PoolClient;

    await stageLinkCdcEvent(tx, {
      eventId: "11111111-1111-1111-1111-111111111111",
      sourceObjectType: "Order",
      linkTypeApiName: "ownedBy",
      sourcePrimaryKey: "O-1",
      targetPrimaryKey: "C-1",
      operation: "REMOVE",
      ontologyId: "ont-1",
      branchId: "main",
      correlationId: "corr-1",
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("INSERT INTO link_cdc_outbox");
    expect(queries[0].sql).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(queries[0].params).toContain("cdc.links.order.ownedby");
    expect(queries[0].params).toContain("REMOVE");
    expect(queries[0].params).toContain("ont-1");
    expect(queries[0].params).toContain("main");
    const payload = JSON.parse(queries[0].params[10] as string);
    expect(payload.operation).toBe("REMOVE");
    expect(payload.event_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(payload.branch_id).toBe("main");
  });
});

describe("drainLinkOutboxOnce", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  async function setup(pending: Array<{ event_id: string; topic: string; payload: unknown; publish_attempts: number }>) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const dbMod = await import("../../../src/db");
    vi.spyOn(dbMod, "query").mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/SELECT[\s\S]*FROM link_cdc_outbox/i.test(String(sql))) {
        return { rows: pending as never, rowCount: pending.length } as never;
      }
      executed.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 } as never;
    });
    const prod = await import("../../../src/services/searchAround/cdcLinkProducer");
    const publish = vi.spyOn(prod, "publishRowsToTopic");
    return { executed, publish };
  }

  it("publishes rows accepted by the broker and stamps published_at", async () => {
    const { executed, publish } = await setup([
      { event_id: "00000000-0000-0000-0000-0000000000a1", topic: "cdc.links.x.y", payload: { source_pk: "a", target_pk: "b" }, publish_attempts: 0 },
    ]);
    publish.mockResolvedValue(1);
    const res = await drainLinkOutboxOnce(500);
    expect(res).toEqual({ scanned: 1, published: 1, retrying: 0, deadLettered: 0 });
    expect(executed.some((q) => /SET published_at = now\(\)/.test(q.sql))).toBe(true);
  });

  it("broker failure schedules a bounded retry — never fabricates publication", async () => {
    const { executed, publish } = await setup([
      { event_id: "00000000-0000-0000-0000-0000000000a2", topic: "cdc.links.x.y", payload: { source_pk: "a", target_pk: "b" }, publish_attempts: 1 },
    ]);
    publish.mockResolvedValue(0); // broker unreachable
    const res = await drainLinkOutboxOnce(500);
    expect(res.published).toBe(0);
    expect(res.retrying).toBe(1);
    const retry = executed.find((q) => /next_attempt_at = \$2/.test(q.sql));
    expect(retry).toBeDefined();
    const nextAt = new Date(retry!.params[1] as string).getTime();
    expect(nextAt).toBeGreaterThan(Date.now());
    expect(nextAt).toBeLessThan(Date.now() + 120_000);
    expect(executed.some((q) => /published_at/.test(q.sql))).toBe(false);
  });

  it("exhausted attempts dead-letter the row and never mark it published", async () => {
    const { executed, publish } = await setup([
      { event_id: "00000000-0000-0000-0000-0000000000a3", topic: "cdc.links.x.y", payload: { source_pk: "a", target_pk: "b" }, publish_attempts: 20 },
    ]);
    publish.mockResolvedValue(1);
    const res = await drainLinkOutboxOnce(500, 20);
    expect(res.published).toBe(0);
    expect(res.deadLettered).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(executed.some((q) => /dead_lettered_at = now\(\)/.test(q.sql))).toBe(true);
  });

  it("empty backlog is a no-op", async () => {
    const { executed } = await setup([]);
    const res = await drainLinkOutboxOnce();
    expect(res.scanned).toBe(0);
    expect(executed).toEqual([]);
  });
});
