import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  runOnce: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  query: mocks.query,
}));

vi.mock("../../../src/qa/rwanda/pindoAutomationRuntime", () => ({
  runRwandaPindoAutomationOnce: mocks.runOnce,
}));

import {
  evaluateRwandaPindoOnce,
  RWANDA_PINDO_EVALUATE_ROUTE,
} from "../../../src/qa/rwanda/pindoAutomationProbe";

function makeRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res as unknown as {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

function makeReq(body: unknown) {
  return { body } as never;
}

describe("Rwanda Pindo automation probe", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.runOnce.mockReset();
    mocks.runOnce.mockResolvedValue(1);
  });

  it("is mounted under the test-hooks prefix only", () => {
    expect(RWANDA_PINDO_EVALUATE_ROUTE).toBe("/api/v1/_test/qa/rwanda/pindo/evaluate");
  });

  it("refuses to touch non-fixture primary keys", async () => {
    const res = makeRes();
    await evaluateRwandaPindoOnce(makeReq({ routeId: "production-route-7", patch: {} }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.runOnce).not.toHaveBeenCalled();
  });

  it("rejects malformed patches before any database write", async () => {
    const res = makeRes();
    await evaluateRwandaPindoOnce(makeReq({ routeId: "QA-RW-PI-R-0000001", patch: [1] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("patches only the seeded route, evaluates once, and returns the durable audit", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ properties: { killSwitch: "true" } }] })
      .mockResolvedValueOnce({
        rows: [
          {
            outcome: "SUPPRESSED",
            reason: "global kill switch engaged",
            service_identity: "rwanda-pindo-automation",
            action_execution_id: null,
            created_at: "2026-08-10T08:00:00.000Z",
          },
        ],
      });
    const res = makeRes();

    await evaluateRwandaPindoOnce(
      makeReq({ routeId: "QA-RW-PI-R-0000001", patch: { killSwitch: "true" } }),
      res,
    );

    const [patchSql, patchParams] = mocks.query.mock.calls[0]!;
    expect(String(patchSql)).toContain("object_type_api_name = $1");
    expect(String(patchSql)).toContain("primary_key LIKE $4");
    expect(patchParams).toEqual([
      "QaRwPindoCarrierRoutes",
      JSON.stringify({ killSwitch: "true" }),
      "QA-RW-PI-R-0000001",
      "QA-RW-%",
    ]);
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluated: 1,
        routeId: "QA-RW-PI-R-0000001",
        audit: [expect.objectContaining({ outcome: "SUPPRESSED" })],
      }),
    );
  });

  it("still runs the evaluation when no patch is requested", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();

    await evaluateRwandaPindoOnce(makeReq({ routeId: "QA-RW-PI-R-0000001" }), res);

    expect(mocks.query).toHaveBeenCalledTimes(1); // audit read-back only
    expect(mocks.runOnce).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ evaluated: 1, properties: null }),
    );
  });
});
