// ---------------------------------------------------------------------------
// Gap M — OpenSearch-resilient security backfill: offline decision-logic
// tests. Covers §17's available / unavailable / becomes-available / retry /
// duplicate-safe / not-found / fatal matrix without a live OpenSearch by
// injecting a mock client + stubbed sleep/random.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import {
  classifyBackfillError,
  withBoundedRetry,
  backfillIndexOnce,
  runSecurityBackfill,
  DEFAULT_BACKFILL_RETRY,
  type OpenSearchLike,
  type BackfillResult,
} from "../../../src/services/opensearch/securityBackfill";

const MARKING = "PUBLIC";

function mockClient(impl: (index: string) => Promise<{ body: unknown } | never>): OpenSearchLike {
  return {
    updateByQuery: vi.fn(async (params: Record<string, unknown>) => impl(params.index as string)) as any,
    cat: { indices: vi.fn(async () => ({ body: [] })) } as any,
  };
}

function noSleep() {
  return { sleep: vi.fn(async () => {}), random: () => 0.5 };
}

describe("classifyBackfillError", () => {
  it("404 → not_found", () => {
    expect(classifyBackfillError({ statusCode: 404 })).toBe("not_found");
    expect(classifyBackfillError({ meta: { statusCode: 404 } })).toBe("not_found");
  });
  it("connection refused / timeout / 5xx → unavailable", () => {
    expect(classifyBackfillError({ statusCode: 503 })).toBe("unavailable");
    expect(classifyBackfillError({ statusCode: 504 })).toBe("unavailable");
    expect(classifyBackfillError({ statusCode: 408 })).toBe("unavailable");
    expect(classifyBackfillError({ code: "ConnectionError" })).toBe("unavailable");
    expect(classifyBackfillError({ message: "connect ECONNREFUSED 127.0.0.1:9200" })).toBe("unavailable");
    expect(classifyBackfillError({ message: "Request timed out" })).toBe("unavailable");
  });
  it("other errors → fatal", () => {
    expect(classifyBackfillError({ statusCode: 400 })).toBe("fatal");
    expect(classifyBackfillError({ message: "script_exception: bad painless" })).toBe("fatal");
    expect(classifyBackfillError(new Error("boom"))).toBe("fatal");
  });
});

describe("withBoundedRetry", () => {
  it("succeeds on the first attempt — no retry, not deferred", async () => {
    const fn = vi.fn(async () => "ok");
    const out = await withBoundedRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep());
    expect(out.deferred).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("becomes available on the 2nd attempt — retries once, succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw { statusCode: 503 };
      return "recovered";
    });
    const out = await withBoundedRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep());
    expect(out.deferred).toBe(false);
    expect(out.attempts).toBe(2);
    expect(out.result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stays unavailable across all attempts — deferred, no infinite loop", async () => {
    const fn = vi.fn(async () => {
      throw { message: "connect ECONNREFUSED" };
    });
    const out = await withBoundedRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep());
    expect(out.deferred).toBe(true);
    expect(out.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("a 404 is a no-op success — NOT retried", async () => {
    const fn = vi.fn(async () => {
      throw { statusCode: 404 };
    });
    const out = await withBoundedRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep());
    expect(out.deferred).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.lastErrorClass).toBe("not_found");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("a fatal error is NOT retried — surfaces immediately", async () => {
    const fn = vi.fn(async () => {
      throw { statusCode: 400 };
    });
    const out = await withBoundedRetry(fn, { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep());
    expect(out.deferred).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.lastErrorClass).toBe("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("backfillIndexOnce", () => {
  it("parses update-by-query updated/noops/failures", async () => {
    const client = mockClient(async () => ({ body: { updated: 7, noops: 3, failures: [] } }));
    const r = await backfillIndexOnce(client, "ontology-foo", MARKING);
    expect(r).toEqual({ index: "ontology-foo", updated: 7, noop: 3, failures: 0 } as BackfillResult);
  });

  it("a 404 → no-op result (index absent, no data loss)", async () => {
    const client = mockClient(async () => {
      throw { statusCode: 404 };
    });
    const r = await backfillIndexOnce(client, "ontology-missing", MARKING);
    expect(r).toEqual({ index: "ontology-missing", updated: 0, noop: 0, failures: 0 });
  });

  it("a fatal error rethrows (so the retry wrapper can classify it)", async () => {
    const client = mockClient(async () => {
      throw { statusCode: 400, message: "bad request" };
    });
    await expect(backfillIndexOnce(client, "ontology-bad", MARKING)).rejects.toThrow();
  });
});

describe("runSecurityBackfill — aggregate exit-decision matrix", () => {
  it("all available + updated → no deferred, no fatal", async () => {
    const client = mockClient(async () => ({ body: { updated: 5, noops: 0, failures: [] } }));
    const report = await runSecurityBackfill(client, ["ontology-a", "ontology-b"], MARKING, DEFAULT_BACKFILL_RETRY, noSleep());
    expect(report.deferred).toBe(0);
    expect(report.fatal).toBe(0);
    expect(report.totalUpdated).toBe(10);
    expect(report.indices).toBe(2);
  });

  it("OpenSearch unavailable for every index → all deferred, no fatal, exit would be 0", async () => {
    const client = mockClient(async () => {
      throw { message: "connect ECONNREFUSED 127.0.0.1:9200" };
    });
    const report = await runSecurityBackfill(
      client,
      ["ontology-a"],
      MARKING,
      { maxAttempts: 2, baseDelayMs: 1, jitterMs: 0 },
      noSleep(),
    );
    expect(report.deferred).toBe(1);
    expect(report.fatal).toBe(0);
    expect(report.totalUpdated).toBe(0);
  });

  it("becomes available mid-run — an unavailable-then-recovered index backfills on retry", async () => {
    let attempt = 0;
    const client = mockClient(async () => {
      attempt += 1;
      if (attempt <= 1) throw { statusCode: 503 };
      return { body: { updated: 2, noops: 0, failures: [] } };
    });
    const report = await runSecurityBackfill(
      client, ["ontology-a"], MARKING,
      { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep(),
    );
    expect(report.deferred).toBe(0);
    expect(report.totalUpdated).toBe(2);
  });

  it("a fatal index is reported as fatal (not deferred, not retried)", async () => {
    const client = mockClient(async () => {
      throw { statusCode: 400, message: "bad painless" };
    });
    const report = await runSecurityBackfill(
      client, ["ontology-x"], MARKING,
      { maxAttempts: 3, baseDelayMs: 1, jitterMs: 0 }, noSleep(),
    );
    expect(report.fatal).toBe(1);
    expect(report.deferred).toBe(0);
  });

  it("duplicate-safe — a no-op re-run (docs already carry markings) records noop, no failures", async () => {
    const client = mockClient(async () => ({ body: { updated: 0, noops: 9, failures: [] } }));
    const report = await runSecurityBackfill(client, ["ontology-a"], MARKING, DEFAULT_BACKFILL_RETRY, noSleep());
    expect(report.totalUpdated).toBe(0);
    expect(report.totalFailures).toBe(0);
    expect(report.perIndex[0].noop).toBe(9);
  });

  it("a missing index (404) is a no-op success, not deferred/fatal", async () => {
    const client = mockClient(async () => {
      throw { statusCode: 404 };
    });
    const report = await runSecurityBackfill(client, ["ontology-absent"], MARKING, DEFAULT_BACKFILL_RETRY, noSleep());
    expect(report.deferred).toBe(0);
    expect(report.fatal).toBe(0);
    expect(report.totalUpdated).toBe(0);
  });

  it("bounded retry does not block startup — sleep is bounded and attempts are capped", async () => {
    const sleeps: number[] = [];
    const client = mockClient(async () => {
      throw { statusCode: 503 };
    });
    await runSecurityBackfill(
      client, ["ontology-a"], MARKING,
      { maxAttempts: 3, baseDelayMs: 5, jitterMs: 0 },
      { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 },
    );
    // 3 attempts → at most 2 sleeps (between attempts), each bounded to baseDelay*2^k.
    expect(sleeps.length).toBeLessThanOrEqual(2);
    for (const s of sleeps) expect(s).toBeLessThanOrEqual(5 * 4 + 1);
  });
});
