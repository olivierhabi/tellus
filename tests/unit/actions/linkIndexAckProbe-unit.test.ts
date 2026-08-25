// ---------------------------------------------------------------------------
// Fix 1 + Fix 3 unit tests: linkIndexAckHttp probe + per-item budget helper.
//
// probeExecutionIndexVisibility: PENDING / VISIBLE / null (no events ⇒
//   field absent ⇒ byte-compatible audit body), probed via the SAME
//   per-event_id barrier the write path used (edgeIndexWatermark).
// perItemAckBudgetMs: batch route pre-defer math (Fix 3).
// ---------------------------------------------------------------------------
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, confirmEdgeMock, incCounterMock, observeHistogramMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  confirmEdgeMock: vi.fn(),
  incCounterMock: vi.fn(),
  observeHistogramMock: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query: queryMock }));

// persistStickyVisibleVerdict imports incCounter from funnel/metrics; mock
// it so the failure-path test can assert the failure counter is incremented
// without depending on the in-memory registry. observeHistogram is also
// referenced by the probe's barrier on the live path (not under test here).
vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: incCounterMock,
  observeHistogram: observeHistogramMock,
  setGauge: vi.fn(),
}));

// The status probe dynamically imports confirmEdgeIndexVisibility; cache
// the mock against that path so the dynamic import resolves to ours.
vi.mock("../../../src/services/serving/edgeIndexWatermark", () => ({
  confirmEdgeIndexVisibility: confirmEdgeMock,
}));

import {
  perItemAckBudgetMs,
  probeExecutionIndexVisibility,
  persistStickyVisibleVerdict,
} from "../../../src/actions/linkIndexAckHttp";

describe("probeExecutionIndexVisibility — statusUrl index state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmEdgeMock.mockResolvedValue({ confirmed: true, deferred: 0, waitedMs: 0 });
  });

  it("execution staged NO link events ⇒ null (audit body omits the field — byte-compat)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await probeExecutionIndexVisibility({ executionId: "ex-none" })).toBeNull();
    expect(confirmEdgeMock).not.toHaveBeenCalled();
  });

  it("all events visible ⇒ 'VISIBLE'", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          event_id: "e1",
          link_type_api_name: "ownedBy",
          ontology_id: "ont",
          branch_id: "main",
          tenant_id: "",
          outbox_seq: 1,
          source_object_type: "Src",
        },
      ],
    });
    expect(await probeExecutionIndexVisibility({ executionId: "ex-vis" })).toBe("VISIBLE");
  });

  it("any scope group unconfirmed ⇒ 'PENDING' (timed-out probe is still NOT visible)", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          event_id: "e1",
          link_type_api_name: "ownedBy",
          ontology_id: "ont",
          branch_id: "main",
          tenant_id: "",
          outbox_seq: 1,
          source_object_type: "Src",
        },
      ],
    });
    confirmEdgeMock.mockResolvedValueOnce({
      confirmed: false,
      deferred: 1,
      waitedMs: 1000,
      reason: "timeout",
    });
    expect(await probeExecutionIndexVisibility({ executionId: "ex-pending" })).toBe("PENDING");
  });

  it("probe THROWS (CH outage) ⇒ 'PENDING' (never fabricate visibility)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ event_id: "e1", link_type_api_name: "x", ontology_id: "o", branch_id: "b", tenant_id: "", outbox_seq: 1, source_object_type: "S" }] });
    confirmEdgeMock.mockRejectedValueOnce(new Error("ch down"));
    expect(await probeExecutionIndexVisibility({ executionId: "ex-out" })).toBe("PENDING");
  });

  it("multi-scope execution: ALL groups confirmed ⇒ VISIBLE; the per-scope probe is bounded by the shared deadline", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { event_id: "e1", link_type_api_name: "lt", ontology_id: "o1", branch_id: "b", tenant_id: "", outbox_seq: 1, source_object_type: "S" },
        { event_id: "e2", link_type_api_name: "lt", ontology_id: "o2", branch_id: "b", tenant_id: "", outbox_seq: 2, source_object_type: "S" },
      ],
    });
    expect(await probeExecutionIndexVisibility({ executionId: "ex-multi" })).toBe("VISIBLE");
    expect(confirmEdgeMock).toHaveBeenCalledTimes(2);
    // Second group's timeoutMs bounded by remaining (shared deadline).
    const second = confirmEdgeMock.mock.calls[1][0];
    expect(second.timeoutMs).toBeLessThanOrEqual(1_000);
  });

  it("deadline expired MId-probe ⇒ 'PENDING' (resolves in-budget even for a huge backlog)", async () => {
    // Six scopes; first resolves after 200ms; budget tiny.
    queryMock.mockResolvedValueOnce({
      rows: Array.from({ length: 6 }, (_, i) => ({
        event_id: `e${i}`,
        link_type_api_name: "lt",
        ontology_id: `o${i}`,
        branch_id: "b",
        tenant_id: "",
        outbox_seq: i,
        source_object_type: "S",
      })),
    });
    confirmEdgeMock.mockImplementation(
      async () => new Promise((r) => setTimeout(() => r({ confirmed: true, deferred: 0, waitedMs: 0 }), 200)),
    );
    const out = await probeExecutionIndexVisibility({ executionId: "ex-many", timeoutMs: 50 });
    expect(out).toBe("PENDING"); // deadline expired before groups finished
  });
});

// -- Sticky VISIBLE verdict (migration 159) -------------------------------
// Handler that branches by SQL content so we can exercise the full
// probe flow (JOIN → sticky SELECT → live probe → sticky INSERT) with
// one mock, including the sticky-was-persisted and flap-resilience cases.
function stickyAwareQuery(overrides: {
  joinRows?: Array<Record<string, unknown>>;
  stickyPresent?: boolean;
  confirms?: Array<boolean>;
}) {
  let stickyPresent = overrides.stickyPresent ?? false;
  let confirmIdx = 0;
  const confirms = overrides.confirms ?? [];
  return {
    fn: async (text: string, params?: unknown[]) => {
      // The audit-row lookup is NOT part of the probe — the mock is only
      // used by the probe function itself.
      if (text.includes("link_edit le")) {
        return { rows: overrides.joinRows ?? [{ event_id: "e1", link_type_api_name: "lt", ontology_id: "o", branch_id: "b", tenant_id: "", outbox_seq: 1, source_object_type: "S" }] };
      }
      if (text.includes("SELECT 1 FROM link_execution_index_visibility")) {
        return { rows: stickyPresent ? [{}] : [] };
      }
      if (text.includes("INSERT INTO link_execution_index_visibility")) {
        stickyPresent = true;
        return { rows: [] };
      }
      return { rows: [] };
    },
    confirmEdge: async () => ({
      confirmed: confirms[confirmIdx++] ?? true,
      deferred: 0,
      waitedMs: 0,
    }),
    isStickyPresent: () => stickyPresent,
  };
}

describe("probeExecutionIndexVisibility — sticky VISIBLE verdict (monotonicity)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first VISIBLE: live probe confirms → INSERT sticky → returns VISIBLE", async () => {
    const handler = stickyAwareQuery({
      stickyPresent: false,
      confirms: [true],
    });
    queryMock.mockImplementation(handler.fn);
    confirmEdgeMock.mockImplementation(handler.confirmEdge);
    const out = await probeExecutionIndexVisibility({ executionId: "ex-1" });
    expect(out).toBe("VISIBLE");
    expect(confirmEdgeMock).toHaveBeenCalledTimes(1); // live probe ran
    expect(handler.isStickyPresent()).toBe(true); // INSERT written
  });

  it("second poll: sticky row exists → short-circuits to VISIBLE WITHOUT live-probing (monotonic)", async () => {
    const handler = stickyAwareQuery({
      stickyPresent: true, // sticky row from a prior poll
      confirms: [false], // would return PENDING — but MUST NOT be called
    });
    queryMock.mockImplementation(handler.fn);
    confirmEdgeMock.mockImplementation(handler.confirmEdge);
    const out = await probeExecutionIndexVisibility({ executionId: "ex-1" });
    expect(out).toBe("VISIBLE");
    expect(confirmEdgeMock).not.toHaveBeenCalled(); // NO live probe — sticky shortcut
    expect(handler.isStickyPresent()).toBe(true); // unchanged
  });

  it("flip-flop resilience: first poll VISIBLE, second poll would-probe-PENDING, but sticky VISIBLE wins", async () => {
    // Simulate a ReplacingMergeTree merge collapse: the live probe
    // would return confirmed=false (event_id row gone), but the sticky
    // verdict from the first VISIBLE poll persists and short-circuits.
    const handler = stickyAwareQuery({
      stickyPresent: true,
      confirms: [false], // simulated collapse — probe would say PENDING
    });
    queryMock.mockImplementation(handler.fn);
    confirmEdgeMock.mockImplementation(handler.confirmEdge);
    const out = await probeExecutionIndexVisibility({ executionId: "ex-flap" });
    expect(out).toBe("VISIBLE"); // monotonic — sticky wins
    expect(confirmEdgeMock).not.toHaveBeenCalled(); // never probed
  });

  it("unset sticky falls through to a live probe (PENDING when events not yet visible)", async () => {
    const handler = stickyAwareQuery({
      stickyPresent: false,
      confirms: [false], // not yet visible
    });
    queryMock.mockImplementation(handler.fn);
    confirmEdgeMock.mockImplementation(handler.confirmEdge);
    const out = await probeExecutionIndexVisibility({ executionId: "ex-pend" });
    expect(out).toBe("PENDING");
    expect(confirmEdgeMock).toHaveBeenCalledTimes(1);
    expect(handler.isStickyPresent()).toBe(false); // NOT written on PENDING
  });

  it("never fabricates VISIBLE: sticky only set AFTER a real confirmed probe", async () => {
    const handler = stickyAwareQuery({
      stickyPresent: false,
      confirms: [false, false, true], // flaps, then confirms
    });
    queryMock.mockImplementation(handler.fn);
    confirmEdgeMock.mockImplementation(handler.confirmEdge);
    // Poll 1: PENDING (confirmEdge returns false)
    let out = await probeExecutionIndexVisibility({ executionId: "ex-fab" });
    expect(out).toBe("PENDING");
    expect(handler.isStickyPresent()).toBe(false);
    // Poll 2: still PENDING — no sticky, confirmEdge returns false again
    out = await probeExecutionIndexVisibility({ executionId: "ex-fab" });
    expect(out).toBe("PENDING");
    expect(handler.isStickyPresent()).toBe(false);
    // Poll 3: VISIBLE — confirmEdge returns true → sticky written
    out = await probeExecutionIndexVisibility({ executionId: "ex-fab" });
    expect(out).toBe("VISIBLE");
    expect(handler.isStickyPresent()).toBe(true);
  });

  it("null (no link events) skips sticky entirely — the audit body omits the field (byte-compat)", async () => {
    const handler = stickyAwareQuery({ joinRows: [] });
    queryMock.mockImplementation(handler.fn);
    const out = await probeExecutionIndexVisibility({ executionId: "ex-null" });
    expect(out).toBeNull();
    expect(handler.isStickyPresent()).toBe(false);
    expect(confirmEdgeMock).not.toHaveBeenCalled();
  });
});

// -- persistStickyVisibleVerdict (shared writer: write barrier + probe) ----
// The write barrier (editApplicator Step 6c) calls THIS helper when the
// in-band ack confirmed (the 200 path); the status probe calls it after a
// live confirmed=true round. The unit cases below prove the helper's
// contract; the live post-fix gate proves the write barrier actually
// invokes it on confirmed (200-confirmed ⇒ sticky row exists with no poll).
describe("persistStickyVisibleVerdict — shared sticky writer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("success: INSERT ... ON CONFLICT DO NOTHING for the executionId; does not throw", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(persistStickyVisibleVerdict("ex-ok")).resolves.toBeUndefined();
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO link_execution_index_visibility"),
      ["ex-ok"],
    );
    expect(queryMock.mock.calls[0][0]).toContain("ON CONFLICT DO NOTHING");
    // success path MUST NOT increment the failure counter
    expect(incCounterMock).not.toHaveBeenCalledWith(
      "link_index_sticky_write_failures_total",
    );
  });

  it("PG failure: NEVER throws, logs once, increments the failure counter (no silent swallow)", async () => {
    queryMock.mockRejectedValueOnce(new Error("relation link_execution_index_visibility does not exist"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(persistStickyVisibleVerdict("ex-fail")).resolves.toBeUndefined();
    // visible, not silent: one warn line naming the executionId
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("ex-fail");
    // and a counter increment so the outage is observable in metrics
    expect(incCounterMock).toHaveBeenCalledWith("link_index_sticky_write_failures_total");
    warnSpy.mockRestore();
  });

  it("never fabricates: the writer is ONLY invoked by the confirmed path — it has no PENDING branch", async () => {
    // The helper performs a blind INSERT; it is the CALLER's contract that
    // gates it on confirmed=true (write barrier) / live-probe-confirmed
    // (probe). Assert the SQL carries ON CONFLICT DO NOTHING so a duplicate
    // (spurious) write is a no-op, not a fabrication: presence of a row is
    // only ever set by a confirmed verdict upstream.
    queryMock.mockResolvedValueOnce({ rows: [] });
    await persistStickyVisibleVerdict("ex-idempotent");
    expect(queryMock.mock.calls[0][0]).toContain("ON CONFLICT DO NOTHING");
  });
});

describe("perItemAckBudgetMs — batch route pre-defer math (Fix 3)", () => {
  it("no stamped deadline ⇒ undefined (harness/missing middleware ⇒ env-timeout fallback unchanged)", () => {
    expect(
      perItemAckBudgetMs({ localsDeadlineAt: undefined, envAckTimeoutMs: 5_000 }),
    ).toBeUndefined();
    expect(
      perItemAckBudgetMs({ localsDeadlineAt: "not-a-number", envAckTimeoutMs: 5_000 }),
    ).toBeUndefined();
  });

  it("plenty of budget ⇒ capped by the env ack timeout, not the deadline", () => {
    const now = 1_000_000;
    const deadline = now + 30_000;
    // The reserve only bites when REMAINING is the tight factor — with
    // 30 s of budget the env timeout (5 s) is what bounds the barrier.
    expect(
      perItemAckBudgetMs({ localsDeadlineAt: deadline, envAckTimeoutMs: 5_000, now }),
    ).toBe(5_000);
  });

  it("tight budget ⇒ shrinking to the remaining deadline minus the response reserve", () => {
    const now = 1_000_000;
    const deadline = now + 3_000; // only 3s left
    // remaining - reserve = (3000 - 500) = 2500; that < env 5000 ⇒ 2500.
    expect(
      perItemAckBudgetMs({ localsDeadlineAt: deadline, envAckTimeoutMs: 5_000, now }),
    ).toBe(2_500);
  });

  it("expired budget ⇒ 0 (PRE-DEFER: the item resolves as 202-per-item pending, never 504)", () => {
    expect(
      perItemAckBudgetMs({ localsDeadlineAt: 1_000, envAckTimeoutMs: 5_000, now: 5_000 }),
    ).toBe(0);
  });

  it("negative reserve clamp ⇒ 0, never a negative ceiling", () => {
    expect(
      perItemAckBudgetMs({ localsDeadlineAt: 1_500, envAckTimeoutMs: 5_000, now: 2_000 }),
    ).toBe(0);
  });
});
