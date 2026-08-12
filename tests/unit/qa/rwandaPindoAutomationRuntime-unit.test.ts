import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  executeAction: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  pool: { query: mocks.query },
}));

vi.mock("../../../src/actions/actionExecutor", () => ({
  executeAction: mocks.executeAction,
}));

import { runRwandaPindoAutomationOnce } from "../../../src/qa/rwanda/pindoAutomationRuntime";

const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-08-10T08:00:00.000Z");

function breachRoute() {
  return {
    ontology_id: ONTOLOGY_ID,
    primary_key: "QA-RW-PI-R-0000001",
    last_modified_at: "2026-08-10T07:59:00.000Z",
    properties: {
      p95Latency: 2_000,
      measuredAt: "2026-08-10T07:59:00.000Z",
      threshold: 1_000,
      breachHoldDown: 60,
      recoveryHoldDown: 600,
      maxFailoversPerWindow: 1,
      targetRoute: "QA-RW-PI-R-0000002",
    },
  };
}

describe("Rwanda Pindo automation runtime", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.executeAction.mockReset();
    mocks.query
      .mockResolvedValueOnce({ rows: [breachRoute()] })
      .mockResolvedValueOnce({
        rows: [{ state: { activeRoute: "primary", breachSince: "2026-08-10T07:58:00.000Z", failovers: [] } }],
      })
      .mockResolvedValue({ rows: [] });
  });

  it("dispatches one immediate failover and persists the service-owned decision", async () => {
    mocks.executeAction.mockResolvedValue({ executionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });

    await expect(runRwandaPindoAutomationOnce(NOW)).resolves.toBe(1);

    expect(mocks.executeAction).toHaveBeenCalledWith(
      ONTOLOGY_ID,
      "qaRwPindoSwitchCarrierRoute",
      expect.objectContaining({
        routeId: "QA-RW-PI-R-0000001",
        targetRoute: "QA-RW-PI-R-0000002",
        reason: "Automated sustained Pindo carrier breach",
      }),
      expect.objectContaining({
        executedBy: "rwanda-pindo-automation",
        subjectKind: "service",
        subjectIdentifier: "rwanda-pindo-automation",
        roles: ["ops-engineer"],
      }),
    );
    const writes = mocks.query.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /^\s*INSERT INTO rwanda_pindo_automation_(state|audit)/.test(sql),
    );
    expect(writes).toHaveLength(2);
    expect(writes[0][1]).toEqual([ONTOLOGY_ID, "QA-RW-PI-R-0000001", expect.any(String)]);
    expect(JSON.parse(writes[0][1][2])).toMatchObject({ activeRoute: "fallback" });
    expect(writes[1][1]).toEqual([
      ONTOLOGY_ID,
      "QA-RW-PI-R-0000001",
      "FAILOVER",
      "sustained latency breach",
      "rwanda-pindo-automation",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
  });

  it("keeps prior state and records a durable failure when action dispatch rejects", async () => {
    mocks.executeAction.mockRejectedValue(new Error("routing API unavailable"));

    await expect(runRwandaPindoAutomationOnce(NOW)).resolves.toBe(1);

    const writes = mocks.query.mock.calls.filter(([sql]) =>
      typeof sql === "string" && /^\s*INSERT INTO rwanda_pindo_automation_(state|audit)/.test(sql),
    );
    expect(JSON.parse(writes[0][1][2])).toMatchObject({ activeRoute: "primary", failovers: [] });
    expect(writes[1][1]).toEqual([
      ONTOLOGY_ID,
      "QA-RW-PI-R-0000001",
      "FAILED",
      "routing API unavailable",
      "rwanda-pindo-automation",
      null,
    ]);
  });
});
