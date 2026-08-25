// ---------------------------------------------------------------------------
// linkIndexAck → HTTP outcome mapping (unit, pure — no I/O).
//
// Contract (src/actions/linkIndexAckHttp.ts):
//   * ack confirmed / LINK_INDEX_ACK_REQUIRED disabled → 200 with the
//     unchanged success body (byte-compatible, no schema drift).
//   * committed but ack NOT confirmed → 202 COMMITTED_INDEX_PENDING with
//     executionId + pollable statusUrl.
//   * INVARIANT: a post-commit index deferral is NEVER a client-visible
//     failure (>=400 status or result "failed"/"failure") — a failure shape
//     invites retries of an already-applied mutation.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  actionExecutionStatusUrl,
  assertApplyOutcomeInvariant,
  assertBatchAckOutcomeInvariant,
  collectPendingAcks,
  COMMITTED_INDEX_PENDING,
  mapApplyExecutionToHttp,
  type ApplyOutcomeInput,
} from "../../../src/actions/linkIndexAckHttp";

const BASE: ApplyOutcomeInput = {
  executionId: "exec-123",
  result: "success",
  affectedObjects: [
    { objectType: "T", primaryKey: "t-1", operation: "update" },
  ],
  durationMs: 42,
};

const CONFIRMED_ACK = {
  confirmed: true,
  deferred: 0,
  waitedMs: 17,
};

const TIMEOUT_ACK = {
  confirmed: false,
  deferred: 1,
  waitedMs: 1500,
  reason: "timeout" as const,
};

const OUTAGE_ACK = {
  confirmed: false,
  deferred: 2,
  waitedMs: 1500,
  reason: "index_outage" as const,
};

describe("mapApplyExecutionToHttp — 200 cases (byte-compatible)", () => {
  it("LINK_INDEX_ACK_REQUIRED disabled (no ack) → 200, exact pre-contract shape", () => {
    const outcome = mapApplyExecutionToHttp(BASE);
    expect(outcome.status).toBe(200);
    // Exact key set + values — no schema drift for existing callers.
    expect(outcome.body).toEqual({
      executionId: "exec-123",
      result: "success",
      affectedObjects: BASE.affectedObjects,
      durationMs: 42,
    });
    expect("linkIndexAck" in outcome.body).toBe(false);
    expect("statusUrl" in outcome.body).toBe(false);
  });

  it("confirmed ack → 200 success with the ack verdict surfaced verbatim", () => {
    const outcome = mapApplyExecutionToHttp({ ...BASE, linkIndexAck: CONFIRMED_ACK });
    expect(outcome.status).toBe(200);
    expect(outcome.body.result).toBe("success");
    expect(outcome.body.linkIndexAck).toEqual(CONFIRMED_ACK); // no coercion
    expect("statusUrl" in outcome.body).toBe(false);
  });

  it("'partial' result (committed, degraded object indexing) + confirmed ack stays 200", () => {
    const outcome = mapApplyExecutionToHttp({
      ...BASE,
      result: "partial",
      linkIndexAck: CONFIRMED_ACK,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.body.result).toBe("partial");
  });
});

describe("mapApplyExecutionToHttp — 202 COMMITTED_INDEX_PENDING", () => {
  it("timeout ack → 202 + COMMITTED_INDEX_PENDING + executionId + statusUrl", () => {
    const outcome = mapApplyExecutionToHttp({ ...BASE, linkIndexAck: TIMEOUT_ACK });
    expect(outcome.status).toBe(202);
    expect(outcome.body.result).toBe(COMMITTED_INDEX_PENDING);
    expect(outcome.body.executionId).toBe("exec-123");
    expect(outcome.body.statusUrl).toBe("/api/v1/audit/log/exec-123");
    // The watermark details are surfaced un-coerced for diagnostics.
    expect(outcome.body.linkIndexAck).toEqual(TIMEOUT_ACK);
    // Committed data is still reported — the mutation IS durable in PG.
    expect(outcome.body.affectedObjects).toEqual(BASE.affectedObjects);
  });

  it("index_outage ack → 202 as well (stalls and outages are both deferrals)", () => {
    const outcome = mapApplyExecutionToHttp({ ...BASE, linkIndexAck: OUTAGE_ACK });
    expect(outcome.status).toBe(202);
    expect(outcome.body.result).toBe(COMMITTED_INDEX_PENDING);
    expect(outcome.body.linkIndexAck?.reason).toBe("index_outage");
    expect(outcome.body.statusUrl).toBe(actionExecutionStatusUrl("exec-123"));
  });

  it("degraded-but-committed ('partial') + unconfirmed ack is still 202, never failure", () => {
    const outcome = mapApplyExecutionToHttp({
      ...BASE,
      result: "partial",
      linkIndexAck: TIMEOUT_ACK,
    });
    expect(outcome.status).toBe(202);
    expect(outcome.body.result).toBe(COMMITTED_INDEX_PENDING);
  });
});

describe("collectPendingAcks — batch aggregation rule (single source of truth)", () => {
  it("all confirmed (or flag off: no acks) → zero pending", () => {
    expect(
      collectPendingAcks([
        { index: 0, executionId: "e0", linkIndexAck: CONFIRMED_ACK },
        { index: 1, executionId: "e1", linkIndexAck: CONFIRMED_ACK },
      ])
    ).toEqual([]);
    // Flag disabled: items carry no ack at all.
    expect(
      collectPendingAcks([
        { index: 0, executionId: "e0" },
        { index: 1, executionId: "e1" },
      ])
    ).toEqual([]);
  });

  it("one-of-N timeout → exactly that item pending, with its own executionId + statusUrl", () => {
    const pending = collectPendingAcks([
      { index: 0, executionId: "e0", linkIndexAck: CONFIRMED_ACK },
      { index: 1, executionId: "e1", linkIndexAck: TIMEOUT_ACK },
      { index: 2, executionId: "e2", linkIndexAck: CONFIRMED_ACK },
    ]);
    expect(pending).toEqual([
      { index: 1, executionId: "e1", statusUrl: "/api/v1/audit/log/e1" },
    ]);
  });

  it("index_outage is pending too; multiple pending items all collected in order", () => {
    const pending = collectPendingAcks([
      { index: 0, executionId: "e0", linkIndexAck: TIMEOUT_ACK },
      { index: 1, executionId: "e1", linkIndexAck: CONFIRMED_ACK },
      { index: 2, executionId: "e2", linkIndexAck: OUTAGE_ACK },
    ]);
    expect(pending.map((p) => p.index)).toEqual([0, 2]);
    expect(pending[1].statusUrl).toBe("/api/v1/audit/log/e2");
  });

  it("pre-commit FAILED items (no executionId) are never pending — they are genuine failures, not deferrals", () => {
    expect(
      collectPendingAcks([
        { index: 0, executionId: null, linkIndexAck: TIMEOUT_ACK },
        { index: 1, executionId: "e1" },
      ])
    ).toEqual([]);
  });
});

describe("assertBatchAckOutcomeInvariant — batch post-commit deferral is never an error, never silent", () => {
  it("accepts the real outcomes: 202+marker when pending; 200 flag-off; 422 all-pre-commit-failed", () => {
    expect(() =>
      assertBatchAckOutcomeInvariant({
        status: 202,
        pendingCount: 2,
        result: COMMITTED_INDEX_PENDING,
      })
    ).not.toThrow();
    expect(() =>
      assertBatchAckOutcomeInvariant({ status: 200, pendingCount: 0 })
    ).not.toThrow();
    expect(() =>
      assertBatchAckOutcomeInvariant({ status: 422, pendingCount: 0 })
    ).not.toThrow();
  });

  it("REJECTS a pending batch on a silent 200 (the placebo-flag regression)", () => {
    expect(() =>
      assertBatchAckOutcomeInvariant({ status: 200, pendingCount: 1 })
    ).toThrow(/INVARIANT VIOLATION/);
  });

  it("REJECTS a pending batch on any 4xx/5xx (committed items must never look like failures)", () => {
    for (const status of [400, 422, 500, 504]) {
      expect(() =>
        assertBatchAckOutcomeInvariant({
          status,
          pendingCount: 1,
          result: COMMITTED_INDEX_PENDING,
        })
      ).toThrow(/INVARIANT VIOLATION/);
    }
  });

  it("REJECTS the marker without pending items (no fabricated deferrals)", () => {
    expect(() =>
      assertBatchAckOutcomeInvariant({
        status: 202,
        pendingCount: 0,
        result: COMMITTED_INDEX_PENDING,
      })
    ).toThrow(/INVARIANT VIOLATION/);
  });
});

describe("assertApplyOutcomeInvariant — post-commit deferral is never a failure", () => {
  it("all real outcomes pass the guard", () => {
    for (const ack of [undefined, CONFIRMED_ACK, TIMEOUT_ACK, OUTAGE_ACK]) {
      const outcome = mapApplyExecutionToHttp({ ...BASE, linkIndexAck: ack });
      expect(() => assertApplyOutcomeInvariant(outcome)).not.toThrow();
      // Belt-and-braces: committed executions never map to client-visible failure.
      expect(outcome.status).toBeLessThan(400);
      expect(outcome.body.result).not.toBe("failed");
      expect(outcome.body.result).not.toBe("failure");
    }
  });

  it("REJECTS a COMMITTED_INDEX_PENDING body on a non-202 status", () => {
    expect(() =>
      assertApplyOutcomeInvariant({
        status: 200,
        body: { result: COMMITTED_INDEX_PENDING },
      })
    ).toThrow(/INVARIANT VIOLATION/);
    expect(() =>
      assertApplyOutcomeInvariant({
        status: 500,
        body: { result: COMMITTED_INDEX_PENDING },
      })
    ).toThrow(/INVARIANT VIOLATION/);
  });

  it("REJECTS any 4xx/5xx status on a committed outcome (success/partial/pending)", () => {
    for (const result of ["success", "partial", COMMITTED_INDEX_PENDING]) {
      expect(() =>
        assertApplyOutcomeInvariant({ status: 400, body: { result } })
      ).toThrow(/INVARIANT VIOLATION/);
      expect(() =>
        assertApplyOutcomeInvariant({ status: 503, body: { result } })
      ).toThrow(/INVARIANT VIOLATION/);
    }
  });
});
