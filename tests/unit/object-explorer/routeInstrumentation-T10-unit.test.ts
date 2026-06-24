// ---------------------------------------------------------------------------
// T-10 — routeInstrumentation helper unit tests.
//
// Contracts covered:
//   C-203 routeMetric increments tellus_read_branch_filtered_total with
//         scoped="true" iff branchId !== null.
//   C-204 routeLog emits a single JSON line on stdout AND observes the
//         tellus_route_duration_seconds histogram with the matching
//         status_class.
//   C-205 routeLog includes correlationId / requestId / traceId / userId
//         when set on the request, and null when absent.
//   C-206 startRouteTimer captures Date.now at call time and forwards
//         the elapsed duration to routeLog (deterministic via a fake
//         clock).
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Request } from "express";

import {
  routeMetric,
  routeLog,
  startRouteTimer,
} from "../../../src/utils/routeInstrumentation";
import {
  __resetMetricsForTesting,
  renderPrometheus,
} from "../../../src/services/funnel/metrics";

function fakeReq(props: Record<string, unknown> = {}): Request {
  // Build a minimal Request with the fields the helper reads.
  return props as unknown as Request;
}

beforeEach(() => {
  __resetMetricsForTesting();
});

describe("T-10 C-203: routeMetric scoped label", () => {
  it("T-10 C-203a: branchId=null → scoped=false", () => {
    routeMetric(fakeReq(), "objects.search", null);
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_read_branch_filtered_total{route="objects.search",scoped="false"} 1',
    );
  });

  it("T-10 C-203b: branchId=non-null → scoped=true", () => {
    routeMetric(fakeReq(), "objects.search", "feature-x");
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_read_branch_filtered_total{route="objects.search",scoped="true"} 1',
    );
  });
});

describe("T-10 C-204: routeLog emits JSON line + observes histogram", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("T-10 C-204a: status=200 → status_class=2xx; log line is parseable JSON", () => {
    routeLog(fakeReq({ correlationId: "abc" }), "objects.search", 200, 12, {
      hits: 5,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.type).toBe("route_call");
    expect(parsed.route).toBe("objects.search");
    expect(parsed.status).toBe(200);
    expect(parsed.durationMs).toBe(12);
    expect(parsed.correlationId).toBe("abc");
    expect(parsed.hits).toBe(5);
    const prom = renderPrometheus();
    expect(prom).toContain(
      'tellus_route_duration_seconds_count{route="objects.search",status_class="2xx"} 1',
    );
  });

  it("T-10 C-204b: status=503 → status_class=5xx", () => {
    routeLog(fakeReq(), "objects.search", 503, 100);
    const prom = renderPrometheus();
    expect(prom).toContain('status_class="5xx"');
  });

  it("T-10 C-204c: status=429 → status_class=4xx", () => {
    routeLog(fakeReq(), "objects.search", 429, 1);
    const prom = renderPrometheus();
    expect(prom).toContain('status_class="4xx"');
  });
});

describe("T-10 C-205: log line carries correlation IDs + user", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("T-10 C-205a: ids present → echoed into JSON", () => {
    routeLog(
      fakeReq({
        correlationId: "corr",
        requestId: "rid",
        traceId: "tid",
        user: { id: "alice" },
      }),
      "objects.search",
      200,
      0,
    );
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBe("corr");
    expect(parsed.requestId).toBe("rid");
    expect(parsed.traceId).toBe("tid");
    expect(parsed.user).toBe("alice");
  });

  it("T-10 C-205b: ids absent → null in JSON (no `undefined` strings)", () => {
    routeLog(fakeReq(), "objects.search", 200, 0);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBeNull();
    expect(parsed.requestId).toBeNull();
    expect(parsed.traceId).toBeNull();
    expect(parsed.user).toBeNull();
  });

  it("T-10 C-205c: non-string id → null (defensive — never serialises object refs)", () => {
    routeLog(
      fakeReq({ correlationId: { not: "a string" }, user: { id: 42 } }),
      "objects.search",
      200,
      0,
    );
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.correlationId).toBeNull();
    expect(parsed.user).toBeNull();
  });
});

describe("T-10 C-206: startRouteTimer captures elapsed duration", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.useRealTimers();
  });

  it("T-10 C-206a: timer captures monotonic-style delta via Date.now", () => {
    const done = startRouteTimer(fakeReq(), "objects.search");
    vi.advanceTimersByTime(75);
    done(200, { hits: 0 });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.durationMs).toBe(75);
    expect(parsed.status).toBe(200);
    expect(parsed.hits).toBe(0);
  });
});
