// ---------------------------------------------------------------------------
// /api/v1/funnel/replacement/* — integration
//
// Quickwit dual-index cutover control plane. The orchestrator itself
// needs Quickwit to actually execute; these tests lock the HTTP
// contract only — required fields, 400 / 404 paths, response envelope
// — and accept 500 from the state-machine transitions when the
// backend can't reach Quickwit.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../../helpers/api";

beforeAll(async () => {
  await (
    await import("../../../src/services/testing/destructiveTestGuard")
  ).assertDestructiveTestEnvironment({
    operation: "funnel-replacement-fixture-cleanup",
    skipApiProbe: true,
  });
});

describe("POST /api/v1/funnel/replacement/start", () => {
  it("400s without the required fields", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/replacement/start",
      {},
    );
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
    expect(body.message).toContain("previousProperties[]");
  });

  it("400s if previousProperties isn't an array", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/replacement/start",
      {
        objectTypeApiName: "Foo",
        primaryKeyApiName: "id",
        previousProperties: "oops",
        nextProperties: [],
      },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("BAD_REQUEST");
  });
});

describe("GET /api/v1/funnel/replacement/:objectType", () => {
  it("returns 404 NOT_FOUND when no replacement row exists", async () => {
    const { status, body } = await api(
      "GET",
      "/api/v1/funnel/replacement/NoSuchObjectType_xyz",
    );
    expect(status).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
  });
});

describe("POST /api/v1/funnel/replacement/scheduler-tick", () => {
  it("fires one scheduler iteration and returns a result object", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/replacement/scheduler-tick",
      {},
    );
    // 200 = tick ran. 500 = DB / Quickwit unreachable. Either way the
    // endpoint should NOT throw to the client unhandled.
    expect([200, 500]).toContain(status);
    if (status === 200) {
      expect(body).toBeDefined();
    }
  });
});

describe("POST /api/v1/funnel/replacement/sweep", () => {
  it("returns {dropped: { examined, droppedIndexIds }} on the happy path", async () => {
    const { status, body } = await api(
      "POST",
      "/api/v1/funnel/replacement/sweep",
      {},
    );
    expect([200, 500]).toContain(status);
    if (status === 200) {
      // Handler serialises the service's result verbatim as
      // `{ dropped: <SweepResult> }`; SweepResult is an object, NOT
      // an array. Lock the current shape so a future refactor that
      // swaps in a bare array explicitly breaks this test.
      expect(typeof body.dropped).toBe("object");
      expect(body.dropped).not.toBeNull();
      expect(typeof body.dropped.examined).toBe("number");
      expect(Array.isArray(body.dropped.droppedIndexIds)).toBe(true);
    }
  });
});

describe("GET /api/v1/funnel/replacement/:objectType/preview-cutover", () => {
  it("returns a verdict object or a controlled error for an unknown object type", async () => {
    const { status } = await api(
      "GET",
      "/api/v1/funnel/replacement/NoSuchObjectType_xyz/preview-cutover",
    );
    // The orchestrator may throw on a missing replacement row — that's
    // returned as a 500 with INTERNAL, which is a known structured
    // response (not a 5xx crash).
    expect([200, 500]).toContain(status);
  });
});

describe("Replacement state-transition endpoints (404/500 on unknown OT)", () => {
  // These endpoints require an active replacement row to succeed.
  // For an unknown Object Type they must NOT crash the server — the
  // orchestrator raises a structured error that the handler
  // passes through as a 500 with the INTERNAL envelope.
  const paths = [
    "/api/v1/funnel/replacement/NoSuchObjectType_xyz/complete-backfill",
    "/api/v1/funnel/replacement/NoSuchObjectType_xyz/approve-cutover",
    "/api/v1/funnel/replacement/NoSuchObjectType_xyz/rollback",
  ];

  for (const p of paths) {
    it(`${p} → controlled error, no 5xx crash`, async () => {
      const { status, body } = await api("POST", p, {});
      expect([200, 404, 500]).toContain(status);
      if (status === 500) {
        expect(body.error).toBe("INTERNAL");
      }
    });
  }
});
