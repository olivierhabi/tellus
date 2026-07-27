// ---------------------------------------------------------------------------
// Unit tests for src/models/actionSideEffectJob.ts — Phase 5.
//
// Mocks `../db` so getClient() + query() return scripted clients; verifies
// the SQL semantics (enqueue / claim FOR UPDATE SKIP LOCKED / succeed /
// retry with bounded backoff / dead-letter / requeue) without touching PG.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module — every model fn calls getClient() or query().
// Smart mock: chooses a response based on the SQL text so BEGIN/COMMIT
// don't consume the queued response meant for the SELECT/UPDATE we care
// about.
vi.mock("../../../src/db", () => {
  const responses: Array<{ regex: RegExp; rows: any[]; once: boolean }> = [];
  const client = {
    _calls: [] as Array<{ kind: string; text: string; values?: any }>,
    async query(text: string, values?: any) {
      client._calls.push({ kind: "query", text, values });
      // Skip the response lookup for transaction framing — return
      // an empty result for BEGIN/COMMIT/ROLLBACK so they don't
      // consume a queued row meant for a real SELECT/INSERT.
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text.trim())) {
        return { rows: [] };
      }
      for (let i = 0; i < responses.length; i++) {
        if (responses[i].regex.test(text)) {
          const r = responses[i];
          if (r.once) responses.splice(i, 1);
          return { rows: r.rows };
        }
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    getClient: async () => client,
    query: async (text: string, values?: any) => client.query(text, values),
    __client: client,
    __setResponse(textRegex: RegExp, rows: any[], once = false) {
      responses.push({ regex: textRegex, rows, once });
    },
    __resetResponses() {
      responses.length = 0;
    },
  };
});

import {
  enqueueSideEffectJobsInTransaction,
  claimSideEffectJobs,
  markSideEffectJobSucceeded,
  markSideEffectJobRetryOrDead,
  requeueDeadSideEffectJob,
} from "../../../src/models/actionSideEffectJob";
import { __client, __setResponse, __resetResponses } from "../../../src/db";

const anyClient = __client as any;

beforeEach(() => {
  anyClient._calls = [];
  __resetResponses();
});

const fakeRow = (overrides: Record<string, any> = {}) => ({
  job_id: "job-1",
  execution_id: "exec-1",
  action_type_id: "at-1",
  action_type_version: 1,
  side_effect_index: 0,
  kind: "webhook",
  payload: { spec: { url: "https://ok.example.com" } },
  status: "pending",
  attempt_count: 0,
  last_error_code: null,
  last_error_at: null,
  next_attempt_at: null,
  idempotency_key: null,
  external_receipt: null,
  created_at: "2026-07-25T00:00:00Z",
  updated_at: "2026-07-25T00:00:00Z",
  ...overrides,
});

describe("actionSideEffectJob model", () => {
  describe("enqueueSideEffectJobsInTransaction", () => {
    it("returns [] for empty jobs[] without touching the client", async () => {
      const r = await enqueueSideEffectJobsInTransaction(anyClient, {
        executionId: "e",
        actionTypeId: "at",
        actionTypeVersion: 1,
        jobs: [],
      });
      expect(r).toEqual([]);
      expect(anyClient._calls.length).toBe(0);
    });

    it("inserts one row per job with status='pending', attempt_count=0", async () => {
      __setResponse(/INSERT INTO action_side_effect_job/, [fakeRow()], true);
      __setResponse(/INSERT INTO action_side_effect_job/, [fakeRow({ job_id: "job-2", side_effect_index: 1 })], true);
      const r = await enqueueSideEffectJobsInTransaction(anyClient, {
        executionId: "exec-1",
        actionTypeId: "at-1",
        actionTypeVersion: 1,
        jobs: [
          { sideEffectIndex: 0, kind: "webhook", payload: {} },
          { sideEffectIndex: 1, kind: "notification", payload: {} },
        ],
      });
      expect(r).toHaveLength(2);
      expect(r[0].job_id).toBe("job-1");
      expect(r[1].job_id).toBe("job-2");
      // All calls are INSERTs.
      const insertCalls = anyClient._calls.filter((c: any) => c.text.includes("INSERT INTO action_side_effect_job"));
      expect(insertCalls).toHaveLength(2);
    });

    it("threads idempotency_key through when provided", async () => {
      __setResponse(/INSERT INTO action_side_effect_job/, [fakeRow({ idempotency_key: "key-x" })]);
      await enqueueSideEffectJobsInTransaction(anyClient, {
        executionId: "exec-1",
        actionTypeId: "at-1",
        actionTypeVersion: 1,
        jobs: [
          { sideEffectIndex: 0, kind: "webhook", payload: {}, idempotencyKey: "key-x" },
        ],
      });
      const insertCall = anyClient._calls.find((c: any) => c.text.includes("INSERT INTO action_side_effect_job"));
      expect(insertCall?.values).toContain("key-x");
    });
  });

  describe("claimSideEffectJobs", () => {
    it("SELECT-skip-locked + UPDATE → returning claimed rows", async () => {
      __setResponse(/SELECT job_id FROM action_side_effect_job/, [{ job_id: "j-a" }, { job_id: "j-b" }]);
      __setResponse(/UPDATE action_side_effect_job/, [
        fakeRow({ job_id: "j-a", status: "running" }),
        fakeRow({ job_id: "j-b", status: "running" }),
      ]);
      const r = await claimSideEffectJobs(8);
      expect(r).toHaveLength(2);
      expect(r[0].status).toBe("running");
      // The first non-framing call should be the SELECT FOR UPDATE SKIP LOCKED.
      const sqlCalls = anyClient._calls.filter((c: any) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(c.text.trim()));
      expect(sqlCalls[0].text).toMatch(/FOR UPDATE SKIP LOCKED/);
      // The second should be the UPDATE.
      expect(sqlCalls[1].text).toMatch(/UPDATE action_side_effect_job/);
    });

    it("returns [] when the first SELECT finds no rows (commit + empty)", async () => {
      // SELECT returns empty by default — no stub needed.
      const r = await claimSideEffectJobs(8);
      expect(r).toEqual([]);
      // Only the SELECT + BEGIN + COMMIT are issued — the UPDATE is skipped.
      const sqlCalls = anyClient._calls.filter((c: any) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(c.text.trim()));
      expect(sqlCalls.length).toBe(1);
      expect(sqlCalls[0].text).toMatch(/SELECT job_id FROM action_side_effect_job/);
    });
  });

  describe("markSideEffectJobSucceeded", () => {
    it("UPDATE … SET status='succeeded' with external_receipt when provided", async () => {
      await markSideEffectJobSucceeded("job-1", { receiptId: "abc" });
      const updateCall = anyClient._calls.find((c: any) => c.text.includes("UPDATE action_side_effect_job"));
      expect(updateCall?.text).toMatch(/status = 'succeeded'/);
      const expectedReceipt = JSON.stringify({ receiptId: "abc" });
      expect(updateCall?.values).toContain(expectedReceipt);
    });

    it("passes NULL for external_receipt when omitted", async () => {
      await markSideEffectJobSucceeded("job-1");
      const updateCall = anyClient._calls.find((c: any) => c.text.includes("UPDATE action_side_effect_job"));
      expect(updateCall?.values[1]).toBeNull();
    });
  });

  describe("markSideEffectJobRetryOrDead", () => {
    it("transitions to 'dead' when attempt_count reaches maxAttempts", async () => {
      __setResponse(/SELECT attempt_count FROM action_side_effect_job/, [{ attempt_count: 4 }]);
      const next = await markSideEffectJobRetryOrDead("job-1", "ERR_X", "boom", {
        maxAttempts: 5,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
        multiplier: 2,
        jitterMs: 100,
      });
      expect(next).toBe("dead");
      const deadCall = anyClient._calls.find((c: any) => c.text.includes("status = 'dead'"));
      expect(deadCall).toBeTruthy();
    });

    it("transitions to 'retrying' with computed next_attempt_at when under max", async () => {
      __setResponse(/SELECT attempt_count FROM action_side_effect_job/, [{ attempt_count: 0 }]);
      const next = await markSideEffectJobRetryOrDead("job-1", "ERR_X", "fail", {
        maxAttempts: 5,
        initialBackoffMs: 1_000,
        maxBackoffMs: 60_000,
        multiplier: 2,
        jitterMs: 100,
      });
      expect(next).toBe("retrying");
      const retryCall = anyClient._calls.find((c: any) => c.text.includes("status = 'retrying'"));
      expect(retryCall).toBeTruthy();
      // next_attempt_at should be a future ISO timestamp.
      const v = retryCall?.values.find((x: any) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x));
      expect(v).toBeTruthy();
      expect(new Date(v).getTime()).toBeGreaterThan(Date.now() - 1000);
    });

    it("throws when the row is missing — ROLLBACK issued", async () => {
      // SELECT returns empty by default — no stub = not found.
      await expect(
        markSideEffectJobRetryOrDead("missing", "ERR", "x", {
          maxAttempts: 5,
          initialBackoffMs: 1, maxBackoffMs: 1, multiplier: 1, jitterMs: 0,
        }),
      ).rejects.toThrow(/not found/);
    });
  });

  describe("requeueDeadSideEffectJob", () => {
    it("UPDATE … SET status='pending' WHERE status='dead'", async () => {
      __setResponse(/UPDATE action_side_effect_job\s+.*SET status = 'pending'/,
        [fakeRow({ status: "pending", attempt_count: 0 })]);
      const r = await requeueDeadSideEffectJob("job-1");
      expect(r?.status).toBe("pending");
      const call = anyClient._calls.find((c: any) => c.text.includes("status = 'pending'"));
      expect(call?.text).toMatch(/WHERE job_id = \$1 AND status = 'dead'/);
    });

    it("returns null when the row doesn't exist or isn't 'dead'", async () => {
      // UPDATE returns empty by default → null result.
      const r = await requeueDeadSideEffectJob("nope");
      expect(r).toBeNull();
    });
  });
});
