// ---------------------------------------------------------------------------
// Stage 3 — edge-index confirmation watermarks (unit).
//
// Proves against mocked PG + ClickHouse:
//   * per-event confirmation resolves ONLY when every event is visible
//     in the scoped edge table;
//   * timeout/outage DEFERS (confirmed:false) — completion is never
//     fabricated; no visible mark is stamped on the watermark table for a
//     non-confirmed event;
//   * the counters/gauges/histogram exposed for ops;
//   * StoreWatermarkTimeout on the sound set-diff barrier;
//   * window-limit guard on waitForLinkWatermark;
//   * stageLinkCdcEvent assigns + embeds the monotonic outbox_seq.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach } from "vitest";
import {
  confirmEdgeIndexVisibility,
  waitForLinkWatermark,
  WATERMARK_WINDOW_LIMIT,
  BARRIER_EPSILON_MS,
} from "../../../src/services/serving/edgeIndexWatermark";
import {
  stageLinkCdcEvent,
  type StageLinkCdcInput,
} from "../../../src/services/searchAround/linkCdcOutbox";
import { __resetMetricsForTesting, renderPrometheus } from "../../../src/services/funnel/metrics";
import { StoreWatermarkTimeout } from "../../../src/services/serving/contracts";

const DESCRIPTOR = {
  sourceObjectType: "SrcType",
  linkName: "ownedBy",
  targetObjectType: "TgtType",
};
const SCOPE = { tenantId: "", ontologyId: "ont-1", branchId: "main" };

function makeDeps(overrides: {
  hits?: number;
  maxSeq?: number;
  maxVersion?: number;
  chCls?: Array<{ outbox_seq: number }>;
  throwCh?: boolean;
  pgSequences?: number[] | null;
}) {
  const calls: { sql: string[]; pg: Array<{ text: string; params?: unknown[] }> } = {
    sql: [],
    pg: [],
  };
  const chCls = overrides.chCls; // rows for the DISTINCT query in waitForLinkWatermark
  const chExec = async <T>(sql: string): Promise<T[]> => {
    calls.sql.push(sql);
    if (overrides.throwCh) throw new Error("connection refused");
    if (sql.includes("countIf")) {
      return [
        {
          hits: overrides.hits ?? 0,
          max_seq: overrides.maxSeq ?? 0,
          max_version: overrides.maxVersion ?? 0,
        },
      ] as unknown as T[];
    }
    if (sql.includes("SELECT DISTINCT outbox_seq")) {
      return (chCls ?? []) as unknown as T[];
    }
    return [
      { max_seq: overrides.maxSeq ?? 0, max_version: overrides.maxVersion ?? 0 },
    ] as unknown as T[];
  };
  const pgQuery = async (text: string, params?: unknown[]) => {
    calls.pg.push({ text, params });
    if (text.includes("INSERT INTO link_edge_watermarks")) return { rows: [] };
    if (text.includes("FROM link_cdc_outbox")) {
      const seqs = overrides.pgSequences ?? [];
      return { rows: seqs.map((outbox_seq) => ({ outbox_seq })) };
    }
    return { rows: [] };
  };
  // Real sleep with tiny polls — each test gives a small timeout so the
  // loop still exercises its polling semantics rather than being
  // short-circuited by a fake clock.
  const deps = {
    chExec,
    pgQuery,
    resolveDescriptor: async () => DESCRIPTOR,
    sleep: async () => {},
  };
  return { deps, calls };
}

beforeEach(() => __resetMetricsForTesting());

describe("confirmEdgeIndexVisibility", () => {
  it("resolves confirmed:true when EVERY handle is visible; watermarks observed with max values", async () => {
    const { deps, calls } = makeDeps({ hits: 1, maxSeq: 77, maxVersion: 999 });
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e1", outboxSeq: 70, linkTypeApiName: "ownedBy", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 2_000,
      deps,
    });
    expect(out.confirmed).toBe(true);
    expect(out.deferred).toBe(0);
    // Per-scope watermark stats were upserted with the observed maxes.
    const upsert = calls.pg.find((c) => c.text.includes("INSERT INTO link_edge_watermarks"));
    expect(upsert).toBeDefined();
    expect(upsert!.params).toEqual(["default", "ont-1", "main", "ownedBy", 77, 999]);
  });

  it("invisible handle ⇒ polls to the deadline, DEFERS, and never writes a watermark row", async () => {
    const { deps, calls } = makeDeps({ hits: 0 });
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e2", outboxSeq: 88, linkTypeApiName: "ownedBy", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 50,
      pollMs: 10,
      deps: { ...deps, sleep: async (ms: number) => new Promise((r) => setTimeout(r, ms)) },
    });
    expect(out.confirmed).toBe(false);
    expect(out.deferred).toBe(1);
    expect(out.reason).toBe("timeout");
    expect(calls.pg.some((c) => c.text.includes("INSERT INTO link_edge_watermarks"))).toBe(false);
    expect(renderPrometheus()).toContain('link_index_ack_deferred_total{reason="timeout"} 1');
    expect(renderPrometheus()).toContain("link_index_ack_wait_seconds");
  });

  it("ClickHouse outage ⇒ kept probing; on the deadline defers with reason=index_outage", async () => {
    const { deps } = makeDeps({ throwCh: true });
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e3", outboxSeq: 1, linkTypeApiName: "ownedBy", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 30,
      pollMs: 5,
      deps: { ...deps, sleep: async (ms: number) => new Promise((r) => setTimeout(r, ms)) },
    });
    expect(out.confirmed).toBe(false);
    expect(out.reason).toBe("index_outage");
  });

  it("unknown link type ⇒ deferred immediately, never confirmed", async () => {
    const { deps } = makeDeps({});
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e4", outboxSeq: 1, linkTypeApiName: "ghost", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 1_000,
      deps: { ...deps, resolveDescriptor: async () => null },
    });
    expect(out.confirmed).toBe(false);
    expect(out.deferred).toBe(1);
  });

  it("zero handles ⇒ trivially confirmed without probing anything", async () => {
    const { deps, calls } = makeDeps({});
    const out = await confirmEdgeIndexVisibility({ scope: SCOPE, handles: [], timeoutMs: 100, deps });
    expect(out).toEqual({ confirmed: true, deferred: 0, waitedMs: 0 });
    expect(calls.sql).toEqual([]);
  });

  // -- Fix 3: deadline-aware probes ---------------------------------------

  it("resolves by deadline + ε even when a probe hangs past the deadline (never 504-ready on commit)", async () => {
    // A CH probe that takes 3 s — far past the 100 ms barrier budget —
    // simulates the overshoot (~2.8 s) found in the manual transcript.
    const hangCh = async <T>(_sql: string): Promise<T[]> =>
      new Promise<T[]>((r) => setTimeout(() => r([] as unknown as T[]), 3_000));
    const t0 = Date.now();
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e5", outboxSeq: 1, linkTypeApiName: "ownedBy", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 100,
      pollMs: 50,
      deps: { chExec: hangCh, pgQuery: async () => ({ rows: [] }), resolveDescriptor: async () => DESCRIPTOR, sleep: async () => {} },
    });
    const waited = Date.now() - t0;
    expect(out.confirmed).toBe(false);
    // A SLOW-but-non-erroring probe is a LAG, not an outage — reason="timeout".
    expect(out.reason).toBe("timeout");
    // HARD INVARIANT: overshoot ≤ BARRIER_EPSILON_MS.
    expect(waited).toBeLessThanOrEqual(100 + BARRIER_EPSILON_MS + 50);
  });

  it("never STARTS a probe whose floor already exceeds the remaining deadline (timeoutMs exhausted ⇒ pre-defer without probing)", async () => {
    // Hang-forever chExec with a tight 50ms timeout — only ONE kick is
    // possible, and the loop's remaining<=0 path defers WITHOUT probing.
    let probed = 0;
    const hangCh = async <T>(): Promise<T[]> => {
      probed += 1;
      return new Promise<T[]>(() => {}); // never resolves — would hang the test
    };
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e6", outboxSeq: 1, linkTypeApiName: "ownedBy", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 40, // expire by the time the loop wakes after the sleep cap
      pollMs: 5,
      deps: { chExec: hangCh, pgQuery: async () => ({ rows: [] }), resolveDescriptor: async () => DESCRIPTOR, sleep: async () => {} },
    });
    // The race-bound overshoot still ≤ ε; and a probe that errored would
    // set sawOutage — but a hang that the deadline race bounds stays "timeout".
    expect(out.confirmed).toBe(false);
    expect(out.reason).toBe("timeout");
    expect(probed).toBeLessThanOrEqual(2); // rounds started only while remaining>0
  });

  it("timeoutMs=0 ⇒ pre-defers WITHOUT ever probing (used by route-side budget pre-defer)", async () => {
    let probed = 0;
    const countingCh = async <T>(): Promise<T[]> => { probed += 1; return [{}] as unknown as T[]; };
    const out = await confirmEdgeIndexVisibility({
      scope: SCOPE,
      handles: [{ eventId: "e7", outboxSeq: 1, linkTypeApiName: "ownedBy", sourceObjectType: "SrcType", ontologyId: "ont-1" }],
      timeoutMs: 0,
      deps: { chExec: countingCh, pgQuery: async () => ({ rows: [] }), resolveDescriptor: async () => DESCRIPTOR, sleep: async () => {} },
    });
    expect(probed).toBe(0); // remaining <= 0 ⇒ never started
    expect(out.confirmed).toBe(false);
    expect(out.deferred).toBe(1);
    expect(out.reason).toBe("timeout");
  });
});

describe("waitForLinkWatermark (sound set-difference)", () => {
  it("resolves when every published outbox row <= minOffset is present in CH", async () => {
    const { deps, calls } = makeDeps({
      pgSequences: [5, 7],
      chCls: [{ outbox_seq: 5 }, { outbox_seq: 7 }],
      maxSeq: 9,
      maxVersion: 500,
    });
    await waitForLinkWatermark({
      scope: SCOPE,
      linkTypeApiName: "ownedBy",
      minOffset: 7,
      timeoutMs: 1_000,
      deps,
    });
    expect(calls.pg.some((c) => c.text.includes("INSERT INTO link_edge_watermarks"))).toBe(true);
  });

  it("missing seq ⇒ polls until deadline ⇒ StoreWatermarkTimeout (never fabricates)", async () => {
    const { deps } = makeDeps({
      pgSequences: [5, 7],
      chCls: [{ outbox_seq: 5 }], // 7 missing — a later seq can not mask it
    });
    await expect(
      waitForLinkWatermark({
        scope: SCOPE,
        linkTypeApiName: "ownedBy",
        minOffset: 7,
        timeoutMs: 40,
        pollMs: 5,
        deps,
      }),
    ).rejects.toBeInstanceOf(StoreWatermarkTimeout);
  });

  it("window larger than the guard ⇒ rejects without touching ClickHouse", async () => {
    const { deps, calls } = makeDeps({
      pgSequences: Array.from({ length: WATERMARK_WINDOW_LIMIT + 1 }, (_, i) => i + 1),
    });
    await expect(
      waitForLinkWatermark({
        scope: SCOPE,
        linkTypeApiName: "ownedBy",
        minOffset: 10_001,
        timeoutMs: 1_000,
        deps,
      }),
    ).rejects.toThrow(/window/);
    expect(calls.sql).toEqual([]);
  });

  it("unknown link type ⇒ explicit error, no silent pass", async () => {
    const { deps } = makeDeps({});
    await expect(
      waitForLinkWatermark({
        scope: SCOPE,
        linkTypeApiName: "ghost",
        minOffset: 1,
        timeoutMs: 1_000,
        deps: { ...deps, resolveDescriptor: async () => null },
      }),
    ).rejects.toThrow(/unknown link type/);
  });
});

describe("stageLinkCdcEvent monotonic offset", () => {
  const input: StageLinkCdcInput = {
    eventId: "aaaaaaaa-1111-4222-8333-444444444444",
    sourceObjectType: "SrcType",
    linkTypeApiName: "ownedBy",
    sourcePrimaryKey: "s1",
    targetPrimaryKey: "t1",
    operation: "ADD",
    ontologyId: "ont-1",
    branchId: "main",
  };

  it("assigns outbox_seq via the serial default and embeds it in the stored payload", async () => {
    const stmts: Array<{ text: string; params?: unknown[] }> = [];
    const tx = {
      query: async (text: string, params?: unknown[]) => {
        stmts.push({ text, params });
        if (text.startsWith("INSERT INTO link_cdc_outbox")) return { rows: [{ outbox_seq: 42 }] };
        return { rows: [] };
      },
    };
    const out = await stageLinkCdcEvent(tx as never, input);
    expect(out).toEqual({ eventId: input.eventId, outboxSeq: 42 });
    const embed = stmts.find((s) => s.text.includes("jsonb_set"));
    expect(embed).toBeDefined();
    expect(embed!.params).toEqual([input.eventId, 42]);
    // Scope keys: folded to canonical "default" (Stage 8 handshake).
    const insert = stmts[0];
    expect(insert.params![2]).toBe("default"); // PG tenant column (param $3) — canonical key, NOT NULL
    expect(insert.params![3]).toBe("ont-1"); // ontology column (param $4)
    expect(insert.params![4]).toBe("main"); // branch column (param $5)
    const payload = JSON.parse(insert.params![10] as string);
    expect(payload.tenant_id).toBe("default"); // CH-bound payload uses the same canonical handshake.
  });

  it("conflicting re-stage (retried action) keeps the original row + seq", async () => {
    const tx = {
      query: async (text: string, _params?: unknown[]) => {
        if (text.startsWith("INSERT INTO link_cdc_outbox")) return { rows: [] }; // ON CONFLICT path
        if (text.startsWith("SELECT outbox_seq")) return { rows: [{ outbox_seq: 7 }] };
        return { rows: [] };
      },
    };
    const out = await stageLinkCdcEvent(tx as never, input);
    expect(out.outboxSeq).toBe(7);
  });
});
